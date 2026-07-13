using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Gatherlight.Server.Modules.Scrapers.Services;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Scrapers.Tools;

/// <summary>
/// C#/Playwright port of the flight-schedule verifier: fetches the actual schedule for a carrier +
/// flight number from FlightAware + FlightStats and cross-checks any claimed time/route. Catches
/// fabricated carrier codes (the incident: "IZ313" claimed for Spring Japan, whose real code is
/// IJ — IZ is Arkia Israeli). Navigation via the shared browser; parse is deterministic + tested.
/// </summary>
public sealed partial class FlightScheduleScraperTool : IGatherlightTool
{
    private readonly IPlaywrightScraper _scraper;

    public FlightScheduleScraperTool(IPlaywrightScraper scraper) => _scraper = scraper;

    public string Name => "flight_schedule";
    public string Description =>
        "核验航班时刻:给定承运人 IATA 代码 + 航班号,从 FlightAware + FlightStats 抓取实际出发/到达时间与航线,并与声称值交叉核对。能发现编造的承运人代码。写入计划前必须核验。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("carrierIATA", "承运人 IATA 代码(如 JQ / QF / IJ)", required: true)
        .Str("flightNumber", "航班号数字部分(如 17)", required: true)
        .Str("claimedDepartTime", "声称的出发时间 HH:MM(可选,用于核对)")
        .Str("claimedOrigin", "声称的出发地 IATA(可选)")
        .Str("claimedDest", "声称的目的地 IATA(可选)"));

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var carrier = args.GetProperty("carrierIATA").GetString()?.Trim().ToUpperInvariant() ?? "";
        var num = args.GetProperty("flightNumber").GetString()?.Trim() ?? "";
        if (carrier.Length == 0 || num.Length == 0) throw new ToolException(400, "carrierIATA 和 flightNumber 必填");
        var claimedDepart = ScraperArgs.Str(args, "claimedDepartTime");
        var claimedOrigin = ScraperArgs.Str(args, "claimedOrigin");
        var claimedDest = ScraperArgs.Str(args, "claimedDest");

        var sources = new JsonArray();
        var faUrl = $"{ScraperBases.FlightAware}/live/flight/{carrier}{num}";
        var fa = await _scraper.FetchAsync(faUrl, timeoutMs: 30_000, ct: ct);
        var faSource = ParseFlightAware(fa.Text, fa.Title);
        if (faSource is not null) sources.Add(SourceNode("flightaware.com", faUrl, faSource));

        var fsUrl = $"{ScraperBases.FlightStats}/v2/flight-tracker/{carrier}/{num}";
        var fs = await _scraper.FetchAsync(fsUrl, timeoutMs: 30_000, ct: ct);
        var fsSource = ParseFlightStats(fs.Text);
        if (fsSource is not null) sources.Add(SourceNode("flightstats.com", fsUrl, fsSource));

        var actualDepart = First(faSource?.DepartTime, fsSource?.DepartTime);
        var actualArrive = First(faSource?.ArriveTime, fsSource?.ArriveTime);
        var actualOrigin = First(faSource?.Origin, fsSource?.Origin);
        var actualDest = First(faSource?.Dest, fsSource?.Dest);

        bool? timeMatch = claimedDepart is not null && actualDepart is not null
            ? ParseTime(claimedDepart) == actualDepart : null;
        bool? originMatch = claimedOrigin is not null && actualOrigin is not null
            ? string.Equals(claimedOrigin, actualOrigin, StringComparison.OrdinalIgnoreCase) : null;
        bool? destMatch = claimedDest is not null && actualDest is not null
            ? string.Equals(claimedDest, actualDest, StringComparison.OrdinalIgnoreCase) : null;
        var checks = new[] { timeMatch, originMatch, destMatch }.Where(x => x is not null).Select(x => x!.Value).ToList();

        return new JsonObject
        {
            ["query"] = new JsonObject { ["carrierIATA"] = carrier, ["flightNumber"] = num },
            ["flightAwareUrl"] = faUrl,
            ["actualOrigin"] = actualOrigin,
            ["actualDest"] = actualDest,
            ["actualDepartTime"] = actualDepart,
            ["actualArriveTime"] = actualArrive,
            ["claimedMatches"] = new JsonObject
            {
                ["time"] = timeMatch, ["origin"] = originMatch, ["dest"] = destMatch,
                ["all"] = checks.Count > 0 ? checks.All(x => x) : null,
            },
            ["sources"] = sources,
            ["notes"] = $"sources={sources.Count}; flightaware={(faSource is null ? "miss" : "ok")}; flightstats={(fsSource is null ? "miss" : "ok")}",
            ["scrapedAt"] = DateTime.UtcNow.ToString("o"),
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }

    internal sealed record Src(string? DepartTime, string? ArriveTime, string? Origin, string? Dest);

    internal static Src? ParseFlightAware(string text, string title)
    {
        if (text.Length == 0 || NotFoundRegex().IsMatch(text) || NotFoundRegex().IsMatch(title)) return null;
        var dep = ParseTime(FaDepartRegex().Match(text) is { Success: true } m ? m.Groups[1].Value : null);
        var arr = ParseTime(FaArriveRegex().Match(text) is { Success: true } m2 ? m2.Groups[1].Value : null);
        var route = RouteRegex().Match(text);
        // A source needs at least one real data point (a time or a route) — the flight number
        // merely appearing in the page text (incl. a "not found" message) is not a hit.
        if (dep is null && arr is null && !route.Success) return null;
        return new Src(dep, arr,
            route.Success ? route.Groups[1].Value : null,
            route.Success ? route.Groups[2].Value : null);
    }

    internal static Src? ParseFlightStats(string text)
    {
        if (text.Length == 0 || NotFoundRegex().IsMatch(text)) return null;
        var dep = ParseTime(FsDepartRegex().Match(text) is { Success: true } m ? m.Groups[1].Value : null);
        var arr = ParseTime(FsArriveRegex().Match(text) is { Success: true } m2 ? m2.Groups[1].Value : null);
        if (dep is null && arr is null) return null;
        return new Src(dep, arr, null, null);
    }

    internal static string? ParseTime(string? s)
    {
        if (s is null) return null;
        var m = TimeRegex().Match(s);
        return m.Success ? $"{m.Groups[1].Value.PadLeft(2, '0')}:{m.Groups[2].Value}" : null;
    }

    private static JsonObject SourceNode(string domain, string url, Src s) => new()
    {
        ["domain"] = domain, ["url"] = url,
        ["departTime"] = s.DepartTime, ["arriveTime"] = s.ArriveTime, ["origin"] = s.Origin, ["dest"] = s.Dest,
    };

    private static string? First(string? a, string? b) => !string.IsNullOrEmpty(a) ? a : (!string.IsNullOrEmpty(b) ? b : null);

    [GeneratedRegex(@"Departure[^\d]{0,40}(\d{1,2}:\d{2})", RegexOptions.IgnoreCase)]
    private static partial Regex FaDepartRegex();
    [GeneratedRegex(@"Arrival[^\d]{0,40}(\d{1,2}:\d{2})", RegexOptions.IgnoreCase)]
    private static partial Regex FaArriveRegex();
    // FlightAware shows the route as "NRT / RJAA - PEK / ZBAA" (IATA / ICAO pairs). Capture each
    // pair's leading 3-letter IATA code. Fall back handled by the caller (route optional).
    [GeneratedRegex(@"\b([A-Z]{3})\s*/\s*[A-Z]{4}\b.{0,80}?\b([A-Z]{3})\s*/\s*[A-Z]{4}\b", RegexOptions.Singleline)]
    private static partial Regex RouteRegex();
    [GeneratedRegex(@"flight not found|no flight|404", RegexOptions.IgnoreCase)]
    private static partial Regex NotFoundRegex();
    [GeneratedRegex(@"Departure[^\n]{0,80}?(\d{1,2}:\d{2})", RegexOptions.IgnoreCase)]
    private static partial Regex FsDepartRegex();
    [GeneratedRegex(@"Arrival[^\n]{0,80}?(\d{1,2}:\d{2})", RegexOptions.IgnoreCase)]
    private static partial Regex FsArriveRegex();
    [GeneratedRegex(@"(\d{1,2}):(\d{2})")]
    private static partial Regex TimeRegex();
}
