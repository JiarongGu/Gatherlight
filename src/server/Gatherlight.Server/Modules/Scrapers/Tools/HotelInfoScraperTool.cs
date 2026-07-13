using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Gatherlight.Server.Modules.Scrapers.Services;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Scrapers.Tools;

/// <summary>
/// C#/Playwright port of the hotel-info verifier. Searches DuckDuckGo for a hotel, scrapes an
/// official page + a trusted aggregator, extracts phone / address / postcode / check-in-out, votes
/// the most common value across sources, and flags a mismatch against any claimed phone. Built per
/// verify-policy-info: model-recalled hotel postcodes/addresses are frequently wrong.
/// </summary>
public sealed partial class HotelInfoScraperTool : IGatherlightTool
{
    private readonly IPlaywrightScraper _scraper;

    public HotelInfoScraperTool(IPlaywrightScraper scraper) => _scraper = scraper;

    public string Name => "hotel_info";
    public string Description =>
        "批量核验酒店地址/电话/入退房时间(多来源交叉:官方站 + 订房平台)。写入计划前核验 — 模型记忆的邮编/地址常出错。queries 为 JSON 数组:[{\"name\":\"…\",\"city\":\"…\",\"claimedPhone\":\"…\",\"claimedAddress\":\"…\"}]。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("queries", "JSON 数组:[{name, city?, claimedPhone?, claimedAddress?}]", required: true));

    private static readonly string[] TrustedDomains =
        { "booking.com", "tripadvisor.com", "agoda.com", "expedia.com", "rakutentravel.com" };

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var queries = ParseQueries(args);
        var rows = new JsonArray();
        foreach (var q in queries)
            rows.Add(await ProcessAsync(q, ct));

        return new JsonObject
        {
            ["source"] = "gatherlight/hotel_info (C#/Playwright)",
            ["scrapeTime"] = DateTime.UtcNow.ToString("o"),
            ["rows"] = rows,
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }

    internal sealed record Query(string Name, string? City, string? ClaimedPhone, string? ClaimedAddress);

    private async Task<JsonObject> ProcessAsync(Query q, CancellationToken ct)
    {
        var sources = new JsonArray();
        var contact = new List<Contact>();

        List<SearchHit> hits;
        try { hits = await DdgSearch.RunAsync(_scraper, $"{q.Name} {q.City} address phone official".Trim(), 15, ct); }
        catch (Exception ex) { return Row(q, sources, null, null, null, null, null, false, $"search-error: {ex.Message}"); }

        // One likely-official page (domain shares a long name token) + up to two trusted aggregators.
        var nameTokens = q.Name.ToLowerInvariant().Split(new[] { ' ', '-', '_', '.', ',' },
            StringSplitOptions.RemoveEmptyEntries).Where(t => t.Length >= 4).ToArray();
        var aggregators = hits.Where(h => TrustedDomains.Any(d => h.Domain.EndsWith(d))).ToList();
        var official = hits.FirstOrDefault(h =>
            nameTokens.Any(t => h.Domain.Contains(t)) && !TrustedDomains.Any(d => h.Domain.EndsWith(d)));

        var toScrape = new List<SearchHit>();
        if (official is not null) toScrape.Add(official);
        if (aggregators.Count > 0) toScrape.Add(aggregators[0]);
        if (aggregators.Count > 1 && aggregators[1].Domain != aggregators[0].Domain) toScrape.Add(aggregators[1]);

        foreach (var hit in toScrape)
        {
            var page = await _scraper.FetchAsync(hit.Url, waitForSelector: null, timeoutMs: 30_000, ct: ct);
            if (page.Text.Length == 0) continue;
            var c = Extract(page.Text);
            contact.Add(c);
            sources.Add(new JsonObject
            {
                ["url"] = hit.Url,
                ["domain"] = hit.Domain,
                ["phone"] = c.Phone,
                ["address"] = c.Address,
                ["postalCode"] = c.Postal,
                ["checkInTime"] = c.CheckIn,
                ["checkOutTime"] = c.CheckOut,
            });
        }

        var phone = PickBest(contact.Select(c => c.Phone));
        var address = PickBest(contact.Select(c => c.Address));
        var postal = PickBest(contact.Select(c => c.Postal));
        var checkIn = PickBest(contact.Select(c => c.CheckIn));
        var checkOut = PickBest(contact.Select(c => c.CheckOut));

        var mismatch = q.ClaimedPhone is not null && phone is not null &&
            Digits(q.ClaimedPhone) != Digits(phone) && Digits(q.ClaimedPhone).Length > 0 && Digits(phone).Length > 0;

        var notes = $"sources={contact.Count}; phones=[{string.Join(" | ", contact.Select(c => c.Phone ?? "?"))}]";
        return Row(q, sources, phone, address, postal, checkIn, checkOut, mismatch, notes);
    }

