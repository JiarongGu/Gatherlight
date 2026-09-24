namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>What a GGUF is FOR. llama-server's <c>embeddings</c> and <c>reranking</c> presets each restrict a
/// child to one API, so this is not a label — it decides how the model is launched, and a wrong value makes
/// the model refuse every call it is asked to serve.</summary>
public enum GgufCapability
{
    Embedding,
    Completion,
    /// <summary>A cross-encoder: scores (query, document) pairs, never generates. Served with
    /// <c>reranking = true</c>, which RESTRICTS its child to <c>/v1/rerank</c>.</summary>
    Reranking,
}

/// <summary>One downloadable GGUF for the app-provisioned llama.cpp runtime.</summary>
/// <param name="Id">The model id the router will answer to — and, because <c>--models-dir</c> derives an id
/// from the DIRECTORY name when a model sits in one, also this model's install directory. So the id is ours
/// to choose: the router answers to it whatever the file inside is called. And every row CHOOSES the upstream
/// file's stem, on purpose — a catalogued id is typed and fitted by its row, and the stem is also the id a
/// household who drops that same file in flat ends up with (a flat file takes its filename), so they get the
/// row too rather than a kind guessed from the name (see the mMiniLMv2 row, whose stem has no "rerank").</param>
/// <param name="Repo">HuggingFace repo.</param>
/// <param name="Commit">Pinned COMMIT, never a branch: a branch ref lets the bytes move under the checksum,
/// which then reads as a corrupt download rather than as an upstream edit.</param>
/// <param name="File">The filename inside the repo — and inside our install dir, unchanged, so the download
/// is traceable back to the thing it came from.</param>
/// <param name="Measured">What it scored on this app's own recall job, or null. Null must be SAID by the UI,
/// not left blank: an empty cell in a comparison table reads as a zero.</param>
/// <param name="ContextTokens">The model's own token window, DECLARED when it is a hard limit on what the model can
/// be sent — null for a model that takes whatever the launch preset gives it. Read for a RERANKER, by both sides of
/// one contract: the preset launches it with this <c>ctx-size</c> and batch (<see cref="LlamaServerRuntime"/>), and
/// <see cref="RerankInputCap"/> fits every (query, document) pair to it. Past it llama.cpp refuses the WHOLE
/// <c>/v1/rerank</c> call — one over-long pair and no candidate is scored — and the verifier fails open, so a missing
/// declaration is a silent loss of verification on exactly the recalls that surface a long fact. Declared from the
/// GGUF header's <c>context_length</c> and the served slot size, both measured, never guessed.</param>
public sealed record GgufModel(
    string Id,
    string Name,
    GgufCapability Capability,
    string Repo,
    string Commit,
    string File,
    string Sha256,
    long ApproxBytes,
    string Note,
    EmbeddingMeasurement? Measured = null,
    int? ContextTokens = null);

