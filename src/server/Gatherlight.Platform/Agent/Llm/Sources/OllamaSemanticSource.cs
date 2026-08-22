using Gatherlight.Server.Platform.Agent.Llm.Services;
using Lyntai;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>
/// 语义 on an embedding model held by the local Ollama — the same daemon at the same URL as
/// <see cref="OllamaJudgeSource"/>, with a different model on it. One provider, two layers.
///
/// <para>A CLOUD embedder is not offered and should not be: embedding a fact means sending the household's
/// private material to whatever does the embedding, on every single write. <see cref="OllamaRuntime"/>
/// enforces that as a loopback rule rather than promising it in a doc.</para>
/// </summary>
public sealed class OllamaSemanticSource : IMemorySemanticSource
{
    public string Id => "ollama";
    public string Name => "本机 · Ollama";

    public string Description =>
        "用这台机器上的嵌入模型为事实生成向量:占用磁盘与算力,不消耗 token,资料不离开这台电脑。";

    public bool NeedsEndpoint => false;

    /// <summary>The same daemon the judge's local arm uses, through the same loopback guard — one Ollama,
    /// two layers, different models on it.</summary>
    public string? Endpoint(MemorySourceSettings s) =>
        OllamaRuntime.ResolveBaseUrl(s.Config.OllamaUrl);

    public bool IsConfigured(MemorySourceSettings s) => true;

    /// <summary>The embedder plus the vector store the GRAPH member picks up — that is where meaning-based
    /// recall actually happens, via <c>SemanticSeedK</c>. <c>AddSemanticMemory</c> is here for its
    /// registration alone: <c>ISemanticMemory</c> resolves only when an embedder did, so its presence is
    /// the app's "semantic recall is available" signal.
    /// <para>Keyless on purpose: a local Ollama takes no bearer token, and inventing one would only make a
    /// misconfigured remote endpoint look authenticated.</para></summary>
    /// <summary>Provisioned or the household's own — decided per install, because both are normal. 资源 has
    /// installed and started Ollama since 2026-08-21, and the picker calling it 本机 · Ollama without saying
    /// so is what let a provisioned runtime read as a manual prerequisite.</summary>
    public RuntimeOrigin Origin(MemorySourceContext ctx) =>
        RuntimeOriginFrom.Locate(ctx.Ollama.Locate(),
            Services.OllamaRuntime.ProvisionedExe(ctx.Settings.ResourcesPath), "Ollama");

    public void Register(LyntaiBuilder b, MemoryWiringContext ctx) =>
        b.AddOpenAiCompatibleEmbedder("ollama", o =>
         {
             o.BaseUrl = ctx.Endpoint;
             o.Model = ctx.Model;
         })
         .UseSqliteVectorStore()
         .AddSemanticMemory();

    public async Task<SourceStatus> StatusAsync(MemorySourceContext ctx, CancellationToken ct = default)
    {
        var s = await ctx.Ollama.ProbeAsync(ct: ct);
        if (!s.Installed)
            return new SourceStatus(false, "这台机器没有安装 Ollama —— 可在「资源 · Resources」面板安装。");
        if (!s.Serving)
            return new SourceStatus(false, "Ollama 已安装但没有运行 —— 在「资源 · Resources」面板点「启动」。");

        return s.Models.Any(CanEmbed)
            ? SourceStatus.Ready
            : new SourceStatus(false,
                $"这台机器上还没有嵌入模型 —— 语义检索需要一个。可以下载 {EmbeddingCatalog.Recommended}" +
                "(实测中文检索并列最好,约 622 MB)。", EmbeddingCatalog.Recommended);
    }

    /// <summary>Installed embedders FIRST — what can be used right now — then the measured shortlist as
    /// things to fetch, which 资源 owns the button for.
    /// <para>The shortlist is not the limit: an uncatalogued model already on disk still appears, and
    /// appears as usable, because a list baked into a release cannot contain a model published after it.
    /// That is exactly how this panel once shipped without the two best models that already existed.</para></summary>
    public async Task<IReadOnlyList<ModelOption>> ModelsAsync(MemorySourceContext ctx, CancellationToken ct = default)
    {
        var s = await ctx.Ollama.ProbeAsync(ct: ct);

        var installed = s.Models.Where(CanEmbed).Select(m =>
        {
            var known = EmbeddingCatalog.Find(m.Name);
            return new ModelOption(m.Name, m.Name, Installed: true, SizeBytes: m.SizeBytes,
                Note: known?.Note, Measured: known?.Measured, Vintage: known?.Vintage);
        }).ToList();

        var offerable = EmbeddingCatalog.Options
            .Where(o => !s.Has(o.Id))
            .Select(o => new ModelOption(o.Id, o.Name, Installed: false, SizeBytes: o.ApproxBytes,
                Note: o.Note, Measured: o.Measured, Vintage: o.Vintage));

        return installed.Concat(offerable).ToList();
    }

    /// <summary>Ollama's own answer, with the shortlist as the fallback for a daemon too old to give one —
    /// the mirror of <see cref="OllamaJudgeSource"/>'s filter, and <c>bool?</c> for the same reason.</summary>
    private static bool CanEmbed(OllamaModel m) => m.CanEmbed ?? EmbeddingCatalog.Find(m.Name) is not null;

    /// <summary>The CHEAP no, then the real proof. A model Ollama has already said cannot embed will not
    /// start embedding once it is in memory, and the probe below costs a cold model load — up to minutes —
    /// to reach the same answer. Nothing is refused here that the probe would have accepted; the household
    /// just stops waiting out a load for a certain no.</summary>
    public async Task<EmbedProbe?> ProveAsync(MemorySourceContext ctx, string model, CancellationToken ct = default)
    {
        var s = await ctx.Ollama.ProbeAsync(refresh: true, ct: ct);
        if (!s.Serving) return null;

        var held = s.Find(model);
        if (held is null || held.CanEmbed is false) return null;

        return await ctx.Ollama.ProbeEmbeddingAsync(model, ct);
    }
}
