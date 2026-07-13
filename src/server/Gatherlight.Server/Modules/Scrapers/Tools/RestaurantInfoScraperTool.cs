using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Gatherlight.Server.Modules.Scrapers.Services;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Scrapers.Tools;

/// <summary>
/// C#/Playwright port of the restaurant verifier. For each claimed restaurant (name + area + maybe
/// a URL), checks whether the claimed URL really is that restaurant; if broken/mismatched, searches
/// DuckDuckGo for a trusted-domain replacement (Tabelog EN / TableCheck / Michelin individual page)
/// and verifies it. Built per tool-first: model-fabricated Tabelog IDs render an unrelated
/// restaurant instead of 404, so the mismatch is silent without live verification.
/// </summary>
public sealed partial class RestaurantInfoScraperTool : IGatherlightTool
{
    private readonly IPlaywrightScraper _scraper;

    public RestaurantInfoScraperTool(IPlaywrightScraper scraper) => _scraper = scraper;

    public string Name => "restaurant_info";
    public string Description =>
        "批量核验餐厅:验证声称的目录页 URL 是否对应该店,坏链自动搜索可信替代(Tabelog/TableCheck/Michelin 个店页)。模型记忆的餐厅目录 ID 系统性不可靠 — 必须逐条核验。queries 为 JSON 数组:[{\"name\":\"…\",\"area\":\"…\",\"cuisine\":\"…\",\"claimedUrl\":\"…\"}]。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("queries", "JSON 数组:[{name, area?, cuisine?, claimedUrl?}]", required: true));

    // Trust order = fallback-search preference.
    private static readonly string[] TrustedDomains =
        { "tabelog.com", "tablecheck.com", "guide.michelin.com", "opentable.co.jp", "opentable.com", "savorjapan.com" };

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var queries = ParseQueries(args);
        var rows = new JsonArray();
        foreach (var q in queries)
            rows.Add(await ProcessAsync(q, ct));

        return new JsonObject
        {
            ["source"] = "gatherlight/restaurant_info (C#/Playwright)",
            ["scrapeTime"] = DateTime.UtcNow.ToString("o"),
            ["rows"] = rows,
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }

    internal sealed record Query(string Name, string? Area, string? Cuisine, string? ClaimedUrl);
    internal sealed record Verify(string? ActualName, string? Cuisine, string? Area, string? PriceRange,
        string? Hours, string Status, string Notes);

    private async Task<JsonObject> ProcessAsync(Query q, CancellationToken ct)
    {
        var notes = new List<string>();
        bool? claimedMatches = null;

        // Step 1 — verify the claimed URL, short-circuit if it really is this restaurant.
        if (q.ClaimedUrl is not null)
        {
            var claimed = await VerifyUrlAsync(q.ClaimedUrl, ct);
            if (claimed.ActualName is not null)
            {
                var sim = NameSimilarity(q.Name, claimed.ActualName);
                claimedMatches = sim >= 0.4 && claimed.Status == "active";
                notes.Add($"claimed: name=\"{claimed.ActualName}\" sim={sim:0.00} status={claimed.Status}");
                if (claimedMatches == true)
                    return Row(q, q.ClaimedUrl, true, claimed, new JsonArray(), string.Join(" | ", notes));
            }
            else
            {
                claimedMatches = false;
                notes.Add($"claimed: no name extracted, status={claimed.Status}");
            }
            if (claimed.Notes.Length > 0) notes.Add(claimed.Notes);
        }

        // Step 2 — search for a trusted replacement.
        var query = string.Join(" ", new[] { q.Name, q.Area, q.Cuisine, "tabelog OR tablecheck OR michelin" }
            .Where(s => !string.IsNullOrEmpty(s)));
        List<SearchHit> hits;
        try { hits = await DdgSearch.RunAsync(_scraper, query, 12, ct); }
        catch (Exception ex) { notes.Add($"search-error: {ex.Message}"); return Row(q, null, claimedMatches, null, new JsonArray(), string.Join(" | ", notes)); }

        var candArray = new JsonArray();
        foreach (var h in hits) candArray.Add(new JsonObject { ["title"] = h.Title, ["url"] = h.Url, ["domain"] = h.Domain });
        if (hits.Count == 0) { notes.Add("no search results"); return Row(q, null, claimedMatches, null, candArray, string.Join(" | ", notes)); }

        var pick = PickBestCandidate(hits, q);
        if (pick is null) { notes.Add("no verified candidate (no individual restaurant page on trusted domains)"); return Row(q, null, claimedMatches, null, candArray, string.Join(" | ", notes)); }

        var (best, tier) = pick.Value;
        var result = await VerifyUrlAsync(best.Url, ct);
        notes.Add($"candidate-tier={tier}");
        notes.Add($"candidate-domain={best.Domain}");
        if (result.ActualName is not null)
            notes.Add($"candidate: name=\"{result.ActualName}\" sim={NameSimilarity(q.Name, result.ActualName):0.00}");
        if (result.Notes.Length > 0) notes.Add(result.Notes);
        return Row(q, best.Url, claimedMatches, result, candArray, string.Join(" | ", notes));
    }

