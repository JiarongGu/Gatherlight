using Gatherlight.Server.Modules.Tools.Services;
using Microsoft.Playwright;

namespace Gatherlight.Server.Modules.Scrapers.Services;

public sealed record PageResult(int Status, string FinalUrl, string Title, string Text);

/// <summary>
/// Shared navigate-and-extract on the one headless chromium (via PlaywrightHost). The scraper
/// tools (flight_schedule, policy_check, …) build their site URLs and call this, then run a
/// deterministic parse over the returned text. One realistic browser context per fetch.
/// </summary>
public interface IPlaywrightScraper
{
    /// <summary>Navigate + return the page. On timeout/failure returns Status 0 and whatever text
    /// rendered (scrapers try several sources, so a miss is normal, not an error).</summary>
    Task<PageResult> FetchAsync(string url, string? waitForSelector = null, int timeoutMs = 30_000, CancellationToken ct = default);
}

public sealed class PlaywrightScraper : IPlaywrightScraper
{
    private const string DesktopUa =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36";

    private readonly IPlaywrightHost _host;

    public PlaywrightScraper(IPlaywrightHost host) => _host = host;

    public async Task<PageResult> FetchAsync(string url, string? waitForSelector = null, int timeoutMs = 30_000, CancellationToken ct = default)
    {
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
                response = await page.GotoAsync(url, new PageGotoOptions
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
            return new PageResult(response?.Status ?? 0, page.Url, title, text);
        }
        finally
        {
            await context.DisposeAsync();
        }
    }

    private static async Task<T> SafeAsync<T>(Func<Task<T>> fn, T fallback)
    {
        try { return await fn(); } catch { return fallback; }
    }
}
