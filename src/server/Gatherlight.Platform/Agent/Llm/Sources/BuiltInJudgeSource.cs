using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Hosting.Resources.Services;
using Lyntai;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>
/// 判断 on the in-process reranker — mmarco-mMiniLMv2 as ONNX, scored on the CPU inside this process
/// (<see cref="InProcessReranker"/>). It VERIFIES; tagging stays on the Claude CLI, exactly as for llama.cpp's reranker,
/// because a cross-encoder scores pairs and never writes a subject handle.
///
/// <para><b>It was a declined entry for a reason that stopped being true, and then an unbuilt one.</b> Until Lyntai 3.5
/// the in-process ONNX path read WordPiece tokenizers only, so the one reranker proven through it was English-only
/// (ms-marco-MiniLM-L6-v2), while the multilingual rerankers are SentencePiece and ran on llama.cpp
/// (<c>docs/superpowers/specs/2026-09-23-reranker-judge-and-verdict-bench-design.md</c> §Constraints). Lyntai's D191
/// (3.5.0) owns a SentencePiece tokenizer that reads <c>tokenizer.json</c>, and records this very model running end to
/// end — which left the declined entry saying "not built", honestly, until the owner decided (2026-09-26, confirmed in
/// round 6) to build it. dev-conventions' rule held throughout: "cannot" is only for a real impossibility, never for an
/// option nobody built.</para>
///
/// <para><b>Offered, described, and NOT recommended — because it is not measured.</b> It is the same checkpoint llama.cpp
/// serves as <see cref="GgufCatalog.RerankerWithoutGpu"/>, but a different quantisation (ONNX qint8 against GGUF Q8_0), a
/// different tokenizer implementation and a different runtime, so its quality is a claim until
/// <c>docs/judge-bench.md</c> Run 13 compares the two within one run. Every sentence it owns says so, and nothing
/// recommends it: 资源's badge never names it and an installed copy does not end the suggestion of a measured reranker
/// (<c>ModelsController.Recommend</c>). It stays bindable — worse or costlier would be reasons to describe it, and
/// unmeasured is a reason to say so — but only after the same screen every reranker passes
/// (<see cref="RerankScreen"/>).</para>
///
/// <para><b>Everything past the model is shared with llama.cpp's reranker</b> (<see cref="RerankVerification"/>): the
/// fit to the model's declared window, the windows, the pace, the admission and the skip, the page it endorses. The
/// window is the catalogue's declaration for the same model (512), not a second copy of the number.</para>
/// </summary>
public sealed class BuiltInJudgeSource : IMemoryJudgeSource
{
    /// <summary>The resource id this backend's model arrives as — the same string 资源 provisions under, and the install
    /// directory's name.</summary>
    public const string ResourceId = "rerank-model";

    /// <summary>What the picker offers, and the only thing it offers: one exported model, like the built-in embedder's
    /// <c>embeddinggemma-300m-onnx</c>. Not the GGUF's id — that is llama.cpp's file, and the same weights in two
    /// runtimes are two models to bind, delete and measure.</summary>
    public const string ModelId = "mmarco-mMiniLMv2-L12-H384-v1-onnx";

    /// <summary>The catalogued GGUF this export has the SAME WEIGHTS as — so "is the small reranker what runs?" can be
    /// answered across runtimes (<see cref="MemorySources.RunsModel"/>) without a branch on a backend id.</summary>
    public const string SameWeightsAs = GgufCatalog.RerankerWithoutGpu;

    /// <summary>The window pairs are fitted to: the catalogue's DECLARATION for the same model — one writer of the
    /// number, the one llama.cpp's preset and fit read (<see cref="GgufCatalog.DeclaredWindow"/>). The same tokenizer
    /// family on the same vocabulary, so <see cref="RerankInputCap"/>'s character bound holds for it unchanged; the
    /// export's own window (512) is checked against it at load (<see cref="InProcessReranker"/>).</summary>
    public static int? Window => GgufCatalog.DeclaredWindow(SameWeightsAs);