    private static JsonObject Row(Query q, string? verifiedUrl, bool? claimedMatches, Verify? v,
        JsonArray candidates, string notes) => new()
    {
        ["query"] = new JsonObject { ["name"] = q.Name, ["area"] = q.Area, ["cuisine"] = q.Cuisine },
        ["claimedUrl"] = q.ClaimedUrl,
        ["claimedNameMatches"] = claimedMatches,
        ["verifiedUrl"] = verifiedUrl,
        ["actualName"] = v?.ActualName,
        ["cuisine"] = v?.Cuisine,
        ["area"] = v?.Area,
        ["priceRange"] = v?.PriceRange,
        ["hours"] = v?.Hours,
        ["status"] = v?.Status ?? "unknown",
        ["candidates"] = candidates,
        ["notes"] = notes,
    };

    private async Task<Verify> VerifyUrlAsync(string url, CancellationToken ct)
    {
        try
        {
            var page = await _scraper.FetchAsync(url, waitForSelector: null, timeoutMs: 30_000, ct: ct);
            var isTabelog = Uri.TryCreate(url, UriKind.Absolute, out var u) &&
                u.Host.EndsWith("tabelog.com", StringComparison.OrdinalIgnoreCase);
            return isTabelog ? ParseTabelog(page) : ParseGeneric(page);
        }
        catch (Exception ex) { return new Verify(null, null, null, null, null, "unknown", $"verify-error: {ex.Message}"); }
    }

    // ---- deterministic parsers (tested) ----
    internal static Verify ParseTabelog(PageResult page)
    {
        if (TabelogNotFound().IsMatch(page.Title))
            return new Verify(null, null, null, null, null, "404", $"Tabelog: page not displayed (title=\"{page.Title}\")");

        var text = page.Text;
        var name = LabelValue(text, "Restaurant name") ?? (page.H1.Length > 0 ? page.H1 : null);
        var cuisine = LabelValue(text, "Categories");
        var area = LabelValue(text, "Address");
        var hours = LabelValue(text, "Business hours");
        var price = LabelValue(text, "Average price") ?? LabelValue(text, "Budget");
        var onHold = OnHoldRegex().IsMatch(text);
        return new Verify(name, cuisine, area, price, hours,
            onHold ? "closed" : "active", onHold ? "Tabelog: listing on hold / closed / relocated" : "");
    }

    internal static Verify ParseGeneric(PageResult page)
    {
        var name = page.H1.Length > 0 ? page.H1 : SplitTitle(page.Title);
        var looks404 = GenericNotFound().IsMatch(page.Title);
        return new Verify(name, null, null, null, null, looks404 ? "404" : "active",
            $"generic-verify (h1=\"{Trunc(page.H1, 60)}\", title=\"{Trunc(page.Title, 60)}\")");
    }

    private static string? SplitTitle(string title)
    {
        var parts = TitleSep().Split(title);
        return parts.Length > 0 && parts[0].Trim().Length > 0 ? parts[0].Trim() : null;
    }

    /// <summary>Value after a table label in Playwright innerText ("Label\tvalue" per row).</summary>
    private static string? LabelValue(string text, string label)
    {
        var m = Regex.Match(text, Regex.Escape(label) + @"[\t ]+([^\n]+)", RegexOptions.IgnoreCase);
        return m.Success ? m.Groups[1].Value.Trim() : null;
    }

