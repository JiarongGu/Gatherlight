using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Agent.Llm.Sources;
using Gatherlight.Server.Platform.Kernel.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Platform.Agent.Llm;

/// <summary>
/// 记忆检索 · Memory recall setup — three layers, each a ROW with a backend and a model.
///
/// <list type="bullet">
/// <item><b>公式 · Formula</b> — graph decay + rank fusion + FTS trigram. Always on, no setup, no cost.
/// The floor, and what remains when the other two are off.</item>
/// <item><b>判断 · Judgement</b> — a subject label on every write, a verdict on which candidates actually
/// answered on every recall. On by default because it already shipped that way; the point of this surface
/// is that declining it is a setting rather than a code edit.</item>
/// <item><b>语义 · Semantic</b> — real vectors, so a paraphrase finds the fact.</item>
/// </list>
///
/// <para><b>A layer's backend is a source, and a source serves a layer by EXISTING.</b> This controller
/// holds no list of which backend can do what: it renders <see cref="MemorySources"/>, where a backend
/// appears under a layer because a class implementing that layer's interface is in the list. That is why
/// 语义 offers no Claude arm — not a filter, an absent class. It is also why nothing here has to change
/// when a backend is added.</para>
///
/// <para><b>What this controller no longer owns:</b> downloading and deleting models. A model is a file
/// with a size and a capability, and it lives in 资源 with the runtime that hosts it — see
/// <c>ModelsController</c>. What stays here is the only part that IS a recall decision.</para>
///
/// <para><b>Two kinds of change, reported differently.</b> 判断's on/off is an <c>app_config</c> value read
/// per call and takes effect at once; a BINDING is a startup registration (a provider, a named client, an
/// embedder, a vector store) and needs a restart. Every layer therefore reports the SAVED backend beside
/// the RUNNING one — in the same vocabulary, because two vocabularies for one comparison can never come
/// out equal, which reads on screen as a restart that is permanently owed.</para>
/// </summary>
[ApiController]
public sealed class MemoryRecallController : ControllerBase
{
    private readonly IOllamaRuntime _ollama;
    private readonly IClaudeCliRuntime _claude;
    private readonly ServerConfigService _config;
    private readonly Storage.Knowledge.Services.IFactIndex _facts;
    private readonly ILogger<MemoryRecallController> _log;

    // Non-null only when an embedder was actually registered at startup — the honest answer to "is 语义
    // running right now", which is NOT the saved setting: between saving and restarting the two disagree.
    // 判断 needs no such field, because its on/off is read live from app_config.
    private readonly Lyntai.Memory.ISemanticMemory? _semantic;
    private readonly IAppConfigService _appConfig;
    private readonly IReindexStatus _reindex;
    private readonly IPlatformContext _platform;
    // What the judge is RUNNING on, as opposed to what is saved — see MemoryJudgeWiring.
    private readonly MemoryJudgeWiring _judgeWiring;
    private readonly Storage.Knowledge.Services.IKnowledgeStore _knowledge;

    public MemoryRecallController(IOllamaRuntime ollama, IClaudeCliRuntime claude, ServerConfigService config,
        Storage.Knowledge.Services.IFactIndex facts, IAppConfigService appConfig,
        Storage.Knowledge.Services.IKnowledgeStore knowledge,
        IReindexStatus reindex, MemoryJudgeWiring judgeWiring, IPlatformContext platform,
        ILogger<MemoryRecallController> log,
        Lyntai.Memory.ISemanticMemory? semantic = null)
    {
        _judgeWiring = judgeWiring;
        _ollama = ollama;
        _claude = claude;
        _config = config;
        _facts = facts;
        _appConfig = appConfig;
        _knowledge = knowledge;
        _reindex = reindex;
        _platform = platform;
        _log = log;
        _semantic = semantic;
    }

    /// <summary>The startup-time facts (config + where resources live) a source needs for the two
    /// questions it can answer without a container. Built here so both are read at the same instant.</summary>
    private MemorySourceSettings Settings() => new(_config.Current.Memory, _platform.ResourcesPath);

    private MemorySourceContext Context() => new(_ollama, _claude, Settings());

