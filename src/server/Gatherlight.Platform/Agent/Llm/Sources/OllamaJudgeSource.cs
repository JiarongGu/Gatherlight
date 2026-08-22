using Gatherlight.Server.Platform.Agent.Llm.Services;
using Lyntai;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>
/// 判断 on a chat model held by the local Ollama.
///
/// <para>Not the cheap-and-worse arm it sounds like: Lyntai measured a local <c>gemma3:4b</c> beating its
/// ground-truth reference on junk admitted (pollution 0.33 → 0.05), at ~1.5 s per recall and no tokens at
/// all. It also takes a network round-trip out of the latency path of every recall and keeps memory working
/// with no connection — none of which the CLI arm can offer at any model size.</para>
/// </summary>
public sealed class OllamaJudgeSource : IMemoryJudgeSource
{
    public const string ProviderId = "ollama-chat";
    public const string ClientId = "memory-judge";

    /// <summary>A small chat model to offer when Ollama is running but nothing on it can hold a conversation.
    /// Deliberately NOT in <see cref="EmbeddingCatalog"/> — that list is a measured shortlist of embedders,
    /// and a chat model has no business in it.</summary>
    public const string Suggested = "gemma3:4b";

    public string Id => "ollama";
    public string Name => "本机 · Ollama";

    public string Description =>
        "适合:你本来就装了 Ollama,不想再多一个运行时。模型由它管,应用只连上去用。" +
        "不消耗账号额度,不联网,断网也能用;代价是本机算力。" +
        "避免选「会思考」的模型 —— 判断在每次回忆的必经路径上。";

    public string? ClientName => ClientId;

    public IReadOnlyList<string> CandidateProviderIds => new[] { ProviderId };

    /// <summary>Managed by us, so the address is ours to know, not the household's to type.</summary>
    public bool NeedsEndpoint => false;

    /// <summary>One daemon on one port, resolved through the guard that refuses a non-loopback URL: an
    /// embedder or a judge reachable off this machine would send household material there on every call.</summary>
    public string? Endpoint(MemorySourceSettings s) =>
        OllamaRuntime.ResolveBaseUrl(s.Config.OllamaUrl);

    /// <summary>Always wireable: the URL falls back to the loopback default, so there is no half-configured
    /// state here. Whether anything is LISTENING is <see cref="StatusAsync"/>'s question.</summary>
    public bool IsConfigured(MemorySourceSettings s) => true;

    /// <summary>A provider plus a named client pooled over it alone. <c>claude-cli</c> stays first in the
    /// global candidate list, so this is a FALLBACK rather than a re-route — see
    /// <see cref="IMemoryJudgeSource.CandidateProviderIds"/> for the upstream narrowing bug that makes the
    /// global entry necessary at all.</summary>
    /// <summary>Provisioned or the household's own — decided per install, because both are normal. 资源 has
    /// installed and started Ollama since 2026-08-21, and the picker calling it 本机 · Ollama without saying
    /// so is what let a provisioned runtime read as a manual prerequisite.</summary>
    public RuntimeOrigin Origin(MemorySourceContext ctx) =>
        RuntimeOriginFrom.Locate(ctx.Ollama.Locate(),
            Services.OllamaRuntime.ProvisionedExe(ctx.Settings.ResourcesPath), "Ollama");

    public void Register(LyntaiBuilder b, MemoryWiringContext ctx) =>
        b.AddOllamaProvider(baseUrl: ctx.Endpoint, id: ProviderId)
         .AddLlmClient(ClientId, c => c.UseProviders(ProviderId));

    public async Task<SourceStatus> StatusAsync(MemorySourceContext ctx, CancellationToken ct = default)
    {
        var s = await ctx.Ollama.ProbeAsync(ct: ct);
        if (Candidates(s).Count > 0) return SourceStatus.Ready;

        // Three causes, three fixes, three sentences. The panel used to have exactly one — and it lived
        // inside the <select>, which only renders when there is something to select, so the single case it
        // explained was the single case it could never appear in.
        return !s.Installed
            ? new SourceStatus(false, "这台机器没有安装 Ollama —— 可在「资源 · Resources」面板安装。")
            : !s.Serving
                ? new SourceStatus(false, "Ollama 已安装但没有运行 —— 在「资源 · Resources」面板点「启动」,这里就能选了。")
                : new SourceStatus(false,
                    $"这台机器上只有嵌入模型,没有能对话的 —— 判断需要一个对话模型。可以下载 {Suggested}" +
                    "(约 3.3 GB,和嵌入模型装在同一个 Ollama 里),或自己 pull 别的再回来选。", Suggested);
    }

    public async Task<IReadOnlyList<ModelOption>> ModelsAsync(MemorySourceContext ctx, CancellationToken ct = default)
    {
        var s = await ctx.Ollama.ProbeAsync(ct: ct);
        return Candidates(s)
            .Select(m => new ModelOption(m.Name, m.Name, Installed: true, SizeBytes: m.SizeBytes))
            .ToList();
    }

    /// <summary>OLLAMA's own capability array decides; the embedding shortlist is the fallback for a daemon
    /// too old to report one.
    ///
    /// <para>Asking the catalog FIRST was the defect this replaced, and it was wrong in both directions. A
    /// household whose local models happened to all be catalogued embedders got an empty list and a dead
    /// switch with nothing on screen to explain it. And the first UNCATALOGUED embedder — there is always
    /// one — was offered as a judge and sailed through the check written to stop exactly it, into a
    /// fail-open policy whose only symptom is recall that quietly never improves.</para>
    ///
    /// <para><c>CanComplete</c> is deliberately <c>bool?</c>: an older daemon reports no capabilities at
    /// all, and reading "did not say" as "cannot" would empty this list on every one of those machines.</para></summary>
    private static List<OllamaModel> Candidates(OllamaState s) => s.Models
        .Where(m => m.CanComplete ?? !EmbeddingCatalog.Options.Any(o => OllamaState.Matches(m.Name, o.Id)))
        .ToList();

    public async Task<string?> RejectAsync(MemorySourceContext ctx, string model, CancellationToken ct = default)
    {
        var s = await ctx.Ollama.ProbeAsync(refresh: true, ct: ct);
        if (!s.Serving) return s.Problem ?? "Ollama 未运行。";

        var held = s.Find(model);
        if (held is null) return $"模型 {model} 尚未下载 —— 请先在「资源 · Resources」面板下载,再回来选。";

        // An EMBEDDING model named here would be installed, well-formed and unable to answer a judgement.
        return held.CanComplete is false || (held.CanComplete is null && EmbeddingCatalog.Find(model) is not null)
            ? $"{model} 不是对话模型,不能用来判断检索结果 —— 请选一个对话模型(例如 {Suggested})。"
            : null;
    }
}
