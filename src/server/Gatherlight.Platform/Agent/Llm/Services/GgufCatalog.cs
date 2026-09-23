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
/// number in <see cref="EmbeddingCatalog"/>). The chat models carry latency observations rather than
/// recall scores, because 判断's quality has never been measured per model on this corpus at all; claiming
/// otherwise is the failure this whole area keeps correcting.</para>
/// </summary>
public static class GgufCatalog
{
    /// <summary>The embedder 语义 uses. Same weights as Ollama's recommended model, a different
    /// quantisation, and measured as an equal on retrieval at half the size.</summary>
    public const string RecommendedEmbedder = "embeddinggemma-300M-Q8_0";

    /// <summary>The chat model 判断 gets by default — the smaller of the two, because 判断 sits on the path
    /// of every recall and a judge that is slow is a judge a household turns off.</summary>
    public const string RecommendedJudge = "gemma-3-1b-it-Q4_K_M";

    /// <summary>What every reranker row says, because it is the one thing that differs from a chat judge:
    /// only HALF of 判断 moves.</summary>
    private const string RerankerNote =
        "判断用的重排模型:检索时的判断在本机完成;写入事实时的主题标注仍由 Claude CLI 完成(每条事实一次调用)。";

    public static readonly IReadOnlyList<GgufModel> Models = new[]
    {
        new GgufModel(
            RecommendedEmbedder, "EmbeddingGemma 300M(Q8 · 语义)", GgufCapability.Embedding,
            "ggml-org/embeddinggemma-300M-GGUF", "0f741b5a6585bd53aeb15cd1372c56f2a0f65e12",
            "embeddinggemma-300M-Q8_0.gguf",
            "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63", 333_590_944,
            "语义检索用。和「本机」里 Ollama 推荐的是同一个模型,量化方式不同 —— 实测检索质量相同,体积只有一半。",
            new EmbeddingMeasurement(9, 10, 25, 10, "2026-08-22")),

        new GgufModel(
            RecommendedJudge, "Gemma 3 1B(Q4 · 判断 · 推荐)", GgufCapability.Completion,
            "ggml-org/gemma-3-1b-it-GGUF", "f9c28bcd85737ffc5aef028638d3341d49869c27",
            "gemma-3-1b-it-Q4_K_M.gguf",
            "8ccc5cd1f1b3602548715ae25a66ed73fd5dc68a210412eea643eb20eb75a135", 806_058_240,
            "判断用。实测每次判断约 0.15–0.20 秒(Claude CLI 那条约 9 秒),而且不消耗账号额度。"
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
            RerankerNote + "Lyntai 在英文 LoCoMo 上实测:+9.0(完美判断是 +9.5);本应用的双语数据尚未实测。"),
        new GgufModel(
            "bge-reranker-v2-m3-Q5_K_M", "BGE Reranker v2 M3(Q5 · 判断 · 重排)", GgufCapability.Reranking,
            "gpustack/bge-reranker-v2-m3-GGUF", "3093af03b1a635e67b084b1d8c03c5f5e020fd05",
            "bge-reranker-v2-m3-Q5_K_M.gguf",
            "1a212007526c7083627eed92b39dd4472e90ff1374a03fb068733378220813ef", 468_392_352,
            RerankerNote + "中文评测上比同类更强;Lyntai 量过的是它的 Q8 版本(+5.5),这个 Q5 版本与本应用的双语数据均尚未实测。"),
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
