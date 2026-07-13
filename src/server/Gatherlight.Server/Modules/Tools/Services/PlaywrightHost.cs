using Microsoft.Playwright;

namespace Gatherlight.Server.Modules.Tools.Services;

/// <summary>
/// One shared headless-chromium instance for all browser-backed tools (web_fetch, scrape ports).
/// Lazy: the browser launches on first use and is reused across calls — never at server startup
/// (most sessions never need a browser). Chosen over WebView2: no STA/window requirements in a
/// headless server, and a real automation API (waitForSelector, network, isolated contexts).
/// In the production bundle the Playwright driver ships as libs/.playwright (auto-resolved next to
/// the host exe) and Chromium as libs/browsers (pointed at via PLAYWRIGHT_BROWSERS_PATH below); in
/// dev they come from the per-user cache (`dev.mjs fetch-tools`).
/// </summary>
public interface IPlaywrightHost
{
    Task<IBrowser> GetBrowserAsync(CancellationToken ct = default);
}

public sealed class PlaywrightHost : IPlaywrightHost, IAsyncDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private IPlaywright? _playwright;
    private IBrowser? _browser;

    public async Task<IBrowser> GetBrowserAsync(CancellationToken ct = default)
    {
        if (_browser is { IsConnected: true }) return _browser;
        await _gate.WaitAsync(ct);
        try
        {
            if (_browser is { IsConnected: true }) return _browser;
            // Prefer a Chromium bundled next to the host (libs/browsers) so scraping needs no separate
            // install. Set before the driver spawns (CreateAsync); an explicit env var still wins.
            var bundledBrowsers = Path.Combine(AppContext.BaseDirectory, "browsers");
            if (Directory.Exists(bundledBrowsers) && string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PLAYWRIGHT_BROWSERS_PATH")))
                Environment.SetEnvironmentVariable("PLAYWRIGHT_BROWSERS_PATH", bundledBrowsers);
            _playwright ??= await Playwright.CreateAsync();
            _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
            {
                Headless = true,
            });
            return _browser;
        }
        catch (PlaywrightException ex) when (ex.Message.Contains("Executable doesn't exist"))
        {
            throw new InvalidOperationException(
                "Playwright chromium 未安装 — 运行一次 `node devtools/dev.mjs fetch-tools`。", ex);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_browser is not null) await _browser.DisposeAsync();
        _playwright?.Dispose();
    }
}
