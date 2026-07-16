using System.Text.Json;
using Gatherlight.Server.Modules.Tools.Services;
using Microsoft.Playwright;

namespace Gatherlight.Server.Modules.Scrapers.Services;

public sealed record PageResult(int Status, string FinalUrl, string Title, string Text, string H1 = "");

/// <summary>One anchor pulled off a page (resolved absolute href), for search-result scraping.</summary>
public sealed record ScrapedLink(string Text, string Href);

/// <summary>
/// Shared navigate-and-extract on the one headless chromium (via PlaywrightHost). The scraper
/// tools (flight_schedule, policy_check, hotel_info, …) build their site URLs and call this, then
/// run a deterministic parse over the returned text/links. One realistic browser context per fetch.
///
/// Test seam: when <c>GATHERLIGHT_FIXTURE_ORIGIN</c> is set, the actual navigation is rewritten to
/// <c>{origin}/{host}{path}{query}</c> so e2e can serve canned pages for arbitrary real domains
/// (tabelog.com, booking.com, …) off one local server, while tools still classify/report the
/// original URL. Absent = live sites, unchanged.
/// </summary>
public interface IPlaywrightScraper
{
    /// <summary>Navigate + return the page. On timeout/failure returns Status 0 and whatever text
    /// rendered (scrapers try several sources, so a miss is normal, not an error).</summary>
    Task<PageResult> FetchAsync(string url, string? waitForSelector = null, int timeoutMs = 30_000, CancellationToken ct = default);

    /// <summary>Navigate + return the resolved hrefs of the elements matching <paramref name="selector"/>
    /// (used for search-result pages). Empty on failure.</summary>
    Task<IReadOnlyList<ScrapedLink>> FetchLinksAsync(string url, string selector, int max = 15, int timeoutMs = 30_000, CancellationToken ct = default);
}

public sealed class PlaywrightScraper : IPlaywrightScraper
{
    private const string DesktopUa =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36";

    private readonly IPlaywrightHost _host;

    public PlaywrightScraper(IPlaywrightHost host) => _host = host;

    public async Task<PageResult> FetchAsync(string url, string? waitForSelector = null, int timeoutMs = 30_000, CancellationToken ct = default)
    {
        // Note: scraper tools build URLs from operator-configured GATHERLIGHT_BASE_* bases (the agent
        // supplies flight numbers / countries, not the host), so the SSRF guard lives on WebFetchTool
        // (the agent-supplied-URL surface), not here — else it would block legitimate loopback bases.
        var nav = ForNavigation(url);
        var browser = await _host.GetBrowserAsync(ct);
        var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            UserAgent = DesktopUa,
            Locale = "en-AU",
        });
        try
        {
            var page = await context.NewPageAsync();
            IResponse? response = null;
            try
            {
                response = await page.GotoAsync(nav, new PageGotoOptions
                {
                    WaitUntil = WaitUntilState.DOMContentLoaded,
                    Timeout = timeoutMs,
                });
                if (waitForSelector is not null)
                {
                    try { await page.WaitForSelectorAsync(waitForSelector, new() { Timeout = timeoutMs }); }
                    catch (TimeoutException) { }
                }
                else
                {
                    try { await page.WaitForLoadStateAsync(LoadState.NetworkIdle, new() { Timeout = 6_000 }); }
                    catch (TimeoutException) { }
                }
            }
            catch (TimeoutException) { /* return whatever rendered */ }
            catch (PlaywrightException) { return new PageResult(0, url, "", ""); }

            var title = await SafeAsync(() => page.TitleAsync(), "");
            var text = await SafeAsync(async () =>
            {
                var el = await page.QuerySelectorAsync("body");
                return el is not null ? (await el.InnerTextAsync()).Trim() : "";
            }, "");
            var h1 = await SafeAsync(async () =>
            {
                var el = await page.QuerySelectorAsync("h1");
                return el is not null ? (await el.InnerTextAsync()).Trim() : "";
            }, "");
            // Hide the fixture URL from callers — report the URL they asked for.
            var finalUrl = nav != url ? url : page.Url;
            return new PageResult(response?.Status ?? 0, finalUrl, title, text, h1);
        }
        finally
        {
            await context.DisposeAsync();
        }
    }

    public async Task<IReadOnlyList<ScrapedLink>> FetchLinksAsync(string url, string selector, int max = 15, int timeoutMs = 30_000, CancellationToken ct = default)
    {
        var nav = ForNavigation(url);
        var browser = await _host.GetBrowserAsync(ct);
        var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            UserAgent = DesktopUa,
            Locale = "en-AU",
        });
        try
        {
            var page = await context.NewPageAsync();
            try
            {
                await page.GotoAsync(nav, new PageGotoOptions { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = timeoutMs });
            }
            catch (TimeoutException) { }
            catch (PlaywrightException) { return Array.Empty<ScrapedLink>(); }

            var json = await SafeAsync(() => page.EvalOnSelectorAllAsync<JsonElement>(selector,
                "(els, max) => els.slice(0, max).map(el => ({ text: (el.textContent || '').trim(), href: el.href || el.getAttribute('href') || '' }))",
                max), default);
            var list = new List<ScrapedLink>();
            if (json.ValueKind == JsonValueKind.Array)
                foreach (var e in json.EnumerateArray())
                    list.Add(new ScrapedLink(
                        e.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "",
                        e.TryGetProperty("href", out var h) ? h.GetString() ?? "" : ""));
            return list;
        }
        finally
        {
            await context.DisposeAsync();
        }
    }

    /// <summary>Fixture rewrite (test only). Live: returns the URL unchanged.</summary>
    private static string ForNavigation(string url)
    {
        var origin = Environment.GetEnvironmentVariable("GATHERLIGHT_FIXTURE_ORIGIN");
        if (string.IsNullOrEmpty(origin) || !Uri.TryCreate(url, UriKind.Absolute, out var u)) return url;
        return $"{origin.TrimEnd('/')}/{u.Host}{u.AbsolutePath}{u.Query}";
    }

    private static async Task<T> SafeAsync<T>(Func<Task<T>> fn, T fallback)
    {
        try { return await fn(); } catch { return fallback; }
    }
}
