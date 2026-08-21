using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Kernel.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Platform.Agent.Llm;

/// <summary>
/// 记忆检索 · Memory recall setup. Recall quality is THREE independent switches, not one setting, and this
/// surface exists to make that visible and choosable:
///
/// <list type="bullet">
/// <item><b>公式 · Formula</b> — graph decay + rank fusion + FTS trigram. Always on, no setup, no cost.
/// The floor, and what remains when both others are off.</item>
/// <item><b>判断 · Judgement</b> — a subject label on every write, a judgement of which candidates
/// answered on every recall. On by default because it already shipped that way; the point of this surface
/// is that declining it is now a setting rather than a code edit. Its BACKEND is a choice: the
/// authenticated Claude CLI (costs tokens per write and per recall) or a chat model on this machine
/// (costs local compute).</item>
/// <item><b>语义 · Semantic</b> — real semantic vectors from a local Ollama embedding model. Costs disk
/// and local compute, no tokens, and nothing leaves the machine.</item>
/// </list>
///
/// <para><b>The two are named for what they DO, not for what runs them</b> — the second one used to be
/// called <c>Claude CLI 增强</c>, which asserted a backend the very control inside it moves elsewhere, and
/// its 本机模型 option sat one card above a layer then called 本地模型 · Local model: two near-synonyms
/// meaning different things, adjacent. A backend is now a badge, and a badge reports what is RUNNING (see
/// <see cref="MemoryJudgeWiring"/>), never what was merely saved.</para>
///
/// <para>They are independent because they are complements, not alternatives: verification REORDERS what
/// was retrieved, embeddings change what is RETRIEVABLE. A household must be able to drop the token cost
/// without losing local semantics.</para>
///
/// <para>Every switch is a startup registration, so a change takes effect on restart — the responses say
/// so rather than pretending otherwise, and report the SAVED setting separately from what is actually
/// running, because between the two a panel that reads only the setting would be lying.</para>
/// </summary>
[ApiController]
public sealed class MemoryRecallController : ControllerBase
{
    private readonly IOllamaRuntime _ollama;
    private readonly ServerConfigService _config;
    private readonly Storage.Knowledge.Services.IFactIndex _facts;
    private readonly ILogger<MemoryRecallController> _log;

    // Non-null only when actually wired at startup — the honest answer to "is the local model running
    // right now", which is NOT the saved setting: between saving and restarting the two disagree. The
    // enrichment needs no such field, because it is read live from app_config.
    private readonly Lyntai.Memory.ISemanticMemory? _semantic;
    private readonly IAppConfigService _appConfig;
    private readonly IReindexStatus _reindex;
    private readonly IModelPullStatus _pulls;
    // What the judge is RUNNING on, as opposed to what is saved — see MemoryJudgeWiring.
    private readonly MemoryJudgeWiring _judgeWiring;
    private readonly Storage.Knowledge.Services.IKnowledgeStore _knowledge;

    public MemoryRecallController(IOllamaRuntime ollama, ServerConfigService config,
        Storage.Knowledge.Services.IFactIndex facts, IAppConfigService appConfig,
        Storage.Knowledge.Services.IKnowledgeStore knowledge,
        IReindexStatus reindex, IModelPullStatus pulls, MemoryJudgeWiring judgeWiring,
        ILogger<MemoryRecallController> log,
        Lyntai.Memory.ISemanticMemory? semantic = null)
    {
        _judgeWiring = judgeWiring;
        _ollama = ollama;
        _config = config;
        _facts = facts;
        _appConfig = appConfig;
        _knowledge = knowledge;
        _reindex = reindex;
        _pulls = pulls;
        _log = log;
        _semantic = semantic;
    }