    /// <summary>What this model IS, whether or not it is on disk — 资源's row and the picker read the same facts.</summary>
    public static readonly ModelOption Catalog = new(
        ModelId, "mMiniLMv2(内置 · 判断 · 重排)", Installed: true,
        SizeBytes: 135_704_003,
        // The speed and memory are docs/self-managed-llm-runtime.md §2026-09-28, one laptop's CPU, by hand on the real
        // export: 138–173 ms per 1,000 pair tokens for 8 short pairs and for one long note in 3 windows (quiet runs), a
        // recall of 8 notes of ~1,000 characters 1.7–2.2 s in the app, and the app's private memory 59 MB with 判断 off
        // against 739 MB after the first judged recall and 1,023 MB after long-note recalls. No quality figure: none exists.
        Note: "判断用的重排模型,在应用进程里用 CPU 运行:不需要 llama.cpp,没有常驻服务,文件约 136 MB;"
            + "打分时应用会多占约 0.7–1.0 GB 内存。检索时的判断在本机完成;写入事实时的主题标注由 Claude CLI 完成("
            + MemorySources.CliTaggingCost + ")。"
            + "它和 llama.cpp 上的 mMiniLMv2 是同一个模型(这里是模型仓库自己导出的 ONNX 8 位版本),"
            + "但判断质量还没有在本应用的测试集上实测过,也还没有和 llama.cpp 那条对比过,所以不推荐。"
            + "速度只在一台笔记本的 CPU 上量过(Intel Core Ultra 9 185H):每 1,000 个词元约 0.14–0.17 秒,"
            + "8 条约 1,000 字的长笔记一次检索约 2 秒;较长的事实同样分段读,机器太慢时应用会少读几段或跳过这次判断。"
            + "许可:模型卡写的是 Apache-2.0,但训练它用的 MS MARCO 数据只许非商业使用。");

    public string Id => MemoryBackends.BuiltIn;
    public string Name => "ONNX";

    public string Description =>
        "适合:想在本机核对检索结果,又不想另外装运行时 —— 在应用进程里用 CPU 运行 mMiniLMv2 重排模型,"
        + "不需要 llama.cpp,没有常驻服务,也没有端口,约 136 MB。它只做核对:写入事实时的主题标注仍由 Claude CLI 完成,"
        + "消耗账号额度。和 llama.cpp 那条的 mMiniLMv2 是同一个模型,但还没有对比实测过,所以不推荐。";

    /// <summary>Where the provisioned model lives — derived from the settings, as every source in the static catalog
    /// does (see <see cref="MemorySources"/>).</summary>
    private static string ModelDir(MemorySourceSettings s) => ResourceProvisioner.ProvisionedRerankModel(s.ResourcesPath);

    /// <summary>No address: it runs inside this process.</summary>
    public bool NeedsEndpoint => false;
    public string? Endpoint(MemorySourceSettings s) => null;

    /// <summary>Configured = every file the provider reads is on disk. There is no runtime to be missing — ONNX Runtime
    /// ships in the app — so the files are the whole prerequisite.</summary>
    public bool IsConfigured(MemorySourceSettings s) => InProcessReranker.IsPresent(ModelDir(s));

    /// <summary>The one model it offers, and its files there.</summary>
    public bool HasModel(MemorySourceSettings s, string model) =>
        string.Equals(model, ModelId, StringComparison.OrdinalIgnoreCase) && IsConfigured(s);

    /// <summary>The two ways <see cref="HasModel"/> says no: a model this backend does not offer, or its files not (all)
    /// there — which 资源 fetches.</summary>
    public string WhyNotHere(MemorySourceSettings s, string model) =>
        !string.Equals(model, ModelId, StringComparison.OrdinalIgnoreCase)
            ? $"{model} 不是「内置」的模型 —— 「内置」在「判断」这一层只提供重排模型 mMiniLMv2"
            : $"内置重排模型 mMiniLMv2 的文件不在 {ModelDir(s)}(或不全)—— 可以在「资源 · Resources」面板下载「内置重排模型(mMiniLMv2)」";

    /// <summary>Managed — the app downloads the model and runs it; the group costs disk, not quota, for the checking.</summary>
    public string Group => MemoryGroups.Managed;

    public RuntimeOrigin Origin(MemorySourceContext ctx) =>
        new(MemoryRuntimeOrigins.Bundled, "在应用内直接运行 —— 没有第二个进程,也没有端口");

    /// <summary>Register wires a provider and a pace into the container, which is built once.</summary>
    public bool TakesEffectOnRestart => true;

    /// <summary>The provider — lazy, so a household with 判断 switched off never loads 118 MB of weights — and the
    /// pace, which starts from this machine's CPU measured in process at its first use
    /// (<see cref="InProcessReranker.MeasurePaceSeed"/>) and presumes nothing busy after a cut, because this scorer
    /// stops an abandoned call at its next pass.</summary>
    public void Register(LyntaiBuilder b, MemoryWiringContext ctx)
    {
        var dir = ModelDir(ctx.Settings);
        b.Services.AddSingleton(sp => new InProcessReranker(dir, Window, sp.GetService<ILogger<InProcessReranker>>()));
        // The same instance behind the router's provider list; the container disposes it once (Dispose is idempotent).
        b.AddProvider(sp => sp.GetRequiredService<InProcessReranker>(), InProcessReranker.Declared);
        RerankVerification.AddPace(b, sp => sp.GetRequiredService<InProcessReranker>().MeasurePaceSeed(),
            abandonedCallsRunOn: false);
    }