    [HttpGet("api/manage/memory")]
    public async Task<IActionResult> Get([FromQuery] bool refresh = false)
    {
        if (refresh) await _ollama.ProbeAsync(refresh: true);

        var mem = _config.Current.Memory;
        var ctx = Context();
        var boundJudge = MemorySources.ResolveJudge(Settings());
        var boundSemantic = MemorySources.ResolveSemantic(Settings());
        var (indexed, totalFacts) = await _knowledge.CoverageAsync();

        return Ok(new
        {
            layers = new object[]
            {
                new
                {
                    id = MemoryLayers.Formula, name = "公式 · Formula",
                    alwaysOn = true, on = true, live = true,
                    what = "图谱衰减 + 排名融合 + 三元组全文检索。不需要设置,不产生费用 —— 其余两层都建立在它之上。",
                    cost = "不产生任何费用。",
                    source = (string?)null, model = (string?)null,
                    activeSource = (string?)null, activeModel = (string?)null,
                    sources = Array.Empty<object>(),
                },
                new
                {
                    id = MemoryLayers.Judge, name = "判断 · Judgement",
                    alwaysOn = false,
                    // LIVE: an app_config value read per call. The BINDING below is a startup registration,
                    // so the two kinds of change are reported differently rather than looking alike.
                    on = MemoryEnrichment.IsOn(_appConfig), live = true,
                    what = "写入事实时标注主题,检索时判断哪些结果真正回答了问题(明显提升召回质量)。",
                    cost = boundJudge.Id == MemorySources.DefaultJudgeSource
                        ? "每次记录事实与每次检索各消耗一次 Claude CLI 调用(使用已登录的账号)。"
                        : "每次记录事实与每次检索各调用一次本机模型:不消耗账号额度,不联网,断网也能用。",
                    source = boundJudge.Id, model = MemorySources.ResolveJudgeModel(Settings()),
                    activeSource = _judgeWiring.Transport, activeModel = _judgeWiring.Model,
                    sources = await SourceViews(MemorySources.Judge, MemorySources.JudgeDeclined, ctx, MemoryLayers.Judge),
                },
                new
                {
                    id = MemoryLayers.Semantic, name = "语义 · Semantic",
                    alwaysOn = false,
                    on = boundSemantic is not null, live = false,
                    what = "用本机模型为事实生成向量,按语义检索 —— 问法与原文用词完全不同也能找到。",
                    cost = "占用磁盘与本机算力,不消耗 token;资料不离开这台电脑。",
                    source = boundSemantic?.Id, model = mem.EmbeddingModel,
                    // Only this layer can OBSERVE its own running state: ISemanticMemory resolves exactly
                    // when an embedder was registered.
                    activeSource = _semantic is not null ? boundSemantic?.Id : null,
                    activeModel = _semantic is not null ? mem.EmbeddingModel : null,
                    sources = await SourceViews(MemorySources.Semantic, MemorySources.SemanticDeclined, ctx, MemoryLayers.Semantic),
                    // Turning this on re-embeds by REBUILDING, so say so where the household decides: the
                    // ranking the index has accumulated is reset, and on a large corpus it is not quick.
                    note = "开启或更换模型后需要重建索引:会重新计算全部向量,并重置已积累的排序权重(事实本身不受影响)。",
                    reindex = ReindexView(),
                    // COVERAGE, not a history of rebuilds. It answers the question a household actually
                    // has — is what I know searchable right now — and it is self-correcting: an interrupted
                    // rebuild shows as < 100% and the next startup back-fill repairs it. A durable record
                    // of runs would answer a question nobody asked and could outlive the work it described.
                    coverage = new { indexed, total = totalFacts },
                },
            },
            // WHY 语义 is presented as the advanced one rather than a co-equal third.
            //
            // ATTRIBUTED, deliberately and permanently. This is LYNTAI's measurement on LYNTAI's corpus,
            // and this household's material is not that corpus. Presenting someone else's numbers as ours
            // would be exactly the unearned confidence the card model exists to prevent — so the sentence
            // names its source, and stays named until somebody measures it here.
            weighting = new
            {
                primary = MemoryLayers.Judge,
                note = "Lyntai 在自己的语料上实测:漏检里 0% 是「没检索到」—— 答案本来就在候选里,只是排在了后面。"
                    + "所以想让改写过的问法也能问到,先开「判断」比先开「语义」更划算(漏检 0.54 → 0.19)。"
                    + "这份实测来自 Lyntai 的语料,不是这个家庭的;两层是互补的,不是二选一。",
            },
            // Where the models themselves are managed now, so the panel can say so rather than leaving a
            // household looking for a download button that used to be here.
            modelsAt = "资源 · Resources",
        });
    }

