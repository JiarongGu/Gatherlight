using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Agent.Llm.Sources;
using Gatherlight.Server.Platform.Kernel.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Platform.Hosting.Resources;

/// <summary>
/// 本机模型 · Local models — the provisioning half of 资源.
///
/// <para><b>Why models live beside chromium, git and the claude CLI rather than inside 记忆检索.</b> A model
/// is a file with a size, a capability and a delete button; it carries no opinion about recall. The
/// chat/embedding split is Ollama's, enforced upstream — not a product rule we chose and could relax. So
/// downloading one is the same act as downloading a browser, and the panel that does it should be the same
/// panel. It also ends a split that was visible to the household: the runtime was installed in 资源 while
/// the models it hosts were installed two panels away.</para>
///
/// <para>What stays in 记忆检索 is the only part that IS a recall decision — which model each layer uses.
/// This controller therefore knows what is ON DISK and never which layer wants it, except for the one
/// question a delete has to ask.</para>
/// </summary>
[ApiController]
public sealed class ModelsController : ControllerBase
{
    private readonly IOllamaRuntime _ollama;
    private readonly ServerConfigService _config;
    private readonly IModelPullStatus _pulls;
    private readonly IPlatformContext _platform;
    private readonly ILogger<ModelsController> _log;

    public ModelsController(IOllamaRuntime ollama, ServerConfigService config,
        IModelPullStatus pulls, IPlatformContext platform, ILogger<ModelsController> log)
    {
        _ollama = ollama;
        _config = config;
        _pulls = pulls;
        _platform = platform;
        _log = log;
    }

    /// <summary>The startup-time facts a source needs to answer where it talks and whether it is ready.
    /// Built here rather than passed around because both this controller's questions want the same pair.</summary>
    private MemorySourceSettings Settings() => new(_config.Current.Memory, _platform.ResourcesPath);

    /// <summary>Approximate size of the suggested chat model, for the row that offers it. A figure the
    /// household reads before committing to a download, not one anything computes with.</summary>
    private const long SuggestedJudgeBytes = 3_300_000_000L;

    /// <summary>The fixture and WHEN, for the footnote under the comparison table.
    ///
    /// <para>Derived from the rows rather than written here, because a literal was a second writer of one
    /// fact and it lost: the date sat at "2026-08-21" through a re-measurement that changed every latency
    /// figure in the table it was labelling. A range appears when the rows are genuinely not one run — which
    /// is the honest answer, and the reason <see cref="EmbeddingMeasurement.MeasuredOn"/> is per-row.</para></summary>
    private static string MeasuredOnLabel()
    {
        var dates = EmbeddingCatalog.Options
            .Select(o => o.Measured?.MeasuredOn)
            .Where(d => !string.IsNullOrWhiteSpace(d))
            .Distinct()
            .OrderBy(d => d, StringComparer.Ordinal)
            .ToList();
        var when = dates.Count switch
        {
            0 => "未测",
            1 => dates[0]!,
            _ => $"{dates[0]}–{dates[^1]}",
        };
        return $"20 条中英混排事实 · 10 个改写提问 · {when}";
    }

