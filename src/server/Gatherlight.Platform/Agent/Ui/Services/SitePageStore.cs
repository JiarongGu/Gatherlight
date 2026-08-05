using System.Text.Json;
using Gatherlight.Server.Platform.Agent.Ui.Models;
using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Site.Services;

namespace Gatherlight.Server.Platform.Agent.Ui.Services;

/// <summary>
/// Reads page specs from the site's UI directory (site.json's <c>ui.spec</c>, default <c>ui/</c>).
/// A page is the SAME validated tree the chat mount renders — a page is not a second system, just
/// the same data somewhere durable. A corrupted page reports its reason like an invalid block does;
/// it never throws a 500 and never renders unvalidated.
/// </summary>
public interface ISitePageStore
{
    IReadOnlyList<SitePageSummary> List();
    SitePageView? Get(string name);
}

public sealed class SitePageStore : ISitePageStore
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    private readonly ISiteContext _site;
    private readonly IUiTreeValidator _validator;
    private readonly ISiteManifestStore _manifest;

    public SitePageStore(ISiteContext site, IUiTreeValidator validator, ISiteManifestStore manifest)
    {
        _site = site;
        _validator = validator;
        _manifest = manifest;
    }

    private string Dir => _site.ResolveSitePath(_manifest.Current.Ui.Spec.TrimEnd('/')) ?? "";

    // A page name is a bare file stem — no separators, no dots — so a name can never walk out of
    // the UI directory before ResolveSitePath is even consulted.
    private static bool ValidName(string name) =>
        name.Length is > 0 and <= 64 && name.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    public IReadOnlyList<SitePageSummary> List()
    {
        var dir = Dir;
        if (dir is "" || !Directory.Exists(dir)) return [];
        var pages = new List<SitePageSummary>();
        foreach (var file in Directory.EnumerateFiles(dir, "*.json").OrderBy(f => f, StringComparer.Ordinal))
        {
            var name = Path.GetFileNameWithoutExtension(file);
            if (!ValidName(name)) continue;
            var title = name;
            SitePageFile? parsed = null;
            try
            {
                parsed = JsonSerializer.Deserialize<SitePageFile>(File.ReadAllText(file), Json);
                if (!string.IsNullOrWhiteSpace(parsed?.Title)) title = parsed!.Title;
            }
            catch (JsonException) { /* listed with its file name; Get() reports the real reason */ }
            // A malformed page keeps its file-name title and the defaults below — it still appears,
            // marked, rather than vanishing from the menu with no trace of why.
            var nav = parsed?.Nav;
            pages.Add(new SitePageSummary(
                name, title,
                Label: string.IsNullOrWhiteSpace(nav?.Label) ? title : nav!.Label!,
                Order: nav?.Order ?? 1000,
                Hidden: nav?.Hidden ?? false));
        }
        // Declared order first, then name — a page with no order sorts after the ordered ones
        // rather than jumping to the front.
        return pages.OrderBy(p => p.Order).ThenBy(p => p.Name, StringComparer.Ordinal).ToList();
    }

    public SitePageView? Get(string name)
    {
        var dir = Dir;
        if (!ValidName(name) || dir is "") return null;
        var path = Path.Combine(dir, name + ".json");
        if (!File.Exists(path)) return null;

        SitePageFile? parsed;
        try { parsed = JsonSerializer.Deserialize<SitePageFile>(File.ReadAllText(path), Json); }
        catch (JsonException ex) { return new SitePageView(name, name, "invalid", null, $"not valid JSON: {ex.Message}"); }
        if (parsed is null) return new SitePageView(name, name, "invalid", null, "page file is empty");

        var result = _validator.ValidateElement(parsed.Root);
        return result.Ok
            ? new SitePageView(name, parsed.Title ?? name, "ready", result.Node, null)
            : new SitePageView(name, parsed.Title ?? name, "invalid", null, result.Reason);
    }
}
