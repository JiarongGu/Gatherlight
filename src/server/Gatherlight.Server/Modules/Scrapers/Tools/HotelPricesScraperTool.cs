using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Gatherlight.Server.Modules.Scrapers.Services;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Scrapers.Tools;

/// <summary>
/// C#/Playwright port of the hotel price scraper (Booking.com search results, AUD). Booking ranks
/// the named hotel first and prints the TOTAL for the stay; we locate the name in the results text
/// and take the first plausible price after it, dividing by nights for an indicative per-night rate.
/// </summary>
public sealed partial class HotelPricesScraperTool : IGatherlightTool
{
    private readonly IPlaywrightScraper _scraper;

    public HotelPricesScraperTool(IPlaywrightScraper scraper) => _scraper = scraper;

    public string Name => "hotel_prices";
    public string Description =>
        "批量酒店房价查询(按酒店名 + 入退房日期 + 人数)。返回价格快照 — 引用时带抓取日期。queries 为 JSON 数组:[{\"name\":\"…\",\"checkin\":\"YYYY-MM-DD\",\"checkout\":\"YYYY-MM-DD\",\"guests\":3}]。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("queries", "JSON 数组:[{name, checkin, checkout, guests?}]", required: true));

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var stays = ParseStays(args);
        var rows = new JsonArray();
        foreach (var s in stays)
        {
            var nights = Nights(s.Checkin, s.Checkout);
            var url = BookingUrl(s);
            var page = await _scraper.FetchAsync(url, waitForSelector: null, timeoutMs: 45_000, ct: ct);
            var (perNight, notes) = ParsePrice(page.Text, page.Title, s.Name, nights);
            rows.Add(new JsonObject
            {
                ["name"] = s.Name,
                ["checkin"] = s.Checkin,
                ["checkout"] = s.Checkout,
                ["nights"] = nights,
                ["cheapestPerNight"] = perNight,
                ["totalAUD"] = perNight is not null && nights > 0 ? perNight * nights : null,
                ["notes"] = notes,
                ["url"] = url,
            });
        }

        return new JsonObject
        {
            ["currency"] = "AUD",
            ["source"] = "Booking.com (search results)",
            ["rows"] = rows,
            ["note"] = "Indicative per-night = total / nights. Verify on Booking before booking.",
            ["scrapedAt"] = DateTime.UtcNow.ToString("o"),
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }

    internal sealed record Stay(string Name, string Checkin, string Checkout, int Guests);

    private static List<Stay> ParseStays(JsonElement args)
    {
        var raw = args.GetProperty("queries").GetString() ?? "";
        JsonDocument doc;
        try { doc = JsonDocument.Parse(raw); }
        catch (JsonException) { throw new ToolException(400, "queries 必须是合法 JSON"); }
        using (doc)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Array) throw new ToolException(400, "queries 必须是 JSON 数组");
            var stays = new List<Stay>();
            foreach (var e in doc.RootElement.EnumerateArray())
            {
                var name = Str(e, "name");
                var ci = Str(e, "checkin");
                var co = Str(e, "checkout");
                if (name is null || ci is null || co is null)
                    throw new ToolException(400, "每个 stay 需要 name / checkin / checkout");
                var guests = e.TryGetProperty("guests", out var g) && g.TryGetInt32(out var gi) ? gi : 3;
                stays.Add(new Stay(name, ci, co, guests));
            }
            if (stays.Count == 0) throw new ToolException(400, "queries 为空");
            return stays;
        }
    }

    internal static string BookingUrl(Stay s) =>
        $"{ScraperBases.Booking}/searchresults.html?ss={Uri.EscapeDataString(s.Name)}" +
        $"&checkin={s.Checkin}&checkout={s.Checkout}&group_adults={s.Guests}&no_rooms=1&selected_currency=AUD";

    internal static int Nights(string checkin, string checkout)
    {
        if (DateTime.TryParse(checkin, CultureInfo.InvariantCulture, DateTimeStyles.None, out var a) &&
            DateTime.TryParse(checkout, CultureInfo.InvariantCulture, DateTimeStyles.None, out var b))
            return Math.Max(0, (int)Math.Round((b - a).TotalDays));
        return 0;
    }

    /// <summary>First plausible AUD total appearing after the hotel name → per-night = total/nights.</summary>
    internal static (int? PerNight, string Notes) ParsePrice(string text, string title, string hotelName, int nights)
    {
        if (text.Length == 0) return (null, $"empty page (title={Trunc(title, 60)})");
        if (BlockedRegex().IsMatch(title)) return (null, $"Blocked (title={Trunc(title, 60)})");
        if (nights <= 0) return (null, "invalid nights (checkin/checkout unparseable)");

        var idx = text.IndexOf(hotelName, StringComparison.OrdinalIgnoreCase);
        if (idx < 0) return (null, $"Hotel \"{hotelName}\" not on first results page");

        // Strip filter-range noise ("AUD 60 - AUD 900+") before taking the first real price.
        var window = text.Substring(idx, Math.Min(1500, text.Length - idx));
        window = RangeRegex().Replace(window, "");
        var m = AudRegex().Match(window);
        var parser = "first price after hotel name";
        if (!m.Success) { m = PlainDollarRegex().Match(window); parser = "fallback plain $"; }
        if (!m.Success) return (null, "Hotel name found but no price within 1500 chars after");

        var total = ToInt(m.Groups[1].Value);
        if (total is not (>= 50 and <= 30000)) return (null, $"Implausible price {total}");
        return ((int)Math.Round(total.Value / (double)nights), $"total {total} AUD over {nights} nights ({parser})");
    }

    private static int? ToInt(string raw)
    {
        var digits = new string(raw.Where(char.IsDigit).ToArray());
        return int.TryParse(digits, out var n) ? n : null;
    }

    private static string? Str(JsonElement e, string key) =>
        e.TryGetProperty(key, out var v) && v.GetString() is { Length: > 0 } s ? s : null;

    private static string Trunc(string s, int n) => s.Length <= n ? s : s[..n];

    [GeneratedRegex(@"captcha|access denied|verify|are you human|blocked", RegexOptions.IgnoreCase)] private static partial Regex BlockedRegex();
    [GeneratedRegex(@"AUD\s?\d+\s*-\s*AUD\s?\d+\+?", RegexOptions.IgnoreCase)] private static partial Regex RangeRegex();
    [GeneratedRegex(@"(?:AU?\$|AUD\s?)\s?([\d,]+)", RegexOptions.IgnoreCase)] private static partial Regex AudRegex();
    [GeneratedRegex(@"\$\s?([\d,]+)")] private static partial Regex PlainDollarRegex();
}
