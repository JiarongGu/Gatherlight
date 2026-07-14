using Gatherlight.Server.Modules.Core.Services;
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
    private readonly IDataContext _data;
    private IPlaywright? _playwright;
    private IBrowser? _browser;

    public PlaywrightHost(IDataContext data) => _data = data;

    public async Task<IBrowser> GetBrowserAsync(CancellationToken ct = default)
    {
        if (_browser is { IsConnected: true }) return _browser;
        await _gate.WaitAsync(ct);
        try
        {
            if (_browser is { IsConnected: true }) return _browser;
            // Chromium is provisioned at setup into the data folder ({data}/state/resources/browsers);
            // prefer that, then a copy bundled next to the host (libs/browsers), else the per-user cache.
            // Set before the driver spawns (CreateAsync); an explicit env var still wins.
            var provisioned = Path.Combine(_data.ResourcesPath, "browsers");
            var bundled = Path.Combine(AppContext.BaseDirectory, "browsers");
            var browsers = Directory.Exists(provisioned) ? provisioned : Directory.Exists(bundled) ? bundled : null;
            if (browsers is not null && string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PLAYWRIGHT_BROWSERS_PATH")))
                Environment.SetEnvironmentVariable("PLAYWRIGHT_BROWSERS_PATH", browsers);
            // Driver: if provisioned into the data folder, point Playwright there via
            // PLAYWRIGHT_DRIVER_SEARCH_PATH (it appends `.playwright`, so pass the PARENT). Only when the
            // driver is actually present — this var has no fallback, so a wrong path would throw. Absent
            // it, Playwright's default resolution finds a driver bundled next to the exe (dev / --offline).
            var provDriver = Path.Combine(_data.ResourcesPath, ".playwright", "node", "win32_x64", "node.exe");
            if (File.Exists(provDriver) && string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PLAYWRIGHT_DRIVER_SEARCH_PATH")))
                Environment.SetEnvironmentVariable("PLAYWRIGHT_DRIVER_SEARCH_PATH", _data.ResourcesPath);
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
                "Chromium 未安装 — 在管理台「资源 · Resources」中下载(或 dev: `node devtools/dev.mjs fetch-tools`)。", ex);
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