    /// <summary>EVERY backend for a layer — the ones it can be bound to, and the ones it cannot.
    ///
    /// <para><b>An option the layer cannot use is still LISTED, with its reason.</b> Dropping it answers
    /// "why can't I pick this?" by making the question unaskable, and "no class implements it" is an answer
    /// only the source tree gives. So 语义 shows Claude and says it has no embeddings endpoint; both layers
    /// show 嵌入式 and say it is not shipped yet. That is the same rule the AVAILABLE-but-blocked case
    /// already followed (three causes, three sentences) applied one level out.</para>
    ///
    /// <para><c>bindable</c> is the distinction the client needs and the type system already makes: a
    /// declined backend has no <see cref="IMemorySource"/> behind it, so there is nothing to bind and the
    /// button must not be pressable. An AVAILABLE-false source, by contrast, could be bound the moment its
    /// prerequisite is met.</para>
    ///
    /// <para>Takes the shared base rather than each layer's interface, so one helper serves both lists. The
    /// layer-specific members (RejectAsync, ProveAsync) are not needed to DESCRIBE a source — only to bind
    /// one — which is why the split sits where it does.</para></summary>
    private static async Task<object[]> SourceViews(
        IEnumerable<IMemorySource> sources, IEnumerable<DeclinedBackend> declined, MemorySourceContext ctx,
        string layer)
    {
        var views = new List<object>();
        foreach (var s in sources)
        {
            var status = await s.StatusAsync(ctx);
            views.Add(new
            {
                id = s.Id, name = s.Name, description = s.Description, bindable = true,
                available = status.Available, reason = status.Reason, suggest = status.Suggest,
                // Does the household have to supply an address, and what did they supply? The RAW value,
                // not the resolved one: a refused URL must come back so the box shows what was typed
                // beside the sentence explaining why it was refused.
                needsEndpoint = s.NeedsEndpoint,
                endpoint = s.NeedsEndpoint ? RawEndpoint(ctx.Config, layer) : null,
                models = (await s.ModelsAsync(ctx)).Select(m => new
                {
                    id = m.Id, name = m.Name, installed = m.Installed, sizeBytes = m.SizeBytes,
                    note = m.Note, vintage = m.Vintage,
                    measured = m.Measured is null ? null : new
                    {
                        top1 = m.Measured.RecallTop1, top3 = m.Measured.RecallTop3,
                        queries = m.Measured.Queries, msPerQuery = m.Measured.MsPerQuery,
                    },
                }),
            });
        }
        foreach (var d in declined)
        {
            views.Add(new
            {
                id = d.Id, name = d.Name, description = d.Reason, bindable = false,
                available = false, reason = d.Reason, suggest = (string?)null,
                needsEndpoint = false, endpoint = (string?)null,
                models = Enumerable.Empty<object>(),
            });
        }
        return views.ToArray();
    }

    /// <summary>What the household actually typed for this layer's address, unresolved. Shown back to them
    /// even when it was REFUSED — a box that silently empties itself gives no way to see the typo the
    /// sentence beside it is complaining about.
    /// <para>Keyed on the LAYER, not on the source's type: <c>OpenAiCompatibleSource</c> implements both
    /// layer interfaces, so a type test would answer the same for both of its instances — which is exactly
    /// the class this has to get right.</para></summary>
    private static string? RawEndpoint(MemoryConfig config, string layer) =>
        layer == MemoryLayers.Semantic ? config.SemanticEndpoint : config.JudgeEndpoint;

    /// <summary>Turn 判断 on or off. Off keeps the deterministic floor intact — it removes an enrichment,
    /// not the feature.</summary>
    [HttpPost("api/manage/memory/enrichment")]
    public IActionResult Enrichment([FromBody] EnabledRequest body)
    {
        if (body is null) return BadRequest(new { error = "enabled is required" });
        MemoryEnrichment.Set(_appConfig, body.Enabled);
        _log.LogInformation("Memory LLM enrichment set to {Enabled} (live, no restart)", body.Enabled);
        return Ok(new { ok = true, enabled = body.Enabled, restartRequired = false });
    }