/// <summary>
/// The GGUFs the app can download for its own llama.cpp runtime — the shelf, as
/// <see cref="EmbeddingCatalog"/> is the shelf for Ollama.
///
/// <para><b>Why this is a CLOSED list where the Ollama one is not.</b> `EmbeddingCatalog` is explicitly a
/// suggestion rather than a gate: anything Ollama can pull is selectable, because Ollama resolves a tag
/// against its own registry and we only advise. Here we are the downloader — url, commit and checksum — so
/// a model we have not pinned is a model we cannot fetch. The trade is deliberate: a household gains a
/// verified download and loses free choice, and the panel says so rather than presenting a short list as if
/// it were the whole world. A household who wants something else drops its GGUF into the models folder
/// (<c>ResourceProvisioner.ProvisionedGgufDir</c>, <c>state/resources/gguf</c>): the router serves it, 资源 lists
/// it and 记忆检索 offers it — with no note, no measurement, and a kind guessed from its file name
/// (<c>ResourceProvisioner.GgufKind</c>), which the panel's fine print says in those words. (This said "points
/// <c>openai-compat</c> at it" until that backend was retired, 2026-08-22.)</para>
///
/// <para><b>Every entry is sha256-pinned at a commit</b>, like git, node and the ONNX model. Unlike
/// <c>ollama pull</c>, which fetches a mutable tag, this cannot silently become different bytes.</para>
///
/// <para><b>Measurements are per model and honestly sparse.</b> Only the embedder has been scored on the
/// 10-query fixture (9/10 top-1, 25 ms/query through the app, 2026-08-22 — the same instrument as every
/// number in <see cref="EmbeddingCatalog"/>). The rerankers and two chat models have been scored AS 判断 on
/// the 240-question bilingual fixture (<c>docs/judge-bench.md</c>: Run 2 for LAMAR and BGE, Run 3 for Gemma 3
/// 1B, Run 4 for mMiniLMv2, Run 5b for Qwen3 0.6B) — top-1 and found@8, which is not the shape of
/// <see cref="EmbeddingMeasurement"/> (top-3 of 10 queries), so those figures live in the note and
/// <see cref="GgufModel.Measured"/> stays null rather than carrying a found@8 in a top-3 slot. The 4B chat model has
/// no measurement at all, and its note says so; claiming otherwise is the failure this whole area keeps correcting.
/// (Run 5b also measured Qwen3.5 0.8B — no significant difference from no judge — and Gemma 3 270M — worse; neither
/// is catalogued.)</para>
///
/// <para><b>There is no recommended CHAT judge, and that is a decision, not an omission.</b> Gemma 3 1B
/// was <c>RecommendedJudge</c> — 推荐 in its name, 「判断质量没有单独实测过」 in its note, the model 资源's 推荐
/// badge fell to and the download the 判断 row suggested — until Run 3 (2026-09-24) measured it significantly
/// WORSE than no judge. It stays selectable and says so; the constant is gone, and 判断's local default is
/// <see cref="RecommendedReranker"/>. Qwen3 0.6B (Run 5b) is the first chat judge measured BETTER than no judge on
/// both metrics — and it is offered, not recommended: the reranker still puts the answer on the page far more often
/// (found@8 203 against 148 in the same run), which is what the owner kept the default for (2026-09-24).</para>
/// </summary>
public static class GgufCatalog
{
    /// <summary>The embedder 语义 uses. Same weights as Ollama's recommended model, a different
    /// quantisation, and measured as an equal on retrieval at half the size.</summary>
    public const string RecommendedEmbedder = "embeddinggemma-300M-Q8_0";

    /// <summary>The reranker the bilingual bench recommends (docs/judge-bench.md, Run 2) — by the tie rule
    /// declared before the run, and by NOTHING measured. Paired on the same 240 questions, LAMAR and BGE were
    /// neither significantly different nor equivalent on top-1 or on found@8, so the rule took the smaller
    /// file — and the two files differ by 1,408 bytes.
    ///
    /// <para><b>The leans are not symmetric, and the notes say so.</b> found@8 — the metric a reranker is FOR —
    /// leans LAMAR 5–0 (exact p = 0.063, just short; the bench's own interval [−4.0, −0.1] pp excludes zero),
    /// while BGE's top-1 lead is 6–2 (p = 0.289, an interval spanning zero). The rule stands as registered:
    /// re-picking after seeing which way the data leaned would be worse than a tie-break that runs against the
    /// lean. It is a tie-break, and <see cref="RerankerPair"/> says that where the household reads it.</para>
    ///
    /// <para><b>It is also 判断's local DEFAULT</b> (owner decision, 2026-09-24): the model 资源's 推荐 badge offers
    /// once the embedders are in, and the download the 判断 row suggests when llama.cpp holds no judge model. That
    /// job was the Gemma 3 1B chat model's until Run 3 measured it worse than no judge; a reranker is a local
    /// judge that measured BETTER (Runs 2 and 4). So is Qwen3 0.6B (Run 5b), a chat judge — and it stays offered, not
    /// the default: it ranks the answer first more often than BGE and gets it onto the page far less often (found@8
    /// 148 against 203), and the owner kept the reranker (2026-09-24). Which reranker is still the tie-break above, and the note says
    /// so where the badge points. Its display name carries no 推荐 — no row's does — because a name is read in
    /// every picker, long after the advice has been taken. Re-run <c>dev.mjs judge-bench</c> before treating the
    /// choice between rerankers as more than the tie-break.</para></summary>
    public const string RecommendedReranker = "bge-reranker-v2-m3-Q5_K_M";