    [HttpGet("api/manage/models")]
    public async Task<IActionResult> Get([FromQuery] bool refresh = false)
    {
        var s = await _ollama.ProbeAsync(refresh);
        var mem = Settings();
        var judgeModel = MemorySources.ResolveJudgeModel(mem);
        var rec = EmbeddingCatalog.Recommend(s.GpuLikely);

        return Ok(new
        {
            // The runtime that hosts them. Reported here rather than assumed, and carrying its own
            // problem sentence, because "no models" and "no daemon" have completely different fixes.
            runtime = new
            {
                id = "ollama", baseUrl = s.BaseUrl, installed = s.Installed, serving = s.Serving,
                version = s.Version, executable = s.Executable, gpuLikely = s.GpuLikely, problem = s.Problem,
            },
            // On disk NOW: what it costs, what Ollama says it can do, and whether a layer is holding it.
            // `capabilities` is passed through rather than reduced to a boolean of ours: it is null on a
            // daemon too old to report the field, and a guess printed as a fact is worse than a blank.
            models = s.Models.Select(m => new
            {
                id = m.Name, name = m.Name, runtime = "ollama", sizeBytes = m.SizeBytes,
                capabilities = m.Capabilities,
                inUse = InUse(m.Name, mem, judgeModel),
                measured = Measured(m.Name),
            }),
            // Offerable but absent — the measured embedding shortlist, plus a chat model when this machine
            // has none. That last row is why this list is not just the embedding catalog: the local judge
            // and the local embedder are ONE provider, so a panel that installs an embedder with a button
            // has no business answering "you need a chat model" with a shell command.
            offers = Offers(s),
            recommendation = new { id = rec.Id, reason = rec.Reason, caution = rec.Caution },
            // The sample size travels with the numbers. "9/10" invites the right question where "很好"
            // does not, and a measurement with no denominator is an opinion wearing a number.
            measuredOn = MeasuredOnLabel(),
            // Downloads in flight (and the last few that finished). Read from memory rather than from the
            // probe, so a progress bar stays live while the 20s probe cache does its job.
            pulls = _pulls.Current.Select(p => new
            {
                model = p.Model, running = p.Running, percent = p.Percent, status = p.Status, error = p.Error,
            }),
        });
    }

    /// <summary>What a model scored on this app's own recall job. Null for anything nobody benchmarked,
    /// which the console must SAY rather than leave blank: an empty cell in a comparison table reads as a
    /// zero, and an unmeasured model would then look like a bad one.</summary>
    public sealed record MeasuredView(int Top1, int Top3, int Queries, int MsPerQuery);

    /// <summary>A model on the shelf rather than on the disk — what a download would get you.</summary>
    public sealed record ModelOfferView(
        string Id, string Name, string Runtime, string Capability,
        long ApproxBytes, int? Dimensions, string Note, string? Vintage, MeasuredView? Measured);

    /// <summary>The embedding shortlist this machine does not hold, plus a chat model when it holds none.
    /// <para>A named shape rather than two anonymous ones because the second row genuinely differs — no
    /// dimensions, no measurement, a different capability — and two near-identical anonymous types cannot
    /// be concatenated anyway. Naming it is what makes the difference legible instead of a cast.</para></summary>
    private static IReadOnlyList<ModelOfferView> Offers(OllamaState s)
    {
        var offers = EmbeddingCatalog.Options
            .Where(o => !s.Has(o.Id))
            .Select(o => new ModelOfferView(
                o.Id, o.Name, "ollama", "embedding", o.ApproxBytes, o.Dimensions, o.Note, o.Vintage,
                o.Measured is null ? null : new MeasuredView(
                    o.Measured.RecallTop1, o.Measured.RecallTop3, o.Measured.Queries, o.Measured.MsPerQuery)))
            .ToList();

        if (!s.Has(OllamaJudgeSource.Suggested))
            offers.Add(new ModelOfferView(
                OllamaJudgeSource.Suggested,
                $"{OllamaJudgeSource.Suggested}(对话模型 · 可用于「判断」)",
                "ollama", "completion", SuggestedJudgeBytes, null,
                "小而快的对话模型 —— 「判断」这一层用它就够,而且不消耗账号额度。", null, null));

        return offers;
    }

    /// <summary>Which layer, if any, is holding this model — the reason a delete is refused, named.
    /// <para>Deliberately the only question this controller asks about recall. It has to be asked: recall is
    /// fail-open, so deleting a bound model gives searches that quietly find less rather than an error
    /// naming what was removed.</para></summary>
    private static string? InUse(string name, MemorySourceSettings mem, string? judgeModel)
    {
        if (MemorySources.ResolveSemantic(mem) is not null && mem.Config.EmbeddingModel is { } emb
            && OllamaState.Matches(name, emb)) return MemoryLayers.Semantic;

        if (MemorySources.ResolveJudge(mem).Id != MemorySources.DefaultJudgeSource
            && judgeModel is { } j && OllamaState.Matches(name, j)) return MemoryLayers.Judge;

        return null;
    }

