using System.Text.Json;
using System.Text.Json.Nodes;
using Gatherlight.Server.Modules.Knowledge.Services;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Knowledge.Tools;

/// <summary>Agent-writable cross-session memory for granular verified facts. Curated markdown
/// (.claude rules, household profile) stays canonical for policies/preferences — this is for
/// facts too fine-grained to curate: a verified URL, a scraped price with its date, a venue's
/// status. Same kind+topic updates in place.</summary>
public sealed class RememberFactTool : IGatherlightTool
{
    private readonly IKnowledgeStore _store;
    public RememberFactTool(IKnowledgeStore store) => _store = store;

    public string Name => "remember_fact";

    public string Description =>
        "把一条已验证的细粒度事实存入跨会话知识库(如:已核验的餐厅 URL、带日期的价格、场所营业状态)。规则/偏好类内容仍写入 .claude 或 household 文件 — 此工具只存零散事实。同 kind+topic 会覆盖更新。";

    public string InputSchema => ToolSchema.Of(b => b
        .Str("kind", "分类,如 venue-url / price / policy / schedule", required: true)
        .Str("topic", "事实的主题键,如 \"金久右衛門 道頓堀店 tabelog\"", required: true)
        .Str("content", "事实本身(含关键细节)", required: true)
        .Str("source", "来源 URL 或依据(强烈建议)")
        .Num("confidence", "0-1 置信度(默认 0.7;scrape 实测过的用 0.9+)"));

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var id = await _store.LearnAsync(
            args.GetProperty("kind").GetString()!,
            args.GetProperty("topic").GetString()!,
            args.GetProperty("content").GetString()!,
            args.TryGetProperty("source", out var s) ? s.GetString() : null,
            args.TryGetProperty("confidence", out var c) && c.ValueKind == JsonValueKind.Number ? c.GetDouble() : 0.7);
        return new JsonObject { ["ok"] = true, ["id"] = id }.ToJsonString();
    }
}

public sealed class RecallFactsTool : IGatherlightTool
{
    private readonly IKnowledgeStore _store;
    public RecallFactsTool(IKnowledgeStore store) => _store = store;

    public string Name => "recall_facts";

    public string Description =>
        "从跨会话知识库检索已存的事实(按主题/内容模糊匹配,置信度排序)。规划涉及曾经核验过的场所/价格/政策时先查这里,能省去重复调研。";

    public string InputSchema => ToolSchema.Of(b => b
        .Str("query", "检索词(匹配 topic 或 content)", required: true)
        .Str("kind", "限定分类(可选)")
        .Int("limit", "最多返回条数(默认 8)"));

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var rows = await _store.RecallAsync(
            args.GetProperty("query").GetString()!,
            args.TryGetProperty("kind", out var k) ? k.GetString() : null,
            args.TryGetProperty("limit", out var l) && l.TryGetInt32(out var n) ? Math.Clamp(n, 1, 50) : 8);
        var arr = new JsonArray();
        foreach (var r in rows)
        {
            arr.Add(new JsonObject
            {
                ["id"] = r.Id,
                ["kind"] = r.Kind,
                ["topic"] = r.Topic,
                ["content"] = r.Content,
                ["source"] = r.Source,
                ["confidence"] = Math.Round(r.Confidence, 3),
                ["updatedAt"] = r.UpdatedAt,
            });
        }
        return new JsonObject { ["facts"] = arr }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }
}