    /// <summary>Verification by the in-process cross-encoder, through the chain llama.cpp's reranker uses; annotation by
    /// the default client on <see cref="AnnotationModel"/>.</summary>
    public JudgeWiring Wiring(MemoryWiringContext ctx) =>
        JudgeWiring.Reranker(AnnotationModel(ctx.Model), InProcessReranker.ProviderId, Window);

    /// <summary>A reranker's id must never reach the CLI — tagging runs on the CLI's default judge model.</summary>
    public string AnnotationModel(string model) => MemorySources.DefaultJudgeModel;

    /// <summary>The default client's only candidate: the CLI, where the tagging goes.</summary>
    public string AnnotationProvider(string model) => Lyntai.Providers.ClaudeCli.ClaudeCliProvider.ProviderId;

    /// <summary>It only checks — stated beside <see cref="AnnotationModel"/>, as the interface requires.</summary>
    public bool ChecksOnly(string model) => true;

    /// <summary>BOTH halves, because they cost different things — and the tagging clause is
    /// <see cref="MemorySources.CliTaggingCost"/>, the one the toast and the model note carry.</summary>
    public string Cost(string? model) =>
        "检索时的判断由应用进程里的重排模型在 CPU 上完成:不消耗账号额度,不联网,也不需要 llama.cpp。"
        + "写入事实时的主题标注由 Claude CLI 完成 —— " + MemorySources.CliTaggingCost + ";"
        + "没有已登录的 CLI 时只是不标注,检索时的判断照常。";

    /// <summary>What the household must know on binding it: unmeasured, so not recommended.</summary>
    public string? BindCaveat(string model) =>
        "它和 llama.cpp 上的 mMiniLMv2 是同一个模型,但判断质量还没有实测过、也还没有和那条对比过,所以应用不推荐它;"
        + "它在 CPU 上运行,长事实多的检索会慢一些。";

    public Task<SourceStatus> StatusAsync(MemorySourceContext ctx, CancellationToken ct = default) =>
        Task.FromResult(IsConfigured(ctx.Settings)
            ? SourceStatus.Ready
            : new SourceStatus(false,
                "内置重排模型还没有下载 —— 在「资源 · Resources」面板下载「内置重排模型(mMiniLMv2)」(约 136 MB);"
                + "它在应用进程里运行,不需要 llama.cpp。", ResourceId));

    public Task<IReadOnlyList<ModelOption>> ModelsAsync(MemorySourceContext ctx, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<ModelOption>>(IsConfigured(ctx.Settings) ? [Catalog] : []);

    /// <summary>The same screen every reranker passes before it may bind (<see cref="RerankScreen"/>), scored by a fresh
    /// load of the files on disk — which also proves they LOAD, since a damaged file would otherwise surface only as a
    /// recall that is never verified. Off the request thread: the load is ~1 s of CPU.</summary>
    public async Task<string?> RejectAsync(MemorySourceContext ctx, string model, CancellationToken ct = default)
    {
        var dir = ModelDir(ctx.Settings);
        double[] scores;
        try
        {
            scores = await Task.Run(() =>
            {
                using var reranker = new InProcessReranker(dir, Window);
                return reranker.ScoreNow(RerankScreen.Query, RerankScreen.Documents);
            }, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            return $"内置重排模型没能在应用里载入或打分:{ex.Message} —— 文件可能不完整;"
                + "请在「资源 · Resources」面板删除「内置重排模型」后重新下载。";
        }
        return RerankScreen.AnswerFirst(scores)
            ? null
            // Not 「换一个」, as llama.cpp's refusal says: there is no other built-in model, and the pinned files ranking
            // backwards would mean they are damaged or the runtime is wrong — so the remedy is a fresh download, or llama.cpp.
            : $"内置重排模型没有通过重排自检:答案没有排在前面(答案 {scores[RerankScreen.Answer]:0.###},"
              + $"干扰项 {scores[1 - RerankScreen.Answer]:0.###})—— 应用钉过的文件不该这样,可能是文件损坏;"
              + "请在「资源 · Resources」面板删除「内置重排模型」后重新下载,或改用 llama.cpp 上的 mMiniLMv2。";
    }
}