    /// <summary>Models on this machine that could answer a memory JUDGEMENT.
    ///
    /// <para>The filter is Ollama's own <c>capabilities</c> array, falling back to "not in our embedding
    /// shortlist" only when the daemon is too old to report one. The shortlist WAS the filter until
    /// 2026-08-21, and it was wrong in both directions. A household whose local models happened to all be
    /// catalogued embedders got an empty list, which disabled the 本机模型 switch with no explanation on a
    /// panel that was simultaneously listing those models under 本机模型占用. And the first embedder we had
    /// not catalogued — there is always one — was offered as a judge and then sailed through
    /// <see cref="SetJudge"/>'s catalog check into a fail-open policy, where the only symptom would have
    /// been recall that quietly never improved.</para></summary>
    private static List<OllamaModel> JudgeCandidates(OllamaState s) => s.Models
        .Where(m => m.CanComplete ?? !EmbeddingCatalog.Options.Any(o => OllamaState.Matches(m.Name, o.Id)))
        .ToList();

    /// <summary>A small chat model to offer when the household has an Ollama running but nothing on it can
    /// hold a conversation. Not in <see cref="EmbeddingCatalog"/> on purpose — that list is a MEASURED
    /// shortlist of embedders, and a chat model has no business in it.</summary>
    private const string SuggestedJudgeModel = "gemma3:4b";

    /// <summary>Why the 本机模型 switch is unavailable — and, when the fix is a download, WHICH model.
    ///
    /// <para>Three causes with three different fixes, so they get three different sentences. The panel used
    /// to have exactly one — and it lived inside the <c>&lt;select&gt;</c>, which only renders when there is
    /// something to select, so the single case it explained was the single case it could never appear
    /// in.</para>
    ///
    /// <para><b><c>Suggest</c> exists because the local judge and the local embedder are ONE provider.</b>
    /// They are the same Ollama at the same URL with the same <c>/api/pull</c>; only the model differs. So
    /// a panel that installs an embedding model with a button and answers "you need a chat model" with a
    /// terminal command is drawing a line the system does not have — and sending the household to a shell
    /// for a capability it already has wired, one card away.</para></summary>
    private static (string? Reason, string? Suggest) JudgeBlocked(OllamaState s) =>
        JudgeCandidates(s).Count > 0 ? (null, null)
        : !s.Installed ? ("这台机器没有安装 Ollama —— 本机判断需要它,可在「资源 · Resources」面板安装。", null)
        : !s.Serving ? ("Ollama 已安装但没有运行 —— 在下面「语义」一栏点「启动」,这里就能选了。", null)
        : ($"这台机器上只有嵌入模型,没有能对话的 —— 判断需要一个对话模型。可以直接下载 {SuggestedJudgeModel}"
            + "(约 3.3 GB,和嵌入模型装在同一个 Ollama 里),或自己 pull 别的再回来选。", SuggestedJudgeModel);

