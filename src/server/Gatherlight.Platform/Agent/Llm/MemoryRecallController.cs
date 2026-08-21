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
/// <item><b>Claude CLI</b> — a subject label on every write, a judgement of which candidates answered on
/// every recall. Costs TOKENS per write and per recall. On by default because it already shipped that
/// way; the point of this surface is that declining it is now a setting rather than a code edit.</item>
/// <item><b>本地模型 · Local model</b> — real semantic vectors from a local Ollama. Costs disk and local
/// compute, no tokens, and nothing leaves the machine.</item>
/// </list>
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

    public MemoryRecallController(IOllamaRuntime ollama, ServerConfigService config,
        Storage.Knowledge.Services.IFactIndex facts, IAppConfigService appConfig,
        IReindexStatus reindex, ILogger<MemoryRecallController> log,
        Lyntai.Memory.ISemanticMemory? semantic = null)
    {
        _ollama = ollama;
        _config = config;
        _facts = facts;
        _appConfig = appConfig;
        _reindex = reindex;
        _log = log;
        _semantic = semantic;
    }

    [HttpGet("api/manage/memory")]
    public async Task<IActionResult> Get([FromQuery] bool refresh = false)
    {
        var mem = _config.Current.Memory;
        var s = await _ollama.ProbeAsync(refresh);
        var rec = EmbeddingCatalog.Recommend(s.GpuLikely);
        var judgeLocal = string.Equals(mem.JudgeTransport, "local", StringComparison.OrdinalIgnoreCase)
            && !string.IsNullOrWhiteSpace(mem.JudgeModel);

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
                model = "使用的模型在本页「记忆增强 · Memory」一行调整。",
                // WHERE it runs, separately from WHETHER it runs. The transport is a startup registration
                // (a provider + a named client), so unlike the on/off switch it needs a restart — and the
                // console says which of the two kinds of change the household just made.
                transport = judgeLocal ? "local" : "cli",
                localModel = mem.JudgeModel,
                // Chat-capable models on this machine. Deliberately not filtered to a shortlist: which local
                // models exist is the household's business, and an embedding-only model is refused when
                // chosen rather than hidden here, where hiding it would look like it does not exist.
                localCandidates = s.Models
                    .Where(m => !EmbeddingCatalog.Options.Any(o => OllamaState.Matches(m.Name, o.Id)))
                    .Select(m => new { name = m.Name, sizeBytes = m.SizeBytes }),
                localNote = "本机判断在 Lyntai 的实测中,漏检与误收都优于 ground-truth 参考,且不消耗额度;"
                    + "换成本机模型需要重启服务。避免选「会思考」的模型 —— 检索在每次回忆的必经路径上。",
            },
            localModel = new
            {
                enabled = mem.SemanticEnabled,
                active = _semantic is not null,
                model = mem.EmbeddingModel,
                what = "用本地模型为事实生成向量,按语义检索 —— 问法与原文用词完全不同也能找到。",
                cost = "占用磁盘与本机算力,不消耗 token;资料不离开这台电脑。",
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
                ollama = new
                {
                    baseUrl = s.BaseUrl, installed = s.Installed, serving = s.Serving, version = s.Version,
                    executable = s.Executable, gpuLikely = s.GpuLikely, problem = s.Problem,
                    models = s.Models.Select(m => new { name = m.Name, sizeBytes = m.SizeBytes }),
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
        if (!state.Has(model!))
            return StatusCode(409, new { error = $"模型 {model} 尚未下载 —— 请先下载再启用。" });

        // An EMBEDDING model named here would be installed, well-formed, and unable to answer a judgement —
        // and both memory policies are fail-open, so the failure would surface as recall that quietly never
        // improves. Refuse it by name rather than let it be chosen.
        if (EmbeddingCatalog.Find(model) is not null)
            return StatusCode(409, new
            {
                error = $"{model} 是嵌入模型,不能用来判断检索结果 —— 请选一个对话模型(例如 gemma3:4b)。",
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

    [HttpPost("api/manage/memory/local/pull")]
    public async Task<IActionResult> Pull([FromBody] ModelRequest body)
    {
        if (string.IsNullOrWhiteSpace(body?.Model)) return BadRequest(new { error = "model is required" });
        // Shape, not membership. The catalog is a measured shortlist, not the set of models that work: a
        // list baked into a release cannot contain a model published after it, and this one shipped without
        // the two strongest options that already existed. See EmbeddingCatalog.IsWellFormedId for what the
        // gate still checks and why that is the right line.
        if (!EmbeddingCatalog.IsWellFormedId(body.Model))
            return BadRequest(new { error = $"模型名称格式不正确:{body.Model}" });
        try
        {
            await _ollama.PullModelAsync(body.Model);
            return Ok(new { ok = true });
        }
        catch (Exception ex)
        {
            _log.LogWarning("Embedding model pull failed for {Model}: {Msg}", body.Model, ex.Message);
            return StatusCode(502, new { error = ex.Message });
        }
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
        if (!state.Has(model!))
            return StatusCode(409, new { error = $"模型 {model} 尚未下载 —— 请先下载再启用。" });

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
