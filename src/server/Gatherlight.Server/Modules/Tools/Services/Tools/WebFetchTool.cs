using System.Text.Json;
using System.Text.Json.Nodes;
using Gatherlight.Server.Modules.Tools.Models;
using Microsoft.Playwright;

namespace Gatherlight.Server.Modules.Tools.Services.Tools;

/// <summary>
/// Renders a page in a real headless browser and returns its text — the JS-executing WebFetch.
/// This is the C#-native replacement for the Node puppeteer scrape leaf: search deeplinks and
/// SPA pages can only be verified through a real browser (plain HTTP fetch sees the empty shell
/// and reports false positives — the incident that created the link-verification rule).
/// </summary>
public sealed class WebFetchTool : IGatherlightTool
{
    private readonly IPlaywrightHost _host;

    public WebFetchTool(IPlaywrightHost host) => _host = host;

    public string Name => "scrape";

    public string Description =>
        "用真实 headless 浏览器打开并渲染网页(执行 JS),返回标题 + 文本内容。用于校验 JS 渲染的链接(机票/酒店搜索深链接、SPA)是否真的展示结果 — 普通 HTTP 抓取会误报。";

    public string InputSchema => ToolSchema.Of(b => b
        .Str("url", "要打开的完整 URL", required: true)
        .Str("selector", "只提取匹配该 CSS 选择器的文本(可选,默认整页 body)")
        .Str("waitFor", "等待该 CSS 选择器出现后再提取(可选)")
        .Int("timeout", "导航超时毫秒数(默认 30000,上限 60000)"));

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var url = ToolArgs.Req(args, "url");
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
            throw new ToolException(400, $"无效 URL:{url}");
        var selector = ToolArgs.Str(args, "selector") ?? "body";
        var waitFor = ToolArgs.Str(args, "waitFor");
        var timeout = args.TryGetProperty("timeout", out var t) && t.TryGetInt32(out var ms) && ms > 0
            ? Math.Min(ms, 60_000) : 30_000;

        var browser = await _host.GetBrowserAsync(ct);
        var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36",
            Locale = "en-AU",
        });
        try
        {
            var page = await context.NewPageAsync();
            var response = await page.GotoAsync(url, new PageGotoOptions
            {
                WaitUntil = WaitUntilState.DOMContentLoaded,
                Timeout = timeout,
            });
            if (waitFor is not null)
            {
                try { await page.WaitForSelectorAsync(waitFor, new PageWaitForSelectorOptions { Timeout = timeout }); }
                catch (TimeoutException) { /* report what rendered anyway */ }
            }
            else
            {
                // Give SPAs a beat to hydrate after DOMContentLoaded.
                try { await page.WaitForLoadStateAsync(LoadState.NetworkIdle, new PageWaitForLoadStateOptions { Timeout = 8_000 }); }
                catch (TimeoutException) { /* busy pages never go idle — proceed */ }
            }

            var title = await page.TitleAsync();
            string text;
            var el = await page.QuerySelectorAsync(selector);
            text = el is not null ? (await el.InnerTextAsync()).Trim() : "";
            const int cap = 20_000;
            var truncated = text.Length > cap;
            if (truncated) text = text[..cap];

            return new JsonObject
            {
                ["url"] = url,
                ["finalUrl"] = page.Url,
                ["status"] = response?.Status,
                ["title"] = title,
                ["text"] = text,
                ["truncated"] = truncated,
                ["fetchedAt"] = DateTime.UtcNow.ToString("o"),
            }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
        }
        catch (TimeoutException)
        {
            throw new ToolException(504, $"页面加载超时:{url}");
        }
        finally
        {
            await context.DisposeAsync();
        }
    }
}