    [HttpGet("api/manage/memory")]
    public async Task<IActionResult> Get([FromQuery] bool refresh = false)
    {
        var mem = _config.Current.Memory;
        var s = await _ollama.ProbeAsync(refresh);
        var rec = EmbeddingCatalog.Recommend(s.GpuLikely);
        var judgeLocal = string.Equals(mem.JudgeTransport, "local", StringComparison.OrdinalIgnoreCase)
            && !string.IsNullOrWhiteSpace(mem.JudgeModel);
        var (indexed, totalFacts) = await _knowledge.CoverageAsync();

        return Ok(new
        {
            formula = new
            {
                alwaysOn = true,
                what = "图谱衰减 + 排名融合 + 三元组全文检索。不需要设置,不产生费用 —— 其余两项都建立在它之上。",
            },
            llmEnrichment = new
            {
                // Live: it is an app_config value read per call, so there is no saved-vs-running gap to
                // report here — unlike the local model, whose wiring is fixed at startup.
                enabled = MemoryEnrichment.IsOn(_appConfig),
                live = true,
                what = "写入事实时标注主题,检索时判断哪些结果真正回答了问题(明显提升召回质量)。",
                cost = judgeLocal
                    ? "每次记录事实与每次检索各调用一次本机模型:不消耗账号额度,不联网,断网也能用。"
                    : "每次记录事实与每次检索各消耗一次 Claude CLI 调用(使用已登录的账号)。",
                model = "使用的模型在本页「记忆判断 · Memory」一行调整。",
                // WHERE it runs, separately from WHETHER it runs. The transport is a startup registration
                // (a provider + a named client), so unlike the on/off switch it needs a restart — and the
                // console says which of the two kinds of change the household just made.
                transport = judgeLocal ? "local" : "cli",
                localModel = mem.JudgeModel,
                // …and what is ACTUALLY running, which is not the same thing until the restart happens.
                // The layer's header now names its backend, so it has to name the one doing the work.
                transportActive = _judgeWiring.Transport,
                activeModel = _judgeWiring.Model,
                // Chat-capable models on this machine — see JudgeCandidates for why that is Ollama's answer
                // rather than ours.
                localCandidates = JudgeCandidates(s)
                    .Select(m => new { name = m.Name, sizeBytes = m.SizeBytes }),
                // …and, when there are none, WHY. A disabled control that says nothing is a dead end: the
                // household can see their models listed further down the same panel and has no way to learn
                // that the daemon is stopped, or that none of them can hold a conversation.
                // `localSuggest` names a model the panel can PULL for them — same Ollama, same endpoint the
                // embedding table's 下载 button already uses.
                localBlocked = JudgeBlocked(s).Reason,
                localSuggest = JudgeBlocked(s).Suggest,
                // Says WHICH local runtime, because it is the same Ollama the 语义 layer below uses — one
                // daemon, one URL, a chat model here and an embedding model there. The panel used to name
                // Ollama only on the 语义 card, which read as though that layer were the Ollama one and
                // this 本机模型 were something else.
                localNote = $"「本机模型」就是下面「语义」用的那个 Ollama({s.BaseUrl}),只是换成对话模型。"
                    + "本机判断在 Lyntai 的实测中,漏检与误收都优于 ground-truth 参考,且不消耗额度;"
                    + "换成本机模型需要重启服务。避免选「会思考」的模型 —— 检索在每次回忆的必经路径上。",
            },
            localModel = new
            {
                enabled = mem.SemanticEnabled,
                active = _semantic is not null,
                model = mem.EmbeddingModel,
                what = "用本地模型为事实生成向量,按语义检索 —— 问法与原文用词完全不同也能找到。",
                cost = "占用磁盘与本机算力,不消耗 token;资料不离开这台电脑。",
                // WHY this layer has no backend picker while 判断 does — the question the rename makes
                // obvious, so the panel answers it instead of leaving an unexplained asymmetry.
                //
                // It leads with the thing that is easy to get wrong: BOTH layers' local arm is the same
                // Ollama at the same URL (GatherlightApp passes one `ollamaUrl` to AddOllamaProvider for
                // the judge and to AddOpenAiCompatibleEmbedder for this one) — only the model differs.
                // So the asymmetry is not "this layer is the Ollama one"; it is that 判断 has a SECOND
                // option and this layer does not. Both reasons for that are constraints rather than
                // preferences: Claude has no embeddings endpoint at all, and a cloud embedder would post
                // every household fact off this machine on every write — the rule OllamaRuntime enforces
                // by refusing a non-loopback URL.
                backend = "和「判断」的本机选项是同一个 Ollama,只是这里装的是嵌入模型、那里是对话模型。"
                    + "这一层没有 Claude CLI 选项,是因为 Claude 不提供嵌入接口(生成文字,不生成向量)"
                    + "—— 但这不代表 Claude 帮不上按语义找东西:Lyntai 实测里,把「答对了却排在后面」捞上来的"
                    + "主要就是「判断」那一层(漏检 0.54 → 0.19),换句话说想让改写的问法也能问到,"
                    + "先开「判断」比先开这一层更划算。",
                // The limitation reported here until 2026-08-21 ("only kind-filtered recalls benefit") is
                // gone: it was this app's own doing, not an upstream gap — see FactIndex.AllFacts. Re-measured
                // after the fix, unscoped recall improved on 3/3 probe queries.
                //
                // Turning this on re-embeds by REBUILDING, so say so where the household decides: the
                // ranking the index has accumulated is reset, and on a large corpus it is not quick.
                note = _semantic is null ? null
                    : "开启或更换模型后需要重建索引:会重新计算全部向量,并重置已积累的排序权重(事实本身不受影响)。",
                // The reindex a household may be watching. Reported inside localModel because that is the
                // control that starts it, so the bar renders where the button is.
                reindex = ReindexView(),
                // Downloads in flight (and the last few that finished), so the panel can put a real bar on
                // the row whose button started one. Read from memory, not from the probe, so it stays live
                // while the 20s probe cache does its job.
                pulls = _pulls.Current.Select(p => new
                {
                    model = p.Model, running = p.Running, percent = p.Percent, status = p.Status, error = p.Error,
                }),
                // COVERAGE, not a history of rebuilds. It answers the question a household actually has —
                // is what I know searchable right now — and it is self-correcting: an interrupted rebuild
                // shows as < 100% and the next startup back-fill repairs it (measured 2026-08-21: 2/6 →
                // 6/6 across a restart). A durable record of runs would answer a question nobody asked and
                // could outlive the in-process work it described.
                coverage = new { indexed, total = totalFacts },
                ollama = new
                {
                    baseUrl = s.BaseUrl, installed = s.Installed, serving = s.Serving, version = s.Version,
                    executable = s.Executable, gpuLikely = s.GpuLikely, problem = s.Problem,
                    // `capabilities` is Ollama's own (null on an older daemon) and it is reported rather
                    // than kept server-side for two reasons: the disk list can then say WHY a model the
                    // household owns is not offered as a judge, and it makes the capability filter
                    // assertable from the API — with no response carrying it, e2e could only ever check
                    // that the endpoint answered.
                    models = s.Models.Select(m => new
                    {
                        name = m.Name, sizeBytes = m.SizeBytes, capabilities = m.Capabilities,
                    }),
                },
                // The shortlist is not the limit — the UI lets the household name any model, so it also
                // reports whether the one in use is on this list (`catalogued`) rather than implying the
                // list is exhaustive.
                current = mem.EmbeddingModel,
                currentCatalogued = EmbeddingCatalog.Find(mem.EmbeddingModel) is not null,
                measuredOn = "20 条中英混排事实 · 10 个改写提问 · 2026-08-21",
                options = EmbeddingCatalog.Options.Select(o => new
                {
                    measured = o.Measured is null ? null : new
                    {
                        top1 = o.Measured.RecallTop1, top3 = o.Measured.RecallTop3,
                        queries = o.Measured.Queries, msPerQuery = o.Measured.MsPerQuery,
                    },
                    vintage = o.Vintage,
                    id = o.Id, name = o.Name, approxBytes = o.ApproxBytes, dimensions = o.Dimensions,
                    multilingual = o.Multilingual, note = o.Note, present = s.Has(o.Id),
                }),
                recommendation = new { id = rec.Id, reason = rec.Reason, caution = rec.Caution },
            },
        });
    }