    private static JsonObject Row(Query q, JsonArray sources, string? phone, string? address, string? postal,
        string? checkIn, string? checkOut, bool mismatch, string notes) => new()
    {
        ["query"] = new JsonObject { ["name"] = q.Name, ["city"] = q.City },
        ["claimedPhone"] = q.ClaimedPhone,
        ["claimedAddress"] = q.ClaimedAddress,
        ["verifiedPhone"] = phone,
        ["verifiedAddress"] = address,
        ["postalCode"] = postal,
        ["checkInTime"] = checkIn,
        ["checkOutTime"] = checkOut,
        ["sources"] = sources,
        ["mismatch"] = mismatch,
        ["notes"] = notes,
    };

    internal sealed record Contact(string? Phone, string? Postal, string? Address, string? CheckIn, string? CheckOut);

    internal static Contact Extract(string text)
    {
        var phone = PhoneRegex().Match(text) is { Success: true } pm ? pm.Value.Trim() : null;
        var postal = PostalRegex().Match(text) is { Success: true } zm ? zm.Groups[1].Value : null;

        string? address = null;
        foreach (var line in text.Split('\n').Select(l => l.Trim()).Where(l => l.Length is >= 10 and <= 200))
            if ((AddressKeywords().IsMatch(line) || JpAddress().IsMatch(line)) &&
                (line.Any(char.IsDigit) || JpAddress().IsMatch(line)))
            { address = line; break; }

        var ci = CheckInRegex().Match(text);
        var co = CheckOutRegex().Match(text);
        return new Contact(phone, postal, address,
            ci.Success ? ci.Groups[1].Value : null, co.Success ? co.Groups[1].Value : null);
    }

    /// <summary>Most common non-null value (source agreement wins).</summary>
    internal static string? PickBest(IEnumerable<string?> values)
    {
        var best = values.Where(v => !string.IsNullOrEmpty(v))
            .GroupBy(v => v)
            .OrderByDescending(g => g.Count())
            .FirstOrDefault();
        return best?.Key;
    }

    private static string Digits(string s) => new(s.Where(char.IsDigit).ToArray());

    private static List<Query> ParseQueries(JsonElement args) => ScraperArgs.ParseArray(args, "queries", e =>
        new Query(
            ScraperArgs.Str(e, "name") ?? throw new ToolException(400, "每个 query 需要 name"),
            ScraperArgs.Str(e, "city"), ScraperArgs.Str(e, "claimedPhone"), ScraperArgs.Str(e, "claimedAddress")));

    // Japanese phone: +81-X-XXXX-XXXX / 0X-XXXX-XXXX etc.
    [GeneratedRegex(@"(?:\+81[-\s]?|0)\d{1,4}[-\s]\d{2,4}[-\s]\d{3,4}")] private static partial Regex PhoneRegex();
    [GeneratedRegex(@"[〒]?\b(\d{3}-\d{4})\b")] private static partial Regex PostalRegex();
    [GeneratedRegex(@"Tokyo|Osaka|Kyoto|Kobe|Nara|Chiyoda|Chuo|Minato|Shibuya|Shinjuku|Nakagyo|Naka-ku|Kita-ku|Otemachi|Umeda|Kawaramachi|Marunouchi|Ginza", RegexOptions.IgnoreCase)]
    private static partial Regex AddressKeywords();
    [GeneratedRegex(@"[都府県区市町]")] private static partial Regex JpAddress();
    [GeneratedRegex(@"check[\s-]?in[^\n]{0,40}?(\d{1,2}:\d{2})", RegexOptions.IgnoreCase)] private static partial Regex CheckInRegex();
    [GeneratedRegex(@"check[\s-]?out[^\n]{0,40}?(\d{1,2}:\d{2})", RegexOptions.IgnoreCase)] private static partial Regex CheckOutRegex();
}
