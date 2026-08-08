using System.Text.Json;
using System.Text.Json.Nodes;
using Gatherlight.Server.Platform.Storage.Knowledge.Services;
using Gatherlight.Server.Platform.Capabilities.Tools.Models;

namespace Gatherlight.Server.Platform.Storage.Knowledge.Tools;

/// <summary>Agent-writable cross-session memory for granular verified facts. Curated markdown
/// (.claude rules, household profile) stays canonical for policies/preferences — this is for
/// facts too fine-grained to curate: a verified URL, a scraped price with its date, a venue's
/// status. Same kind+topic updates in place.</summary>
public sealed class RememberFactTool : IGatherlightTool
{
    private readonly IKnowledgeStore _store;
    private readonly IFactIndex _index;
    public RememberFactTool(IKnowledgeStore store, IFactIndex index) => (_store, _index) = (store, index);

    public string Name => "remember_fact";

    public string Description =>
        "把一条已验证的细粒度事实存入跨会话知识库(如:已核验的餐厅 URL、带日期的价格、场所营业状态)。规则/偏好类内容仍写入 .claude 或 household 文件 — 此工具只存零散事实。同 kind+topic 会覆盖更新。";

    public string InputSchema => ToolSchema.Of(b => b
        .Str("kind", "分类,如 venue-url / price / policy / schedule", required: true)
        .Str("topic", "事实的主题键,如 \"金久右衛門 道頓堀店 tabelog\"", required: true)
        .Str("content", "事实本身(含关键细节)", required: true)
        .Str("source", "来源 URL 或依据(强烈建议)")
        .Num("confidence", "0-1 置信度(默认 0.7;scrape 实测过的用 0.9+)"));

    private sealed record Args(string? Kind, string? Topic, string? Content, string? Source, double? Confidence);

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var a = ToolArgs.Parse<Args>(args);
        var kind = ToolArgs.Req(a.Kind, "kind");
        var topic = ToolArgs.Req(a.Topic, "topic");
        var content = ToolArgs.Req(a.Content, "content");

        // The row is the record of truth and is written first — the index is derived, so a fact must
        // never depend on the index succeeding to be remembered at all.
        var id = await _store.LearnAsync(kind, topic, content, a.Source, a.Confidence ?? 0.7);
        var reference = await _index.IndexAsync(kind, topic, content, ct);
        if (reference is not null) await _store.SetGraphRefAsync(id, reference);

        return new JsonObject { ["ok"] = true, ["id"] = id }.ToJsonString();
    }
}

/// <summary>
/// Recall, ranked by the graph index when it is there and by FTS when it is not.
///
/// <para>The index contributes what keyword search cannot: entries decay unless they get used, so a
/// price nobody has looked at in months sinks beneath fresher material; recall reinforces what it
/// returns, so facts that keep proving useful last; and facts recalled together become linked, so a
/// query can reach a fact it never literally matched. Nothing is deleted — decay only ranks.</para>
///
/// <para><b>The fallback is not a nicety.</b> An empty index, an unindexed fact, an engine that failed
/// — each must degrade to the keyword recall this tool has always done, because returning nothing reads
/// to the agent as "the household does not know this", which is a lie told on their own data.</para>
/// </summary>
public sealed class RecallFactsTool : IGatherlightTool
{
    private readonly IKnowledgeStore _store;
    private readonly IFactIndex _index;
    public RecallFactsTool(IKnowledgeStore store, IFactIndex index) => (_store, _index) = (store, index);

    public string Name => "recall_facts";

    public string Description =>
        "从跨会话知识库检索已存的事实(按主题/内容匹配;越常用、越近期被用到的排得越前,并会带出相关联的事实)。规划涉及曾经核验过的场所/价格/政策时先查这里,能省去重复调研。返回的 ref 可用 expand_fact 展开关联。";

    public string InputSchema => ToolSchema.Of(b => b
        .Str("query", "检索词(匹配 topic 或 content)", required: true)
        .Str("kind", "限定分类(可选)")
        .Int("limit", "最多返回条数(默认 8)"));

    private sealed record Args(string? Query, string? Kind, int? Limit);

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var a = ToolArgs.Parse<Args>(args);
        var query = ToolArgs.Req(a.Query, "query");
        var kind = a.Kind;
        var limit = Math.Clamp(a.Limit ?? 8, 1, 50);

        var arr = new JsonArray();
        var ranked = "fts";

        var hits = await _index.RankAsync(query, kind, limit, ct);
        if (hits.Count > 0)
        {
            var byRef = hits.ToDictionary(h => h.GraphRef, h => h, StringComparer.Ordinal);
            var rows = await _store.ByGraphRefsAsync([.. hits.Select(h => h.GraphRef)], kind);
            if (rows.Count > 0)
            {
                ranked = "graph";
                foreach (var (row, graphRef) in rows.Take(limit))
                {
                    var hit = byRef[graphRef];
                    var o = Row(row);
                    o["ref"] = graphRef;
                    o["retrievability"] = Math.Round(hit.Retrievability, 3);
                    o["linked"] = hit.Degree;
                    arr.Add(o);
                }
            }
        }

        if (arr.Count == 0)
        {
            foreach (var row in await _store.RecallAsync(query, kind, limit)) arr.Add(Row(row));
        }

        // `ranked` is not decoration: without it a graph result and a fallback result are
        // indistinguishable, and the first question about a surprising recall is which one ran.
        return new JsonObject { ["facts"] = arr, ["ranked"] = ranked }
            .ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }

    internal static JsonObject Row(KnowledgeRow r) => new()
    {
        ["id"] = r.Id,
        ["kind"] = r.Kind,
        ["topic"] = r.Topic,
        ["content"] = r.Content,
        ["source"] = r.Source,
        ["confidence"] = Math.Round(r.Confidence, 3),
        ["updatedAt"] = r.UpdatedAt,
    };
}

/// <summary>Open one recalled fact and see what it is connected to — the other half of a cheap first
/// load. `recall_facts` returns a ranked index; this pays for depth only where the agent turns.</summary>
public sealed class ExpandFactTool : IGatherlightTool
{
    private readonly IFactIndex _index;
    public ExpandFactTool(IFactIndex index) => _index = index;

    public string Name => "expand_fact";

    public string Description =>
        "展开 recall_facts 返回的某条事实(用它的 ref):给出完整内容,以及与它相关联的其它事实的标题 — 常能带出没被检索词直接命中的相关信息。";

    public string InputSchema => ToolSchema.Of(b => b
        .Str("ref", "recall_facts 返回的 ref 值", required: true));

    private sealed record Args(string? Ref);

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var a = ToolArgs.Parse<Args>(args);
        var reference = ToolArgs.Req(a.Ref, "ref");
        var expansion = await _index.ExpandAsync(reference, ct);
        if (expansion is null)
        {
            // Say which of the two it is. "No such fact" and "the index is not running" call for
            // completely different next moves from the agent.
            return new JsonObject
            {
                ["ok"] = false,
                ["reason"] = _index.Available ? "该 ref 不存在(可能已被更新或重建索引)" : "关联索引未启用",
            }.ToJsonString();
        }
        return new JsonObject
        {
            ["ok"] = true,
            ["ref"] = expansion.GraphRef,
            ["topic"] = expansion.Headline,
            ["content"] = expansion.Content,
            ["linkedTopics"] = new JsonArray([.. expansion.Neighbours.Select(n => (JsonNode)JsonValue.Create(n)!)]),
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }
}
