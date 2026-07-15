namespace Gatherlight.Server.Modules.Scrapers.Services;

/// <summary>
/// Base URLs for the scraper tools, each overridable by an env var so e2e can point them at a
/// local fixture server and test the full navigate+parse path deterministically (no live sites).
/// </summary>
public static class ScraperBases
{
    public static string FlightAware => Env("GATHERLIGHT_BASE_FLIGHTAWARE", "https://www.flightaware.com");
    public static string FlightStats => Env("GATHERLIGHT_BASE_FLIGHTSTATS", "https://www.flightstats.com");
    public static string Mofa => Env("GATHERLIGHT_BASE_MOFA", "https://www.mofa.go.jp");
    public static string DuckDuckGo => Env("GATHERLIGHT_BASE_DDG", "https://html.duckduckgo.com");
    public static string Kayak => Env("GATHERLIGHT_BASE_KAYAK", "https://www.kayak.com.au");
    public static string Booking => Env("GATHERLIGHT_BASE_BOOKING", "https://www.booking.com");
    public static string Xhs => Env("GATHERLIGHT_BASE_XHS", "https://www.xiaohongshu.com");

    private static string Env(string key, string def) =>
        Environment.GetEnvironmentVariable(key) is { Length: > 0 } v ? v.TrimEnd('/') : def;
}