    /// <summary>Bind a layer to a backend and a model — the one action that used to be three, spread across
    /// two stores and two panels.
    ///
    /// <para>A restart is owed either way: a backend is a provider, a named client, an embedder or a vector
    /// store, all registered while the container is built. 判断's on/off beside it stays live, and the
    /// console distinguishes the two rather than making every change look like it needs a restart.</para></summary>
    [HttpPost("api/manage/memory/layer/{layer}")]
    public async Task<IActionResult> Bind(string layer, [FromBody] BindRequest body)
    {
        var model = body?.Model?.Trim();
        var ctx = Context();

        if (string.Equals(layer, MemoryLayers.Judge, StringComparison.OrdinalIgnoreCase))
        {
            var source = MemorySources.FindJudge(body?.Source);
            if (source is null) return BadRequest(new { error = $"未知的后端:{body?.Source}" });

            // The ADDRESS is saved before the backend is asked anything, because a source reads its endpoint
            // from config — probing first would test the PREVIOUS binding's address.
            if (body?.Endpoint is not null)
                _config.Update(c => c.Memory.JudgeEndpoint = Blank(body.Endpoint));
            if (!source.IsConfigured(Settings()))
                return StatusCode(409, new
                {
                    error = (await source.StatusAsync(Context())).Reason ?? "这个后端还缺少必要的设置。",
                });
            ctx = Context();

            // AN ADDRESS WITHOUT A MODEL is a legitimate first step, not a malformed request: for a service
            // we do not manage, the model list comes FROM the address, so there is nothing to pick until it
            // is saved. Demanding both at once would make the field impossible to submit.
            if (string.IsNullOrWhiteSpace(model))
            {
                if (!source.NeedsEndpoint) return BadRequest(new { error = "model is required" });
                return Ok(new
                {
                    ok = true, layer, source = source.Id, model = (string?)null, restartRequired = false,
                    note = "地址已保存 —— 现在可以选一个模型了。",
                });
            }
            if (!EmbeddingCatalog.IsWellFormedId(model))
                return BadRequest(new { error = $"模型名称格式不正确:{model}" });

            // A model that is installed, well-formed and unable to judge would sail into a FAIL-OPEN
            // policy, where the only symptom is recall that quietly never improves.
            if (await source.RejectAsync(ctx, model!) is { } why) return StatusCode(409, new { error = why });

            _config.Update(c =>
            {
                c.Memory.JudgeSource = source.Id;
                c.Memory.JudgeModel = model;
                // Cleared on the first write through this path, so no install carries two answers to one
                // question for longer than it takes to make a choice.
                c.Memory.JudgeTransport = null;
            });
            // ONE key names the model. Cortex used to offer a second, and its value OVERRODE this one —
            // which is how "haiku" got handed to an Ollama that had never heard of it, silently, because
            // both memory policies are fail-open.
            _appConfig.Set("llm.model.memory", model!);
            _log.LogInformation("memory judge bound to {Source}/{Model}", source.Id, model);

            return Ok(new
            {
                ok = true, layer, source = source.Id, model, restartRequired = true,
                note = "设置已保存。重启服务后,标注与核对将由这个后端完成。",
            });
        }

        if (string.Equals(layer, MemoryLayers.Semantic, StringComparison.OrdinalIgnoreCase))
        {
            var source = MemorySources.FindSemantic(body?.Source);
            if (source is null) return BadRequest(new { error = $"未知的后端:{body?.Source}" });

            if (body?.Endpoint is not null)
                _config.Update(c => c.Memory.SemanticEndpoint = Blank(body.Endpoint));
            if (!source.IsConfigured(Settings()))
                return StatusCode(409, new
                {
                    error = (await source.StatusAsync(Context())).Reason ?? "这个后端还缺少必要的设置。",
                });
            ctx = Context();

            // Same first step as 判断: for a service we do not manage, the model list comes FROM the
            // address, so saving the address alone has to be allowed.
            if (string.IsNullOrWhiteSpace(model))
            {
                if (!source.NeedsEndpoint) return BadRequest(new { error = "model is required" });
                return Ok(new
                {
                    ok = true, layer, source = source.Id, model = (string?)null, restartRequired = false,
                    note = "地址已保存 —— 现在可以选一个模型了。",
                });
            }
            if (!EmbeddingCatalog.IsWellFormedId(model))
                return BadRequest(new { error = $"模型名称格式不正确:{model}" });

            // PROVE it embeds before saving. Installed is not usable, and the failure would surface only as
            // recall that finds nothing — indistinguishable from a household that knows nothing.
            var probe = await source.ProveAsync(ctx, model!);
            if (probe is null)
                return StatusCode(409, new
                {
                    error = $"{model} 没有返回向量 —— 它可能不是嵌入模型,或 Ollama 未运行。"
                        + "请换一个,或先在「资源 · Resources」面板确认。",
                });

            var previous = _config.Current.Memory.EmbeddingModel;
            _config.Update(c =>
            {
                c.Memory.SemanticSource = source.Id;
                c.Memory.EmbeddingModel = model;
                c.Memory.SemanticEnabled = true;   // keeps a legacy reader correct
            });
            // A CHANGED model invalidates every stored vector — they keep the old width, and recall then
            // matches nothing rather than erroring — so the reindex is not optional, and saying so here is
            // what stops a household sitting on silently empty recall.
            var modelChanged = previous is not null && !OllamaState.Matches(previous, model!);
            _log.LogInformation("semantic recall bound to {Source}/{Model} ({Dims}d)",
                source.Id, model, probe.Dimensions);

            return Ok(new
            {
                ok = true, layer, source = source.Id, model, restartRequired = true, reindexRequired = true,
                modelChanged, dimensions = probe.Dimensions, probeMs = probe.Milliseconds,
                catalogued = EmbeddingCatalog.Find(model) is not null,
                note = "设置已保存。重启服务后生效,然后请重新建立一次语义索引。",
            });
        }

        return NotFound(new { error = $"未知的层:{layer}" });
    }