    /// <summary>Turn the claude-CLI enrichment on or off. Off keeps the deterministic floor intact — it
    /// removes an enrichment, not the feature.</summary>
    [HttpPost("api/manage/memory/enrichment")]
    public IActionResult Enrichment([FromBody] EnabledRequest body)
    {
        if (body is null) return BadRequest(new { error = "enabled is required" });
        MemoryEnrichment.Set(_appConfig, body.Enabled);
        _log.LogInformation("Memory LLM enrichment set to {Enabled} (live, no restart)", body.Enabled);
        return Ok(new { ok = true, enabled = body.Enabled, restartRequired = false });
    }

    /// <summary>Start Ollama ONLY when nothing is answering — a household's own instance is left alone.</summary>
    [HttpPost("api/manage/memory/local/start")]
    public async Task<IActionResult> Start()
    {
        var ok = await _ollama.EnsureServingAsync();
        return ok
            ? Ok(new { ok = true })
            : StatusCode(409, new { error = (await _ollama.ProbeAsync(refresh: true)).Problem ?? "无法启动 Ollama。" });
    }

    /// <summary>Move the memory judge between the authenticated Claude CLI and a model on this machine.
    /// <para>A restart is owed either way — the transport is a provider + named-client registration, built
    /// while the container is. The on/off switch beside it stays live, and the console distinguishes the
    /// two rather than making every change look like it needs a restart.</para></summary>
    [HttpPost("api/manage/memory/judge")]
    public async Task<IActionResult> SetJudge([FromBody] JudgeRequest body)
    {
        var transport = body?.Transport?.Trim().ToLowerInvariant();
        if (transport is not ("cli" or "local"))
            return BadRequest(new { error = "transport 必须是 cli 或 local。" });

        if (transport == "cli")
        {
            // The model is REMEMBERED rather than cleared: going back to the CLI should not throw away a
            // choice that cost a download, in case it goes back the other way.
            _config.Update(c => c.Memory.JudgeTransport = "cli");
            return Ok(new { ok = true, transport, restartRequired = true });
        }

        var model = body?.Model?.Trim();
        if (!EmbeddingCatalog.IsWellFormedId(model))
            return BadRequest(new { error = $"模型名称格式不正确:{body?.Model}" });

        var state = await _ollama.ProbeAsync(refresh: true);
        if (!state.Serving) return StatusCode(409, new { error = state.Problem ?? "Ollama 未运行。" });
        var held = state.Find(model!);
        if (held is null)
            return StatusCode(409, new { error = $"模型 {model} 尚未下载 —— 请先下载再启用。" });

        // An EMBEDDING model named here would be installed, well-formed, and unable to answer a judgement —
        // and both memory policies are fail-open, so the failure would surface as recall that quietly never
        // improves. Refuse it rather than let it be chosen.
        //
        // OLLAMA's capability list decides; the catalog is only the fallback for a daemon too old to report
        // one. Asking the catalog FIRST was the defect: it knows the nine models we measured and nothing
        // else, so the first uncatalogued embedder — and there is always one — passed straight through the
        // check written to stop exactly it.
        if (held.CanComplete is false || (held.CanComplete is null && EmbeddingCatalog.Find(model) is not null))
            return StatusCode(409, new
            {
                error = $"{model} 不是对话模型,不能用来判断检索结果 —— 请选一个对话模型(例如 gemma3:4b)。",
            });

        _config.Update(c =>
        {
            c.Memory.JudgeTransport = "local";
            c.Memory.JudgeModel = model;
        });
        return Ok(new
        {
            ok = true, transport, model, restartRequired = true,
            note = "设置已保存。重启服务后,标注与核对将由本机模型完成,不再消耗账号额度。",
        });
    }

