using System.Text.Json;
using Gatherlight.Server.Platform.Agent.Ui.Models;
using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Site.Services;

namespace Gatherlight.Server.Platform.Agent.Ui.Services;

/// <summary>Builds the diff gate's page previews. Reads the WORKING TREE — at review time that
/// already holds the agent's edits and not yet a commit, so what is validated and rendered is
/// exactly what approval would commit.</summary>
public interface IPageReviewService
{
    bool IsPagePath(string relPath);

    /// <summary>Everything the household has to look at because this file changed. For a page that is
    /// the page. For a COMPONENT DEFINITION it is the definition plus every page that uses it: editing
    /// one changes pages whose own files did not change at all, and a gate that showed only the edited
    /// file would be asking for approval of a change it is not displaying.</summary>
    IReadOnlyList<string> PagesToReview(string relPath);

    Task<PageDiffView> ReviewAsync(string relPath, string? beforeJson, CancellationToken ct = default);
}

public sealed class PageReviewService : IPageReviewService
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    private readonly ISiteContext _site;
    private readonly ISiteManifestStore _manifest;
    private readonly IUiTreeValidator _validator;
    private readonly IUiBindingResolver _bindings;
    private readonly IUiCompositeStore _composites;

    public PageReviewService(ISiteContext site, ISiteManifestStore manifest, IUiTreeValidator validator,
        IUiBindingResolver bindings, IUiCompositeStore composites)
    {
        _site = site;
        _manifest = manifest;
        _validator = validator;
        _bindings = bindings;
        _composites = composites;
    }

    private string UiDir => _manifest.Current.Ui.Spec.Trim('/');

    public bool IsPagePath(string relPath)
    {
        var rel = relPath.Replace('\\', '/');
        var dir = UiDir;
        return dir.Length > 0
            && rel.StartsWith(dir + "/", StringComparison.Ordinal)
            && rel.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
            && !rel[(dir.Length + 1)..].Contains('/');
    }

    public IReadOnlyList<string> PagesToReview(string relPath)
    {
        var rel = relPath.Replace('\\', '/');
        if (_composites.Definition(rel) is not { } def) return [rel];
        return new[] { rel }.Concat(_composites.PagesUsing(def.Name)).ToList();
    }

    public async Task<PageDiffView> ReviewAsync(string relPath, string? beforeJson, CancellationToken ct = default)
    {
        var rel = relPath.Replace('\\', '/');
        var name = Path.GetFileNameWithoutExtension(rel);
        var abs = _site.ResolveSitePath(rel);

        // A component definition has nothing of its own to render; what it HAS is reach. Its card
        // states that plainly and names the pages it touches — built here in code, not from anything
        // the agent wrote, like every other approval surface.
        if (_composites.Definition(rel) is { } def)
        {
            var users = _composites.PagesUsing(def.Name);
            if (def.Problem is { } problem)
                return new PageDiffView(rel, name, def.Name, "invalid", null, problem, "");
            return new PageDiffView(rel, name, def.Name, "ready", DefinitionCard(def, users), null,
                users.Count == 0
                    ? "新的组件定义,暂时没有页面使用 · a component definition, not used by any page yet"
                    : $"组件定义改动,影响 {users.Count} 个页面 · a component definition change affecting {users.Count} page(s)");
        }

        if (abs is null || !File.Exists(abs))
            return new PageDiffView(rel, name, name, "deleted", null, null, PageDiffSummary.Describe(Parse(beforeJson), null));

        SitePageFile? parsed;
        try { parsed = JsonSerializer.Deserialize<SitePageFile>(File.ReadAllText(abs), Json); }
        catch (JsonException ex)
        {
            return new PageDiffView(rel, name, name, "invalid", null, $"not valid JSON: {ex.Message}", "");
        }
        if (parsed is null)
            return new PageDiffView(rel, name, name, "invalid", null, "page file is empty", "");

        var result = _validator.ValidateElement(parsed.Root);
        var title = string.IsNullOrWhiteSpace(parsed.Title) ? name : parsed.Title;
        if (!result.Ok) return new PageDiffView(rel, name, title, "invalid", null, result.Reason, "");

        // The CHANGE is summarized from the authored trees (bindings and all), but the PREVIEW is
        // rendered with bindings resolved: the reviewer is being asked to approve what the household
        // will actually see, and for a bound page that is live data, not the word "bind".
        var preview = await _bindings.ResolveAsync(result.Node!, ct);
        return new PageDiffView(rel, name, title, "ready", preview, null,
            PageDiffSummary.Describe(Parse(beforeJson), result.Node));
    }

    /// <summary>Platform chrome for a component definition at the gate: what it is called, what it
    /// takes, and which pages it reaches. Assembled in code from the parsed definition and the file
    /// scan — nothing here is a sentence the agent supplied.</summary>
    private static UiNode DefinitionCard(UiComposite def, IReadOnlyList<string> users)
    {
        var items = new List<string> { $"参数 · parameters: {(def.Params.Count == 0 ? "(无 · none)" : string.Join(", ", def.Params.Keys.OrderBy(k => k, StringComparer.Ordinal)))}" };
        items.AddRange(users.Count == 0
            ? ["暂无页面使用 · no page uses it yet"]
            : users.Select(u => $"用于 · used by {u}"));

        var card = new UiNode { Type = "Card" };
        card.Props["title"] = JsonSerializer.SerializeToElement($"组件定义 · component: {def.Name}");
        var list = new UiNode { Type = "List" };
        list.Props["items"] = JsonSerializer.SerializeToElement(items);
        card.Children.Add(list);
        return card;
    }

    // The pre-change tree, when git gave us one. A previous version that no longer validates is not
    // an error here — it just means there is nothing to compare against.
    private UiNode? Parse(string? beforeJson)
    {
        if (string.IsNullOrWhiteSpace(beforeJson)) return null;
        try
        {
            var file = JsonSerializer.Deserialize<SitePageFile>(beforeJson, Json);
            return file is null ? null : _validator.ValidateElement(file.Root).Node;
        }
        catch (JsonException) { return null; }
    }
}