    /// <summary>What every reranker row says, because it is the one thing that differs from a chat judge:
    /// only HALF of 判断 moves. The tagging clause is <see cref="Sources.MemorySources.CliTaggingCost"/>, shared
    /// with the cost line and the bind toast — it once left out that tagging spends the account.</summary>
    private const string RerankerNote =
        "判断用的重排模型:检索时的判断在本机完成;写入事实时的主题标注由 Claude CLI 完成("
        + Sources.MemorySources.CliTaggingCost + ")。";

    /// <summary>What a reranker row's measured figures are read AGAINST — the same 240 questions with 判断 off
    /// and with the Claude CLI judge, the two other answers this layer offers (docs/judge-bench.md, Runs 1 and
    /// 2: same seed, same questions, equal formula digests). Shared because the comparators are the same for
    /// every reranker, and a figure with nothing beside it cannot be weighed. The trade is stated both ways:
    /// a reranker puts the answer on the page far more often and first hardly more often, because it chooses
    /// which eight make the page and the engine still orders them.
    /// <para>The Claude figures are Run 1's CONTENT-ONLY arm (130 / 131, serial median 8.7 s, Haiku) — the judge input
    /// that ships since 2026-09-24 — not its <c>content</c> arm (topic — content: 132 / 133, 9.5 s), the 1.3.0
    /// input, which Run 1 measured equivalent. A number belongs to its configuration. The wait is
    /// <see cref="Sources.MemorySources.ClaudeJudgeWait"/>, the one writer the CLI row quotes too.</para></summary>
    private const string RerankerMeasuredAgainst =
        "同一测试集上,不开判断是 79/240 与 125/240(每次约 0.23 秒),Claude CLI 判断(Haiku)是 130/240 与 131/240"
        + "(每次" + Sources.MemorySources.ClaudeJudgeWait + "):重排把答案带进前八的次数多得多,排到第一的次数却只比不开判断略多 —— "
        + "它挑哪八条上页,先后仍按原来的排序。";

    /// <summary>The configuration every reranker row's figures were measured in (docs/judge-bench.md Runs 2 and 4): the
    /// 240-question fixture, 语义 off (no embedder), and each recall's page of 8 chosen by the reranker (EndorseCount =
    /// the page). A reranker's gain belongs to its configuration — with an embedder, or a different page, it was not
    /// measured — so the figures never appear without it.</summary>
    private const string RerankerBenchSetup = "本应用双语测试集 240 道提问、不开语义、每次检索由它挑 8 条上页:";

    /// <summary>What a reranker row's latency was measured UNDER: serial medians with the model already loaded,
    /// on one machine's GPU, over recalls of at most 60 candidates (docs/judge-bench.md, Run 2). A reranker
    /// scores every candidate it is shown, so a CPU-only machine — or a recall showing it more — may be much slower.
    /// A bare 「0.47 秒」 would promise that figure on any machine.
    ///
    /// <para><b>How many it is shown depends on the recall's LIMIT</b>, not only on its kind: Lyntai verifies 4× the
    /// candidates <c>FactIndex.RankAsync</c> asks for, which is min(3 × limit, 100) with no kind and 100 with one — so
    /// up to 96 at the default page of 8, and 400 on a recall naming a kind OR asking for 34 or more. This said
    /// 「限定类别、候选可达 400 条」 until 2026-09-24, true only at the default limit.</para>
    ///
    /// <para><b>And on how LONG the candidates are</b> (<c>docs/judge-bench.md</c> Runs 6 and 6c): the row figures are on
    /// facts of at most 101 characters. A candidate longer than one window is scored in several (ChunkedScoreProvider,
    /// the default since 2026-09-24), each window a pair the model scores, so the same recall on 60 notes of 883–1,241
    /// characters — the same GPU, warm, serial medians — took 3.2 s on BGE and LAMAR (3,150 / 3,156 ms) and 1.2 s on
    /// mMiniLMv2 (1,155 ms), against 2.0 / 2.2 / 0.5 s when each note was cut to its first window. The clause names those
    /// figures and their notes, because 「事实很长时更慢」 alone would not let a household weigh it.</para></summary>
    private const string RerankerLatencyCaveat =
        "(模型已加载、在显卡上、每次不超过 60 条候选、事实都很短时测得;只有 CPU 的机器、候选更多或事实很长的检索,"
        + "都可能慢得多 —— 默认每次取 8 条时候选最多 96 条,限定类别或一次要 34 条以上时可达 400 条;"
        + "较长的事实会分段打分、每段都要算一次,在 60 条约 900–1,200 字的长笔记上,"
        + "BGE 与 LAMAR 每次检索约 3.2 秒,mMiniLMv2 约 1.2 秒)";

