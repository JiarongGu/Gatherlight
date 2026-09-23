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
/// to choose and stays stable no matter what the upstream filename is.</param>
/// <param name="Repo">HuggingFace repo.</param>
/// <param name="Commit">Pinned COMMIT, never a branch: a branch ref lets the bytes move under the checksum,
/// which then reads as a corrupt download rather than as an upstream edit.</param>
/// <param name="File">The filename inside the repo — and inside our install dir, unchanged, so the download
/// is traceable back to the thing it came from.</param>
/// <param name="Measured">What it scored on this app's own recall job, or null. Null must be SAID by the UI,
/// not left blank: an empty cell in a comparison table reads as a zero.</param>
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
    EmbeddingMeasurement? Measured = null);

/// <summary>
/// The GGUFs the app can download for its own llama.cpp runtime — the shelf, as
/// <see cref="EmbeddingCatalog"/> is the shelf for Ollama.
///
/// <para><b>Why this is a CLOSED list where the Ollama one is not.</b> `EmbeddingCatalog` is explicitly a
/// suggestion rather than a gate: anything Ollama can pull is selectable, because Ollama resolves a tag
/// against its own registry and we only advise. Here we are the downloader — url, commit and checksum — so
/// a model we have not pinned is a model we cannot fetch. The trade is deliberate: a household gains a
/// verified download and loses free choice, and the panel says so rather than presenting a short list as if
/// it were the whole world. A household who wants something else runs it themselves and points
/// <c>openai-compat</c> at it, which is exactly what that backend is for.</para>
///
/// <para><b>Every entry is sha256-pinned at a commit</b>, like git, node and the ONNX model. Unlike
/// <c>ollama pull</c>, which fetches a mutable tag, this cannot silently become different bytes.</para>
///
/// <para><b>Measurements are per model and honestly sparse.</b> Only the embedder has been scored on the
/// 10-query fixture (9/10 top-1, 25 ms/query through the app, 2026-08-22 — the same instrument as every
/// number in <see cref="EmbeddingCatalog"/>). The two rerankers have been scored AS 判断 on the 240-question
/// bilingual fixture (<c>docs/judge-bench.md</c>, Run 2, 2026-09-23) — top-1 and found@8, which is not the
/// shape of <see cref="EmbeddingMeasurement"/> (top-3 of 10 queries), so those figures live in the note and
/// <see cref="GgufModel.Measured"/> stays null rather than carrying a found@8 in a top-3 slot. The chat
/// models carry latency observations rather than recall scores, because no local chat judge has been
/// measured per model on this corpus; claiming otherwise is the failure this whole area keeps
/// correcting.</para>
/// </summary>
public static class GgufCatalog
{
    /// <summary>The embedder 语义 uses. Same weights as Ollama's recommended model, a different
    /// quantisation, and measured as an equal on retrieval at half the size.</summary>
    public const string RecommendedEmbedder = "embeddinggemma-300M-Q8_0";

    /// <summary>The chat model 判断 gets by default — the smaller of the two, because 判断 sits on the path
    /// of every recall and a judge that is slow is a judge a household turns off.</summary>
    public const string RecommendedJudge = "gemma-3-1b-it-Q4_K_M";

    /// <summary>The reranker the bilingual bench recommends (docs/judge-bench.md, Run 2) — by the tie rule
    /// declared before the run, NOT by a measured difference. Paired on the same 240 questions, LAMAR and BGE
    /// were neither significantly different nor equivalent on top-1 or on found@8, so the rule took the smaller
    /// file — and the two files differ by 1,408 bytes. Both rows' notes say the fixture could not separate them.
    /// Its display name carries no 推荐 (unlike <see cref="RecommendedJudge"/>'s), and the console's 推荐 badge
    /// does not read it: either would claim a preference the measurement cannot see. Re-run
    /// <c>dev.mjs judge-bench</c> before treating it as more.</summary>
    public const string RecommendedReranker = "bge-reranker-v2-m3-Q5_K_M";

    /// <summary>What every reranker row says, because it is the one thing that differs from a chat judge:
    /// only HALF of 判断 moves.</summary>
    private const string RerankerNote =
        "判断用的重排模型:检索时的判断在本机完成;写入事实时的主题标注由 Claude CLI 完成(每条事实一次调用,"
        + "事实内容会发给 Claude)。";

