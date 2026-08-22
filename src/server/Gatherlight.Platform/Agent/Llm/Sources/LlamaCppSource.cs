using System.Text;
using System.Text.Json;
using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Hosting.Resources.Services;
using Lyntai;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>
/// Both recall layers on llama.cpp's <c>llama-server</c> — the runtime this app PROVISIONS and runs, as of
/// 2026-08-22. Decision, alternatives and measurements: <c>docs/self-managed-llm-runtime.md</c>.
///
/// <para><b>Why this is a separate backend when it speaks the same API as <see cref="OpenAiCompatibleSource"/>.</b>
/// Identical wire protocol, opposite relationship. There the household runs a service and types its address;
/// here the app downloads the runtime, starts it, chooses the port and owns the model files. That means no
/// address to enter, a model list that comes from what WE provisioned rather than from whatever somebody
/// happened to load, and a status sentence that can offer a fix instead of describing a symptom. It is the
/// same reason Ollama has its own backend rather than being folded into the generic one.</para>
///
/// <para><b>ONE class, BOTH layers, two instances</b> — the shape <see cref="OpenAiCompatibleSource"/>
/// exists for. Here it is not merely convenient: the router genuinely serves an embedder and a chat model at
/// the same time, from one process on one port, which is the property that made llama.cpp beat Ollama for
/// this product in the first place.</para>
///
/// <para><b>It reports its own models by KIND, and refuses the wrong one.</b> llama-server's
/// <c>embeddings</c> preset restricts a child to embeddings, so a chat model offered to 语义 or an embedder
/// offered to 判断 would fail at the first real call — and both memory policies are fail-open, so that
/// surfaces as recall which quietly never improves rather than as an error. The kind comes from
/// <see cref="ResourceProvisioner.IsEmbeddingGguf"/>, the single writer of that rule.</para>
/// </summary>
public sealed class LlamaCppSource : IMemoryJudgeSource, IMemorySemanticSource
{
    private const string ProviderId = "llamacpp";
    private const string ClientId = "memory-llamacpp";

    private readonly string _layer;

    /// <summary>One instance per layer. Which one this is decides what it offers and how it registers —
    /// see <see cref="Register"/>.</summary>
    public LlamaCppSource(string layer) => _layer = layer;

    public string Id => MemoryBackends.LlamaCpp;
    public string Name => "llama.cpp(应用自带运行时)";

    public string Description =>
        "用应用自己安装并启动的 llama.cpp 跑本机模型:不用装 Ollama,也不用填地址,模型在「资源 · Resources」"
        + "面板下载。运行时约 35 MB(Ollama 是 1.5 GB),实测检索质量与 Ollama 相同、每次查询更快;"
        + "判断与语义共用同一个进程,各用自己的模型。";

    public string? ClientName => ClientId;
    public IReadOnlyList<string> CandidateProviderIds => new[] { ProviderId };

    /// <summary>No address to ask for: the app chose the port and started the process. That is the whole
    /// difference from <see cref="OpenAiCompatibleSource"/>, which is the same protocol with the opposite
    /// ownership.</summary>
    public bool NeedsEndpoint => false;

    /// <summary>Where the runtime listens — resolved from the SAME static the service uses, so the endpoint
    /// registered at DI time and the one probed later cannot diverge.</summary>
    public string? Endpoint(MemorySourceSettings s) => LlamaServerRuntime.ResolveBaseUrl();

    /// <summary>Configured = the runtime is on disk AND there is a model of the right kind for this layer.
    ///
    /// <para>Both halves matter. Binding with no runtime registers a provider against a port nothing will
    /// ever answer on; binding with no model of the right kind registers one against a router that will
    /// refuse every call. Either way the failure lands on the first fact the household writes, and
    /// fail-open policies turn it into silence.</para></summary>
    public bool IsConfigured(MemorySourceSettings s) =>
        File.Exists(ResourceProvisioner.ProvisionedLlamaServer(s.ResourcesPath))
        && ModelsOnDisk(s).Count > 0;

    /// <summary>The GGUFs on disk that suit THIS layer, by the id the router answers to (the filename
    /// without its extension — the router derives it that way, so we must not invent our own).</summary>
    private List<string> ModelsOnDisk(MemorySourceSettings s)
    {
        var dir = ResourceProvisioner.ProvisionedGgufDir(s.ResourcesPath);
        if (!Directory.Exists(dir)) return new List<string>();
        try
        {
            return Directory.EnumerateFiles(dir, "*.gguf")
                .Select(f => Path.GetFileNameWithoutExtension(f)!)
                .Where(id => ResourceProvisioner.IsEmbeddingGguf(id) == (_layer == MemoryLayers.Semantic))
                .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }
        catch (IOException) { return new List<string>(); }
    }

    /// <summary>Always <c>app</c>: this backend exists BECAUSE the app provisions it. Unlike the Ollama and
    /// CLI arms there is no per-install question to answer — a household's own llama-server is reached
    /// through <see cref="OpenAiCompatibleSource"/> instead, which is exactly why this one never searches
    /// PATH.</summary>
    public RuntimeOrigin Origin(MemorySourceContext ctx) =>
        new(MemoryRuntimeOrigins.App, "应用安装并运行 —— 不需要你自己装");