    public sealed record JudgeRequest(string? Transport, string? Model);

    private object ReindexView()
    {
        var r = _reindex.Current;
        return new
        {
            running = r.Running, done = r.Done, total = r.Total, embedded = r.Embedded, error = r.Error,
            // Computed here rather than in the client so "no total yet" reads as indeterminate rather than
            // as 0% — a bar pinned at zero looks stuck, which is the impression this whole change removes.
            percent = r.Total > 0 ? (int)Math.Round(100.0 * r.Done / r.Total) : (int?)null,
        };
    }

    /// <summary>Delete a local model, freeing its disk.
    /// <para>Refused for a model this install is CONFIGURED to use — the embedder or the local judge —
    /// even when that configuration is not running yet. Deleting the embedder would leave semantic recall
    /// pointing at something absent, and because recall is fail-open the household would see searches that
    /// quietly find less rather than an error naming what they removed.</para></summary>
    [HttpPost("api/manage/memory/local/remove")]
    public async Task<IActionResult> Remove([FromBody] ModelRequest body)
    {
        var model = body?.Model?.Trim();
        if (!EmbeddingCatalog.IsWellFormedId(model))
            return BadRequest(new { error = $"模型名称格式不正确:{body?.Model}" });

        var mem = _config.Current.Memory;
        if (mem.SemanticEnabled && mem.EmbeddingModel is { } emb && OllamaState.Matches(model!, emb))
            return StatusCode(409, new { error = $"{model} 正在用于语义检索 —— 请先切换到别的模型或停用,再删除。" });
        if (string.Equals(mem.JudgeTransport, "local", StringComparison.OrdinalIgnoreCase)
            && mem.JudgeModel is { } judge && OllamaState.Matches(model!, judge))
            return StatusCode(409, new { error = $"{model} 正在用于记忆判断 —— 请先切回 Claude CLI 或换个模型,再删除。" });

        try
        {
            await _ollama.RemoveModelAsync(model!);
            return Ok(new { ok = true, removed = model });
        }
        catch (Exception ex)
        {
            _log.LogWarning("removing {Model} failed: {Msg}", model, ex.Message);
            return StatusCode(502, new { error = ex.Message });
        }
    }