    /// <summary>What a reranker row's measured figures are read AGAINST — the same 240 questions with 判断 off
    /// and with the Claude CLI judge, the two other answers this layer offers (docs/judge-bench.md, Runs 1 and
    /// 2: same seed, same questions, equal formula digests). Shared because the comparators are the same for
    /// every reranker, and a figure with nothing beside it cannot be weighed. The trade is stated both ways:
    /// a reranker puts the answer on the page far more often and first hardly more often, because it chooses
    /// which eight make the page and the engine still orders them.</summary>
    private const string RerankerMeasuredAgainst =
        "同一测试集上,不开判断是 79/240 与 125/240(每次约 0.23 秒),Claude CLI 判断是 132/240 与 133/240"
        + "(每次约 9.5 秒):重排把答案带进前八的次数多得多,排到第一的次数却只比不开判断略多 —— "
        + "它挑哪八条上页,先后仍按原来的排序。";

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

        new GgufModel(
            RecommendedJudge, "Gemma 3 1B(Q4 · 判断 · 推荐)", GgufCapability.Completion,
            "ggml-org/gemma-3-1b-it-GGUF", "f9c28bcd85737ffc5aef028638d3341d49869c27",
            "gemma-3-1b-it-Q4_K_M.gguf",
            "8ccc5cd1f1b3602548715ae25a66ed73fd5dc68a210412eea643eb20eb75a135", 806_058_240,
            "判断用。实测每次判断约 0.15–0.20 秒(Claude CLI 那条实测每次检索 9–17 秒),而且不消耗账号额度。"
            + "小模型,判断质量没有单独实测过 —— 这一层的质量还没有在这个家庭的资料上按模型量过。"),

        new GgufModel(
            "gemma-3-4b-it-Q4_K_M", "Gemma 3 4B(Q4 · 判断 · 更大)", GgufCapability.Completion,
            "ggml-org/gemma-3-4b-it-GGUF", "d0976223747697cb51e056d85c532013931fe52e",
            "gemma-3-4b-it-Q4_K_M.gguf",
            "882e8d2db44dc554fb0ea5077cb7e4bc49e7342a1f0da57901c0802ea21a0863", 2_489_757_856,
            "同样用于判断,参数量是上一个的四倍,占用也是 —— 判断质量可能更好,但没有实测数据支持这句话;"
            + "显存不够时它会明显更慢。"),

        new GgufModel(
            "LAMAR-600m.Q5_K_M", "LAMAR 600M(Q5 · 判断 · 重排)", GgufCapability.Reranking,
            "mradermacher/LAMAR-600m-GGUF", "cd4da764d5b17d9996710dbf0ef5ad31c9aed182",
            "LAMAR-600m.Q5_K_M.gguf",
            "ec708b20336577c63702dd8efb23060bc611933579572bf9ad47ce2eaeda546f", 468_393_760,
            RerankerNote + "本应用双语测试集:首位命中 86/240,前八命中 208/240,每次检索约 0.47 秒。"
            + RerankerMeasuredAgainst + "和 BGE 的差别这个测试集分不出来。"
            + "Lyntai 在英文 LoCoMo 上实测:+9.0(完美判断是 +9.5)。"),
        new GgufModel(
            RecommendedReranker, "BGE Reranker v2 M3(Q5 · 判断 · 重排)", GgufCapability.Reranking,
            "gpustack/bge-reranker-v2-m3-GGUF", "3093af03b1a635e67b084b1d8c03c5f5e020fd05",
            "bge-reranker-v2-m3-Q5_K_M.gguf",
            "1a212007526c7083627eed92b39dd4472e90ff1374a03fb068733378220813ef", 468_392_352,
            RerankerNote + "本应用双语测试集:首位命中 90/240,前八命中 203/240,每次检索约 0.49 秒。"
            + RerankerMeasuredAgainst + "和 LAMAR 的差别这个测试集分不出来(公开的中文评测上它比同类更强;"
            + "本应用的中文题上两者只有两题结果不同,都是 LAMAR 对);两个文件大小只差 1.4 KB,"
            + "推荐它只是按「分不出时取较小的文件」。"
            + "Lyntai 在英文 LoCoMo 上量过的是它的 Q8 版本(+5.5)。"),
    };

    public static GgufModel? Find(string? id) =>
        id is null ? null : Models.FirstOrDefault(m => string.Equals(m.Id, id, StringComparison.OrdinalIgnoreCase));

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
