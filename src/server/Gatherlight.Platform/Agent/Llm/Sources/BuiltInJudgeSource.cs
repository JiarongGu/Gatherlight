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
/// <para><b>Offered, and RECOMMENDED where there is no usable GPU — by measurement.</b> It is the same checkpoint llama.cpp
/// serves as <see cref="GgufCatalog.SmallReranker"/>, in another quantisation (ONNX qint8 against GGUF Q8_0), tokenizer
/// implementation and runtime, so "the same model" was a claim until <c>docs/judge-bench.md</c> Run 13 (2026-09-28, Lyntai
/// 3.5.1, one laptop's CPU) paired the two within one run: on the 240-question fixture found@8 203 against 203 (equivalent)
/// and top-1 99 against 100 (equivalent); on the long fixture 180 against 182 and 81 against 79, no significant difference;
/// and per recall 0.47 against 0.82 s and 8.1 against 20.0 s against llama.cpp on the CPU (faster on 223 and 225 of 240).
/// Until then it was offered as unmeasured and nothing recommended it. Now <see cref="GgufCatalog.RerankerWithoutGpu"/> IS
/// it: the fresh-install (nothing has answered whether there is a GPU — round-6 review), no-GPU, skip-driven and
/// BGE-measured-too-slow suggestions name it, one writer (<see cref="GgufCatalog.RecommendedRerankerFor"/>). Where
/// llama.cpp lists a GPU, BGE on llama.cpp is recommended, and the text says what for: a long note's answer on the page
/// more often (found@8 201 against llama.cpp's mMiniLMv2 at 182, Runs 6c and 12) — NOT speed: the fast one on a discrete
/// GPU is the same mMiniLMv2 on llama.cpp (0.30 against 0.47 s, 1.2 against 8.1 s), while BGE takes ~0.46 s and ~3.2 s
/// (Runs 11, 6c/12). The text credited BGE with that speed until the review (<see cref="OnADiscreteGpu"/>). It binds only
/// after the same screen every reranker passes (<see cref="RerankScreen"/>).</para>
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

    /// <summary>The catalogued GGUF this export has the SAME WEIGHTS as — whose row declares the window the pairs are fitted
    /// to (<see cref="Window"/>).</summary>
    public const string SameWeightsAs = GgufCatalog.SmallReranker;

    /// <summary>The window pairs are fitted to: the catalogue's DECLARATION for the same model — one writer of the
    /// number, the one llama.cpp's preset and fit read (<see cref="GgufCatalog.DeclaredWindow"/>). The same tokenizer
    /// family on the same vocabulary, so <see cref="RerankInputCap"/>'s character bound holds for it unchanged; the
    /// export's own window (512) is checked against it at load (<see cref="InProcessReranker"/>).</summary>
    public static int? Window => GgufCatalog.DeclaredWindow(SameWeightsAs);

    /// <summary>What it did against llama.cpp on a CPU, in one clause, for the sentences that RECOMMEND it — the 判断 row's skip
    /// notice and 资源's badge reason — pointing at the row for the configuration. One writer, so the recommendation and the
    /// row cannot quote it differently. docs/judge-bench.md Run 13: medians per recall, the 240-question fixture and the long
    /// fixture, on one laptop's CPU.</summary>
    public const string CpuComparison =
        "它就是 mMiniLMv2,在应用进程里用 CPU 运行,不需要 llama.cpp;在一台笔记本的 CPU 上实测,事实都很短时它判断得和 llama.cpp"
        + " 上的同一个模型一样好,长笔记上没有测出显著差别,每次检索却快得多(短事实约 0.47 秒对 0.82 秒,长笔记约 8.1 秒对 20 秒;"
        + "实测和设置见「资源」里 mMiniLMv2(内置)那一行的说明)";

    /// <summary>What a DISCRETE GPU would change, for a household whose machine may have one — the fresh-install badge, the
    /// skip-driven reason and the skip notice where llama.cpp lists a GPU or has not answered. Two figures, each its own
    /// comparison, each said with what it compares: the SAME model on a discrete GPU is the fast one (Run 13's GPU arm,
    /// llama.cpp's mMiniLMv2: 1.2 s per long-note recall against 内置's 8.1 s), and BGE brings a long note's answer onto the
    /// page more often (found@8 201 against llama.cpp's mMiniLMv2 at 182, both on one GPU, Runs 6c and 12; 内置's own long
    /// figure is Run 13's 180) — which is what BGE is recommended on a GPU for, not speed (~0.46 s short, ~3.2 s long). And
    /// an integrated GPU may not help: on one laptop's Arc both llama.cpp rerankers ran slower than its CPU.</summary>
    public const string OnADiscreteGpu =
        "在一块独立显卡上,llama.cpp 上的同一个 mMiniLMv2 快得多(长笔记每次约 1.2 秒,「内置」约 8.1 秒),"
        + "llama.cpp 上的 BGE 把长笔记的答案带进前八的次数更多(同一块显卡上 201/240 对 mMiniLMv2 的 182/240;"
        + "「内置」自己在另一轮是 180/240);集成显卡上 llama.cpp 不一定比 CPU 快";

    /// <summary>What this model IS, whether or not it is on disk — 资源's row and the picker read the same facts.
    ///
    /// <para>Every figure is docs/judge-bench.md Run 13's (2026-09-28): Lyntai 3.5.1; one laptop's CPU (Intel Core Ultra 9
    /// 185H), ~17–22% of it busy with other work; the 240-question bilingual fixture and the long fixture (60 notes of
    /// ~900–1,200 characters), 语义 off, a page of 8 endorsed; each arm's accuracy pass alone; the qint8 ONNX export
    /// against llama.cpp's Q8_0 GGUF of the same model. Top-1 / found@8: short 99 / 203 against the GPU arm's 100 / 203
    /// (both equivalent), long 81 / 180 against 79 / 182 (no significant difference; 9/7 on found@8, p = 0.804). Median per
    /// recall: 467 ms short and 8,061.5 ms long, against llama.cpp on the CPU's 817.5 and 19,958.5 and on the GPU's 300 and
    /// 1,229.5. The per-set figures are descriptive only (one of 16 uncorrected tests), so they are said as such: on the long
    /// fixture's cross-language set 41 against the GPU arm's 47, on the same-language set 50 against 46. Memory ~0.76 GB
    /// private after short facts and ~1.04 GB after long notes (B1's 0.7–1.0 GB, just past its upper end); the load 1.25–1.37
    /// s at the first judged recall.</para></summary>
    public static readonly ModelOption Catalog = new(
        ModelId, "mMiniLMv2(内置 · 判断 · 重排)", Installed: true,
        SizeBytes: 135_704_003,
        Note: "判断用的重排模型,在应用进程里用 CPU 运行:不需要 llama.cpp,没有常驻服务,也没有端口,文件约 136 MB;"
            + "第一次判断时先载入约 1.3 秒,载入后一直占用内存(实测约 0.76–1.04 GB,直到重启服务;更大的检索没有量过)。"
            + "检索时的判断在本机完成;写入事实时的主题标注由"
            + " Claude CLI 完成(" + MemorySources.CliTaggingCost + ")。"
            + "它和 llama.cpp 上的 mMiniLMv2 是同一个模型:这里是模型仓库自己导出的 ONNX 8 位版本,那边是 Q8_0 的 GGUF。"
            + "本应用双语测试集 240 道提问、不开语义、每次由它挑 8 条上页,在一台笔记本的 CPU 上实测(Intel Core Ultra 9 185H,"
            + "Lyntai 3.5.1):首位命中 99/240,前八命中 203/240,同一轮 llama.cpp 在显卡上是 100/240 与 203/240,可以算一样好;"
            + "60 条约 900–1,200 字的长笔记上是 81/240 与 180/240,对 79/240 与 182/240,没有测出显著差别"
            + "(按提问语言拆开只作描述:跨语言的少带进 6 题,同语言的多 4 题)。"
            + "每次检索约 0.47 秒(短事实)与 8.1 秒(长笔记),比 llama.cpp 只用 CPU 时快得多(0.82 秒与 20 秒),"
            + "比同一个模型在 llama.cpp、一块独立显卡上慢(0.30 秒与 1.2 秒)。"
            + "所以还不知道这台机器有没有能用的显卡(llama.cpp 还没装)、llama.cpp 用不了任何显卡、检索因为机器太慢跳过了判断、"
            + "或 BGE 在这台机器上实测太慢时,应用推荐它;llama.cpp 看得到显卡时推荐的是 llama.cpp 上的 BGE —— "
            + "长笔记上它把答案带进前八的次数更多(同一块显卡上 201/240 对 mMiniLMv2 的 182/240)。"
            + "许可:模型卡写的是 Apache-2.0,但训练它用的 MS MARCO 数据只许非商业使用。");

    public string Id => MemoryBackends.BuiltIn;
    public string Name => "ONNX";

    public string Description =>
        "适合:这台机器用不了显卡,或者不想另外装运行时 —— 在应用进程里用 CPU 运行 mMiniLMv2 重排模型,"
        + "不需要 llama.cpp,没有常驻服务,也没有端口,约 136 MB。它只做核对:写入事实时的主题标注仍由 Claude CLI 完成,"
        + "消耗账号额度。实测它在事实都很短时判断得和 llama.cpp 那条的 mMiniLMv2 一样好,长笔记上没有测出显著差别,只用 CPU 时快得多;"
        + "有独立显卡时,推荐的是 llama.cpp 上的 BGE —— 长笔记上它把答案带进前八的次数更多;"
        + "同一个 mMiniLMv2 在独立显卡上也快得多(长笔记每次约 1.2 秒对 8.1 秒)。";

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

    /// <summary>What the household must know on binding it: what it costs — memory held until a restart, and how long a
    /// recall of long notes takes — and where something else does better. It said "unmeasured, so not recommended" until
    /// docs/judge-bench.md Run 13 measured it (2026-09-28); then 「打分时多占」 and 「每次要几秒」, which the review found
    /// understated both (the memory stays; the long-note median is 8.1 s, its p90 15.6 s, the longest 47.5 s), and credited
    /// the speed of a discrete GPU to BGE, whose GPU advantage is found@8 on long notes (see <see cref="OnADiscreteGpu"/>).</summary>
    public string? BindCaveat(string model) =>
        "它在 CPU 上运行:载入后一直占用内存(实测约 0.76–1.04 GB,直到重启服务;更大的检索没有量过);"
        + "长笔记多的检索每次要几秒到几十秒(实测中位数约 8.1 秒,九成在 15.6 秒以内,最慢约 47.5 秒)。"
        + "有独立显卡的机器上,推荐的是 llama.cpp 上的 BGE —— 长笔记上它把答案带进前八的次数更多;"
        + "同一个 mMiniLMv2 在独立显卡上长笔记每次约 1.2 秒。";

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
    /// recall that is never verified. Off the request thread: the load is ~1.2–1.4 s of CPU.
    ///
    /// <para><b>A SECOND session, for as long as the screen runs, when one is already loaded</b> — the container was built
    /// bound to 内置, the household switched away without restarting, and now binds it again: the running verifier's
    /// session stays, and the screen loads the weights and tokenizer (~136 MB of files) once more, scores two short
    /// documents, and disposes it. Not reused, on purpose: this source is a static catalog entry that holds no container,
    /// and the screen is of the files on disk NOW, not of whatever the running session loaded. What the second session
    /// costs in memory at its peak was not measured; it is released when the screen ends (review, round 6).</para></summary>
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
