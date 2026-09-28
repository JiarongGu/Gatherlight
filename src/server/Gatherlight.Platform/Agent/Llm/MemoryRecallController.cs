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
    // The reranker judge's pace, when one is running: its skip count is the one place a skipped recall becomes visible.
    private readonly RerankPace? _pace;
    // What 语义 is RUNNING on — the embedder arm and model wired at startup — as opposed to what is saved.
    private readonly MemorySemanticWiring? _semanticWiring;

    public MemoryRecallController(IClaudeCliRuntime claude,
        ILlamaServerRuntime llama, ServerConfigService config,
        Storage.Knowledge.Services.IFactIndex facts, IAppConfigService appConfig,
        Storage.Knowledge.Services.IKnowledgeStore knowledge,
        IReindexStatus reindex,
        MemoryJudgeWiring judgeWiring, IPlatformContext platform,
        ILogger<MemoryRecallController> log,
        Lyntai.Memory.ISemanticMemory? semantic = null,
        Lyntai.Inference.ITextClient? llm = null,
        RerankPace? pace = null,
        MemorySemanticWiring? semanticWiring = null)
    {
        _pace = pace;
        _semanticWiring = semanticWiring;
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
        var boundJudgeModel = MemorySources.ResolveJudgeModel(Settings());
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

        // WHETHER TAGGING IS HAPPENING, for a judge that only checks: a reranker hands tagging to the CLI, and a
        // CLI that is signed out means none at all, fail-open and unreported. From the CACHED probe — the CLI
        // arm's status above has just refreshed it — and nothing when nobody has probed yet: no guessing.
        var runningJudge = MemorySources.FindJudge(_judgeWiring.Transport);
        var tagging = MemoryEnrichment.IsOn(_appConfig) && runningJudge is not null
            && _judgeWiring.Model is { } runningModel && runningJudge.ChecksOnly(runningModel)
                ? MemorySources.CliTaggingNow(_claude.Cached)
                : null;

        // WHETHER THE JUDGE HAS BEEN SKIPPED, and what to try instead. A recall the reranker's pace skips — this machine
        // too slow for one window per candidate — is NoOpinion at once, and otherwise visible only as an Information line in
        // state/logs: fail-open and unreported. Read from the pace's own counter, which is a lock and an array: nothing
        // awaited. Shown only when there were skips; the smaller reranker offered unless it is what runs, or is already
        // downloaded — then there is nothing to fetch (GgufCatalog.SkipNotice, RecommendedRerankerFor).
        object? paceView = null;
        if (MemoryEnrichment.IsOn(_appConfig) && _pace?.RecentSkips is { Skipped: > 0 } skips)
        {
            // The one writer 资源's badge reads too; with skips it names the small reranker whatever the device probe says.
            var small = GgufCatalog.RecommendedRerankerFor(_llama.Gpu, skippedHere: true);
            // "What runs" in EITHER runtime: the 内置 reranker is mMiniLMv2 too, and offering it again beside itself — as
            // "a smaller reranker, 28% of BGE" — would advise a download of the model that is already skipping.
            var offerSmall = !MemorySources.RunsModel(_judgeWiring.Model, small)
                && !Hosting.Resources.Services.ResourceProvisioner.InstalledGgufIds(_platform.ResourcesPath)
                    .Contains(small, StringComparer.OrdinalIgnoreCase);
            paceView = new
            {
                skipped = skips.Skipped, recalls = skips.Recalls,
                text = GgufCatalog.SkipNotice(skips.Skipped, skips.Recalls, offerSmall),
                // A RESOURCE id, as a source's own suggestion is — the 资源 row that downloads it.
                suggest = offerSmall ? GgufCatalog.ResourceIdFor(small) : null,
            };
        }

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
                    // top of the page. How it gets there is Lyntai's GraphMemoryEngine.ApplyVerdict: the
                    // endorsed candidates are PROMOTED ahead of the rest before the cut, the engine's own order
                    // kept within each group, and reinforcement follows the endorsed set. (This comment once
                    // credited the move to reinforcement alone; reinforcement comes after, the promotion is what
                    // moves the page.)
                    // Both measurements stand together: the judge CAN move a result, and on this corpus it
                    // moved nothing, because it endorsed what already ranked top. So the honest sentence
                    // describes what it does and declines to promise an improvement nobody has measured.
                    // …and it was wrong a THIRD way: 「在本机现有的事实上实测过:排序结果与关闭时相同」 quoted ONE
                    // household's 16 facts to every household, measured while the judge still saw only topics.
                    // The mechanism is Lyntai's partition — an endorsed fact is promoted to the front, in the
                    // engine's own order — and the numbers now come from the committed bilingual fixture anyone
                    // can re-run (docs/judge-bench.md, Runs 1 and 11, `all` set): the two judges move different
                    // things, which is the one sentence a household choosing between them needs.
                    // The Claude figure is Run 1's CONTENT-ONLY arm (130), the judge input that ships since
                    // 2026-09-24 — not its `content` arm (topic — content, 132), the 1.3.0 input, measured
                    // equivalent to it. A number belongs to its configuration.
                    // The reranker range spans the THREE catalogued rerankers, each under partition with 语义 off
                    // and 8 endorsed = the page: found@8 203 (mMiniLMv2) to 208 (BGE), top-1 +9 (LAMAR, 89) to +20
                    // (mMiniLMv2, 100), against the no-judge 127 / 80 — docs/judge-bench.md Run 11, on Lyntai 3.5.1. It
                    // read 199–208 / 7–20 from 125 / 79 (Runs 2 and 4, on 3.2) until then, and 203–208 / 7–11 until
                    // mMiniLMv2 was catalogued — a range quoted for "the local rerankers" has to cover every one the
                    // picker offers.
                    // TWO BASES, SAID AS TWO. The Claude judge was not re-run on 3.5.1 (no quota), so its 79 → 130 stays
                    // Run 1's, on the earlier engine, where even the no-judge floor differs (79 against 80). The
                    // sentence says each result against its own version's no-judge count, and says which one is the
                    // earlier version, rather than letting a household read 79 and 127 as one baseline.
                    what = "写入事实时标注主题(让讲同一件事的记录彼此关联);检索时判断哪些结果真正回答了问题,"
                        + "被判断为「答到了」的事实会排到前面,也更容易被后续检索记住。"
                        + "在本应用 240 题的双语测试集上实测(不开语义),各自和同一版本里不开判断时比:"
                        // "llama.cpp 上的", not 「本机」: since round 6 the local rerankers include the in-process 内置 one,
                        // which is NOT measured (Run 13), so a range quoted for "the local rerankers" would claim it.
                        + "llama.cpp 上的重排模型(每次挑 8 条上页)让答案进入前八的次数从 127 题增加到 203–208 题,排第一的多 9–20 题"
                        + "(在应用进程里运行的「内置」重排模型还没有实测过);"
                        + "Claude CLI 判断是在本应用较早的版本上量的,让排第一的答案从那时不开判断的 79 题增加到 130 题。"
                        + "每次检索都要等它一次,这一点是当场就有的。",
                    // COST IS TWO THINGS, and only one of them was stated. The token cost was here from the
                    // start; the LATENCY was measured later, on this household's own facts.
                    //
                    // TWO MEASURED WAITS, each with its configuration. Five paired runs on one household's own 16
                    // facts (2026-08-23, the judge still reading topics only) gave 8.9, 14.9, 15.1, 16.5 and 16.9 s
                    // against a 公式 floor of 68–90 ms; this line once said "约 9 秒" — the fastest reading of the
                    // five, the best case quoted as if it were the case — and then quoted the range, 9–17 s, with no
                    // configuration at all, while the model notes in the same picker quoted docs/judge-bench.md Run
                    // 1's 8.7 s. Now both are quoted, each where it was measured: the fixture's serial median (240
                    // questions, 语义 off, Haiku, content only — MemorySources.ClaudeJudgeWaitMeasured, the one
                    // writer every row quoting it reads) beside its own no-judge floor, and the household range beside
                    // its own. Neither alone is "the" wait: the cost is a CLI process spawn per call, so a figure is
                    // one machine on one afternoon. It is OUR number, so unlike the weighting note below it needs no
                    // attribution.
                    // The local arm avoids the spawn, and its latency IS quoted now that it has been measured —
                    // this comment said "deliberately NOT quoted, nobody has measured it" long after it had
                    // been. Two figures, of two kinds, both docs/judge-bench.md Run 11 (Lyntai 3.5.1, the 240-question
                    // fixture, serial medians, model warm on one GPU): LlamaCppSource.Description quotes the ADDED cost
                    // per recall — +0.08–0.14 s for the chat judges, +0.10–0.22 s for the rerankers — and each model's
                    // note quotes a whole RECALL beside its own run's no-judge one: ~0.34 s (Gemma 3 1B) and ~0.38 s
                    // (Qwen3 0.6B) against ~0.25–0.26 s, a reranker ~0.34–0.46 s against ~0.25 s, the rerankers' with
                    // their conditions. This said the Description quoted a chat judge's CALL, 150–204 ms, long after it
                    // moved to the per-recall figure (2026-09-24). Every figure carries its source; a plausible one
                    // without is still the thing this panel refuses.
                    // The texts live on each source's `Cost` (IMemoryJudgeSource) — the bound arm describes itself.
                    cost = boundJudge.Cost(boundJudgeModel),
                    source = boundJudge.Id, model = boundJudgeModel,
                    activeSource = _judgeWiring.Transport, activeModel = _judgeWiring.Model,
                    groups = judgeGroups,
                    // A saved backend that no longer exists is SAID, never silently
                    // swapped — see RetiredNote.
                    retired = RetiredNote(mem.JudgeSource, MemoryLayers.Judge),
                    // Null unless the running judge only checks AND the CLI's state is known.
                    tagging = tagging is null ? null : new { works = tagging.Works, text = tagging.Text },
                    // Null unless the reranker's pace skipped recent recalls — see paceView.
                    pace = paceView,
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
                    activeSource = RunningSemantic(boundSemantic).Source,
                    activeModel = RunningSemantic(boundSemantic).Model,
                    groups = semanticGroups,
                    // A saved backend that no longer exists is SAID, never silently
                    // swapped — see RetiredNote.
                    retired = RetiredNote(mem.SemanticSource, MemoryLayers.Semantic),
                    // What the reindex costs and keeps, FOR THE BOUND ARM — the cost line's rule. It said "会重新计算全部
                    // 向量,并重置已积累的排序权重" for every arm: false for the CLI arm always (it writes a column and never
                    // touched the graph), and false for an embedder since the Lyntai 3.5 bump, which re-embeds in place.
                    note = ReindexNote(boundSemantic),
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
    // Ollama itself stopped being a backend the same day, and so did `openai-compat`, the generic arm that
    // could have reached a household's own Ollama by address: it was never tested end to end, and shipping an
    // option we could not stand behind was worse than not offering it (see MemoryBackends.IsRetired). A
    // layer still bound to either is SAID, never silently redirected — see RetiredNote below.


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
        // Named the way the household SEES them: the picker shows the three GROUPS (Claude CLI · 本机模型 ·
        // 不用模型) and then MODEL names — 「内置」 is how the built-in embedder is named there and in 资源, while
        // "llama.cpp" and "ONNX" are backend names that reach the screen only in the running-backend badge.
        // 语义's advice used to end 「或选「内置」只用公式检索」 — 内置 in its OLD meaning, the no-model group,
        // which is 「不用模型」 now: it would have bound an embedder while promising formula only.
        return $"这一层原来用的是「{was}」,这个版本不再连接外部服务 —— "
            + (layer == MemoryLayers.Judge
                ? "请改选「Claude CLI」,或在「资源」面板下载一个对话模型或重排模型后,在「本机模型」里选它。"
                : "请在「本机模型」里选一个嵌入模型(llama.cpp 的,或「内置」的;都在「资源」面板下载),"
                  + "或选「不用模型」只用公式检索。");
    }

    /// <summary>Is the bound 语义 arm actually doing anything right now?
    ///
    /// <para>Two different questions behind one word, which is why this is not just a null check on
    /// <c>_semantic</c>: an embedder arm is running when the container holds one, and a write-time arm is
    /// running as soon as it is saved.</para></summary>
    private bool SemanticIsRunning(Sources.IMemorySemanticSource? bound) =>
        bound is not null && (!bound.TakesEffectOnRestart || _semantic is not null);

    /// <summary>What 语义 is RUNNING on, in the saved setting's vocabulary: a write-time arm as saved; an embedder arm as
    /// WIRED at startup (<see cref="MemorySemanticWiring"/>), which after a bind names the model still doing the work until
    /// the restart — so the panel's saved-versus-running comparison shows the restart owed, where it used to report the
    /// saved model as running and a model change looked applied.</summary>
    private (string? Source, string? Model) RunningSemantic(Sources.IMemorySemanticSource? bound)
    {
        if (!SemanticIsRunning(bound)) return (null, null);
        if (!bound!.TakesEffectOnRestart || _semanticWiring?.Source is null) return (bound.Id, _config.Current.Memory.EmbeddingModel);
        return (_semanticWiring.Source, _semanticWiring.Model);
    }

    /// <summary>Is the bound EMBEDDER the one wired at startup — same arm, same model? False between a bind and the
    /// restart that wires it (or while a bound model was missing when the container was built). A reindex in that window
    /// would re-embed every entry with the OLD model and report success.</summary>
    private bool BoundEmbedderIsRunning(Sources.IMemorySemanticSource bound) =>
        _semantic is not null && _semanticWiring?.Source is { } wired
        && string.Equals(wired, bound.Id, StringComparison.OrdinalIgnoreCase)
        && _semanticWiring.Model is { } running && _config.Current.Memory.EmbeddingModel is { } saved
        && ModelId.Matches(running, saved);

    /// <summary>Project a <see cref="RuntimeOrigin"/> for the wire. A named projection rather than an
    /// inline anonymous object because a DECLINED backend needs one too — it has no source to ask, so the
    /// two call sites must agree on the shape, and an anonymous type in each would not make them.</summary>
    private static object Origin(RuntimeOrigin o) => new { kind = o.Kind, text = o.Text };

    /// <summary>The three headings a layer offers, each with its member backends nested.
    ///
    /// <para><b>The probes run CONCURRENTLY, and how long each took is logged.</b> Every source answers by
    /// asking something outside this process — spawn the CLI, GET the llama router,
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
                description = MemoryGroups.Description(g, layer),
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
    /// <para>Keyed on the LAYER, not on the source's type: a source may implement both layer interfaces (the
    /// retired <c>openai-compat</c> did, and <see cref="LlamaCppSource"/> does), so a type test would answer the
    /// same for both of its instances — which is exactly the class this has to get right.</para></summary>
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
        // A bind can start llama.cpp — or restart it, to load a model downloaded after it started — and a start the app
        // performs measures a reranker's devices first, a minute or more (RerankDeviceMeter). The household waited through
        // it, so the toast says where the time went: on the note, and on a refusal too — the results stand either way
        // (final review; the start button's clause, one writer).
        using var capture = RerankMeasurementCapture.Begin();
        var result = await BindCoreAsync(layer, body);
        return capture.Report is { } ran ? WithMeasured(result, RerankDeviceNotes.MeasuredBeforeStart(ran, bind: true)) : result;
    }

    /// <summary><paramref name="result"/> with <paramref name="measured"/> appended to the sentence the console shows —
    /// <c>note</c> on success, <c>error</c> on a refusal — and carried as <c>measured</c>, as the start button does.</summary>
    private static IActionResult WithMeasured(IActionResult result, string measured)
    {
        if (result is not ObjectResult { Value: { } value } o
            || System.Text.Json.JsonSerializer.SerializeToNode(value, WireJson) is not System.Text.Json.Nodes.JsonObject body)
            return result;
        var field = o.StatusCode is null or < 300 ? "note" : "error";
        body[field] = (body[field]?.GetValue<string>() ?? "") + measured;
        body["measured"] = measured;
        return new ObjectResult(body) { StatusCode = o.StatusCode };
    }

    private static readonly System.Text.Json.JsonSerializerOptions WireJson = new(System.Text.Json.JsonSerializerDefaults.Web);

    private async Task<IActionResult> BindCoreAsync(string layer, BindRequest? body)
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

            // The resolver keeps a binding only while its model is one of this layer's files (HasModel), so bind
            // asks the same of the NEW model — or a model the router happened to list (llama.cpp's own cache)
            // would bind here and silently fall back at the next restart. Asked before anything calls the router.
            if (!source.HasModel(Settings(), model!))
                return StatusCode(409, new { error = source.WhyNotHere(Settings(), model!) + "。" });

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
            // The ANNOTATION route — for a reranker that is the CLI's model on the CLI, never the reranker's id
            // (JudgeWiring). Provider AND model, so a router reads it only when it holds that provider: one that
            // does not — the running judge's, before the restart that wires a different backend — ignores it with a
            // warning and keeps its own wiring's model. A route a FALLBACK strands is dropped at the next start
            // (LiveRouteMigrationStep), so that warning never becomes one per call for as long as the fallback lasts.
            LiveRoutes.Set(_appConfig, LiveRoutes.Memory, source.AnnotationProvider(model!), source.AnnotationModel(model!));
            _log.LogInformation("memory judge bound to {Source}/{Model}", source.Id, model);

            // …and whether that tagging will HAPPEN: a signed-out or missing CLI means none, which the toast's
            // first sentence would otherwise promise. Said only when the cached probe knows — never guessed.
            var taggingOff = source.ChecksOnly(model!) && MemorySources.CliTaggingNow(_claude.Cached) is { Works: false } off
                ? " " + off.Text : "";

            return Ok(new
            {
                ok = true, layer, source = source.Id, model, restartRequired = true,
                // What the binding MOVES, asked of the source: a reranker takes over only the checking, and
                // saying "标注与核对" for it told the household the opposite of the cost line beside it.
                // No 仍 ("still"), and the content leaving the machine is SAID: a household moving here from a
                // local chat judge is sending facts to Claude for the first time, and this is where they learn it.
                // The tagging clause is MemorySources.CliTaggingCost — the same one the cost line and the model
                // note carry, so the three cannot disagree about whether the account is spent.
                // …and, last, what the SOURCE says a household must know on choosing it (BindCaveat): 内置's reranker says
                // it is unmeasured, which is why nothing recommends it.
                note = (source.ChecksOnly(model!)
                    ? $"设置已保存。重启服务后,检索时的核对将由这个模型完成;写入事实时的主题标注由 Claude CLI"
                      + $"({source.AnnotationModel(model!)})完成 —— {MemorySources.CliTaggingCost}。{taggingOff}"
                    : "设置已保存。重启服务后,标注与核对将由这个后端完成。")
                    + (source.BindCaveat(model!) is { } caveat ? " " + caveat : ""),
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

            // Same rule as 判断: what bind accepts, the resolver must keep (HasModel).
            if (!source.HasModel(Settings(), model!))
                return StatusCode(409, new { error = source.WhyNotHere(Settings(), model!) + "。" });

            // PROVE it embeds before saving. Installed is not usable, and the failure would surface only as
            // recall that finds nothing — indistinguishable from a household that knows nothing.
            // The source's own refusal first — it can name the cause and the cure, where a failed proof can only
            // say "no vector".
            if (await source.WhyNotAsync(ctx, model!) is { } why) return StatusCode(409, new { error = why });
            var probe = await source.ProveAsync(ctx, model!);
            if (probe is null)
                return StatusCode(409, new
                {
                    // The arms fail differently and must SAY so, and the SOURCE says it — see
                    // IMemorySemanticSource.ProveFailed. A branch on the source's id here was the if/else chain
                    // the catalog exists to replace.
                    error = source.ProveFailed(model!),
                });

            var previous = _config.Current.Memory.EmbeddingModel;
            var previousSource = _config.Current.Memory.SemanticSource;
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
            // THE RESTART RE-EMBEDS, now that a re-embed is in place and loses nothing (Lyntai D194). An embedder arm newly
            // bound, or bound to a different model, owes every entry a vector from THIS model: the layout marker records
            // it (FactIndexLayout.VectorsOwed) and the start that wires the model re-embeds in place (FactIndexStep) — no
            // reindex to remember afterwards, and none possible before it (the endpoint refuses while the bound embedder
            // is not the running one). Recorded over the current layout or an owed one — including a console pass's token,
            // which that pass then fails to swap back (its compare-and-set), so a bind landing mid-pass is not lost.
            // Any other value already makes the next start rebuild, which re-embeds too.
            var owesVectors = source.TakesEffectOnRestart && (previous is null || modelChanged
                || !string.Equals(previousSource, source.Id, StringComparison.OrdinalIgnoreCase));
            if (owesVectors && _appConfig.Get(Storage.Knowledge.Services.FactIndexLayout.Key) is { } marker
                && (marker == Storage.Knowledge.Services.FactIndexLayout.Current
                    || Storage.Knowledge.Services.FactIndexLayout.IsVectorsOwed(marker)))
                _appConfig.Set(Storage.Knowledge.Services.FactIndexLayout.Key,
                    Storage.Knowledge.Services.FactIndexLayout.VectorsOwed);
            _log.LogInformation("semantic recall bound to {Source}/{Model} ({Dims}d){Owed}",
                source.Id, model, probe.Dimensions, owesVectors ? "; the next start re-embeds every entry" : "");

            return Ok(new
            {
                // An arm that registers nothing is live on the next WRITE, so telling the household to
                // restart would be asking for something that changes nothing. The reindex is still offered:
                // phrasings attach as facts are written, so what they already know needs a pass to gain them.
                // An embedder arm needs no reindex from the household any more: the restart re-embeds (vectorsOwed).
                ok = true, layer, source = source.Id, model,
                restartRequired = source.TakesEffectOnRestart, reindexRequired = !source.TakesEffectOnRestart,
                vectorsOwed = owesVectors,
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
                note = !source.TakesEffectOnRestart
                    ? "设置已保存,立即生效。现有的事实还没有改写说法 —— 请重新建立一次语义索引,"
                        + "只补写检索用的说法,不会动图谱已经学到的东西。"
                    : owesVectors
                        ? "设置已保存。重启服务后生效 —— 重启时会自动为已有的事实重新计算向量,不需要再手动重建索引。"
                        : "设置已保存。重启服务后生效。",
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

    /// <summary>Re-derive 语义's material over every fact: for an embedder arm, re-embed the graph IN PLACE (Lyntai D194)
    /// and back-fill any fact with no index entry; for the Claude CLI arm, store phrasings. Needed on first bind — the
    /// graph is already populated, so the ordinary back-fill (which touches only rows with no ref) would embed nothing —
    /// and after any model change.</summary>
    [HttpPost("api/manage/memory/layer/semantic/reindex")]
    public async Task<IActionResult> Reindex(CancellationToken ct)
    {
        var bound = MemorySources.ResolveSemantic(Settings());
        if (bound is null)
            return StatusCode(409, new { error = "「语义」这一层尚未启用。" });
        // THE BOUND EMBEDDER MUST BE THE RUNNING ONE. An embedder is wired at startup, so between a bind and its restart
        // a pass would re-embed every entry with the OLD model, report success and record the vectors as current — and
        // after the restart they were the wrong width, semantic recall empty without a word. Refused, and nothing is
        // touched: the bind recorded the vectors as owed, so the restart re-embeds on its own. Proof: e2e-p52 case 11d.
        if (bound.TakesEffectOnRestart && !BoundEmbedderIsRunning(bound))
            return StatusCode(409, new { error = "请先重启服务 —— 新的嵌入模型要在重启后才会生效;重启时会自动为已有的事实"
                + "重新计算向量,不需要再手动重建。" });
        // GATED, like both back-fills (IFactIndex.EmbedderReadyAsync) and BEFORE anything is touched — the layout marker
        // included. A re-embed in place loses nothing when the embedder is down (each entry keeps the vector it had), so
        // this no longer protects the index the way it did when the pass was a destructive rebuild; what it spares is a
        // pass that computes no vector, the marker left owed for the next start, and the back-fill after it, which would
        // re-remember — and annotate, with 判断 on — facts whose writes lose their vector again. Asked for an EMBEDDER arm
        // only: the CLI rephrasing arm's pass embeds nothing, and between a rebind to it and the restart the embedder still
        // wired is the one it replaced, whose outage would refuse a pass that never calls it. Proof: e2e-p52 case 9 (a
        // reindex while the fake refuses embeds is refused, and every ref is kept) and case 11e (the rephrasing arm).
        if (bound.TakesEffectOnRestart && !await _facts.EmbedderReadyAsync(ct))
            return StatusCode(409, new { error = "「语义」的嵌入模型现在没有响应 —— 现在重建算不出任何向量,所以没有开始"
                + "(已有的向量和索引都没有动)。等它恢复后再重建。" });
        if (!_reindex.TryStart())
            return StatusCode(409, new { error = "已经有一次重建在进行中。" });

        // Read NOW, for the back-fill stage's sentence: that stage's writes are annotated exactly when 判断 is on.
        var judgeOn = MemoryEnrichment.IsOn(_appConfig);
        // DETACHED, and deliberately not tied to the request's CancellationToken: the work outlives the
        // POST, so binding it would cancel the pass the moment the browser stopped waiting — which is
        // precisely what happens on an operation this long. Progress is read back from GET /api/manage/memory.
        _ = Task.Run(async () =>
        {
            try
            {
                var result = await _facts.ReindexSemanticAsync(CancellationToken.None,
                    new Relay<Storage.Knowledge.Services.SemanticReindexProgress>(p => ReportStage(p, judgeOn)));
                var (error, summary) = ReindexOutcome(result);
                _reindex.Finish(result.Rederived, error, summary);
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

    /// <summary>The running sentence for each stage the fact index reports. The re-embed is ONE engine call that reports
    /// nothing on the way, so it is shown as indeterminate (total 0 — a bar pinned at 0% reads as stuck) with the count in
    /// the sentence; the back-fill and the phrasings count fact by fact.</summary>
    private void ReportStage(Storage.Knowledge.Services.SemanticReindexProgress p, bool judgeOn)
    {
        switch (p.Stage)
        {
            case Storage.Knowledge.Services.SemanticReindexStage.Reembed:
                _reindex.Report(0, 0, $"正在原地重新计算 {p.Total} 条事实的向量 —— 每条一次嵌入,不调用模型标注,"
                    + "已学到的排序、关联和主题都保留……");
                break;
            case Storage.Knowledge.Services.SemanticReindexStage.BackFill:
                _reindex.Report(p.Done, p.Total, $"补建之前没有索引的事实:{p.Done}/{p.Total} 条"
                    + (judgeOn ? " · 开启了判断,这些事实每条会多一次模型调用" : ""));
                break;
            default:
                _reindex.Report(p.Done, p.Total, $"补写检索用的说法:{p.Done}/{p.Total} 条事实 · 每条一次 Claude 调用");
                break;
        }
    }

    /// <summary>How a finished pass is told: an error for one that did not do its job, else a summary. Read off
    /// <see cref="Storage.Knowledge.Services.IFactIndex.ReindexSemanticAsync"/>'s result.</summary>
    private static (string? Error, string? Summary) ReindexOutcome(Storage.Knowledge.Services.SemanticReindexResult r)
    {
        var backFilled = r.BackFilled > 0 ? $"另外补建了 {r.BackFilled} 条之前没有索引的事实。" : "";
        return r.Arm switch
        {
            // Nothing bound that a pass could re-derive, as far as the RUNNING process knows — a BACKSTOP, not a path the
            // endpoint reaches: the saved arm is the rephrasing one (which always has work) or an embedder, and an embedder
            // that is not the running one is refused above with 「请先重启服务」 before anything starts. So this is only ever
            // the two views disagreeing, and it says what is true whichever way they do. It used to end 「请重启服务,再重建
            // 一次」, which the restart made false: an embedder bound since this start is re-embedded BY that restart (the
            // bind's owed marker, or a bound model missing at this start — layout "2" — FactIndexStep). A reindex after it
            // has nothing left to do. (It blamed Ollama once, a backend retired on 2026-08-22.)
            null => ("没有建立任何索引:这次启动没有装载嵌入模型,「语义」也没有绑定 Claude CLI,没有可以重新计算的东西。"
                + "刚绑定的嵌入模型要在重启服务后才会装载,重启时会自动为已有的事实计算向量,不需要再手动重建。", null),
            // THE REPHRASING ARM, COUNTED BY WHAT IT STORED. It said 「{N} 条事实补写了检索用的说法」 with N the facts it
            // VISITED — so a signed-out CLI, which rephrases nothing, was reported as having rephrased every fact.
            Storage.Knowledge.Services.SemanticReindexStage.Rephrase when r.Rederived == 0 && r.Failed > 0 => (
                $"没有为任何事实补写说法:{r.Failed} 条都没有成功(详见「日志」)。多半是 Claude CLI 没有登录或调用失败 —— "
                + "可以在「资源 · Resources」查看它的状态,再重建一次。", null),
            Storage.Knowledge.Services.SemanticReindexStage.Rephrase when r.Rederived == 0 => (null,
                "上次重建完成:还没有事实,没有需要补写的说法。"),
            Storage.Knowledge.Services.SemanticReindexStage.Rephrase when r.Failed > 0 => (null,
                $"上次重建完成:为 {r.Rederived} 条事实补写了检索用的说法;{r.Failed} 条没有成功(详见「日志」),"
                + "它们和之前一样能按原文找到。图谱没有改动。"),
            Storage.Knowledge.Services.SemanticReindexStage.Rephrase => (null,
                $"上次重建完成:为 {r.Rederived} 条事实补写了检索用的说法,图谱没有改动。"),
            // Entries failed twice and the embedder then stopped answering a probe. Nothing was lost — a failed entry is
            // left as it was before the pass. "下次启动会自动再试": the marker stays owed when this pass owned it (the
            // current layout, or an owed one), so the next start re-embeds in place; any other marker already makes the
            // next start REBUILD, which re-embeds too — true either way, which is why it names no mechanism.
            _ when !r.Completed && r.Failed > 0 => ($"向量没有全部重新计算:嵌入模型在途中停止了响应({r.Rederived} 条已算好,"
                + $"{r.Failed} 条没算成,保持重建前的样子)。下次启动会自动再试一次;也可以等它恢复后再点「重建索引」。", null),
            // The pass THREW — Lyntai throws when a vector WRITE fails, the index itself being broken — possibly after
            // earlier batches were written, which stay re-embedded; the result cannot say how many. Nothing was forgotten.
            _ when !r.Completed => ("向量没有全部重新计算:重新计算时出了错(详见「日志」)。图谱没有动(已学到的排序和关联都保留),"
                + "部分向量可能已经更新;下次启动会自动再试一次。", null),
            _ when r.Rederived == 0 && r.Failed == 0 => (null,
                "上次重建完成:还没有已索引的事实,没有需要重新计算的向量。" + backFilled),
            _ when r.Failed > 0 => (null, $"上次重建完成:{r.Rederived} 条向量已原地重新计算;{r.Failed} 条没能计算"
                + "(多半是超出了嵌入模型的长度上限,仍能按关键词和图谱找到)。" + backFilled),
            _ => (null, $"上次重建完成:{r.Rederived} 条向量已原地重新计算,已学到的排序、关联和主题都保留。" + backFilled),
        };
    }

    /// <summary>Reports on the caller's thread, in order — <see cref="Progress{T}"/> posts each report to the thread
    /// pool, where a later stage's report can land before an earlier one's.</summary>
    private sealed class Relay<T>(Action<T> report) : IProgress<T>
    {
        public void Report(T value) => report(value);
    }

    /// <summary>What a reindex does for the bound 语义 arm, said where the household decides. Null when nothing is bound.
    /// The timing is PER BACKEND (<see cref="ReembedTiming"/>): only what was measured is quoted, with its configuration.</summary>
    private static string? ReindexNote(Sources.IMemorySemanticSource? bound) => bound is null ? null
        : bound.Group == MemoryGroups.Cli
            ? "开启后请重新建立一次语义索引,为已有的事实补写检索用的说法 —— 每条一次 Claude 调用(消耗账号额度);"
              + "图谱已经学到的排序和关联不受影响。"
            : "开启或更换嵌入模型后,重启服务时会自动为每条已有的事实原地重新计算向量 —— 每条一次嵌入,不调用模型标注;"
              + "已经学到的排序、关联和主题都保留。之前没有索引的事实会顺带补建,开启判断时每条多一次模型调用。"
              + "「重建索引」可以随时再做一次。" + ReembedTiming(bound.Id);

    /// <summary>How long the in-place re-embed takes on <paramref name="sourceId"/>, as measured
    /// (docs/self-managed-llm-runtime.md, 2026-09-27), or that it was not. POST to summary, 100 short facts (21–64
    /// characters): llama.cpp b10549 with EmbeddingGemma-300M Q8_0, 2.6–2.7 s on one discrete GPU and 5.4–5.8 s on the
    /// CPU (<c>device = none</c>); the built-in ONNX EmbeddingGemma-300M q4 in this process — ONNX Runtime's CPU provider,
    /// the only one referenced — 4.5–4.8 s on the same laptop.</summary>
    private static string ReembedTiming(string sourceId) => sourceId switch
    {
        MemoryBackends.LlamaCpp => "llama.cpp 上的 EmbeddingGemma,实测一百条短事实:一块独立显卡约 3 秒,只用 CPU 约 6 秒;"
            + "长的事实会慢一些。",
        MemoryBackends.BuiltIn => BuiltInReembedTiming,
        _ => "这个后端重新计算向量要多久还没有实测过。",
    };

    /// <summary>The built-in embedder's measured figure — see <see cref="ReembedTiming"/>.</summary>
    private const string BuiltInReembedTiming = "应用内置的 EmbeddingGemma 在 CPU 上运行,实测一百条短事实约 5 秒;长的事实会慢一些。";

    private object ReindexView()
    {
        var r = _reindex.Current;
        return new
        {
            running = r.Running, done = r.Done, total = r.Total, embedded = r.Embedded, error = r.Error,
            // The server's sentences, one writer each: what the run is doing, and how the last one went.
            phase = r.Phase, summary = r.Summary,
            // Computed here rather than in the client so "no total yet" reads as indeterminate rather than
            // as 0% — a bar pinned at zero looks stuck, which is the impression this exists to remove.
            percent = r.Total > 0 ? (int)Math.Round(100.0 * r.Done / r.Total) : (int?)null,
        };
    }

    /// <summary>An empty box means "clear it", not "leave it" — otherwise a household could never unset a
    /// wrong address, only overwrite it.</summary>
    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    /// <summary><paramref name="Endpoint"/> is null for a backend that needs no address — every backend there
    /// is today (the CLI, llama.cpp, the in-process ONNX one). It carried the base URL of the retired
    /// <c>openai-compat</c> arm, and stays for a future backend that needs one, sent per LAYER because the
    /// judge and the embedder may legitimately be different servers.</summary>
    public sealed record BindRequest(string? Source, string? Model, string? Endpoint = null);
    public sealed record EnabledRequest(bool Enabled);
}