    /// <summary>Start downloading a model, and RETURN — progress is read back from
    /// <c>GET /api/manage/memory</c>.
    /// <para>Detached for the reason the reindex is: a model is hundreds of megabytes to gigabytes over
    /// whatever line the household has, so running it inside the POST gave a button reading 下载中… with no
    /// bar and no bytes for minutes, indistinguishable from a hang — over a request the browser may abandon
    /// while Ollama carries on downloading, which is how a completed pull got reported as a failure.</para></summary>
    [HttpPost("api/manage/memory/local/pull")]
    public IActionResult Pull([FromBody] ModelRequest body)
    {
        if (string.IsNullOrWhiteSpace(body?.Model)) return BadRequest(new { error = "model is required" });
        // Shape, not membership. The catalog is a measured shortlist, not the set of models that work: a
        // list baked into a release cannot contain a model published after it, and this one shipped without
        // the two strongest options that already existed. See EmbeddingCatalog.IsWellFormedId for what the
        // gate still checks and why that is the right line.
        if (!EmbeddingCatalog.IsWellFormedId(body.Model))
            return BadRequest(new { error = $"模型名称格式不正确:{body.Model}" });

        var model = body.Model.Trim();
        // Already downloading is SUCCESS, not a conflict: the household asked for a download and one is
        // running. A 409 here would drop an error toast over a working progress bar.
        if (!_pulls.TryStart(model))
            return Accepted(new { ok = true, started = false, model, note = "这个模型已经在下载中。" });

        _ = Task.Run(async () =>
        {
            try
            {
                // Deliberately NOT the request's CancellationToken: the work outlives the POST, so binding
                // it would abort the download the moment the browser stopped waiting.
                await _ollama.PullModelAsync(model,
                    (percent, status) => _pulls.Report(model, percent, status),
                    CancellationToken.None);
                _pulls.Finish(model, null);
                _log.LogInformation("pulled local model {Model}", model);
            }
            catch (Exception ex)
            {
                _log.LogWarning("Embedding model pull failed for {Model}: {Msg}", model, ex.Message);
                _pulls.Finish(model, ex.Message);
            }
        });
        return Accepted(new { ok = true, started = true, model, note = "开始下载 —— 进度显示在模型列表里。" });
    }

