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

    public MemoryRecallController(IOllamaRuntime ollama, ServerConfigService config,
        Storage.Knowledge.Services.IFactIndex facts, IAppConfigService appConfig,
        ILogger<MemoryRecallController> log,
        Lyntai.Memory.ISemanticMemory? semantic = null)
    {
        _ollama = ollama;
        _config = config;
        _facts = facts;
        _appConfig = appConfig;
        _log = log;
        _semantic = semantic;
    }

    [HttpGet("api/manage/memory")]
    public async Task<IActionResult> Get([FromQuery] bool refresh = false)
    {
        var mem = _config.Current.Memory;
        var s = await _ollama.ProbeAsync(refresh);
        var rec = EmbeddingCatalog.Recommend(s.GpuLikely);

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
                cost = "每次记录事实与每次检索各消耗一次 haiku 调用(使用已登录的 Claude CLI,不需额外配置)。",
                model = "使用的模型在「大脑 · Cortex」面板调整(记忆增强 · Memory)。",
            },
            localModel = new
            {
                enabled = mem.SemanticEnabled,
                active = _semantic is not null,
                model = mem.EmbeddingModel,
                what = "用本地模型为事实生成向量,按语义检索 —— 问法与原文用词完全不同也能找到。",
                cost = "占用磁盘与本机算力,不消耗 token;资料不离开这台电脑。",
                // Measured, not assumed (2026-08-21). Filed upstream as Lyntai TASKS Part 90; when
                // null-scope recall lands this note goes away and nothing here changes.
                limitation = _semantic is null ? null
                    : "当前仅对指定了「类别」的检索生效;未指定类别时按图谱与关键词检索(上游能力待补)。",
                ollama = new
                {
                    baseUrl = s.BaseUrl, installed = s.Installed, serving = s.Serving, version = s.Version,
                    executable = s.Executable, gpuLikely = s.GpuLikely, problem = s.Problem,
                    models = s.Models.Select(m => new { name = m.Name, sizeBytes = m.SizeBytes }),
                },
                options = EmbeddingCatalog.Options.Select(o => new
                {
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

    [HttpPost("api/manage/memory/local/pull")]
    public async Task<IActionResult> Pull([FromBody] ModelRequest body)
    {
        if (string.IsNullOrWhiteSpace(body?.Model)) return BadRequest(new { error = "model is required" });
        // Only catalogued models: the id becomes an argument to a local process that fetches from a remote
        // registry, so an arbitrary caller-supplied name is a request to pull whatever that registry serves.
        if (EmbeddingCatalog.Find(body.Model) is null)
            return BadRequest(new { error = $"未知的嵌入模型:{body.Model}" });
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
        var option = EmbeddingCatalog.Find(body?.Model);
        if (option is null) return BadRequest(new { error = $"未知的嵌入模型:{body?.Model}" });

        var state = await _ollama.ProbeAsync(refresh: true);
        if (!state.Serving) return StatusCode(409, new { error = state.Problem ?? "Ollama 未运行。" });
        if (!state.Has(option.Id))
            return StatusCode(409, new { error = $"模型 {option.Id} 尚未下载 —— 请先下载再启用。" });

        var previous = _config.Current.Memory.EmbeddingModel;
        _config.Update(c =>
        {
            c.Memory.SemanticEnabled = true;
            c.Memory.EmbeddingModel = option.Id;
        });
        // A CHANGED model invalidates every stored vector — they keep the old width, and recall then
        // matches nothing rather than erroring — so the reindex is not optional, and saying so here is what
        // stops a household from sitting on silently empty recall.
        var modelChanged = previous is not null && !OllamaState.Matches(previous, option.Id);
        return Ok(new
        {
            ok = true, model = option.Id, restartRequired = true, reindexRequired = true, modelChanged,
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
    public async Task<IActionResult> Reindex(CancellationToken ct)
    {
        if (!_config.Current.Memory.SemanticEnabled)
            return StatusCode(409, new { error = "本地模型检索尚未启用。" });
        var embedded = await _facts.ReindexSemanticAsync(ct);
        if (embedded == 0)
            return StatusCode(409, new
            {
                error = "没有建立任何索引 —— 通常是服务尚未重启(嵌入器只在启动时装载),或 Ollama 未运行。",
            });
        return Ok(new { ok = true, embedded });
    }

    public sealed record ModelRequest(string Model);
    public sealed record EnabledRequest(bool Enabled);
}
