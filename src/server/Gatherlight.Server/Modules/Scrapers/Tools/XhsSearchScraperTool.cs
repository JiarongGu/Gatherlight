using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Gatherlight.Server.Modules.Scrapers.Services;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Scrapers.Tools;

/// <summary>
/// Searches Xiaohongshu (小红书) for a keyword in the shared headless browser and returns the visible
/// note results (title/summary + link). Exists so the PLANNER never has to author + run its own
/// scraper skill — the scope-guard jail blocks that anyway, and "out-of-boundary → MCP" means web work
/// goes through a server-mediated tool. Best-effort: XHS gates much of its content behind login, so
/// this returns whatever is publicly visible and flags when the page looks login-walled. Deterministic
/// extraction (anchor hrefs via <see cref="IPlaywrightScraper.FetchLinksAsync"/> + a text tidy), so
/// e2e can point <c>GATHERLIGHT_BASE_XHS</c> at a fixture and verify the parse.
/// </summary>
public sealed partial class XhsSearchScraperTool : IGatherlightTool
{
    private readonly IPlaywrightScraper _scraper;

    public XhsSearchScraperTool(IPlaywrightScraper scraper) => _scraper = scraper;

    public string Name => "xhs_search";

    public string Description =>
        "在小红书(xiaohongshu.com)搜索关键词,返回可见的笔记结果(标题/摘要 + 链接),用于查找旅行 / 餐厅 / 亲子 / 攻略灵感。" +
        "best-effort:小红书大量内容需登录,未登录时只返回公开可见部分并给出提示。参数:query(必填)、limit(默认 10,上限 30)。";

    public string InputSchema => ToolSchema.Of(b => b
        .Str("query", "搜索关键词(如「京都 亲子 三日」)", required: true)
        .Int("limit", "最多返回多少条(默认 10,上限 30)"));

    private sealed record Args(string? Query, int? Limit);

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var a = ToolArgs.Parse<Args>(args);
        var query = ToolArgs.Req(a.Query, "query");
        var limit = a.Limit is { } n && n > 0 ? Math.Min(n, 30) : 10;
        var url = $"{ScraperBases.Xhs}/search_result?keyword={Uri.EscapeDataString(query)}";

        // Note cards on the search page link to /explore/<id> or /search_result/<id>; grab those anchors.
        // Ask for extra so dedup (multiple anchors per card) still yields `limit` distinct notes.
        IReadOnlyList<ScrapedLink> links;
        try
        {
            links = await _scraper.FetchLinksAsync(url,
                "a[href*='/explore/'], a[href*='/search_result/']", max: limit * 3, timeoutMs: 30_000, ct: ct);
        }
        catch (Exception ex)
        {
            throw new ToolException(504, $"小红书搜索失败({query}):{ex.Message}");
        }

        var notes = new JsonArray();
        var seen = new HashSet<string>();
        foreach (var link in links)
        {
            var id = link.Href.Split('?')[0].TrimEnd('/');
            if (id.Length == 0 || !seen.Add(id)) continue;
            var title = Whitespace().Replace(link.Text, " ").Trim();
            if (title.Length > 140) title = title[..140];
            notes.Add(new JsonObject { ["title"] = title.Length > 0 ? title : null, ["url"] = id });
            if (notes.Count >= limit) break;
        }

        var loginWalled = notes.Count == 0;
        return new JsonObject
        {
            ["source"] = "gatherlight/xhs_search (C#/Playwright)",
            ["scrapeTime"] = DateTime.UtcNow.ToString("o"),
            ["query"] = query,
            ["url"] = url,
            ["count"] = notes.Count,
            ["notes"] = notes,
            ["loginWalled"] = loginWalled,
            ["hint"] = loginWalled
                ? "未取到公开笔记 — 小红书搜索页通常需要登录或触发了风控;可让用户在浏览器登录后手动查看,或换更宽泛的关键词。"
                : null,
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }

    [GeneratedRegex(@"\s+")] private static partial Regex Whitespace();
}