    /// <summary>LAMAR against BGE, ONE sentence shared by both rows — the same comparison read from either side,
    /// so the two notes cannot tell it differently. It used to say only that the fixture could not separate
    /// them, which hid that the two leans are not symmetric: found@8, where a reranker earns its place, leans
    /// LAMAR with nothing on the other side (5–0; exact p = 0.063, just short, while the 95% interval excludes
    /// zero), and BGE's top-1 lead is 6–2 with an interval spanning zero. The Chinese count is the one the doc
    /// states exactly: every Chinese-worded question, code-switched included (120 of 240) — see "By fact
    /// language" in docs/judge-bench.md.
    ///
    /// <para><b>What "6" counts, recounted 2026-09-24 from <c>results-2026-09-23T113455.224Z.json</c></b>
    /// (partition arms, limit 8): six DISTINCT questions on which the two differ on top-1 or on found@8, and
    /// none differs on both — top-1 on four (anniversary and pharm-24h LAMAR's, onsen and flu-shot BGE's),
    /// found@8 on two (train-express and movie, both LAMAR's). It once said 「4 题 LAMAR 对,2 题 BGE 对」,
    /// which is true only as a tally across the two metrics; the sentence now names the metric each count is
    /// on.</para></summary>
    private const string RerankerPair =
        "LAMAR 和 BGE 这个测试集没有测出差别,但两边并不对称:把答案带进前八,偏向 LAMAR —— 5 题只有 LAMAR 做到,"
        + "反过来一题也没有(精确检验 p = 0.063,差一点够不上显著,95% 区间不含零);排第一,BGE 多 4 题"
        + "(6 对 2,看不出差别)。120 道中文或中英混写的提问里,两者只有 6 题结果不同,没有一题两项都不同:"
        + "排第一的 4 题两边各占 2 题,带进前八的 2 题都是 LAMAR 做到。"
        + "推荐 BGE 只是按事先定好的规则 —— 分不出时取较小的文件,而两个文件只差 1.4 KB。";