    /// <summary>Turn local-model recall on with a chosen model. Refuses when the model is not on the
    /// machine: enabling against a missing model would embed nothing and leave recall looking broken with
    /// no error anywhere — pull first, which is a button away.</summary>
    [HttpPost("api/manage/memory/local/enable")]
    public async Task<IActionResult> EnableLocal([FromBody] ModelRequest body)
    {
        var model = body?.Model?.Trim();
        if (!EmbeddingCatalog.IsWellFormedId(model))
            return BadRequest(new { error = $"模型名称格式不正确:{body?.Model}" });

        var state = await _ollama.ProbeAsync(refresh: true);
        if (!state.Serving) return StatusCode(409, new { error = state.Problem ?? "Ollama 未运行。" });
        var held = state.Find(model!);
        if (held is null)
            return StatusCode(409, new { error = $"模型 {model} 尚未下载 —— 请先下载再启用。" });

        // The CHEAP no, before the expensive one. The probe below is the load-bearing check and stays, but
        // it costs a cold model load — the code below budgets three minutes for it — and a model Ollama has
        // already said cannot embed will not start embedding once it is in memory. Nothing is refused here
        // that the probe would have accepted; the household just stops waiting out a load for a certain no.
        if (held.CanEmbed is false)
            return StatusCode(409, new
            {
                error = $"{model} 不是嵌入模型(Ollama 报告它不能生成向量)—— 请换一个。",
            });

        // PROVE it embeds before saving. Being installed is not being usable: a chat model named here by
        // mistake is on the machine and will never produce a vector, and the failure would surface only as
        // recall that finds nothing — indistinguishable from a household with no facts. This also gets the
        // vector WIDTH from the model itself, which is what a catalog lookup used to supply and cannot for a
        // model nobody catalogued.
        var probe = await _ollama.ProbeEmbeddingAsync(model!);
        if (probe is null)
            return StatusCode(409, new
            {
                error = $"{model} 没有返回向量 —— 它可能不是嵌入模型。请换一个,或先在「资源」面板确认 Ollama 正常。",
            });

        var previous = _config.Current.Memory.EmbeddingModel;
        _config.Update(c =>
        {
            c.Memory.SemanticEnabled = true;
            c.Memory.EmbeddingModel = model;
        });
        // A CHANGED model invalidates every stored vector — they keep the old width, and recall then
        // matches nothing rather than erroring — so the reindex is not optional, and saying so here is what
        // stops a household from sitting on silently empty recall.
        var modelChanged = previous is not null && !OllamaState.Matches(previous, model!);
        return Ok(new
        {
            ok = true, model, restartRequired = true, reindexRequired = true, modelChanged,
            dimensions = probe.Dimensions, probeMs = probe.Milliseconds,
            // Named for a model outside the shortlist too — a household that typed one gets the same
            // width/latency facts as a catalogued pick, rather than a blank where the numbers would be.
            catalogued = EmbeddingCatalog.Find(model) is not null,
            note = "设置已保存。重启服务后生效,然后请重新建立一次语义索引。",
        });
    }

    [HttpPost("api/manage/memory/local/disable")]
    public IActionResult DisableLocal()
    {
        // The model and its vectors are left alone on purpose: turning a feature off should not throw away
        // something that cost a large download and a long reindex, in case it goes back on.
        _config.Update(c => c.Memory.SemanticEnabled = false);
        return Ok(new { ok = true, restartRequired = true });
    }

    /// <summary>(Re)build the vector index over every fact. Needed on first enable — the graph is already
    /// populated, so the ordinary back-fill (which touches only rows with no ref) would embed nothing —
    /// and after any model change.</summary>
    [HttpPost("api/manage/memory/local/reindex")]
    public IActionResult Reindex()
    {
        if (!_config.Current.Memory.SemanticEnabled)
            return StatusCode(409, new { error = "本地模型检索尚未启用。" });
        if (!_reindex.TryStart())
            return StatusCode(409, new { error = "已经有一次重建在进行中。" });

        // DETACHED, and deliberately not tied to the request's CancellationToken: the work outlives the
        // POST, so binding it to the request would cancel the rebuild the moment the browser stopped
        // waiting — which is precisely what happens on an operation this long. Progress is read back from
        // /api/manage/memory instead.
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

    public sealed record ModelRequest(string Model);
    public sealed record EnabledRequest(bool Enabled);
}
