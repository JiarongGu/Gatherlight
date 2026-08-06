using System.Text.Json;
using Gatherlight.Server.Platform.Agent.Ui.Data;
using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Site.Services;

namespace Gatherlight.Server.Platform.Agent.Ui.Services;

/// <summary>A composite definition: a named, parameterized subtree of primitives. <c>Problem</c> is
/// set when the definition is unusable — carried rather than thrown away, because a definition that
/// silently does nothing is the worst outcome: the page keeps rendering, the agent keeps writing the
/// component, and nothing anywhere says why it never appears.</summary>
public sealed record UiComposite(
    string Name, IReadOnlyDictionary<string, UiParamKind> Params, JsonElement Body, string? Problem = null);

/// <summary>The raw file shape — a file in the UI directory with <c>define</c> is a composite, one
/// with <c>root</c> is a page. Same directory, same guard, same diff gate: a composite is not a
/// second kind of thing the household has to learn about.</summary>
public sealed record UiCompositeFile(string Define, Dictionary<string, string>? Params, JsonElement Body);

public interface IUiCompositeStore
{
    /// <summary>The USABLE definitions, by name. A definition with a <c>Problem</c> is excluded, so a
    /// broken one can never shadow anything or half-render.</summary>
    IReadOnlyDictionary<string, UiComposite> All();

    /// <summary>The definition this UI file declares — problems included — or null if it is a page.</summary>
    UiComposite? Definition(string relPath);

    /// <summary>Page files whose trees name this composite — the pages a change to it silently
    /// alters, and therefore the pages the diff gate has to render.</summary>
    IReadOnlyList<string> PagesUsing(string compositeName);
}

/// <summary>
/// Reads composite definitions from the site's UI directory. Deliberately no caching: the directory
/// holds a handful of small files, the page store already enumerates it per call, and a cache here
/// would be a second source of truth for something the agent edits through the diff gate.
/// </summary>
public sealed class UiCompositeStore : IUiCompositeStore
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    private readonly ISiteContext _site;
    private readonly ISiteManifestStore _manifest;
    private readonly HashSet<string> _reserved;

    public UiCompositeStore(ISiteContext site, ISiteManifestStore manifest,
        IEnumerable<Schemas.IUiNodeSchema> schemas)
    {
        _site = site;
        _manifest = manifest;
        _reserved = schemas.Select(s => s.Type).ToHashSet(StringComparer.Ordinal);
    }

    private string DirRel => _manifest.Current.Ui.Spec.Trim('/');
    private string Dir => _site.ResolveSitePath(DirRel) ?? "";

    public IReadOnlyDictionary<string, UiComposite> All()
    {
        var found = new Dictionary<string, UiComposite>(StringComparer.Ordinal);
        var dir = Dir;
        if (dir is "" || !Directory.Exists(dir)) return found;

        foreach (var file in Directory.EnumerateFiles(dir, "*.json").OrderBy(f => f, StringComparer.Ordinal))
        {
            if (Read(file) is not { Problem: null } c) continue;
            // First definition wins, deterministically (files are walked in name order) — two files
            // defining the same name is a mistake, and picking by luck would make it an intermittent one.
            found.TryAdd(c.Name, c);
        }
        return found;
    }

    public UiComposite? Definition(string relPath)
    {
        var abs = _site.ResolveSitePath(relPath.Replace('\\', '/'));
        return abs is not null && File.Exists(abs) ? Read(abs) : null;
    }

    public IReadOnlyList<string> PagesUsing(string compositeName)
    {
        var dir = Dir;
        if (dir is "" || !Directory.Exists(dir)) return [];

        var needle = $"\"{compositeName}\"";
        var pages = new List<string>();
        foreach (var file in Directory.EnumerateFiles(dir, "*.json").OrderBy(f => f, StringComparer.Ordinal))
        {
            string body;
            try { body = File.ReadAllText(file); }
            catch (IOException) { continue; }
            if (Read(file) is not null) continue;               // another composite, not a page
            // A textual probe on the quoted name, then the real check happens when the page is
            // validated. Over-including a page costs one extra render at the gate; under-including it
            // would hide a change the household is being asked to approve.
            if (body.Contains(needle, StringComparison.Ordinal))
                pages.Add($"{DirRel}/{Path.GetFileName(file)}");
        }
        return pages;
    }

    /// <summary>Null when the file is a page (or unreadable). A definition missing its name or body
    /// is not a composite either — it is a broken file, and the page path reports it as one.</summary>
    private UiComposite? Read(string absPath)
    {
        UiCompositeFile? parsed;
        try { parsed = JsonSerializer.Deserialize<UiCompositeFile>(File.ReadAllText(absPath), Json); }
        catch (Exception e) when (e is JsonException or IOException) { return null; }
        if (parsed is null || string.IsNullOrWhiteSpace(parsed.Define)) return null;
        if (parsed.Body.ValueKind != JsonValueKind.Object) return null;

        var ps = new Dictionary<string, UiParamKind>(StringComparer.Ordinal);
        foreach (var (name, kind) in parsed.Params ?? [])
            ps[name] = kind.ToLowerInvariant() switch
            {
                "number" => UiParamKind.Number,
                "bool" or "boolean" => UiParamKind.Bool,
                _ => UiParamKind.String,
            };
        // A definition may not take a built-in's name. Silently letting the primitive win would leave
        // the agent writing a component that never renders, with every check green.
        var problem = _reserved.Contains(parsed.Define)
            ? $"'{parsed.Define}' is a built-in component — a definition needs its own name"
            : null;

        return new UiComposite(parsed.Define, ps, parsed.Body.Clone(), problem);
    }
}