    public static readonly IReadOnlyList<GgufModel> Models = new[]
    {
        new GgufModel(
            RecommendedEmbedder, "EmbeddingGemma 300M(Q8 · 语义)", GgufCapability.Embedding,
            "ggml-org/embeddinggemma-300M-GGUF", "0f741b5a6585bd53aeb15cd1372c56f2a0f65e12",
            "embeddinggemma-300M-Q8_0.gguf",
            "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63", 333_590_944,
            // Compared with the SIBLING in the same group, which is the choice a household is actually making —
            // it used to compare with an Ollama option the panel no longer has. Numbers are the two rows' own
            // measurements, so the note cannot disagree with the table it sits in.
            "语义检索用,由 llama.cpp 运行。和内置的 ONNX 版本是同一个 EmbeddingGemma 模型:这一版首位命中多一题"
            + "(10 题中 9 对 8),代价是多一个运行时(约 35 MB)和一个常驻服务。",
            new EmbeddingMeasurement(9, 10, 25, 10, "2026-08-22")),

        // DESCRIBED BY ITS MEASUREMENT, NOT RECOMMENDED (docs/judge-bench.md Run 3, 2026-09-24). Every figure carries
        // the configuration it was measured in — the 240-question fixture, 语义 off (no embedder), the default
        // content-only judge input, and the no-judge base (79 / 125) it is read against — because a number without
        // them cannot be weighed. Content only is the arm quoted since it is what ships; `topic — content` read
        // 44 / 121, also worse on top-1. Its speed and quota facts stay: they are true, and they are the trade-off a
        // household is weighing against the result. The latencies are the SAME fixture's serial medians, model warm,
        // on one GPU: this judge 403 ms and no judge 219 ms (Run 3), the Claude CLI judge 8,733 ms (Run 1's content-only
        // arm, the shipped input). They read 「每次判断约 0.15–0.20 秒(Claude CLI 那条实测每次检索 9–17 秒)」 until
        // 2026-09-24: a per-CALL figure beside a per-RECALL one, the second from five runs on one household's 16 facts,
        // while the reranker rows beside it quoted Run 1's 8.7 s — two configurations in adjacent rows. The GPU clause
        // then sat after all three figures, as if it covered the CLI's too; it is scoped to the one figure it
        // describes, and the CLI wait comes from its one writer (MemorySources.ClaudeJudgeWait), with its model.
        new GgufModel(
            "gemma-3-1b-it-Q4_K_M", "Gemma 3 1B(Q4 · 判断)", GgufCapability.Completion,
            "ggml-org/gemma-3-1b-it-GGUF", "f9c28bcd85737ffc5aef028638d3341d49869c27",
            "gemma-3-1b-it-Q4_K_M.gguf",
            "8ccc5cd1f1b3602548715ae25a66ed73fd5dc68a210412eea643eb20eb75a135", 806_058_240,
            "判断用的对话模型:写入时的主题标注和检索时的判断都在本机完成,不消耗账号额度。"
            + "本应用双语测试集 240 道提问、不开语义、判断按默认只读事实内容:每次检索约 0.40 秒(模型已加载、在显卡上),"
            + "不开判断约 0.22 秒,Claude CLI 判断(Haiku)" + Sources.MemorySources.ClaudeJudgeWait + ",都是串行中位数。"
            + "但实测它让检索比不开判断更差:"
            + "答案排第一从不开判断的 79 题降到 33 题,带进前八从 125 题降到 111 题,"
            + "两项都是显著变差。量的是检索时的判断,它自己写的主题标注没有量过。"
            + "要在本机做判断,重排模型和 Qwen3 0.6B 在同一测试集上都让检索变好(见它们的说明)。"),

        // UNMEASURED HERE, and not a candidate we mean to recommend — said plainly, and without borrowing the 1B's
        // result in either direction: Run 3 measured one model at one size. Its size is the two pinned files': 2,489,757,856
        // B against the 1B's 806,058,240 — 3.1×, not the "四倍" this note once claimed for both parameters and footprint
        // (the parameter counts are ~4× apart; the Q4 files are not).
        new GgufModel(
            "gemma-3-4b-it-Q4_K_M", "Gemma 3 4B(Q4 · 判断 · 更大)", GgufCapability.Completion,
            "ggml-org/gemma-3-4b-it-GGUF", "d0976223747697cb51e056d85c532013931fe52e",
            "gemma-3-4b-it-Q4_K_M.gguf",
            "882e8d2db44dc554fb0ea5077cb7e4bc49e7342a1f0da57901c0802ea21a0863", 2_489_757_856,
            "同样用于判断,参数量约是 1B 的四倍,文件约 2.5 GB,是 1B 的三倍多:更大、更慢,显存不够时会明显更慢。"
            + "判断质量没有在这里实测过 —— 1B 的实测结果说明不了它会怎样;我们也不打算推荐它。"),

        // THE LOCAL CHAT JUDGE THAT MEASURED BETTER (docs/judge-bench.md Run 5b, committed 1e8e743), offered and NOT
        // recommended: RecommendedReranker stays the local default by the owner's decision (2026-09-24). Every figure
        // is Run 5b's and carries its configuration — the 240-question fixture, 语义 off, content-only judge input,
        // thinking off with the 512-token cap (the preset LlamaServerRuntime.WritePresets writes for a chat model),
        // one chat model per run beside 公式 and BGE. top-1 79 → 110 (+12.9pp, p < 0.001) and found@8 125 → 148
        // (+9.6pp, p < 0.001) against no judge; against BGE in the same run, top-1 +8.3pp (p = 0.002) and found@8
        // 148 against 203 (−22.9pp). Serial median 381 ms against the run's 公式 220 ms. Coverage 226/234.
        //
        // ITS FOOTPRINT IS NOT ITS DOWNLOAD, and the note says so (docs/self-managed-llm-runtime.md, 2026-09-24). Its
        // training window is 40,960 tokens with full attention on all 28 layers, and an uncapped llama.cpp child reserves
        // the KV cache for all of it: +5,175 MiB of GPU memory for the router plus this child (nvidia-smi, b10549, one RTX
        // 4080 Laptop GPU) — 「约 5.4 GB」 — against a 639 MB file. The app launches chat models at 16,384
        // (LlamaServerRuntime.ChatContextTokens): +2,472 MiB on the same machine, 「约 2.6 GB」, both decimal GB like
        // every size in these notes. Run 5b launched it uncapped; the cap sits far above every fixture prompt (60
        // candidates, ~1.7k tokens), so its figures stand.
        //
        // Its TAGGING is unmeasured, and the note says so: the fixture's subject tags were written by the Claude CLI
        // when the seed was built, so no run has scored the tags this model writes. Why a household might still pick
        // it is the other half of the same fact — tagging and checking both stay on the machine, no account quota.
        // Pinned at Qwen's own repo, commit and sha256 as Run 5's pre-registration recorded them; HEAD-checked
        // 2026-09-24 (X-Repo-Commit and X-Linked-Size / X-Linked-ETag match). The repo itself declares Apache-2.0.
        // Id = the upstream stem, as every row.
        new GgufModel(
            "Qwen3-0.6B-Q8_0", "Qwen3 0.6B(Q8 · 判断)", GgufCapability.Completion,
            "Qwen/Qwen3-0.6B-GGUF", "23749fefcc72300e3a2ad315e1317431b06b590a",
            "Qwen3-0.6B-Q8_0.gguf",
            "9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031", 639_446_688,
            "判断用的对话模型:写入时的主题标注和检索时的判断都在本机完成,不消耗账号额度。"
            + "本应用双语测试集 240 道提问、不开语义、判断按默认只读事实内容、关闭思考(应用启动它时就这样设置),"
            + "每轮只测这一个对话模型:答案排第一从不开判断的 79 题增加到 110 题,带进前八从 125 题增加到 148 题,"
            + "两项都显著变好。和同一轮的 BGE 重排模型比:它把答案排在第一的次数更多(多 8.3 个百分点,显著),"
            + "BGE 把答案带进前八的次数多得多(203 对 148)。每次检索约 0.38 秒,同一轮不开判断约 0.22 秒"
            + "(串行中位数,模型已加载、在显卡上)。"
            + "文件约 640 MB,运行时 llama.cpp 为它预留的显存却约 2.6 GB(应用按 16,384 个词元的上下文启动它,"
            + "在一块显卡上实测、含服务本身;不设上限时会按它训练时的 40,960 个词元预留,约 5.4 GB)。"
            + "它自己写的主题标注好不好没有量过 —— 测试集里的主题标注是 Claude 写的。"
            + "许可:Apache-2.0(Qwen 的官方仓库写明)。"),

        new GgufModel(
            "LAMAR-600m.Q5_K_M", "LAMAR 600M(Q5 · 判断 · 重排)", GgufCapability.Reranking,
            "mradermacher/LAMAR-600m-GGUF", "cd4da764d5b17d9996710dbf0ef5ad31c9aed182",
            "LAMAR-600m.Q5_K_M.gguf",
            "ec708b20336577c63702dd8efb23060bc611933579572bf9ad47ce2eaeda546f", 468_393_760,
            // NO LoCoMo figure on either reranker row. Each once quoted Lyntai's English LoCoMo gain — this one
            // +9.0 of 9.5 (2026-09-15, nomic-embed-text, base 83.0%), BGE's +5.5 for its Q8 (2026-09-10,
            // embeddinggemma, base 85.5%) — so side by side they compared two different CONFIGURATIONS, and
            // tilted toward LAMAR in a run where LAMAR Q8 exactly EQUALLED BGE Q8. Lyntai's own rule is that a
            // reranker's delta belongs to its configuration (docs/memory-measurements.md). The household's
            // evidence is this app's own bench; the Lyntai figures, with their bases, are in dev-conventions.
            // The configuration rides with the figures (RerankerBenchSetup), as it does on the mMiniLMv2 row — these two
            // quoted bare 「本应用双语测试集」 while the row below said 不开语义 and 8 on the page.
            RerankerNote + RerankerBenchSetup + "首位命中 86/240,前八命中 208/240,每次检索约 0.47 秒"
            + RerankerLatencyCaveat + "。" + RerankerMeasuredAgainst + RerankerPair),
        new GgufModel(
            RecommendedReranker, "BGE Reranker v2 M3(Q5 · 判断 · 重排)", GgufCapability.Reranking,
            "gpustack/bge-reranker-v2-m3-GGUF", "3093af03b1a635e67b084b1d8c03c5f5e020fd05",
            "bge-reranker-v2-m3-Q5_K_M.gguf",
            "1a212007526c7083627eed92b39dd4472e90ff1374a03fb068733378220813ef", 468_392_352,
            // No claim about public Chinese benchmarks: this row once said it was stronger than its peers there,
            // naming no benchmark and no source — an attribution nobody could check is not one.
            RerankerNote + RerankerBenchSetup + "首位命中 90/240,前八命中 203/240,每次检索约 0.49 秒"
            + RerankerLatencyCaveat + "。" + RerankerMeasuredAgainst + RerankerPair),

        // THE SMALL RERANKER (docs/judge-bench.md Run 4, 2026-09-24): offered, NOT recommended — BGE stays
        // RecommendedReranker by the owner's decision. Every figure is Run 4's and carries its configuration: the
        // 240-question fixture, 语义 off, EndorseCount 8 = the page, candidates ≤ 60, base 79 / 125; BGE and LAMAR are
        // quoted from the SAME run (204 / 208), not from their own rows' Run 2 figures, because only a within-run
        // pairing says anything. Its found@8 against BGE is "no significant difference" and NOT "equivalent" (7/2,
        // p = 0.180, 95% [−4.6, +0.5]pp), and against LAMAR a measured loss (9/0, p = 0.004) — both said.
        //
        // THE ID IS THE UPSTREAM FILE NAME, and deliberately has no "rerank" in it. A catalogued id is typed by its
        // row (ResourceProvisioner.GgufKind asks the catalogue first), so it needs no name hint — and keeping the
        // upstream stem means a household who drops the file in under its own name gets THIS row too: typed a
        // reranker, and fitted to its window. Under an id of ours with "rerank" in it, that same dropped-in file
        // would stay uncatalogued and be typed a CHAT judge by its name — the hazard Run 4 recorded, which is why
        // the bench had to rename it. The other rows follow the same rule (id = upstream stem).
        //
        // ITS WINDOW IS 512 TOKENS — the GGUF's context_length, and the slot size llama.cpp serves it with whatever
        // the preset asks — so the row declares it: the preset launches it at 512 and RerankInputCap fits every
        // pair to it. At the 1,000-character cap every other reranker gets, dense Chinese is 781 tokens and the
        // whole call is refused. What the fit COSTS on a long fact was measured (docs/judge-bench.md Runs 6 and 6c, 60
        // notes of 883–1,241 characters, 240 questions, no subject tags, no embedder, a page of 8 chosen by the reranker):
        // cut to its first window, a note whose answer sat at its END reached the page 4 times in 60 — worse than no judge
        // (29) — and scored in windows (ChunkedScoreProvider, the default since 2026-09-24) 44 times; at the START, 52 and
        // 50, no significant difference. The note says both, with the configuration, and what is still unmeasured; its
        // long-note latency is RerankerLatencyCaveat's. The note said 「这样截短…还没有量过」 until then, which Run 6 made
        // false. Licence: the model card says Apache-2.0; its training set, mMARCO, is
        // a translation of MS MARCO, whose terms are non-commercial; the GGUF repo declares none — so the note says
        // what the CARD says rather than what the model "is".
        //
        // ITS LATENCY WAS MEASURED UNDER THE 4096 LAUNCH (Run 4's router preset, before this row declared 512), and the
        // product now launches it at 512 — so the rerank CALL was re-measured under both, 2026-09-24, on the same GPU:
        // dedicated llama-server b10549, --n-gpu-layers 99, 12 fixture questions × all 60 fixture facts per call, 36 calls
        // each after a warm-up — median 75.1 and 79.3 ms at 4096 (two runs), 76.3 ms at 512. No difference beyond the
        // 4096 launch's own run-to-run spread, so the whole-recall 0.31 s / +0.08 s stand, said as measured at 4096.
        // Reproducible: `dev.mjs rerank-window` (its part 3); docs/self-managed-llm-runtime.md records the run.
        new GgufModel(
            "mmarco-mMiniLMv2-L12-H384-v1-Q8_0", "mMiniLMv2(Q8 · 判断 · 重排 · 更小)", GgufCapability.Reranking,
            "keisuke-miyako/mmarco-mMiniLMv2-L12-H384-v1-gguf-q8_0", "2b37d162c88e0aeb8a1b4acb2d50f0e5ade16fd5",
            "mmarco-mMiniLMv2-L12-H384-v1-Q8_0.gguf",
            "91d70301828ba735c22eda56adb649f48975f371337e8c8b046326b885e26eed", 132_584_000,
            RerankerNote + "体积约 133 MB,是 BGE 的 28%。" + RerankerBenchSetup.TrimEnd(':')
            + "(不开判断是 79/240 与 125/240):前八命中 199/240,同一轮 BGE 是 204/240 —— 没有测出显著差别,"
            + "但也不能算一样好,这一轮排除不了它最多少带进约 11 题;比 LAMAR(208/240)显著少,9 题只有 LAMAR 带进前八,"
            + "反过来一题也没有。首位命中 99/240,比同一轮 BGE 的 90 和 LAMAR 的 86 多,但和 BGE 的差距不足以下结论。"
            + "每次检索约 0.31 秒,同一轮 BGE 约 0.45 秒" + RerankerLatencyCaveat + ";这一轮是按 4096 个词元启动它的,"
            + "应用现在按 512 启动 —— 单次重排调用(60 条候选)在两种启动下另测过,都约 0.08 秒,看不出差别。"
            + "它一次最多只能读 512 个词元:应用把提问截短到放得下,较长的事实则分成几段来读 —— 每段约 250–500 个字符,"
            + "相邻两段有重叠,一条最多 5 段 —— 各段分别打分、取最高的一段。这是量过才改的:在 60 条约 900–1,200 字的长笔记上"
            + "(240 道提问、不开语义、没有主题标注、每次由它挑 8 条上页),答案在笔记末尾时,只读开头的旧做法把答案带进前八"
            + "只有 4/60,比不开判断(29/60)还差;分段读之后是 44/60。答案在开头时两种做法没有显著差别(52/60 与 50/60)。"
            + "还没有量过的:长短事实混在一起时会怎样;还有长到 5 段读不完的事实(约 1,000–2,000 字以上,提问越长、每段越短),"
            + "段与段之间会有读不到的部分。"
            + "许可:模型卡写的是 Apache-2.0(下载用的 GGUF 仓库没有写明许可),但训练它用的 MS MARCO 数据只许非商业使用。",
            ContextTokens: 512),
    };

