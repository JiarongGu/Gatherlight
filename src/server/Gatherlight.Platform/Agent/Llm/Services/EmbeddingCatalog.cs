namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>What a model scored on this app's own job, so a recommendation can be interrogated instead of
/// trusted. Null on an option nobody has measured — which the UI must SAY, rather than quietly implying
/// that an unmeasured model is as good as a measured one.</summary>
/// <param name="RecallTop1">Times the right fact ranked first, out of <paramref name="Queries"/>.</param>
/// <param name="RecallTop3">Times it ranked in the top three.</param>
/// <param name="MsPerQuery">Warm per-query embed latency on the reference machine.</param>
/// <param name="Queries">Sample size. Small, and stated so, because a 10-query fixture can separate a
/// broken model from a working one but cannot rank two working ones.</param>
public sealed record EmbeddingMeasurement(int RecallTop1, int RecallTop3, int MsPerQuery, int Queries);

/// <summary>An embedding model the household may choose. <paramref name="Dimensions"/> is here because it
/// is the reason a model change is not free: stored vectors keep their old width, and Lyntai's semantic
/// recall degrades to NOTHING on a mismatch rather than throwing — so switching models must re-embed.</summary>
public sealed record EmbeddingModelOption(
    string Id,
    string Name,
    long ApproxBytes,
    int Dimensions,
    bool Multilingual,
    string Note,
    EmbeddingMeasurement? Measured = null);

/// <summary>The recommendation, and — more importantly — WHY, in a sentence the household reads.</summary>
public sealed record EmbeddingRecommendation(string Id, string Reason, string? Caution);

/// <summary>
/// A measured SHORTLIST of embedding models — explicitly not the set of models that will work.
///
/// <para><b>This list is a suggestion, never a gate.</b> The previous version was a closed list of four
/// baked into C#, which had two consequences worth not repeating: it went stale (it shipped without the two
/// strongest models available at the time), and a model released tomorrow could not be used until we cut a
/// release. Anything Ollama can pull is selectable; these are the ones somebody actually measured.</para>
///
/// <para><b>The numbers are from this app's own job</b> — find the fact whose MEANING answers a question
/// worded nothing like it — over a fictional 20-fact zh/en corpus with 10 paraphrase queries, embedded
/// through the same OpenAI-compatible endpoint and symmetric prompting the app uses (2026-08-21, RTX 4080
/// Laptop). A benchmark that embeds differently from the product measures a product we do not ship.</para>
///
/// <para><b>What the measurement overturned:</b> `nomic-embed-text` — the most-pulled embedding model on
/// Ollama, and the previous default for machines without a GPU — scored <b>4/10</b>, and every miss was a
/// Chinese query. It is English-first, and for a household whose notes are largely Chinese it is not a
/// lightweight option, it is a broken one: recall that quietly under-performs on the household's own
/// language is worse than none, because it looks like it is working.</para>
/// </summary>
public static class EmbeddingCatalog
{
    /// <summary>Best measured, and small — the default recommendation.</summary>
    public const string Recommended = "embeddinggemma:300m";
    public const string Multilingual = "bge-m3";
    public const string Balanced = "nomic-embed-text";
    public const string Tiny = "all-minilm";

    public static readonly IReadOnlyList<EmbeddingModelOption> Options = new[]
    {
        new EmbeddingModelOption(Recommended, "EmbeddingGemma 300M(推荐 · 多语言)", 622_000_000, 768, true,
            "实测中文与中英混排检索最好,体积只有 BGE-M3 的一半,速度也更快。",
            new EmbeddingMeasurement(9, 10, 269, 10)),
        new EmbeddingModelOption(Multilingual, "BGE-M3(多语言)", 1_200_000_000, 1024, true,
            "检索质量与 EmbeddingGemma 相当,向量更宽(1024);体积 1.2 GB,占用更多磁盘与显存。",
            new EmbeddingMeasurement(9, 10, 341, 10)),
        new EmbeddingModelOption("qwen3-embedding:0.6b", "Qwen3 Embedding 0.6B(多语言 · 较慢)", 640_000_000, 1024, true,
            "检索质量同样很好,但每次查询约 1.6 秒 —— 是上面两个的五倍以上,而检索在每次回忆的必经路径上。",
            new EmbeddingMeasurement(8, 10, 1574, 10)),
        new EmbeddingModelOption(Balanced, "Nomic Embed Text(英文 · 不建议中文)", 274_000_000, 768, false,
            "体积最小、速度最快,但实测中文检索 10 题只答对 4 题 —— 除非你的资料几乎全是英文,否则不要选它。",
            new EmbeddingMeasurement(4, 4, 67, 10)),
        new EmbeddingModelOption(Tiny, "All-MiniLM(极小 · 英文)", 46_000_000, 384, false,
            "几十 MB,几乎不占资源;英文可用,中文很弱。适合极老的机器先试用。"),
    };

    public static EmbeddingModelOption? Find(string? id) =>
        id is null ? null : Options.FirstOrDefault(o => OllamaState.Matches(id, o.Id) || o.Id == id);

    /// <summary>Whether <paramref name="id"/> is SHAPED like an Ollama model reference. This replaces the
    /// old "must be in the catalog" gate, which blocked every model released after we cut a version — the
    /// exact failure that left this list shipping without the two best models available at the time.
    ///
    /// <para>The gate still exists, because the id is handed to a local process that fetches from a remote
    /// registry; what changed is what it checks. A household member typing a model name is doing something
    /// they could already do with <c>ollama pull</c>, and this endpoint sits behind the access gate — so the
    /// risk is not "which model", it is smuggling something that is not a model name at all. Hence: a
    /// conservative character set, a length cap, no whitespace, no <c>..</c> traversal, and no leading
    /// <c>-</c> (which is how a name becomes a command-line flag).</para></summary>
    public static bool IsWellFormedId(string? id) =>
        !string.IsNullOrWhiteSpace(id)
        && id.Length <= 128
        && !id.StartsWith('-')
        && !id.Contains("..", StringComparison.Ordinal)
        && System.Text.RegularExpressions.Regex.IsMatch(id, @"^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._-]+)?$");

    /// <summary>Suggest a model for THIS machine. Returns a reason and a caution rather than just an id: a
    /// recommendation the household cannot interrogate is just a default wearing a hat.
    /// <para>The GPU no longer changes WHICH model — the recommended one is small and fast enough that the
    /// old "no GPU, so take the weak English model" branch was trading the household's own language away to
    /// save a download. It changes only what we warn about.</para></summary>
    public static EmbeddingRecommendation Recommend(bool gpuLikely, bool contentIsCjk = true)
    {
        if (!contentIsCjk)
            return new EmbeddingRecommendation(Recommended,
                "资料以英文为主时它同样够用,且不必为将来出现的中文内容再换一次模型(换模型必须重建索引)。",
                null);

        return new EmbeddingRecommendation(Recommended,
            "实测在中文与中英混排上检索最准(10 题命中 9 题),体积 622 MB,每次查询约 0.27 秒。",
            gpuLikely
                ? "首次需要为已有事实建立一次索引。"
                : "未检测到 GPU 运行时 —— 仍然可用(检索只是一次前向计算),但首次建立索引会慢一些。");
    }
}
