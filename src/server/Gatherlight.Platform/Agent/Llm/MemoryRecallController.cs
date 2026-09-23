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
/// EVERY layer now offers all three groups, including 语义 — which for a while offered no Claude arm and a
/// paragraph explaining that "Claude has no embeddings endpoint, so this layer cannot have it". True about
/// embeddings, false as a conclusion: the layer was defined as embeddings BY US, so the absent class was a
/// fact about what we had written. It exists now and rephrases instead (see
/// <see cref="Sources.ClaudeCliSemanticSource"/>). What the rule still buys is that nothing FILTERS; what it
/// never licensed was withholding an option because it would be the weaker one. It is also why nothing here has to change
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
    private readonly IClaudeCliRuntime _claude;
    private readonly ILlamaServerRuntime _llama;
    private readonly ServerConfigService _config;
    private readonly Storage.Knowledge.Services.IFactIndex _facts;
    private readonly ILogger<MemoryRecallController> _log;

    // Non-null only when an embedder was actually registered at startup — the honest answer to "is 语义
    // running right now", which is NOT the saved setting: between saving and restarting the two disagree.
    // 判断 needs no such field, because its on/off is read live from app_config.
    private readonly Lyntai.Memory.ISemanticMemory? _semantic;
    private readonly IAppConfigService _appConfig;
    private readonly IReindexStatus _reindex;
    // For a source whose work IS a model call rather than a service to connect to.
    private readonly Lyntai.Inference.ITextClient? _llm;
    private readonly IPlatformContext _platform;
    // What the judge is RUNNING on, as opposed to what is saved — see MemoryJudgeWiring.
    private readonly MemoryJudgeWiring _judgeWiring;
    private readonly Storage.Knowledge.Services.IKnowledgeStore _knowledge;

    public MemoryRecallController(IClaudeCliRuntime claude,
        ILlamaServerRuntime llama, ServerConfigService config,
        Storage.Knowledge.Services.IFactIndex facts, IAppConfigService appConfig,
        Storage.Knowledge.Services.IKnowledgeStore knowledge,
        IReindexStatus reindex,
        MemoryJudgeWiring judgeWiring, IPlatformContext platform,
        ILogger<MemoryRecallController> log,
        Lyntai.Memory.ISemanticMemory? semantic = null,
        Lyntai.Inference.ITextClient? llm = null)
    {
        _judgeWiring = judgeWiring;
        _claude = claude;
        _llama = llama;
        _config = config;
        _facts = facts;
        _appConfig = appConfig;
        _knowledge = knowledge;
        _reindex = reindex;
        _platform = platform;
        _log = log;
        _semantic = semantic;
        _llm = llm;
    }

    /// <summary>The startup-time facts (config + where resources live) a source needs for the two
    /// questions it can answer without a container. Built here so both are read at the same instant.</summary>
    private MemorySourceSettings Settings() => new(_config.Current.Memory, _platform.ResourcesPath);

    private MemorySourceContext Context() => new(_claude, _llama, Settings(), _llm);

    [HttpGet("api/manage/memory")]
    public async Task<IActionResult> Get([FromQuery] bool refresh = false)
    {

        var mem = _config.Current.Memory;
        var ctx = Context();
        var boundJudge = MemorySources.ResolveJudge(Settings());
        var boundSemantic = MemorySources.ResolveSemantic(Settings());
        var (indexed, totalFacts) = await _knowledge.CoverageAsync();

        // The two layers share nothing but the context, and inside an object initialiser they were awaited
        // one after the other — so the panel paid 判断's probes plus 语义's, in series, for a screen that
        // shows both at once. Started together here; the anonymous object below just reads the results.
        var judgeTask = BackendGroups(
            MemorySources.Judge, MemorySources.JudgeDeclined, ctx, MemoryLayers.Judge, _log);
        var semanticTask = BackendGroups(
            MemorySources.Semantic, MemorySources.SemanticDeclined, ctx, MemoryLayers.Semantic, _log);
        var judgeGroups = await judgeTask;
        var semanticGroups = await semanticTask;

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
                    groups = Array.Empty<object>(),
                },
                new
                {
                    id = MemoryLayers.Judge, name = "判断 · Judgement",
                    alwaysOn = false,
                    // LIVE: an app_config value read per call. The BINDING below is a startup registration,
                    // so the two kinds of change are reported differently rather than looking alike.
                    on = MemoryEnrichment.IsOn(_appConfig), live = true,
                    // WHAT IT DOES — and this sentence has now been wrong twice, in opposite directions.
                    // It promised 明显提升召回质量, a clear quality gain, which recall-bench refuted: paired
                    // and counterbalanced on this household's own facts, top-1 10/16 and MRR 0.646 with the
                    // judge on AND off, at 78 ms against 8,936. It was then rewritten to say the judgement
                    // does not change this recall's ordering at all — which is ALSO false, proved in p48 by
                    // driving a verdict through the stub: endorsing a fact ranked third brought it to the
                    // top of the page. The verdict reaches the ordering through reinforcement, not through
                    // a re-sort, but it reaches it.
                    // Both measurements stand together: the judge CAN move a result, and on this corpus it
                    // moved nothing, because it endorsed what already ranked top. So the honest sentence
                    // describes what it does and declines to promise an improvement nobody has measured.
                    what = "写入事实时标注主题(让讲同一件事的记录彼此关联);检索时判断哪些结果真正回答了问题,"
                        + "被判断为「答到了」的事实会排得更靠前,也更容易被后续检索记住。"
                        + "在本机现有的事实上实测过:排序结果与关闭时相同 —— 因为它认可的正是原本就排在前面的那几条。"
                        + "每次检索都要等它一次,这一点是当场就有的。",
                    // COST IS TWO THINGS, and only one of them was stated. The token cost was here from the
                    // start; the LATENCY was measured later, on this household's own facts.
                    //
                    // QUOTED AS A RANGE because it is not stable: five paired runs gave 8.9, 14.9, 15.1,
                    // 16.5 and 16.9 s against a 公式 floor of 68–90 ms. This line said "约 9 秒" — the
                    // fastest reading of the five, and roughly half the typical wait. A household deciding
                    // whether to leave 判断 on was being quoted the best case as if it were the case; the
                    // spread is a CLI process spawn competing with whatever else the machine is doing, so
                    // a single number here can only ever be one machine on one afternoon.
                    // essentially all of it a CLI process spawn per call. A household deciding whether to
                    // leave 判断 on is entitled to that before they notice recall feeling slow, and it is
                    // OUR number, so unlike the weighting note below it needs no attribution.
                    // The local arm avoids the spawn; its own latency is deliberately NOT quoted, because
                    // nobody has measured it here and a plausible figure is the thing this panel refuses.
                    cost = boundJudge.Id == MemorySources.DefaultJudgeSource
                        ? "每次记录事实与每次检索各消耗一次 Claude CLI 调用(使用已登录的账号)。"
                          + "实测每次检索 9–17 秒(五次测量,多数在 15 秒上下)—— 每次调用都要启动一次 CLI 进程;"
                          + "只用「公式」时是 0.07–0.09 秒。"
                          + "换成本机模型可以省掉这次进程启动。"
                        : "每次记录事实与每次检索各调用一次本机模型:不消耗账号额度,不联网,断网也能用。"
                          + "没有 CLI 那条的进程启动开销(那条实测每次检索 9–17 秒)。",
                    source = boundJudge.Id, model = MemorySources.ResolveJudgeModel(Settings()),
                    activeSource = _judgeWiring.Transport, activeModel = _judgeWiring.Model,
                    groups = judgeGroups,
                    // A saved backend that no longer exists is SAID, never silently
                    // swapped — see RetiredNote.
                    retired = RetiredNote(mem.JudgeSource, MemoryLayers.Judge),
                },
                new
                {
                    id = MemoryLayers.Semantic, name = "语义 · Semantic",
                    alwaysOn = false,
                    on = boundSemantic is not null, live = false,
                    // THE JOB, then the cost OF THE BOUND ARM — exactly as 判断 above already does. Both
                    // of these were fixed strings written when the only arm was an embedder, and adding
                    // the Claude CLI arm on this branch left them describing something else entirely.
                    //
                    // The cost line was the serious one: it promised "不消耗 token;资料不离开这台电脑"
                    // while the CLI arm sends every fact to Claude to be rephrased and bills for it. A
                    // household reads that sentence to decide whether their household's facts stay on
                    // their machine, and it was answering for a backend they had not chosen. An
                    // unenforced plain-language promise is the defect this whole surface exists to
                    // prevent, and a privacy one is the worst instance of it.
                    what = "换个说法也能命中 —— 问法和原文用词完全不同的时候,也能找到那条事实。",
                    cost = boundSemantic is null
                        ? "这一层没有启用。"
                        : boundSemantic.Group == MemoryGroups.Cli
                            ? "写入每条事实时多一次 Claude 调用:消耗账号额度,而且**事实内容会发送给 "
                              + "Claude** 去改写说法。检索时不额外调用,也不会变慢。"
                            : "占用磁盘与本机算力,不消耗 token;资料不离开这台电脑。",
                    source = boundSemantic?.Id, model = mem.EmbeddingModel,
                    // Only this layer can OBSERVE its own running state: ISemanticMemory resolves exactly
                    // when an embedder was registered.
                    // RUNNING, not saved. For an arm that registers an embedder, "running" means the
                    // container holds one — it cannot until a restart. For an arm whose effect is at write
                    // time, saved IS running: asking whether an ISemanticMemory exists would answer no for
                    // ever and make the restart banner permanent.
                    activeSource = SemanticIsRunning(boundSemantic) ? boundSemantic?.Id : null,
                    activeModel = SemanticIsRunning(boundSemantic) ? mem.EmbeddingModel : null,
                    groups = semanticGroups,
                    // A saved backend that no longer exists is SAID, never silently
                    // swapped — see RetiredNote.
                    retired = RetiredNote(mem.SemanticSource, MemoryLayers.Semantic),
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
                    + "所以想让改写过的问法也能问到,先开「判断」通常比先开「语义」见效更快:"
                    + "那份实测里免费的本机模型把漏检从 0.54 降到 0.26,Claude 判断到 0.19。"
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

    // NO OLLAMA MANAGEMENT HERE, and this is the second time these two endpoints have come out — the
    // first was wrong, this one is not, so the difference is on the record.
    //
    // Removing them because "an unused management verb invites the next caller" was code hygiene overruling
    // what the household could do, and it left the app depending on a daemon it would not manage: 记忆检索
    // listed the models and offered them, while nothing anywhere could add or remove one. There was no
    // consistent version of that.
    //
    // They are gone now because the DEPENDENCY is gone. The managed local runtime is llama.cpp — we install
    // it, start it, pin its models by sha256 and publish their measured ranking as downloadable resources.
    // Ollama is reached, if a household runs it, through `openai-compat` by address, verified end to end
    // (see MemoryBackends.Ollama). So the option survives and the pretence of ownership does not.


    /// <summary>A sentence for a layer whose saved backend no longer exists, or null.
    ///
    /// <para>The alternative is a silent fallback, which for 判断 means quietly spending account quota
    /// nobody chose and for 语义 means the layer switching itself off — both invisible. Naming the retired
    /// backend matters as much as naming the fix: a household who set this up deliberately should not have
    /// to guess why it changed.</para></summary>
    private static string? RetiredNote(string? savedSource, string layer)
    {
        if (!MemoryBackends.IsRetired(savedSource)) return null;
        var was = string.Equals(savedSource, MemoryBackends.Ollama, StringComparison.OrdinalIgnoreCase)
            ? "本机 Ollama" : "自填地址的本机服务";
        return $"这一层原来用的是「{was}」,这个版本不再连接外部服务 —— "
            + (layer == MemoryLayers.Judge
                ? "请改选「Claude CLI」,或在「资源」面板下载 llama.cpp 的对话模型后选「llama.cpp」。"
                : "请改选「llama.cpp」(在「资源」面板下载嵌入模型),或选「内置」只用公式检索。");
    }

    /// <summary>Is the bound 语义 arm actually doing anything right now?
    ///
    /// <para>Two different questions behind one word, which is why this is not just a null check on
    /// <c>_semantic</c>: an embedder arm is running when the container holds one, and a write-time arm is
    /// running as soon as it is saved.</para></summary>
    private bool SemanticIsRunning(Sources.IMemorySemanticSource? bound) =>
        bound is not null && (!bound.TakesEffectOnRestart || _semantic is not null);

    /// <summary>Project a <see cref="RuntimeOrigin"/> for the wire. A named projection rather than an
    /// inline anonymous object because a DECLINED backend needs one too — it has no source to ask, so the
    /// two call sites must agree on the shape, and an anonymous type in each would not make them.</summary>
    private static object Origin(RuntimeOrigin o) => new { kind = o.Kind, text = o.Text };

    /// <summary>The three headings a layer offers, each with its member backends nested.
    ///
    /// <para><b>The probes run CONCURRENTLY, and how long each took is logged.</b> Every source answers by
    /// asking something outside this process — spawn the CLI, GET Ollama's tag list, GET the llama router,
    /// stat a model directory — so serialized they ADD UP, and this endpoint is what the panel blocks on
    /// before it can draw anything. Two layers × four backends × (status + models) is sixteen round trips
    /// for one screen. They are independent by construction (a backend answers about its own runtime), so
    /// the total is a max rather than a sum, and a single slow backend can no longer hold the other seven
    /// behind it.</para>
    ///
    /// <para>The timing line is not decoration: a household reporting "the panel is slow" is reporting a
    /// number nobody could see, and the answer is always WHICH backend — which is exactly what a probe
    /// cannot tell you once its cost has been summed into everyone else's.</para></summary>
    private static async Task<object[]> BackendGroups(
        IEnumerable<IMemorySource> sources, IEnumerable<DeclinedBackend> declined, MemorySourceContext ctx,
        string layer, ILogger log)
    {
        // (rank, view) so the two loops below can append in whatever order they like and the result still
        // comes out in MemoryBackends.Order — see there for why the order is FIXED rather than
        // usable-ones-first.
        var views = new List<(int Rank, string Group, object View)>();
        var timings = new List<(string Id, long Ms)>();
        // One task per source. Ordering is restored by Rank below, so finishing out of order is fine —
        // which is the property that lets this be concurrent at all.
        var probes = sources.Select(async s =>
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            // A source that THROWS must not take the panel down with it: the whole point of this surface is
            // to explain a backend that is not working, and an exception here would replace all three
            // headings with a 500 — the failure mode where the household loses the screen that would have
            // told them what was wrong.
            SourceStatus status;
            IReadOnlyList<ModelOption> models;
            try
            {
                status = await s.StatusAsync(ctx);
                models = await s.ModelsAsync(ctx);
            }
            catch (Exception ex)
            {
                log.LogWarning(ex, "记忆检索:{Layer} 的后端 {Backend} 探测失败", layer, s.Id);
                status = new SourceStatus(false, $"检查 {s.Name} 时出错了 —— 详情见「日志」。");
                models = Array.Empty<ModelOption>();
            }
            return (Source: s, Status: status, Models: models, Ms: clock.ElapsedMilliseconds);
        }).ToArray();

        foreach (var (s, status, sourceModels, ms) in await Task.WhenAll(probes))
        {
            timings.Add((s.Id, ms));
            views.Add((MemoryBackends.Rank(s.Id), s.Group, new
            {
                id = s.Id, name = s.Name, description = s.Description, bindable = true,
                available = status.Available, reason = status.Reason, suggest = status.Suggest,
                // Does the household have to supply an address, and what did they supply? The RAW value,
                // not the resolved one: a refused URL must come back so the box shows what was typed
                // beside the sentence explaining why it was refused.
                needsEndpoint = s.NeedsEndpoint,
                endpoint = s.NeedsEndpoint ? RawEndpoint(ctx.Config, layer) : null,
                // WHOSE runtime this is. Sent for every backend because the answer is the household's
                // question — "do I have to install something?" — and the panel used to answer it only by
                // accident, in a failure message. `kind` for styling, `text` for reading; the source writes
                // the sentence because only it knows whether "the app installs this" describes or promises.
                group = s.Group,
                origin = Origin(s.Origin(ctx)),
                models = sourceModels.Select(m => new
                {
                    id = m.Id, name = m.Name, installed = m.Installed, sizeBytes = m.SizeBytes,
                    note = m.Note, vintage = m.Vintage,
                    measured = m.Measured is null ? null : new
                    {
                        top1 = m.Measured.RecallTop1, top3 = m.Measured.RecallTop3,
                        queries = m.Measured.Queries, msPerQuery = m.Measured.MsPerQuery,
                    },
                }),
            }));
        }
        foreach (var d in declined)
        {
            views.Add((MemoryBackends.Rank(d.Id), d.Group, new
            {
                id = d.Id, name = d.Name, description = d.Reason, bindable = false,
                available = false, reason = d.Reason, suggest = (string?)null,
                needsEndpoint = false, endpoint = (string?)null,
                // NULL, not a guess. A declined backend has no source to ask, and there is no runtime
                // behind it to have an origin — inventing one ("应用可以下载并运行") would promise something
                // that cannot happen, which is the shape of claim this panel exists to refuse. The client
                // renders nothing rather than a placeholder.
                group = d.Group,
                origin = (object?)null,
                models = Enumerable.Empty<object>(),
            }));
        }
        // WHICH backend cost what. Slowest first, because that is the only ordering anybody reads this for.
        // Information rather than Debug when it is slow: this is the number a household is describing when
        // they say the panel hangs, and a level nobody turns on cannot answer them.
        var total = timings.Sum(t => t.Ms);
        var breakdown = string.Join(", ", timings.OrderByDescending(t => t.Ms).Select(t => $"{t.Id} {t.Ms}ms"));
        if (total >= 1000) log.LogInformation("记忆检索:{Layer} 探测耗时 {Total}ms — {Breakdown}", layer, total, breakdown);
        else log.LogDebug("记忆检索:{Layer} 探测耗时 {Total}ms — {Breakdown}", layer, total, breakdown);

        // THE THREE HEADINGS, each carrying its members — see MemoryGroups for why the picker groups.
        //
        // Name and sentence come from MemoryGroups rather than from the console: a group is a product
        // statement about who manages a model, and the client re-deriving those words would be a second
        // writer of them. What the client still works out is whether a group is USABLE, which is only
        // "does any member say so" — and the member already answers it.
        //
        // A group with no members is OMITTED rather than rendered empty. That is not the same as hiding a
        // declined backend: a declined member still appears under its group carrying its reason, because
        // "why can Claude not embed?" has an answer worth showing. A group nothing belongs to has none.
        //
        // OrderBy is stable, so two members of equal rank (an id nobody listed) keep their arrival order.
        return MemoryGroups.Order
            .Select(g => new
            {
                id = g,
                name = MemoryGroups.Name(g),
                description = MemoryGroups.Description(g),
                sources = views.Where(v => v.Group == g).OrderBy(v => v.Rank)
                    .Select(v => v.View).ToArray(),
            })
            // A group with no members is omitted — EXCEPT `none`, whose emptiness is its meaning: it
            // offers no backend because choosing it is choosing not to have one. Without this exception the
            // option would vanish from the picker and "turn this layer off" would go back to living in a
            // separate button, which is what made a model look mandatory.
            .Where(x => x.sources.Length > 0 || x.id == MemoryGroups.None)
            .Cast<object>()
            .ToArray();
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
                    // The two arms fail differently and must SAY so: an embedder that returned no
                    // vector is a wrong-model-or-daemon-down problem, and a CLI that produced no phrasings
                    // is a login-or-model problem. One message covering both describes neither.
                    error = source.Id == MemoryBackends.ClaudeCli
                        ? $"{model} 没能改写出别的说法 —— 请确认 Claude CLI 已登录,或换一个模型。"
                        : $"{model} 没有返回向量 —— 它可能不是嵌入模型,或 Ollama 未运行。"
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
            var modelChanged = previous is not null && !ModelId.Matches(previous, model!);
            _log.LogInformation("semantic recall bound to {Source}/{Model} ({Dims}d)",
                source.Id, model, probe.Dimensions);

            return Ok(new
            {
                // An arm that registers nothing is live on the next WRITE, so telling the household to
                // restart would be asking for something that changes nothing. The reindex is still offered:
                // phrasings attach as facts are written, so what they already know needs a pass to gain them.
                ok = true, layer, source = source.Id, model,
                restartRequired = source.TakesEffectOnRestart, reindexRequired = true,
                // `proved` says what the number IS: a vector width for an embedding arm, "phrasings" for
                // the CLI one. Without it `dimensions: 4` from a rephrasing probe reads as a 4-dimensional
                // embedding, which is the kind of confident-and-wrong label this surface keeps removing.
                modelChanged, dimensions = probe.Dimensions, proved = probe.What ?? "dimensions",
                probeMs = probe.Milliseconds,
                catalogued = EmbeddingCatalog.Find(model) is not null,
                // The note is DERIVED from the same flag the caller is handed, not a fixed sentence
                // beside it. It read "重启服务后生效" unconditionally while `restartRequired` said false
                // for the CLI arm — the response contradicting itself in the one field a household
                // actually reads. That arm registers nothing and is read per write, so telling someone to
                // restart is both wrong and a reason to distrust the rest of the message.
                note = source.TakesEffectOnRestart
                    ? "设置已保存。重启服务后生效,然后请重新建立一次语义索引。"
                    : "设置已保存,立即生效。现有的事实还没有改写说法 —— 请重新建立一次语义索引,"
                        + "只补写检索用的说法,不会动图谱已经学到的东西。",
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
        // OFF STOPS IT PRODUCING; IT DOES NOT RETRACT WHAT IT PRODUCED — and saying so is the whole point
        // of this note. Phrasings live in `knowledge.aka`, which the FTS table indexes unconditionally, so
        // facts already expanded keep matching on their stored wordings after the layer is off. Found by
        // measuring the arm and then turning it off: 15 facts were still matching, with nothing anywhere
        // saying they would.
        //
        // Stated rather than "fixed" by deleting them, because the persistence has a real upside: turning
        // the layer back on costs nothing to re-derive, and re-deriving is ~46 s per fact. An undisclosed
        // effect is the defect here, not the effect itself. A CLEAR action is a separate decision — it
        // turns on whether phrasings are the layer's output or part of the fact — and inventing one inside
        // an "off" button would answer that question by accident.
        return Ok(new
        {
            ok = true, layer, restartRequired = true,
            note = "已停用:不会再为新事实生成说法。已经写入的说法仍留在检索索引里,继续参与匹配 —— "
                + "所以之后重新启用不需要再花时间重建。",
        });
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
