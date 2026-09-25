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
    private readonly ILlamaServerRuntime _llama;
    private readonly ServerConfigService _config;
    private readonly IPlatformContext _platform;
    private readonly ILogger<ModelsController> _log;
    // The reranker judge's pace, when one is running — its skip count moves the 推荐 badge (Recommend). Null otherwise.
    private readonly RerankPace? _pace;

    public ModelsController(ILlamaServerRuntime llama, ServerConfigService config,
        IPlatformContext platform, ILogger<ModelsController> log, RerankPace? pace = null)
    {
        _llama = llama;
        _config = config;
        _platform = platform;
        _log = log;
        _pace = pace;
    }

    /// <summary>The startup-time facts a source needs to answer where it talks and whether it is ready.
    /// Built here rather than passed around because both this controller's questions want the same pair.</summary>
    private MemorySourceSettings Settings() => new(_config.Current.Memory, _platform.ResourcesPath);

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

    /// <summary>The inventory 资源 is entitled to show: the runtime the app installs, and the models the
    /// app downloaded.
    ///
    /// <para><b>Ollama is deliberately absent, and that is a correction rather than a simplification.</b>
    /// This endpoint used to list the household's Ollama models with pull and delete buttons beside them —
    /// against, on a real install, <c>…\Programs\Ollama\ollama.exe</c>, a program we did not put there.
    /// 资源 is the panel for what Gatherlight provisions; a delete button aimed at somebody else's tool is
    /// not a convenience, it is this panel claiming ownership it does not have. 本机 models are still fully
    /// usable — 记忆检索 lists them, because it reads the Ollama probe directly and never went through here
    /// — and they are managed with Ollama, which is what 本机 MEANS (see <c>MemoryGroups</c>).</para>
    ///
    /// <para>Consequently there is no <c>pulls</c> field and no pull endpoint: a GGUF is downloaded as a
    /// sha256-pinned RESOURCE like git or node, and reports progress through the resource list it already
    /// belongs to. One download mechanism, not two.</para></summary>
    /// <summary>Every model Gatherlight manages — ONE list, installed or not.
    ///
    /// <para><b>Why not two.</b> This used to return `models` (on disk) and `offers` (downloadable), and
    /// the console rendered them as three different components: a card for the built-in one, a grid row
    /// inside a disclosure for a downloaded GGUF, a table row for an undownloaded one. Three shapes and
    /// three left edges for one kind of object, differing only by a boolean. Downloaded is a STATE of a
    /// model, not a separate species, so it is a field on the row and the table sorts on it.</para>
    ///
    /// <para><b>Ollama is deliberately absent</b>, and that is a correction rather than a simplification.
    /// This endpoint used to list the household's Ollama models with pull and delete buttons beside them —
    /// against, on a real install, an <c>ollama.exe</c> under their own Programs directory, a program we
    /// did not put there. 资源 is the panel for what Gatherlight provisions; a delete button aimed at
    /// somebody else's tool is not a convenience, it is this panel claiming ownership it does not have.
    /// 本机 models are still fully usable — 记忆检索 lists them, because it reads the Ollama probe directly
    /// and never went through here — and they are managed with Ollama, which is what 本机 MEANS.</para>
    ///
    /// <para>Consequently there is no <c>pulls</c> field and no pull endpoint: every model here is a
    /// sha256-pinned RESOURCE and reports download progress through the resource list it already belongs
    /// to. One download mechanism, not two.</para></summary>
    [HttpGet("api/manage/models")]
    public async Task<IActionResult> Get([FromQuery] bool refresh = false)
    {
        var mem = Settings();
        // CHEAP by construction. `installed` is a file check and `serving` a 120 ms loopback connect
        // (LiveAsync); the build tag and device list come from whatever the last full probe left behind, and
        // a background refresh fills them in if nothing has. Awaiting the full probe here cost ~1.9 s on the
        // first open after every restart — two process starts for two strings that decorate one row — which
        // is the same defect the 记忆检索 panel had, in the same place, for the same reason.
        //
        // `refresh` still means refresh: an explicit re-probe is what the household asked for, and it is the
        // one path where waiting is the honest answer.
        // An explicit refresh re-probes ONLY when there is already something to refresh; otherwise the
        // cheap read plus the background probe below is both faster and the same answer. (This was a
        // three-branch conditional saying it twice.)
        var probe = refresh && _llama.Cached is not null
            ? await _llama.ProbeAsync(true)
            : await _llama.LiveAsync();
        var known = _llama.Cached;
        if (known is null) _ = _llama.ProbeAsync(ct: CancellationToken.None);
        var models = Models(mem);

        return Ok(new
        {
            // The runtime that hosts the llama.cpp rows — OURS. It carries its own problem sentence
            // because "no models" and "not started" have completely different fixes, and an empty list
            // says neither.
            runtime = new
            {
                id = MemoryBackends.LlamaCpp, baseUrl = probe.BaseUrl, installed = probe.Installed,
                serving = probe.Serving, version = known?.Version, executable = probe.Executable,
                // Reported by --list-devices, not guessed — this is the panel that pays for that answer.
                // From the last full probe when there is one — null rather than a guess when there is
                // not, because "no GPU" and "nobody has asked yet" are different answers and the row must
                // not print the first while meaning the second.
                gpuLikely = known?.GpuLikely ?? false, devices = known?.Devices ?? Array.Empty<string>(),
                // The tri-state the recommendation reads: false only when --list-devices answered with no GPU. From the
                // runtime's MEMO of the binary's device list, which an invalidation does not clear (ILlamaServerRuntime.Gpu):
                // read from the cached state, it went null — and the badge back to BGE — after every start or removal.
                gpu = probe.Installed ? _llama.Gpu : null,
                problem = probe.Problem,
            },
            models,
            // Recommended from what is NOT yet installed, and null once there is nothing left to suggest.
            // A fixed id here named the embedder, which is the first thing a household installs — so the
            // moment they took the advice the panel went on recommending a model they already had. A
            // recommendation that survives being followed is not a recommendation, it is a slogan.
            // The device state from the last FULL probe, and only while the runtime is installed — null ("not known")
            // otherwise, which keeps today's suggestion and claims nothing about the machine.
            recommendation = Recommend(models, probe.Installed, probe.Installed ? _llama.Gpu : null,
                _pace?.RecentSkips ?? (0, 0)),
            // The sample size travels with the numbers, here as everywhere: "9/10" invites the right
            // question where a bare adjective does not.
            measuredOn = MeasuredOnLabel(),
        });
    }

    /// <summary>One row per model the app manages, in the order the choice is actually made: by what the
    /// model is FOR, then by what you already have.</summary>
    private IReadOnlyList<ModelRowView> Models(MemorySourceSettings mem)
    {
        var rows = new List<ModelRowView>(GgufRows(MemorySources.BoundToLlamaCpp(mem))) { BuiltInRow(mem) };
        return rows
            .OrderBy(r => r.Capability == "embedding" ? 0 : 1)
            .ThenByDescending(r => r.Installed)
            .ThenBy(r => r.SizeBytes)
            .ToList();
    }

    /// <summary>The in-process ONNX embedder, as a row like any other — it is a model with a size, a
    /// capability and a state. Its facts come from <see cref="BuiltInSemanticSource.Catalog"/>, the single
    /// writer, so this row and the picker cannot disagree about what it scored.</summary>
    private ModelRowView BuiltInRow(MemorySourceSettings mem)
    {
        var c = BuiltInSemanticSource.Catalog;
        var installed = OnnxEmbedder.IsPresent(
            Path.Combine(_platform.ResourcesPath, BuiltInSemanticSource.ResourceId));
        // Bound only if 语义 is on the BUILT-IN backend. The same model id under a different backend is a
        // different thing, and reporting the wrong one as in-use either disables a live delete button or
        // enables a dangerous one.
        var inUse = MemorySources.ResolveSemantic(mem)?.Id == MemoryBackends.BuiltIn
            && string.Equals(mem.Config.EmbeddingModel, c.Id, StringComparison.OrdinalIgnoreCase)
                ? MemoryLayers.Semantic : null;
        return new ModelRowView(
            c.Id, c.Name, MemoryBackends.BuiltIn, "embedding",
            c.SizeBytes ?? 0, installed, inUse, c.Note ?? "",
            c.Measured is null ? null : new MeasuredView(
                c.Measured.RecallTop1, c.Measured.RecallTop3, c.Measured.Queries, c.Measured.MsPerQuery),
            BuiltInSemanticSource.ResourceId);
    }

    /// <summary>Every GGUF — on disk and fetchable — from one pass.
    ///
    /// <para>The shelf is a CLOSED list, unlike the Ollama one it replaced: we are the downloader here
    /// (repo, commit, checksum), so a model we have not pinned is a model we cannot verify. A file the
    /// household dropped into the directory themselves still gets a row, because it is on their disk and
    /// they may want the space back; it simply has no note and no measurement.</para></summary>
    private IEnumerable<ModelRowView> GgufRows(IReadOnlyList<(string Layer, string Model)> bound)
    {
        var dir = Services.ResourceProvisioner.ProvisionedGgufDir(_platform.ResourcesPath);
        var onDisk = Services.ResourceProvisioner.InstalledGgufIds(_platform.ResourcesPath);
        var ids = onDisk
            .Concat(GgufCatalog.Models.Select(m => m.Id))
            .Distinct(StringComparer.OrdinalIgnoreCase);

        foreach (var id in ids)
        {
            var known = GgufCatalog.Find(id);
            var installed = onDisk.Contains(id, StringComparer.OrdinalIgnoreCase);
            // Definitive from the catalogue for anything we pinned; the name heuristic — one writer, the
            // same one the router's presets use — only for a file the household supplied.
            var kind = known?.Capability ?? Services.ResourceProvisioner.GgufKind(id);
            yield return new ModelRowView(
                id, known?.Name ?? id, MemoryBackends.LlamaCpp,
                kind switch { GgufCapability.Embedding => "embedding", GgufCapability.Reranking => "reranking", _ => "completion" },
                installed ? SizeOnDisk(dir, id, known?.ApproxBytes ?? 0) : known?.ApproxBytes ?? 0,
                installed, GgufInUse(id, bound), known?.Note ?? "",
                known?.Measured is { } k
                    ? new MeasuredView(k.RecallTop1, k.RecallTop3, k.Queries, k.MsPerQuery)
                    : null,
                GgufCatalog.ResourceIdFor(id));
        }
    }

    /// <summary>What a model scored on this app's own recall job. Null for anything nobody benchmarked,
    /// which the console must SAY rather than leave blank: an empty cell in a comparison table reads as a
    /// zero, and an unmeasured model would then look like a bad one.</summary>
    public sealed record MeasuredView(int Top1, int Top3, int Queries, int MsPerQuery);

    /// <summary>One model the app manages. <paramref name="Installed"/> is the ONLY difference between a
    /// row you can delete and a row you can download — which is exactly why they are one type: two types
    /// became two components became three left edges.</summary>
    /// <param name="ResourceId">What to provision to get it. Sent rather than derived client-side; the
    /// client building this id by concatenation is how models landed in the runtimes column twice.</param>
    /// <para>There is deliberately NO vintage/date field. The Ollama table had one meaning the MODEL's
    /// release date, which the console styled as "old" below 2025 — and filling it from a measurement date
    /// (the only date a pinned GGUF carries) put two meanings in one field, so a freshly measured model
    /// would eventually render as an obsolete one. WHEN it was measured belongs with the sample size, in
    /// the footnote, which is where every other qualifier on these numbers already lives.</para>
    private sealed record ModelRowView(
        string Id, string Name, string Runtime, string Capability,
        long SizeBytes, bool Installed, string? InUse, string Note,
        MeasuredView? Measured, string ResourceId);

    /// <summary>Which model to put the 推荐 badge on, or null when there is nothing left to advise.
    ///
    /// <para>Only what is NOT installed can be recommended. A fixed id here named the embedder, which is
    /// the first thing a household installs — so the moment they took the advice the badge matched no row
    /// and the line went on recommending a model they already had.</para>
    ///
    /// <para>Order of preference: the measured GGUF embedder, then the built-in one (same weights, no
    /// runtime needed), then <see cref="GgufCatalog.RecommendedReranker"/> for 判断 — and NOTHING after that.
    /// 判断's pick was the Gemma 3 1B chat model until docs/judge-bench.md Run 3 (2026-09-24) measured it
    /// significantly WORSE than no judge (top-1 79 → 33 of 240); a reranker is a local judge that measured
    /// better. So is the Qwen3 0.6B chat judge (Run 5b), and it is never suggested here: the owner kept the reranker as
    /// 判断's local default (2026-09-24), which puts the answer on the page far more often (found@8 203 against 148),
    /// and a chat judge on disk does not stop the reranker suggestion either — it is a different kind of judge, not a
    /// second copy. The two fallbacks that followed went with it — "any embedder", then "whatever is smallest" — because
    /// once the three above are in, the smallest row left is a model nobody chose to recommend (the 1B, or a
    /// reranker kept off the badge), and a badge on it would be a claim no measurement stands behind. Null then is
    /// the honest answer: nothing left to advise.</para>
    ///
    /// <para><b>ONE embedder is enough, so the second is never suggested.</b> The two embedder rows are the same
    /// EmbeddingGemma 300M, as a GGUF for llama.cpp and as ONNX in this process — 语义 binds one of them. Offering
    /// the other once either is in recommended a redundant download, and hid the reranker suggestion behind it
    /// until the household had fetched the same model twice.</para>
    ///
    /// <para><b>…but only an embedder that can RUN counts as in.</b> The GGUF one needs the llama.cpp runtime; with its
    /// file on disk and the runtime gone, it read as "in" and the badge moved on to the reranker — which needs the same
    /// runtime — while 语义 had nothing that worked. What makes it work is the 35 MB runtime, not a second copy of the
    /// same weights, so that is what the line then recommends, naming the in-process 内置 row as the no-runtime
    /// alternative. The id is the runtime's RESOURCE id: no model row matches it, so no table row carries the badge —
    /// the runtime's own row above the table is where it is downloaded. (With nothing installed at all the GGUF
    /// embedder is still the first suggestion, runtime or not: it measured 9/10 against 8/10, and the runtime row says
    /// it is needed.)</para>
    ///
    /// <para><b>ONE reranker is enough too.</b> Any installed reranker is a local judge that measured better than
    /// none (docs/judge-bench.md Runs 2 and 4); suggesting BGE beside LAMAR or mMiniLMv2 was the same second-copy
    /// redundancy as the embedders. Proof for all of it: <c>e2e-p51</c>'s badge block.</para>
    ///
    /// <para><b>WHICH reranker depends on the machine</b> (<see cref="GgufCatalog.RecommendedRerankerFor"/>, owner decision
    /// 2026-09-25 on <c>docs/judge-bench.md</c> Run 8): where llama.cpp's device probe answered and listed no GPU
    /// (<paramref name="gpu"/> false), mMiniLMv2, with a reason quoting that run's CPU result and configuration; a GPU, or
    /// no answer yet, BGE as before, and the reason claims nothing about the machine. The one-reranker rule above holds
    /// either way — an installed reranker of any kind ends the suggestion. Proof: <c>e2e-p51</c>, with a stand-in binary
    /// that answers <c>--list-devices</c> with no device, then with one.</para>
    ///
    /// <para><b>…with ONE exception: a reranker that this machine is too slow for</b> (review, 2026-09-25). The device
    /// probe reads an integrated GPU as a GPU, so on nearly every laptop it keeps BGE — and a household who already
    /// installed BGE was told nothing at all while the judge skipped recall after recall, fail-open and unreported. So when
    /// the running judge's pace SKIPPED recent recalls (<paramref name="skips"/>), mMiniLMv2 is recommended whatever the
    /// probe says and even beside an installed reranker: the one-reranker rule rests on "any installed reranker is a
    /// local judge that measured better than none", which the skips refute on this machine. Never when mMiniLMv2 is itself
    /// installed — it is then no download (and, bound, the skips are its own). The 判断 row says the same, from the same
    /// writer (<see cref="GgufCatalog.RecommendedRerankerFor"/>). Proof: <c>e2e-p52</c> case 6h.</para></summary>
    private static object? Recommend(IReadOnlyList<ModelRowView> models, bool llamaRuntimeInstalled, bool? gpu,
        (int Skipped, int Recalls) skips)
    {
        var offers = models.Where(m => !m.Installed).ToList();
        var builtInIsIn = models.Any(m => m.Installed && m.Id == BuiltInSemanticSource.ModelId);
        var ggufEmbedderIsIn = models.Any(m => m.Installed && m.Id == GgufCatalog.RecommendedEmbedder);
        if (ggufEmbedderIsIn && !llamaRuntimeInstalled && !builtInIsIn)
            return new
            {
                // The runtime's RESOURCE id — ResourceProvisioner's catalogue entry, the id LlamaCppSource's own
                // "download the runtime" suggestion names too.
                id = "llama-cpp",
                reason = "「语义」要用的 EmbeddingGemma(GGUF)已经下载了,但它跑在 llama.cpp 上,而这台机器还没有这个运行时 —— "
                    + "在上面的资源列表里下载「本机模型运行时 · llama.cpp」(约 35 MB)就能用。"
                    + "不想多装一个运行时,也可以下载下表里标着「内置」的嵌入模型 —— 同一个模型,在应用自己的进程里运行,不需要运行时。",
                caution = (string?)null,
            };

        var anEmbedderIsIn = builtInIsIn || (ggufEmbedderIsIn && llamaRuntimeInstalled);
        var aRerankerIsIn = models.Any(m => m.Installed && m.Capability == "reranking");
        var skipped = skips.Skipped > 0;
        var pick = (anEmbedderIsIn ? null
                : offers.FirstOrDefault(o => o.Id == GgufCatalog.RecommendedEmbedder)
                  ?? offers.FirstOrDefault(o => o.Id == BuiltInSemanticSource.ModelId))
            // Only among OFFERS, i.e. not installed — so a skip never recommends mMiniLMv2 beside itself.
            ?? (aRerankerIsIn && !skipped ? null
                : offers.FirstOrDefault(o => o.Id == GgufCatalog.RecommendedRerankerFor(gpu, skipped)));
        if (pick is null) return null;

        if (pick.Capability == "embedding")
            return new
            {
                id = pick.Id,
                // Both embedder rows ARE measured on that benchmark (the GGUF 9/10 top-1, the built-in 8/10), so this
                // sentence claims only what is true of whichever one it lands on. It once said 「这几个里只有它…量过」 —
                // false of both, since each has a score in the same column.
                reason = "「语义」那一层用它 —— 它在本应用自己的 10 题检索基准上实测过,分数在「检索质量」一列。",
                caution = (string?)null,
            };

        return new
        {
            id = pick.Id,
            // What binding it MOVES, because a reranker is half a judge: the checking comes local, the tagging goes
            // to the Claude CLI — the clause the toast, the cost line and the model note all carry.
            reason = (pick.Id == GgufCatalog.RerankerWithoutGpu
                    // WHY this one and not BGE, said where the choice is made — docs/judge-bench.md Run 8, with the
                    // configuration its figures belong to. Reached when the device probe answered with no GPU, or when the
                    // running judge skipped recent recalls for being too slow — the reason says which.
                    ? "「判断」那一层在本机用它核对检索结果。"
                      + (skipped
                          ? $"最近 {skips.Recalls} 次检索里有 {skips.Skipped} 次因为这台机器太慢跳过了判断,所以推荐这个更小的重排模型:"
                          : "llama.cpp 在这台机器上用不了任何显卡,所以推荐这个更小的重排模型,而不是 BGE:")
                      + "在一台只用 CPU 的笔记本上(Intel Core Ultra 9 185H,不用显卡,llama.cpp b10549;60 条约 900–1,200 字的长笔记、"
                      + "240 道提问、不开语义、没有主题标注、每次由它挑 8 条上页)实测,它分段读每次检索约 17.5 秒、每次都在一分钟内判断完,"
                      + "答案带进前八 180/240(不开判断 104/240);BGE 每 1,000 个词元要约 3 秒,一次 40–60 条长笔记"
                      + "每条只读开头一段也要一分多钟到两分钟,几乎每次都等满一分钟、没能判断。"
                      + (skipped ? "" : "llama.cpp 能用显卡时推荐的是 BGE;")
                      + "只有集成显卡的机器两者都还没有量过。"
                    : "「判断」那一层在本机用它核对检索结果 —— 本应用双语测试集上,它让答案进前八的次数比不开判断多得多"
                      + "(数字和测法见这一行的说明)。")
                + "写入事实时的主题标注由 Claude CLI 完成(" + MemorySources.CliTaggingCost + ")。",
            // The 检索质量 column holds the embedders' 10-query score only, so this row reads 未实测 there — which,
            // beside a line recommending it, would read as a recommendation nobody measured.
            caution = "「检索质量」一列只放嵌入模型的 10 题检索分,所以它那一格是「未实测」;"
                + "它作为判断的实测在另一套测试上,数字在这一行的说明里。",
        };
    }

    /// <summary>Which layer is holding a GGUF, if any — and it checks the BACKEND, not just the name.
    ///
    /// <para>The Ollama version above compares model names alone, which is safe there because a tag is
    /// Ollama-shaped. Here it would not be: a household could plausibly have `embeddinggemma:300m` on
    /// Ollama and `embeddinggemma-300M-Q8_0` as a GGUF, and reporting the wrong one as in-use turns a
    /// delete button into a label on a model nobody is using — or worse, leaves it enabled on one that is.
    /// So the layer must ALSO be bound to llama.cpp for its model to count.</para>
    ///
    /// <para>Read from <see cref="MemorySources.BoundToLlamaCpp"/>, the set the start button and the startup step
    /// warm — so a model this badge calls 使用中 is exactly one they load. It asked the same resolvers itself
    /// before, a second writer of that set in this very file.</para></summary>
    private static string? GgufInUse(string modelId, IReadOnlyList<(string Layer, string Model)> bound) =>
        bound.FirstOrDefault(b => string.Equals(b.Model, modelId, StringComparison.OrdinalIgnoreCase)).Layer;

    /// <summary>Actual bytes on disk, falling back to the catalogue's figure. Measured rather than quoted
    /// because a household deciding what to delete wants the space they would get back, and a partially
    /// written file would otherwise report its intended size.</summary>
    private static long SizeOnDisk(string ggufDir, string modelId, long fallback)
    {
        try
        {
            var nested = Path.Combine(ggufDir, modelId);
            if (Directory.Exists(nested))
                return new DirectoryInfo(nested).EnumerateFiles("*.gguf").Sum(f => f.Length);
            // System.IO.File, fully qualified: inside a controller, bare `File` binds to
            // ControllerBase.File(byte[], string) and the error names a method nobody wrote.
            var flat = Path.Combine(ggufDir, modelId + ".gguf");
            if (System.IO.File.Exists(flat)) return new FileInfo(flat).Length;
        }
        catch (IOException) { /* fall through to the declared size */ }
        return fallback;
    }

    /// <summary>Start the runtime ONLY when nothing is answering — a household's own instance is left
    /// alone. Here rather than in 记忆检索 because starting a daemon is a provisioning act, and it was odd
    /// that the button for it lived on a panel that could not install the thing it was starting.</summary>
    /// <summary>What the app's OWN local runtime is doing — llama.cpp, as of 2026-08-22 the runtime this
    /// app provisions rather than merely connects to.
    ///
    /// <para>Reported separately from the Ollama state rather than merged into one "local models" blob,
    /// because they are different relationships and the panel now says which is which: this one we install,
    /// start and can restart; Ollama we detect. Collapsing them is what made a provisioned runtime read as
    /// a manual prerequisite in the first place.</para></summary>
    [HttpGet("api/manage/models/llama")]
    public async Task<IActionResult> Llama([FromQuery] bool refresh = false)
    {
        var s = await _llama.ProbeAsync(refresh);
        return Ok(new
        {
            baseUrl = s.BaseUrl, installed = s.Installed, serving = s.Serving,
            version = s.Version, executable = s.Executable,
            models = s.Models, devices = s.Devices,
            // Reported, not guessed: --list-devices answers this exactly, unlike the GpuLikely heuristic
            // the Ollama arm has to use. NULL when it did not answer (LlamaServerState.Gpu) — "no GPU" and "nobody
            // could ask" are different answers, and the 判断 suggestion changes on the first only.
            gpu = s.Gpu, devicesListed = s.DevicesListed,
            problem = s.Problem,
        });
    }

    /// <summary>Start the router, and WARM the models — the second half is not optional. `--models-max` is
    /// a cap, not a preload: llama-server loads a model on its first request, measured at 17.3 s for a 1B
    /// q4. Returning as soon as the router answers would hand the household a runtime that stalls on its
    /// first real recall, which is the cost this runtime was chosen to remove.
    ///
    /// <para><b>Warms what is BOUND, and nothing else</b> — <see cref="MemorySources.BoundToLlamaCpp"/>, the set the
    /// startup warm step reads, through the resolvers the DI wiring uses. Warming exists so the first RECALL does not
    /// stall, and only a bound model is recalled. It used to warm every GGUF of ours the router listed: the router
    /// holds `--models-max` 2, so with three of ours on disk the button loaded them in turn and could evict the
    /// bound judge or embedder with an unbound one of our own. One model per layer is never more than the router
    /// holds. Nothing bound → the router is started and nothing is loaded (<c>warmed: []</c>).</para>
    ///
    /// <para>That set is OURS by construction — a llama.cpp binding resolves only while its file is in the app's
    /// models folder — so the router's listing of the machine's llama.cpp/Hugging Face cache (four unrelated chat
    /// models, seen on a real machine) is never warmed either.</para>
    ///
    /// <para><b>A bound model the router does not list is REPORTED, not restarted in.</b> Warming it would go
    /// through <see cref="ILlamaServerRuntime.EnsureServesAsync"/>, which can restart our router to load a model
    /// downloaded after it started. That is a BIND's decision, and the start button is not a bind. The model rides
    /// in <c>notWarmed</c> with the reason, and in <c>note</c>, which the console shows as a warning.</para>
    ///
    /// <para><b>The cure depends on WHOSE router it is</b> (<see cref="LlamaServerState.Ours"/>). A service restart
    /// ends ours and the next start spawns one that lists every file, which the startup warm step loads; it leaves an
    /// ADOPTED one running — an orphan of a crash, or the household's own on our port — to be adopted again, so
    /// saying 「重启服务」 there sent the household round a restart for nothing. That case gets the runtime's own
    /// not-ours clause (<c>LlamaServerRuntime.NotOursRemedy</c>). Re-binding the model is not offered either way: the
    /// picker shows 使用中, with no button, for the current binding. Proof for all of it: <c>e2e-p51</c>.</para></summary>
    [HttpPost("api/manage/models/llama/start")]
    public async Task<IActionResult> LlamaStart()
    {
        if (!await _llama.EnsureServingAsync()) return NotRunning(await _llama.ProbeAsync(refresh: true));

        var state = await _llama.ProbeAsync(refresh: true);
        // It answered a moment ago and does not now: a router that died, or one holding the port without answering.
        // Not running either way, so this is the start failing, in the probe's own words (HELD names the port and
        // whose it is) — a 200 reading 「已在运行」 would have been false. Past this line `state.Models` is what the
        // router LISTS: a probe that did not answer reports the files on disk instead.
        if (!state.Serving) return NotRunning(state);

        var warmed = new List<string>();
        var cold = new List<(string Layer, string Model, string Cause, string Cure)>();
        foreach (var (layer, model) in MemorySources.BoundToLlamaCpp(Settings()))
        {
            var listed = state.Models.Contains(model, StringComparer.OrdinalIgnoreCase);
            // Same single writer the preset generator uses — a second copy of this test here is how the
            // preset and the warm-up would come to disagree about what a model is.
            if (listed && await _llama.WarmAsync(model, Services.ResourceProvisioner.GgufKind(model)))
            {
                warmed.Add(model);
                continue;
            }
            var name = layer == MemoryLayers.Semantic ? "语义" : "判断";
            cold.Add(listed
                ? (layer, model, $"「{name}」绑定的 {model} 没能载入", "请看「日志」里的原因。")
                : state.Ours
                    ? (layer, model, $"「{name}」绑定的 {model} 不在这个 llama.cpp 列出的模型里(多半是它启动之后才下载的),"
                        + "所以没有预热,启动按钮也不会为它重启 llama.cpp", "重启服务后应用会载入绑定的模型,载入不了时会说明原因。")
                    : (layer, model, $"「{name}」绑定的 {model} 不在这个 llama.cpp 列出的模型里,所以没有预热",
                        LlamaServerRuntime.NotOursRemedy));
        }
        return Ok(new
        {
            ok = true, warmed,
            notWarmed = cold.Select(c => new { layer = c.Layer, model = c.Model, why = $"{c.Cause}。{c.Cure}" }),
            models = state.Models, devices = state.Devices,
            // The console toasts `note` when there is one and 「已完成」 otherwise — so this is null exactly when every
            // bound model is warm. Each cure is said ONCE, after the models it applies to: both layers cold on one
            // router share one.
            note = cold.Count == 0 ? null : string.Concat(cold.GroupBy(c => c.Cure)
                .Select(g => string.Join(";", g.Select(c => c.Cause)) + "。" + g.Key)),
        });
    }

    /// <summary>The start failing — before the router answered, or after it stopped — in the probe's own words.</summary>
    private ObjectResult NotRunning(LlamaServerState state) =>
        StatusCode(409, new { error = state.Problem ?? "无法启动 llama-server。" });

    /// <summary>Delete a model, freeing its disk.
    /// <para>Refused for one a layer is BOUND to, even when that binding is not running yet: recall is
    /// fail-open, so the household would see searches that quietly find less rather than an error naming
    /// what they removed. The refusal says which layer, and where to change it.</para></summary>
    [HttpPost("api/manage/models/remove")]
    public IActionResult Remove([FromBody] ModelRequest body)
    {
        var model = body?.Model?.Trim();
        if (!EmbeddingCatalog.IsWellFormedId(model))
            return BadRequest(new { error = $"模型名称格式不正确:{body?.Model}" });
        // The check above rejects the shapes that are dangerous to hand to a process or a path — no
        // traversal, no leading dash, a conservative character set — which is exactly as necessary for a
        // filename as for an Ollama tag, so both runtimes pass through it.

        var mem = Settings();

        // BOTH kinds of model are deletable, and through the same gate. The built-in one used to offer
        // 重新下载 where a GGUF offered 删除 — two different verbs in one column for two rows of the same
        // table, and no way at all to reclaim its 222 MB. Every model here is a directory we created, so
        // "delete" means the same thing for all of them.
        //
        // The gate exists because recall is fail-open: deleting a BOUND model gives searches that quietly
        // find less rather than an error naming what was removed. Only our own models reach here — an
        // Ollama model is the household's, managed with Ollama (see Get()).
        var builtIn = string.Equals(body?.Runtime, MemoryBackends.BuiltIn, StringComparison.OrdinalIgnoreCase);
        var holder = builtIn
            ? BuiltInRow(mem).InUse
            : GgufInUse(model!, MemorySources.BoundToLlamaCpp(mem));
        if (holder is not null)
            return StatusCode(409, new
            {
                error = holder == MemoryLayers.Semantic
                    ? $"{model} 正在用于语义检索 —— 请先在「记忆检索」里换个模型或停用该层,再删除。"
                    : $"{model} 正在用于记忆判断 —— 请先在「记忆检索」里换个模型或后端,再删除。",
            });
        return builtIn ? RemoveBuiltIn(model!) : RemoveGguf(model!);
    }

    /// <summary>Delete the provisioned ONNX model directory.
    ///
    /// <para>Refuses an id that is not the built-in model's, so this cannot be pointed at an arbitrary
    /// resource: the resources folder also holds git, node, the CLI and llama.cpp, and a delete endpoint
    /// that took any install directory would be a way to uninstall the app's own runtimes through the
    /// model table. <see cref="ResourceProvisioner"/> re-reads the ready marker on every Status() call, so
    /// removing the directory is the whole operation — there is no cached "installed" to invalidate.</para></summary>
    private IActionResult RemoveBuiltIn(string modelId)
    {
        if (!string.Equals(modelId, BuiltInSemanticSource.ModelId, StringComparison.OrdinalIgnoreCase))
            return StatusCode(404, new { error = $"没有找到本机模型 {modelId}。" });

        var dir = Path.Combine(_platform.ResourcesPath, BuiltInSemanticSource.ResourceId);
        try
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
            return Ok(new { ok = true, removed = modelId });
        }
        catch (Exception ex)
        {
            _log.LogWarning("removing {Model} failed: {Msg}", modelId, ex.Message);
            return StatusCode(502, new { error = ex.Message });
        }
    }

    /// <param name="Runtime">Which runtime holds it. Sent by the caller rather than inferred, because an
    /// Ollama tag and a GGUF id are not reliably distinguishable and guessing wrong here deletes the wrong
    /// thing — or reports success while deleting nothing.</param>
    public sealed record ModelRequest(string Model, string? Runtime = null);

    /// <summary>Text to embed with the BUILT-IN model. Capped because this is a measurement door, not a
    /// general-purpose embedding service — an uncapped one is a CPU-bound endpoint behind the access
    /// gate.</summary>
    /// <summary>Delete a provisioned GGUF — both layouts, because both are enumerated (a directory we
    /// created, or a bare file the household dropped in). Refuses anything that is not actually a model we
    /// can see, so a malformed id cannot be turned into a path.</summary>
    private IActionResult RemoveGguf(string modelId)
    {
        if (!Services.ResourceProvisioner.InstalledGgufIds(_platform.ResourcesPath)
                .Contains(modelId, StringComparer.OrdinalIgnoreCase))
            return StatusCode(404, new { error = $"没有找到本机模型 {modelId}。" });

        var dir = Services.ResourceProvisioner.ProvisionedGgufDir(_platform.ResourcesPath);
        try
        {
            var nested = Path.Combine(dir, modelId);
            if (Directory.Exists(nested)) Directory.Delete(nested, recursive: true);
            var flat = Path.Combine(dir, modelId + ".gguf");
            if (System.IO.File.Exists(flat)) System.IO.File.Delete(flat);
            _llama.Invalidate();
            _log.LogInformation("removed gguf {Model}", modelId);
            return Ok(new { ok = true, removed = modelId });
        }
        catch (Exception ex)
        {
            _log.LogWarning("removing gguf {Model} failed: {Msg}", modelId, ex.Message);
            return StatusCode(500, new { error = ex.Message });
        }
    }

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
