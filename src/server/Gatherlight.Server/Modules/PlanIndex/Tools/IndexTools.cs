using System.Text.Json;
using System.Text.Json.Nodes;
using Gatherlight.Server.Modules.PlanIndex.Services;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.PlanIndex.Tools;

/// <summary>
/// Agent-facing navigation of the plan index. The markdown-native <c>plans/INDEX.md</c> is the
/// human-readable table of contents; these MCP tools are its programmatic twin, kept in sync with it
/// by the server — so the agent lists/searches plans through calls instead of crawling the folder.
/// </summary>
public sealed class IndexListTool : IGatherlightTool
{
    private readonly IPlanIndexService _index;
    public IndexListTool(IPlanIndexService index) => _index = index;

    public string Name => "index_list";
    public string Description =>
        "列出计划索引里的条目(计划 / 家庭 / 知识库),可按类别过滤。这是 plans/INDEX.md 的程序化视图 —— 用它总览,而不是遍历文件夹。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("category", "限定类别(可选):Trips / Daily / Weekly / Budgets / Packing / Visa …")
        .Int("limit", "最多返回条数(默认 200)"));

    public Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var category = ToolArgs.Str(args, "category");
        var items = _index.List()
            .Where(e => category is null || string.Equals(e.Category, category, StringComparison.OrdinalIgnoreCase))
            .Take(ToolArgs.Int(args, "limit", 200)).ToList();
        return Task.FromResult(Render(items));
    }

    internal static string Render(IReadOnlyList<PlanIndexEntry> items)
    {
        var arr = new JsonArray();
        foreach (var e in items)
            arr.Add(new JsonObject
            {
                ["path"] = e.Path, ["category"] = e.Category, ["name"] = e.Name,
                ["title"] = e.Title, ["date"] = e.PlanDate, ["updatedAt"] = e.UpdatedAt,
            });
        return new JsonObject { ["count"] = items.Count, ["items"] = arr }
            .ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }
}

public sealed class IndexSearchTool : IGatherlightTool
{
    private readonly IPlanIndexService _index;
    public IndexSearchTool(IPlanIndexService index) => _index = index;

    public string Name => "index_search";
    public string Description =>
        "在计划索引里按标题 / 名称 / 路径检索计划(比遍历文件夹快)。规划前先查过往同类计划。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("query", "检索词", required: true)
        .Int("limit", "最多返回条数(默认 50)"));

    public Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var q = ToolArgs.Req(args, "query");
        return Task.FromResult(IndexListTool.Render(_index.Search(q, ToolArgs.Int(args, "limit", 50))));
    }
}

public sealed class IndexReindexTool : IGatherlightTool
{
    private readonly IPlanIndexService _index;
    public IndexReindexTool(IPlanIndexService index) => _index = index;

    public string Name => "index_reindex";
    public string Description =>
        "重新扫描数据目录、刷新计划索引并重建 plans/INDEX.md。通常不必手动调用(服务器会自动同步),改动后想强制刷新时可用。";
    public string InputSchema => ToolSchema.Of(_ => { });

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        await _index.RescanAsync(ct);
        return new JsonObject { ["ok"] = true, ["indexed"] = _index.List().Count }.ToJsonString();
    }
}
