using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Gatherlight.Server.Modules.Scrapers.Services;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Scrapers.Tools;

/// <summary>
/// C#/Playwright port of the multi-date flight price comparison (Kayak.com.au, AUD). Kayak's
/// `/flights/&lt;O&gt;-&lt;D&gt;/&lt;date&gt;/&lt;date&gt;` URL SSRs usable prices where Skyscanner's SPA blocks the
/// scraper. Returns the cheapest plausible price per date pair — indicative, verify before booking.
/// </summary>
public sealed partial class FlightPricesScraperTool : IGatherlightTool
{
    private readonly IPlaywrightScraper _scraper;

    public FlightPricesScraperTool(IPlaywrightScraper scraper) => _scraper = scraper;

    public string Name => "flight_prices";
    public string Description =>
        "多日期机票比价(往返城市对,可附加多组日期)。返回各日期组合的最低价快照 — 引用时带抓取日期。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("origin", "出发地 IATA,如 SYD", required: true)
        .Str("dest", "目的地 IATA,如 KIX", required: true)
        .Str("depart", "去程 YYYY-MM-DD", required: true)
        .Str("return", "回程 YYYY-MM-DD", required: true)
        .Str("also", "附加日期组,格式 D1:D2 逗号分隔(可选)")
        .Bool("nonStop", "只看直飞(可选)"));

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var origin = (args.GetProperty("origin").GetString()?.Trim() ?? "").ToUpperInvariant();
        var dest = (args.GetProperty("dest").GetString()?.Trim() ?? "").ToUpperInvariant();
        var depart = args.GetProperty("depart").GetString()?.Trim() ?? "";
        var ret = args.GetProperty("return").GetString()?.Trim() ?? "";
        if (origin.Length == 0 || dest.Length == 0 || depart.Length == 0 || ret.Length == 0)
            throw new ToolException(400, "origin / dest / depart / return 必填");
        var nonStop = args.TryGetProperty("nonStop", out var ns) && ns.ValueKind == JsonValueKind.True;

        var pairs = new List<(string Depart, string Return)> { (depart, ret) };
        if (args.TryGetProperty("also", out var alsoEl) && alsoEl.GetString() is { Length: > 0 } also)
            foreach (var chunk in also.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
            {
                var dd = chunk.Split(':', 2);
                if (dd.Length == 2 && dd[0].Length > 0 && dd[1].Length > 0) pairs.Add((dd[0], dd[1]));
            }

        var rows = new JsonArray();
        foreach (var (d1, d2) in pairs)
        {
            var url = KayakUrl(origin, dest, d1, d2, nonStop);
            var page = await _scraper.FetchAsync(url, waitForSelector: null, timeoutMs: 45_000, ct: ct);
            var (price, notes) = ParsePrice(page.Text, page.Title);
            rows.Add(new JsonObject
            {
                ["depart"] = d1,
                ["return"] = d2,
                ["cheapestAUD"] = price,
                ["notes"] = notes,
                ["url"] = url,
            });
        }

        return new JsonObject
        {
            ["origin"] = origin,
            ["destination"] = dest,
            ["currency"] = "AUD",
            ["source"] = $"Kayak.com.au (economy, 1 adult{(nonStop ? ", non-stop only" : "")})",
            ["rows"] = rows,
            ["note"] = "Indicative prices — verify on Kayak before booking.",
            ["scrapedAt"] = DateTime.UtcNow.ToString("o"),
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }

    internal static string KayakUrl(string origin, string dest, string depart, string ret, bool nonStop)
    {
        var url = $"{ScraperBases.Kayak}/flights/{origin}-{dest}/{depart}/{ret}";
        return nonStop ? $"{url}?fs=stops%3D~0" : url;
    }

    /// <summary>Cheapest plausible AUD figure on the page (200..20000), or null with a reason.</summary>
    internal static (int? Price, string Notes) ParsePrice(string text, string title)
    {
        if (text.Length == 0) return (null, $"empty page (title={Trunc(title, 60)})");
        if (CaptchaRegex().IsMatch(title)) return (null, "CAPTCHA hit — verify manually on site");

        var prices = new List<int>();
        foreach (var re in new[] { AUDollarRegex(), AUDCodeRegex(), PlainDollarRegex() })
            foreach (Match m in re.Matches(text))
            {
                var n = ToInt(m.Groups[1].Value);
                if (n is >= 200 and <= 20000) prices.Add(n.Value);
            }
        if (prices.Count == 0) return (null, $"No prices parsed (title={Trunc(title, 60)})");
        return (prices.Min(), $"cheapest of {prices.Count} prices on page");
    }

    private static int? ToInt(string raw)
    {
        var digits = new string(raw.Where(char.IsDigit).ToArray());
        return int.TryParse(digits, out var n) ? n : null;
    }

    private static string Trunc(string s, int n) => s.Length <= n ? s : s[..n];

    [GeneratedRegex(@"captcha|verify|robot|are you human", RegexOptions.IgnoreCase)] private static partial Regex CaptchaRegex();
    [GeneratedRegex(@"A\$\s?([\d,]+)")] private static partial Regex AUDollarRegex();
    [GeneratedRegex(@"AUD\s*\$?\s*([\d,]+)", RegexOptions.IgnoreCase)] private static partial Regex AUDCodeRegex();
    [GeneratedRegex(@"\$\s?([\d,]+)(?!\s*USD)")] private static partial Regex PlainDollarRegex();
}