    /// <summary>Register against our own endpoint. Identical to the generic OpenAI-compatible registration,
    /// because that is genuinely what llama-server is — the difference between the two backends is ownership
    /// and what the household has to do, not protocol.</summary>
    public void Register(LyntaiBuilder b, MemoryWiringContext ctx)
    {
        if (_layer == MemoryLayers.Semantic)
        {
            b.AddOpenAiCompatibleEmbedder(ProviderId, o =>
             {
                 o.BaseUrl = ctx.Endpoint;
                 o.Model = ctx.Model;
                 // Keyless, like the generic arm: a local server takes no bearer token.
             })
             .UseSqliteVectorStore()
             .AddSemanticMemory();
            return;
        }

        b.AddOpenAiCompatibleProvider(ProviderId, o =>
         {
             o.BaseUrl = ctx.Endpoint;
             o.DefaultModel = ctx.Model;
         })
         .AddLlmClient(ClientId, c => c.UseProviders(ProviderId));
    }

    /// <summary>Three states with three different fixes, so they are three different sentences: the runtime
    /// is not downloaded, the models are not downloaded, or it is simply not started yet.
    ///
    /// <para><b>"Not started" is NOT reported as unavailable</b>, and that is deliberate: the app can start
    /// it, and the binding endpoint does. Saying "unavailable" for something one click away would be the
    /// dead-control failure this surface exists to end.</para></summary>
    public async Task<SourceStatus> StatusAsync(MemorySourceContext ctx, CancellationToken ct = default)
    {
        var s = ctx.Settings;
        if (!File.Exists(ResourceProvisioner.ProvisionedLlamaServer(s.ResourcesPath)))
            return new SourceStatus(false,
                "还没有下载运行时 —— 在「资源 · Resources」面板下载「本机模型运行时 · llama.cpp」(约 35 MB)。",
                "llama-cpp");

        if (ModelsOnDisk(s).Count == 0)
            return new SourceStatus(false,
                _layer == MemoryLayers.Semantic
                    ? "运行时已就绪,但还没有嵌入模型 —— 在「资源 · Resources」面板下载一个。"
                    : "运行时已就绪,但还没有对话模型 —— 在「资源 · Resources」面板下载一个。",
                _layer == MemoryLayers.Semantic ? "embed-gguf" : null);

        // Present and has a model: ready to BIND. Whether the process happens to be up right now is not the
        // household's problem — starting it is ours.
        var state = await ctx.Llama.ProbeAsync(ct: ct);
        return state.Serving || state.Installed
            ? SourceStatus.Ready
            : new SourceStatus(false, state.Problem ?? "llama.cpp 还没有就绪。");
    }

    /// <summary>What this layer may choose. Installed by definition — these are files we downloaded — and
    /// filtered by KIND, because offering a chat model to 语义 would produce a binding that fails on the
    /// first embed and reports nothing.</summary>
    public Task<IReadOnlyList<ModelOption>> ModelsAsync(
        MemorySourceContext ctx, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<ModelOption>>(ModelsOnDisk(ctx.Settings)
            .Select(id => new ModelOption(
                id, id, Installed: true,
                // The measurement travels with the model it was taken on, not with the backend: this is the
                // same GGUF the runtime doc scored, through the same fixture the catalog uses.
                Measured: id.Equals(ResourceProvisioner.EmbedGgufModelId, StringComparison.OrdinalIgnoreCase)
                    ? new EmbeddingMeasurement(9, 10, 25, 10, "2026-08-22")
                    : null))
            .ToList());

    /// <summary>Judge side: refuse an embedder by NAME before any call. Cheap and certain — we downloaded
    /// these files, so unlike the generic arm we know what they are without asking the server.</summary>
    public async Task<string?> RejectAsync(MemorySourceContext ctx, string model, CancellationToken ct = default)
    {
        if (ResourceProvisioner.IsEmbeddingGguf(model))
            return $"{model} 是嵌入模型,不能用来做判断 —— 判断需要一个对话模型。";

        // Then PROVE it, for the same reason every other arm does: installed is not usable, and a judge that
        // cannot answer fails open, i.e. silently.
        if (!await ctx.Llama.EnsureServingAsync(ct))
            return "llama.cpp 没能启动 —— 请看「日志」里的原因。";
        return await ctx.Llama.WarmAsync(model, isEmbedding: false, ct)
            ? null
            : $"{model} 没能在 llama.cpp 上回答 —— 换一个模型,或看「日志」。";
    }

    /// <summary>Semantic side: PROVE it embeds and report the width, exactly as the other arms do. This also
    /// front-loads the model load, so the first fact the household writes does not pay the 17 s.</summary>
    public async Task<EmbedProbe?> ProveAsync(MemorySourceContext ctx, string model, CancellationToken ct = default)
    {
        if (!await ctx.Llama.EnsureServingAsync(ct)) return null;
        var url = LlamaServerRuntime.ResolveBaseUrl();
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(3) };
            using var content = new StringContent(
                JsonSerializer.Serialize(new { model, input = "记忆检索的探测文本 · embedding probe" }),
                new UTF8Encoding(false), "application/json");
            var started = System.Diagnostics.Stopwatch.StartNew();
            using var resp = await http.PostAsync($"{url}/v1/embeddings", content, ct);
            if (!resp.IsSuccessStatusCode) return null;
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
            var dims = doc.RootElement.TryGetProperty("data", out var data) && data.GetArrayLength() > 0
                && data[0].TryGetProperty("embedding", out var vec)
                ? vec.GetArrayLength()
                : 0;
            return dims > 0 ? new EmbedProbe(dims, (int)started.ElapsedMilliseconds) : null;
        }
        catch { return null; }
    }
}
