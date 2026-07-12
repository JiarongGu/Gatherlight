using System.Text.Json;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Tools.Services.Tools;

/// <summary>
/// JS-rendered page scraper — wraps the Node puppeteer leaf (tools/puppeteer/src/scrape.ts)
/// until the Playwright .NET port lands. Used for link verification: WebFetch can't execute
/// JS, so search deeplinks / SPA pages must be verified through a real browser.
/// </summary>
public sealed class ScrapeTool : NodeLeafTool
{
    private readonly string _leafDir;

    public ScrapeTool(IHostEnvironment env)
    {
        // The code repo root is the content root's location during `dotnet run`; walk up to find tools/.
        var dir = new DirectoryInfo(env.ContentRootPath);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "tools", "puppeteer")))
            dir = dir.Parent!;
        _leafDir = dir is not null ? Path.Combine(dir.FullName, "tools", "puppeteer") : "";
    }

    public override string Name => "scrape";

    public override string Description =>
        "用真实浏览器(headless)打开并渲染一个网页,返回其文本内容 — 用于校验 JS 渲染的链接(机票/酒店搜索深链接、SPA 页面)是否真的展示结果。";

    public override string InputSchema => ToolSchema.Of(b => b
        .Str("url", "要抓取的完整 URL", required: true)
        .Str("selector", "只提取匹配该 CSS 选择器的内容(可选)")
        .Str("waitFor", "等待该 CSS 选择器出现后再提取(可选,默认 body)")
        .Int("timeout", "导航超时毫秒数(默认 30000)"));

    protected override string LeafDirectory => _leafDir;

    protected override IEnumerable<string> BuildArgv(JsonElement args)
    {
        yield return "tsx";
        yield return "src/scrape.ts";
        yield return args.GetProperty("url").GetString()!;
        if (args.TryGetProperty("selector", out var sel) && sel.GetString() is { Length: > 0 } s)
        {
            yield return "--selector";
            yield return s;
        }
        var wait = args.TryGetProperty("waitFor", out var w) && w.GetString() is { Length: > 0 } wf ? wf : "body";
        yield return "--wait-for";
        yield return wait;
        if (args.TryGetProperty("timeout", out var t) && t.TryGetInt32(out var ms) && ms > 0)
        {
            yield return "--timeout";
            yield return ms.ToString();
        }
        yield return "--text";
    }
}