    public static GgufModel? Find(string? id) =>
        id is null ? null : Models.FirstOrDefault(m => string.Equals(m.Id, id, StringComparison.OrdinalIgnoreCase));

    /// <summary>The token window a model's row DECLARES, or null — the ONE read behind both halves of a reranker's
    /// input contract: the window <see cref="LlamaServerRuntime"/> launches it with, and the window
    /// <see cref="RerankInputCap"/> fits each (query, document) pair to. Two lookups could disagree; one cannot.
    ///
    /// <para><b>A GGUF the household dropped in has no row, so no declared window — a STATED limit.</b> What then
    /// happens to a small-window model depends on its NAME, because that is all <c>ResourceProvisioner.GgufKind</c>
    /// has: named with "rerank", it is served at 4096 with the 1,000-character cap and refused on long input, as
    /// before per-model windows existed; named without it — this very model's other quants included, whose upstream
    /// stems carry no "rerank" either — <c>ResourceProvisioner.GgufKind</c> types it CHAT, so it is never used
    /// as a reranker at all. The fix for such a model is a catalogue row, measured, not a guess from its file
    /// name.</para>
    ///
    /// <para>A declared window too small to hold a pair's overhead reads as none
    /// (<see cref="RerankInputCap.UsableWindow"/>) — the same rule the fitting applies, so the two halves agree.</para></summary>
    public static int? DeclaredWindow(string? id) => RerankInputCap.UsableWindow(Find(id)?.ContextTokens);

    /// <summary>The download URL. Assembled here so the pinned commit appears in exactly one place.</summary>
    public static string UrlFor(GgufModel m) =>
        Environment.GetEnvironmentVariable("GATHERLIGHT_GGUF_BASE_URL") is { Length: > 0 } b
            ? $"{b.TrimEnd('/')}/{m.File}"
            : $"https://huggingface.co/{m.Repo}/resolve/{m.Commit}/{m.File}";

    /// <summary>The resource id 资源 provisions this model under. Prefixed so it cannot collide with a
    /// runtime's id, and stable because the model id is.</summary>
    public static string ResourceIdFor(string modelId) => $"gguf-{modelId}";

    /// <summary>Reverse of <see cref="ResourceIdFor"/>, for a caller holding a resource id.</summary>
    public static string? ModelIdFrom(string resourceId) =>
        resourceId.StartsWith("gguf-", StringComparison.Ordinal) ? resourceId["gguf-".Length..] : null;
}
