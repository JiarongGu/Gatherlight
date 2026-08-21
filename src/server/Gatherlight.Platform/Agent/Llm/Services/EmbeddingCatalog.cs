namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>An embedding model the household may choose. <paramref name="Dimensions"/> is here because it
/// is the reason a model change is not free: stored vectors keep their old width, and Lyntai's semantic
/// recall degrades to NOTHING on a mismatch rather than throwing — so switching models must re-embed.</summary>
public sealed record EmbeddingModelOption(
    string Id,
    string Name,
    long ApproxBytes,
    int Dimensions,
    bool Multilingual,
    string Note);

/// <summary>The recommendation, and — more importantly — WHY, in a sentence the household reads.</summary>
public sealed record EmbeddingRecommendation(string Id, string Reason, string? Caution);

/// <summary>
/// What to pull, and which to suggest. The household picks; this only advises — but the advice is
/// specific rather than a fixed default, because the two things that actually decide it vary per machine:
///
/// <list type="bullet">
/// <item><b>Language.</b> This planner's material is largely Chinese. `nomic-embed-text` is
/// English-leaning, so recommending it by default would reintroduce exactly the gap the CJK trigram
/// recall work existed to close — semantic recall that quietly under-performs on the household's own
/// language is worse than none, because it looks like it is working.</item>
/// <item><b>GPU.</b> Embedding is a single forward pass, not generation, so CPU is *workable* — but a
/// 568M-parameter multilingual model on CPU makes a first backfill slow enough to notice. Recommending
/// the big model to a machine that cannot run it well is advice that wastes a 1.2 GB download.</item>
/// </list>
/// </summary>
public static class EmbeddingCatalog
{
    public const string Multilingual = "bge-m3";
    public const string Balanced = "nomic-embed-text";
    public const string Tiny = "all-minilm";

    public static readonly IReadOnlyList<EmbeddingModelOption> Options = new[]
    {
        new EmbeddingModelOption(Multilingual, "BGE-M3(多语言 · 中文最佳)", 1_200_000_000, 1024, true,
            "对中文与中英混排的检索质量最好;体积大,在没有 GPU 的机器上首次建立索引会比较慢。"),
        new EmbeddingModelOption(Balanced, "Nomic Embed Text(轻量)", 274_000_000, 768, false,
            "体积小、速度快,英文效果好;中文检索明显弱于 BGE-M3。"),
        new EmbeddingModelOption("mxbai-embed-large", "MxBai Embed Large(英文较强)", 670_000_000, 1024, false,
            "英文检索质量高于 Nomic;中文同样偏弱。"),
        new EmbeddingModelOption(Tiny, "All-MiniLM(极小)", 46_000_000, 384, false,
            "几十 MB,几乎不占资源;质量最低,适合先试用或极老的机器。"),
    };

    public static EmbeddingModelOption? Find(string? id) =>
        id is null ? null : Options.FirstOrDefault(o => OllamaState.Matches(id, o.Id) || o.Id == id);

    /// <summary>Suggest a model for THIS machine. Deliberately returns a reason and a caution rather than
    /// just an id: a recommendation the household cannot interrogate is just a default wearing a hat.</summary>
    public static EmbeddingRecommendation Recommend(bool gpuLikely, bool contentIsCjk = true) => (gpuLikely, contentIsCjk) switch
    {
        (true, true) => new EmbeddingRecommendation(Multilingual,
            "这台机器带 GPU 加速,且你的计划与家庭资料以中文为主 —— BGE-M3 的中文检索质量最好。",
            "首次下载约 1.2 GB,并需要为已有事实重新建立一次索引。"),
        (false, true) => new EmbeddingRecommendation(Balanced,
            "未检测到 GPU 运行时 —— 先用轻量的 Nomic:下载快、建索引快。",
            "Nomic 对中文的检索明显弱于 BGE-M3。若之后装了 GPU(或愿意等一次较慢的建索引),换成 BGE-M3 会明显更准。"),
        (true, false) => new EmbeddingRecommendation("mxbai-embed-large",
            "这台机器带 GPU 加速,资料以英文为主 —— MxBai 的英文检索质量最高。", null),
        (false, false) => new EmbeddingRecommendation(Balanced,
            "未检测到 GPU 运行时 —— Nomic 在英文上质量与体积最平衡。", null),
    };
}