    private static MeasuredView? Measured(string name)
    {
        var m = EmbeddingCatalog.Find(name)?.Measured;
        return m is null ? null : new MeasuredView(m.RecallTop1, m.RecallTop3, m.Queries, m.MsPerQuery);
    }

    /// <summary>Start the runtime ONLY when nothing is answering — a household's own instance is left
    /// alone. Here rather than in 记忆检索 because starting a daemon is a provisioning act, and it was odd
    /// that the button for it lived on a panel that could not install the thing it was starting.</summary>
    [HttpPost("api/manage/models/start")]
    public async Task<IActionResult> Start()
    {
        var ok = await _ollama.EnsureServingAsync();
        return ok
            ? Ok(new { ok = true })
            : StatusCode(409, new { error = (await _ollama.ProbeAsync(refresh: true)).Problem ?? "无法启动 Ollama。" });
    }

    /// <summary>Start a download and RETURN — progress is read back from <c>GET /api/manage/models</c>.
    /// <para>Detached because a model is hundreds of megabytes to gigabytes over whatever line the household
    /// has: awaited inside the POST it gave a button reading 下载中… with no bar and no bytes for minutes,
    /// indistinguishable from a hang — over a request the browser may abandon while Ollama carries on
    /// downloading, which is how a completed pull got reported as a failure.</para></summary>
    [HttpPost("api/manage/models/pull")]
    public IActionResult Pull([FromBody] ModelRequest body)
    {
        if (string.IsNullOrWhiteSpace(body?.Model)) return BadRequest(new { error = "model is required" });
        // Shape, not membership. A catalog baked into a release cannot contain a model published after it —
        // which is exactly how this shipped without the two strongest options that already existed. See
        // EmbeddingCatalog.IsWellFormedId for what the gate still checks and why that is the right line.
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
                _log.LogWarning("model pull failed for {Model}: {Msg}", model, ex.Message);
                _pulls.Finish(model, ex.Message);
            }
        });
        return Accepted(new { ok = true, started = true, model, note = "开始下载 —— 进度显示在模型列表里。" });
    }

    /// <summary>Delete a model, freeing its disk.
    /// <para>Refused for one a layer is BOUND to, even when that binding is not running yet: recall is
    /// fail-open, so the household would see searches that quietly find less rather than an error naming
    /// what they removed. The refusal says which layer, and where to change it.</para></summary>
    [HttpPost("api/manage/models/remove")]
    public async Task<IActionResult> Remove([FromBody] ModelRequest body)
    {
        var model = body?.Model?.Trim();
        if (!EmbeddingCatalog.IsWellFormedId(model))
            return BadRequest(new { error = $"模型名称格式不正确:{body?.Model}" });

        var mem = Settings();
        switch (InUse(model!, mem, MemorySources.ResolveJudgeModel(mem)))
        {
            case MemoryLayers.Semantic:
                return StatusCode(409, new
                {
                    error = $"{model} 正在用于语义检索 —— 请先在「记忆检索」里换个模型或停用该层,再删除。",
                });
            case MemoryLayers.Judge:
                return StatusCode(409, new
                {
                    error = $"{model} 正在用于记忆判断 —— 请先在「记忆检索」里换个后端或模型,再删除。",
                });
        }

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

    public sealed record ModelRequest(string Model);

    /// <summary>Text to embed with the BUILT-IN model. Capped because this is a measurement door, not a
    /// general-purpose embedding service — an uncapped one is a CPU-bound endpoint behind the access
    /// gate.</summary>
    public sealed record EmbedRequest(string[] Texts);

    private const int MaxEmbedTexts = 64;
    private const int MaxEmbedChars = 4000;

    /// <summary>The one loaded session the benchmark door reuses. Static because a controller is per-request
    /// and the whole point is that the model is NOT reloaded per request — see <see cref="Embed"/> for the
    /// measurement that made this load-bearing. Keyed by directory so a re-provisioned model is picked up
    /// rather than served stale from a path that no longer holds those bytes.</summary>
    private static readonly object BenchGate = new();
    private static string? _benchDir;
    private static OnnxEmbedder? _benchEmbedder;

    private static OnnxEmbedder BenchEmbedder(string dir)
    {
        lock (BenchGate)
        {
            if (_benchEmbedder is not null && _benchDir == dir) return _benchEmbedder;
            _benchEmbedder?.Dispose();
            _benchDir = dir;
            return _benchEmbedder = new OnnxEmbedder(dir);
        }
    }

    /// <summary>Embed text with the 内置 model, in this process.
    ///
    /// <para><b>This exists so the built-in backend can be BENCHMARKED like the others.</b>
    /// <c>dev.mjs embed-bench</c> scores embedders by calling an OpenAI-compatible <c>/v1/embeddings</c>,
    /// which every Ollama-hosted model answers and an in-process ONNX session cannot. So the arm with no
    /// setup cost was also the arm with no way to measure it: its "same score as Ollama" rested on an 8-query
    /// probe written while choosing the runtime, which — as <c>docs/builtin-model-runner.md</c> says of
    /// itself — separates working from broken and cannot rank two working embedders. A recommendation the
    /// household cannot interrogate is the thing <see cref="EmbeddingCatalog"/> exists to prevent.</para>
    ///
    /// <para><b>It embeds through the product's own <see cref="OnnxEmbedder"/></b>, so the numbers describe
    /// what actually runs — same variant, same tokenizer, same symmetric prompting. A benchmark that
    /// embedded differently would measure a product we do not ship, which is why the bench refuses to reach
    /// Ollama's native <c>/api/embed</c> either.</para>
    ///
    /// <para><b>The session is CACHED across calls, and that is a correctness requirement, not a speed
    /// optimisation.</b> The first version built a fresh <see cref="OnnxEmbedder"/> per request — reasoning
    /// that the registered singleton only exists when 语义 is actually BOUND to 内置, and the bench must be
    /// able to score a backend the household has not chosen yet. True, but it made the endpoint measure
    /// something the product never does: the bench embeds one query per call, so every per-query figure
    /// carried a full model load, and 内置 reported <b>1011 ms/query</b> against Ollama's 89. The product
    /// loads the model once and holds it. Measured warm, the real figure is an order of magnitude lower —
    /// so the first number would have argued against shipping the backend on the strength of an artifact of
    /// this method.
    /// <para>The memory is not a new worst case: a household bound to 内置 already holds exactly this
    /// session for the life of the process, which is why the model is loaded lazily and never per call.</para></summary>
    [HttpPost("api/manage/models/embed")]
    public async Task<IActionResult> Embed([FromBody] EmbedRequest body, CancellationToken ct)
    {
        var texts = body?.Texts;
        if (texts is null || texts.Length == 0)
            return BadRequest(new { error = "没有要嵌入的文本。" });
        if (texts.Length > MaxEmbedTexts)
            return BadRequest(new { error = $"一次最多 {MaxEmbedTexts} 段文本(收到 {texts.Length})。" });
        if (texts.Any(t => (t?.Length ?? 0) > MaxEmbedChars))
            return BadRequest(new { error = $"单段文本最长 {MaxEmbedChars} 字。" });

        var dir = Services.ResourceProvisioner.ProvisionedEmbedModel(_platform.ResourcesPath);
        if (!OnnxEmbedder.IsPresent(dir))
            return StatusCode(409, new
            {
                error = "内置嵌入模型还没有下载 —— 在「资源 · Resources」面板下载「内置嵌入模型」后再试。",
                resource = BuiltInSemanticSource.ResourceId,
            });

        try
        {
            var embedder = BenchEmbedder(dir);
            var started = System.Diagnostics.Stopwatch.StartNew();
            var vectors = await embedder.EmbedAsync(texts.Select(t => t ?? string.Empty).ToList(), ct);
            var ms = (int)started.ElapsedMilliseconds;
            return Ok(new
            {
                model = BuiltInSemanticSource.ModelId,
                dims = vectors.Count > 0 ? vectors[0].Length : 0,
                msTotal = ms,
                msPerText = texts.Length > 0 ? ms / texts.Length : 0,
                vectors,
            });
        }
        catch (Exception ex)
        {
            _log.LogWarning("built-in embed failed: {Msg}", ex.Message);
            return StatusCode(502, new { error = ex.Message });
        }
    }
}