    /// <summary>Unbind a layer.
    /// <para>The model and its vectors are left alone on purpose: turning a feature off should not throw
    /// away something that cost a large download and a long reindex, in case it goes back on.</para>
    /// <para>判断 is NOT unbindable — it is turned off by its own live switch. Conflating the two would put
    /// a restart in front of a change that needs none, and would leave the layer with no backend to turn
    /// back ON to.</para></summary>
    [HttpPost("api/manage/memory/layer/{layer}/off")]
    public IActionResult Unbind(string layer)
    {
        if (!string.Equals(layer, MemoryLayers.Semantic, StringComparison.OrdinalIgnoreCase))
            return NotFound(new { error = "只有「语义」可以这样停用;「判断」请用它自己的开关。" });

        _config.Update(c => { c.Memory.SemanticSource = null; c.Memory.SemanticEnabled = false; });
        return Ok(new { ok = true, layer, restartRequired = true });
    }

    /// <summary>(Re)build the vector index over every fact. Needed on first bind — the graph is already
    /// populated, so the ordinary back-fill (which touches only rows with no ref) would embed nothing —
    /// and after any model change.</summary>
    [HttpPost("api/manage/memory/layer/semantic/reindex")]
    public IActionResult Reindex()
    {
        if (MemorySources.ResolveSemantic(Settings()) is null)
            return StatusCode(409, new { error = "「语义」这一层尚未启用。" });
        if (!_reindex.TryStart())
            return StatusCode(409, new { error = "已经有一次重建在进行中。" });

        // DETACHED, and deliberately not tied to the request's CancellationToken: the work outlives the
        // POST, so binding it would cancel the rebuild the moment the browser stopped waiting — which is
        // precisely what happens on an operation this long. Progress is read back from GET /api/manage/memory.
        _ = Task.Run(async () =>
        {
            try
            {
                var embedded = await _facts.ReindexSemanticAsync(
                    CancellationToken.None,
                    new Progress<(int Done, int Total)>(p => _reindex.Report(p.Done, p.Total)));
                _reindex.Finish(embedded, embedded == 0
                    ? "没有建立任何索引 —— 通常是服务尚未重启(嵌入器只在启动时装载),或 Ollama 未运行。"
                    : null);
            }
            catch (Exception ex)
            {
                // ReindexSemanticAsync degrades rather than throwing, so reaching here means something
                // outside it did — still recorded, because a run that vanished is worse than one that failed.
                _log.LogWarning(ex, "reindex failed");
                _reindex.Finish(0, ex.Message);
            }
        });
        return Accepted(new { ok = true, started = true });
    }

    private object ReindexView()
    {
        var r = _reindex.Current;
        return new
        {
            running = r.Running, done = r.Done, total = r.Total, embedded = r.Embedded, error = r.Error,
            // Computed here rather than in the client so "no total yet" reads as indeterminate rather than
            // as 0% — a bar pinned at zero looks stuck, which is the impression this exists to remove.
            percent = r.Total > 0 ? (int)Math.Round(100.0 * r.Done / r.Total) : (int?)null,
        };
    }

    /// <summary>An empty box means "clear it", not "leave it" — otherwise a household could never unset a
    /// wrong address, only overwrite it.</summary>
    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    /// <summary><paramref name="Endpoint"/> is null for a backend that needs no address (the CLI, Ollama),
    /// and is the base URL for a household-supplied OpenAI-compatible service. Sent per LAYER because the
    /// judge and the embedder may legitimately be different servers.</summary>
    public sealed record BindRequest(string? Source, string? Model, string? Endpoint = null);
    public sealed record EnabledRequest(bool Enabled);
}
