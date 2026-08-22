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
/// price nobody has looked at in months sinks beneath fresher material; recall refreshes what it
/// returns, so a fact that keeps proving useful never looks stale; and facts recalled together become
/// linked, so a query can reach a fact it never literally matched. Nothing is deleted — decay only ranks.</para>
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
        // The last clause is not decoration. A capability the agent is never TOLD about stays unused while
        // every check passes — the failure this very tool once had, when the fact store held 16 entries and
        // had never been recalled because nothing mentioned it. Subject recall is new reach: the query may
        // name what a fact is ABOUT rather than repeat its words, so saying so is what makes it reachable.
        "从跨会话知识库检索已存的事实(按主题/内容匹配;越常用、越近期被用到的排得越前,并会带出相关联的事实)。规划涉及曾经核验过的场所/价格/政策时先查这里,能省去重复调研。返回的 ref 可用 expand_fact 展开关联。"
        + "检索词也可以直接写这条事实『是关于什么的』,不必照搬原文用词 —— 例如问「证件」也能命中一条只写了护照到期的事实;这类命中会标 matched:\"subject\"。";

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

        var seenIds = new HashSet<long>();

        var ranking = await _index.RankAsync(query, kind, limit, ct);
        var hits = ranking.Hits;
        if (hits.Count > 0)
        {
            var byRef = hits.ToDictionary(h => h.GraphRef, h => h, StringComparer.Ordinal);
            var rows = await _store.ByGraphRefsAsync([.. hits.Select(h => h.GraphRef)], kind);
            if (rows.Count > 0)
            {
                ranked = "graph";
                foreach (var (row, _) in rows.Take(limit)) seenIds.Add(row.Id);
                foreach (var (row, graphRef) in rows.Take(limit))
                {
                    var hit = byRef[graphRef];
                    var o = Row(row);
                    o["ref"] = graphRef;
                    if (hit.BySubject)
                    {
                        // NOT retrievability 0 and NOT linked 0. This fact was found because the query names
                        // one of its subject handles, so neither number was measured — and "0.0" reads as
                        // "fully decayed", which is a claim about the household's memory that nothing
                        // checked. Same reason `ranked` exists: the route matters to what the answer means.
                        o["matched"] = "subject";
                    }
                    else
                    {
                        o["retrievability"] = Math.Round(hit.Retrievability, 3);
                        o["linked"] = hit.Degree;
                    }
                    arr.Add(o);
                }
            }
        }

        // FTS TOPS THE PAGE UP; it is no longer only a fallback for an empty one.
        //
        // It used to run ONLY when the graph resolved nothing, and that quietly cost the 语义 CLI arm most
        // of its value. Phrasings live in `knowledge.aka`, which is in the FTS table and in NO graph node —
        // the graph indexes a fact's content, which never contained them. So the household paid a model
        // call per fact for phrasings that were consulted only when the graph abstained ENTIRELY. Measured
        // in e2e-p48: `zzfishpref harbour` returned the three lexically-matching facts and silently
        // dropped the one whose stored phrasing was the query's only real match.
        //
        // Topping up rather than merging keeps the graph's answer authoritative: its rows come first and
        // in its order, and these only fill slots the caller asked for and the graph did not use. So this
        // cannot displace a ranked hit — the same property that makes the subject append safe — and when
        // the graph already fills the page nothing changes at all. The cost is one local FTS query, which
        // is microseconds beside a recall the judge can make take seconds.
        if (arr.Count < limit)
        {
            // `seenIds` is passed rather than filtered on afterwards: this is a top-up, so "not these" is
            // part of the request. It also keeps `hits` honest — RecallAsync increments every row it
            // returns, and the two paths now overlap, so a fact found by both would count twice for one
            // recall. Nothing reads that counter today, which makes it a latent wrong number rather than a
            // visible one; see IKnowledgeStore.RecallAsync.
            foreach (var row in await _store.RecallAsync(query, kind, limit, seenIds))
            {
                if (arr.Count >= limit) break;
                if (!seenIds.Add(row.Id)) continue;
                var o = Row(row);
                // Only when the graph also answered. If FTS filled an empty page, `ranked` already says
                // "fts" for the whole result and marking each row would be the same fact stated twice.
                if (ranked == "graph") o["matched"] = "text";
                arr.Add(o);
            }
        }

        // `ranked` is not decoration: without it a graph result and a fallback result are
        // indistinguishable, and the first question about a surprising recall is which one ran.
        var result = new JsonObject { ["facts"] = arr, ["ranked"] = ranked };
        // Absent when nothing was judged — and attached ONLY to a graph result: on the FTS fallback
        // (every graph ref an orphan) the judged candidates are not the facts being shown, and a
        // verdict about material the caller cannot see is exactly the confusion this field exists
        // to prevent. "A judge found none of these answer" and "no judge ran" still call for
        // different next moves, same reason `ranked` exists.
        if (ranked == "graph" && ranking.Answered is { } answered) result["answered"] = answered;
        return result.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
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
