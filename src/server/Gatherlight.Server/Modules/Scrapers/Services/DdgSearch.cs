using System.Text.RegularExpressions;

namespace Gatherlight.Server.Modules.Scrapers.Services;

/// <summary>One DuckDuckGo HTML-endpoint result: title, the decoded destination URL, and its host.</summary>
public sealed record SearchHit(string Title, string Url, string Domain);

/// <summary>
/// Shared DuckDuckGo HTML-endpoint search used by the venue verifiers (hotel_info, restaurant_info)
/// to find trusted replacement sources. The `/html/` endpoint is SSR'd — no JS needed — and each
/// result anchor's href is a `…/l/?uddg=<encoded real url>` redirect that we decode.
/// </summary>
public static partial class DdgSearch
{
    public static async Task<List<SearchHit>> RunAsync(
        IPlaywrightScraper scraper, string query, int max = 15, CancellationToken ct = default)
    {
        var url = $"{ScraperBases.DuckDuckGo}/html/?q={Uri.EscapeDataString(query)}";
        var links = await scraper.FetchLinksAsync(url, ".result__a", max, 30_000, ct);
        var hits = new List<SearchHit>();
        foreach (var l in links)
        {
            var real = Decode(l.Href);
            if (!Uri.TryCreate(real, UriKind.Absolute, out var u)) continue;
            var host = u.Host.StartsWith("www.", StringComparison.OrdinalIgnoreCase) ? u.Host[4..] : u.Host;
            hits.Add(new SearchHit(l.Text.Trim(), real, host));
        }
        return hits;
    }

    /// <summary>DDG wraps outbound links as `…/l/?uddg=<url-encoded target>&…` — pull the target out.</summary>
    public static string Decode(string href)
    {
        var m = UddgRegex().Match(href);
        if (!m.Success) return href;
        try { return Uri.UnescapeDataString(m.Groups[1].Value); }
        catch { return href; }
    }

    [GeneratedRegex(@"uddg=([^&]+)")] private static partial Regex UddgRegex();
}
