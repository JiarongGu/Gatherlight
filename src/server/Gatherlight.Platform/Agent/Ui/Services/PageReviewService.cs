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
    PageDiffView Review(string relPath, string? beforeJson);
}

public sealed class PageReviewService : IPageReviewService
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    private readonly ISiteContext _site;
    private readonly ISiteManifestStore _manifest;
    private readonly IUiTreeValidator _validator;

    public PageReviewService(ISiteContext site, ISiteManifestStore manifest, IUiTreeValidator validator)
    {
        _site = site;
        _manifest = manifest;
        _validator = validator;
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

    public PageDiffView Review(string relPath, string? beforeJson)
    {
        var rel = relPath.Replace('\\', '/');
        var name = Path.GetFileNameWithoutExtension(rel);
        var abs = _site.ResolveSitePath(rel);

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
        return result.Ok
            ? new PageDiffView(rel, name, title, "ready", result.Node, null,
                PageDiffSummary.Describe(Parse(beforeJson), result.Node))
            : new PageDiffView(rel, name, title, "invalid", null, result.Reason, "");
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