    // ---- candidate selection (URL tiers) ----
    internal static (SearchHit Hit, string Tier)? PickBestCandidate(List<SearchHit> candidates, Query q)
    {
        var nameTokens = NormalizeTokens(q.Name);
        // Pass 1: trusted individual page with a name token in the title.
        foreach (var domain in TrustedDomains)
        {
            var inDomain = candidates.Where(c => c.Domain.EndsWith(domain) && IsIndividualPage(c.Url, c.Domain)).ToList();
            var titleMatch = inDomain.FirstOrDefault(c => nameTokens.Any(t => c.Title.ToLowerInvariant().Contains(t)));
            if (titleMatch is not null) return (titleMatch, "individual-named");
        }
        // Pass 2: trusted individual page, any title.
        foreach (var domain in TrustedDomains)
        {
            var first = candidates.FirstOrDefault(c => c.Domain.EndsWith(domain) && IsIndividualPage(c.Url, c.Domain));
            if (first is not null) return (first, "individual");
        }
        // Pass 3: trusted curated list / matome / Michelin area page (flagged).
        foreach (var domain in TrustedDomains)
        {
            var first = candidates.FirstOrDefault(c => c.Domain.EndsWith(domain) && IsCuratedList(c.Url, c.Domain));
            if (first is not null) return (first, "curated-list");
        }
        return null;
    }

    internal static bool IsIndividualPage(string url, string domain)
    {
        if (domain.EndsWith("tabelog.com")) return TabelogIndividual().IsMatch(url);
        if (domain.EndsWith("tablecheck.com")) return TableCheckShop().IsMatch(url);
        if (domain.EndsWith("guide.michelin.com")) return MichelinRestaurant().IsMatch(url);
        if (domain.EndsWith("opentable.co.jp") || domain.EndsWith("opentable.com")) return OpenTable().IsMatch(url);
        return false;
    }

    internal static bool IsCuratedList(string url, string domain)
    {
        if (domain.EndsWith("tabelog.com")) return TabelogMatome().IsMatch(url);
        if (domain.EndsWith("guide.michelin.com")) return MichelinArea().IsMatch(url);
        return false;
    }

    internal static double NameSimilarity(string claimed, string actual)
    {
        var a = NormalizeTokens(claimed).ToHashSet();
        var b = NormalizeTokens(actual).ToHashSet();
        if (a.Count == 0 || b.Count == 0) return 0;
        var overlap = a.Count(b.Contains);
        return (double)overlap / Math.Max(a.Count, b.Count);
    }

    internal static List<string> NormalizeTokens(string s) =>
        NonWord().Replace(s.ToLowerInvariant(), " ").Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Where(t => t.Length >= 2).ToList();

    private static List<Query> ParseQueries(JsonElement args)
    {
        var raw = args.GetProperty("queries").GetString() ?? "";
        JsonDocument doc;
        try { doc = JsonDocument.Parse(raw); }
        catch (JsonException) { throw new ToolException(400, "queries 必须是合法 JSON"); }
        using (doc)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Array) throw new ToolException(400, "queries 必须是 JSON 数组");
            var list = new List<Query>();
            foreach (var e in doc.RootElement.EnumerateArray())
            {
                var name = Str(e, "name") ?? throw new ToolException(400, "每个 query 需要 name");
                list.Add(new Query(name, Str(e, "area"), Str(e, "cuisine"), Str(e, "claimedUrl")));
            }
            if (list.Count == 0) throw new ToolException(400, "queries 为空");
            return list;
        }
    }

    private static string? Str(JsonElement e, string key) =>
        e.TryGetProperty(key, out var v) && v.GetString() is { Length: > 0 } s ? s : null;

    private static string Trunc(string s, int n) => s.Length <= n ? s : s[..n];

    [GeneratedRegex(@"このページを表示することができません|page is not displayed|page not found", RegexOptions.IgnoreCase)] private static partial Regex TabelogNotFound();
    [GeneratedRegex(@"掲載保留|on hold|closure period|relocated|permanently closed", RegexOptions.IgnoreCase)] private static partial Regex OnHoldRegex();
    [GeneratedRegex(@"404|not found|page not found|お探しのページ", RegexOptions.IgnoreCase)] private static partial Regex GenericNotFound();
    [GeneratedRegex(@"\s*[|\-—–]\s*")] private static partial Regex TitleSep();
    [GeneratedRegex(@"/[a-z]+/A\d+/A\d+/\d+/?(?:[?#]|$)")] private static partial Regex TabelogIndividual();
    [GeneratedRegex(@"/matome/\d+")] private static partial Regex TabelogMatome();
    [GeneratedRegex(@"/shops/[^/]+(?:/|$)")] private static partial Regex TableCheckShop();
    [GeneratedRegex(@"/restaurant/[^/]+")] private static partial Regex MichelinRestaurant();
    [GeneratedRegex(@"/restaurants(?:/|$)")] private static partial Regex MichelinArea();
    [GeneratedRegex(@"/r/|/restref/")] private static partial Regex OpenTable();
    [GeneratedRegex(@"[^a-z0-9]+")] private static partial Regex NonWord();
}
