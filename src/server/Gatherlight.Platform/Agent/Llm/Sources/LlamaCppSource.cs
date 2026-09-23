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
/// <see cref="ResourceProvisioner.GgufKind"/>, the single writer of that rule.</para>
/// </summary>
public sealed class LlamaCppSource : IMemoryJudgeSource, IMemorySemanticSource
{
    private const string ProviderId = "llamacpp";
    /// <summary>The embedder's OWN id. One llama-server answers both routes, but since Lyntai 3.2 each route
    /// is its own provider (its D133: a host serving two routes is two registrations under two ids), and a
    /// trace should name which of the two answered.</summary>
    private const string EmbedProviderId = "llamacpp-embed";
    private const string ClientId = "memory-llamacpp";

    /// <summary>The reranker's own provider id — a third registration against the same router (Lyntai D133:
    /// one host serving several routes is several registrations), named so a trace says which one answered.</summary>
    private const string RerankProviderId = "llamacpp-rerank";

    /// <summary><c>recall_facts</c>' default page. Lyntai: endorsing more than a page REPLACES the ranking
    /// instead of refining it, and the verifier is never told the caller's limit — so this is a constant.</summary>
    private const int RerankEndorseCount = 8;

    /// <summary>The screen a reranker must pass before it may bind: the ANSWER is second in input order, so a
    /// model that returns input order unchanged fails as surely as one that ranks backwards. Chinese query,
    /// Chinese documents — the household's own case.</summary>
    private const string ScreenQuery = "市场周末几点开门?";
    private static readonly string[] ScreenDocuments = ["图书馆周一闭馆。", "东门市场周六周日早上七点开门。"];

    private readonly string _layer;

    /// <summary>One instance per layer. Which one this is decides what it offers and how it registers —
    /// see <see cref="Register"/>.</summary>
    public LlamaCppSource(string layer) => _layer = layer;

    public string Id => MemoryBackends.LlamaCpp;
    public string Name => "llama.cpp";

    public string Description =>
        "适合:大多数情况 —— 应用自己装好、自己启动,不用填地址,模型在「资源 · Resources」面板下载。"
        + "判断与语义共用同一个进程、各用自己的模型,所以两层都开也只有一个常驻服务。"
        + "实测语义检索 10 题首位命中 9 题、每次查询 0.025 秒;判断每次约 0.15–0.20 秒。";

    /// <summary>A chat model does both halves on our router. A RERANKER only scores, so it verifies and the
    /// default client (the Claude CLI) annotates — on <see cref="AnnotationModel"/>, which is where the
    /// reranker→CLI-model rule is written once.
    ///
    /// <para><b>This and <see cref="Register"/> must agree on the kind, and they do by construction</b>: both
    /// branch on the same <c>ResourceProvisioner.GgufKind(ctx.Model)</c> over the same context. That matters
    /// because <c>ScoringVerificationPolicy</c> THROWS at construction when its <c>ProviderId</c> names no
    /// registered backend — so the verifier below is only ever built when Register added
    /// <see cref="RerankProviderId"/>, and the chat branch never references it.</para></summary>
    public JudgeWiring Wiring(MemoryWiringContext ctx) =>
        ResourceProvisioner.GgufKind(ctx.Model) != GgufCapability.Reranking
            ? JudgeWiring.Llm(ClientId, AnnotationModel(ctx.Model))
            // Verification by the reranker; annotation by the default client on the CLI's default model.
            : new JudgeWiring(null, AnnotationModel(ctx.Model), sp =>
                new Lyntai.Memory.Verification.ScoringVerificationPolicy(
                    sp.GetServices<Lyntai.Inference.IModelProvider>(),
                    new Lyntai.Memory.Verification.ScoringVerificationOptions
                        { ProviderId = RerankProviderId, EndorseCount = RerankEndorseCount },
                    sp.GetService<ILogger<Lyntai.Memory.Verification.ScoringVerificationPolicy>>(),
                    sp.GetService<Lyntai.Inference.IProviderRouterFactory>()));

    /// <summary>A reranker's id must never reach the CLI, which would be asked for a model it has never heard
    /// of — so a reranker binding annotates on the CLI's default judge model.</summary>
    public string AnnotationModel(string model) =>
        ResourceProvisioner.GgufKind(model) == GgufCapability.Reranking ? MemorySources.DefaultJudgeModel : model;

    public string Cost(string? model) =>
        model is not null && ResourceProvisioner.GgufKind(model) == GgufCapability.Reranking
            // BOTH halves, because they cost different things — and the second sentence is the one a household
            // relies on: their facts DO leave the machine, for tagging.
            ? "检索时的判断由本机重排模型完成:不消耗账号额度,不联网。"
              + "写入事实时的主题标注仍由 Claude CLI 完成 —— 每条事实一次调用,事实内容会发给 Claude;"
              + "没有已登录的 CLI 时只是不标注,检索时的判断照常。"
            : "每次记录事实与每次检索各调用一次本机模型:不消耗账号额度,不联网,断网也能用。"
              + "没有 CLI 那条的进程启动开销(那条实测每次检索 9–17 秒)。";

    /// <summary>No address to ask for: the app chose the port and started the process. That is the whole
    /// difference from <see cref="OpenAiCompatibleSource"/>, which is the same protocol with the opposite
    /// ownership.</summary>
    public bool NeedsEndpoint => false;

    /// <summary>Where the runtime listens — resolved from the SAME static the service uses, so the endpoint
    /// registered at DI time and the one probed later cannot diverge.</summary>
    public string? Endpoint(MemorySourceSettings s) => LlamaServerRuntime.ResolveBaseUrl(s.ResourcesPath);

    /// <summary>Configured = the runtime is on disk AND there is a model of the right kind for this layer.
    ///
    /// <para>Both halves matter. Binding with no runtime registers a provider against a port nothing will
    /// ever answer on; binding with no model of the right kind registers one against a router that will
    /// refuse every call. Either way the failure lands on the first fact the household writes, and
    /// fail-open policies turn it into silence.</para></summary>
    public bool IsConfigured(MemorySourceSettings s) =>
        File.Exists(ResourceProvisioner.ProvisionedLlamaServer(s.ResourcesPath))
        && ModelsOnDisk(s).Count > 0;

    /// <summary>The GGUFs on disk that suit THIS layer. Ids come from
    /// <see cref="ResourceProvisioner.InstalledGgufIds"/> — the router's own rule, one writer — and the kind
    /// filter is what stops a chat model being offered to 语义 (see the class comment).</summary>
    private List<string> ModelsOnDisk(MemorySourceSettings s) =>
        ResourceProvisioner.InstalledGgufIds(s.ResourcesPath)
            .Where(id => ServesLayer(ResourceProvisioner.GgufKind(id)))
            .ToList();

    /// <summary>Which kinds this layer can use: 语义 embeds; 判断 either converses (a chat judge) or scores
    /// pairs (a reranker verifies, the CLI tags).</summary>
    private bool ServesLayer(GgufCapability kind) => _layer == MemoryLayers.Semantic
        ? kind == GgufCapability.Embedding
        : kind is GgufCapability.Completion or GgufCapability.Reranking;

    /// <summary>Always <c>app</c>: this backend exists BECAUSE the app provisions it. Unlike the Ollama and
    /// CLI arms there is no per-install question to answer — a household's own llama-server is reached
    /// through <see cref="OpenAiCompatibleSource"/> instead, which is exactly why this one never searches
    /// PATH.</summary>
    /// <summary>Managed — we install, start and own it.</summary>
    public string Group => MemoryGroups.Managed;

    public RuntimeOrigin Origin(MemorySourceContext ctx) =>
        new(MemoryRuntimeOrigins.App, "应用安装并运行 —— 不需要你自己装");

    /// <summary>Register wires a provider or an embedder plus a vector store, and the container is built
    /// once — so a change here is owed a restart.</summary>
    public bool TakesEffectOnRestart => true;

    /// <summary>Register against our own endpoint. Identical to the generic OpenAI-compatible registration,
    /// because that is genuinely what llama-server is — the difference between the two backends is ownership
    /// and what the household has to do, not protocol.</summary>

    public void Register(LyntaiBuilder b, MemoryWiringContext ctx)
    {
        if (_layer == MemoryLayers.Semantic)
        {
            // Keyless: a local server takes no bearer token. The generic door, because no llama preset takes
            // `Produces`. It re-guesses the wire from the URL and would compose Ollama's native one for port
            // 11434 — which our own port range (PortFor) never lands on.
            b.AddHttpProvider(EmbedProviderId, o =>
             {
                 o.BaseUrl = ctx.Endpoint;
                 o.Model = ctx.Model;
                 o.Produces = Lyntai.Inference.ProviderKinds.Vector;
             })
             .AddVectorRecall();
            return;
        }

        // Branches on the SAME GgufKind(ctx.Model) as Wiring, over the same context — which is what guarantees
        // the verifier Wiring builds names a provider registered here (ScoringVerificationPolicy throws on one
        // it cannot find).
        if (ResourceProvisioner.GgufKind(ctx.Model) == GgufCapability.Reranking)
        {
            // A reranker only SCORES. Annotation stays on the default client (the Claude CLI) — see Wiring.
            // The generic door, because no llama preset takes `Produces`; a Score registration is never
            // re-routed to Ollama's native wire whatever the port. It composes `{Endpoint}/v1/rerank`.
            b.AddHttpProvider(RerankProviderId, o =>
            {
                o.BaseUrl = ctx.Endpoint;
                o.Model = ctx.Model;
                o.Produces = Lyntai.Inference.ProviderKinds.Score;
            });
            return;
        }

        // The llama-server PRESET rather than the generic door: the wire is decided by what we know this is,
        // never re-guessed from the URL. On our router server the model name is a SELECTOR, not a label.
        // A named client narrows BOTH the provider pool and the candidate list since Lyntai 3.1 (its D87),
        // so the global candidate list no longer has to be widened to include this provider.
        b.AddLlamaProvider(ctx.Endpoint, ctx.Model, ProviderId)
         .AddTextClient(ClientId, c => c.UseProviders(ProviderId));
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
            // NAME the resource to download, both layers. `Suggest` is what lets the panel point at a row
            // instead of at itself, and it has to be the resource id the provisioner actually knows — a
            // stale literal here would render a button that fetches nothing.
            return new SourceStatus(false,
                _layer == MemoryLayers.Semantic
                    ? "运行时已就绪,但还没有嵌入模型 —— 在「资源 · Resources」面板下载一个。"
                    : "运行时已就绪,但还没有对话模型 —— 在「资源 · Resources」面板下载一个。",
                GgufCatalog.ResourceIdFor(_layer == MemoryLayers.Semantic
                    ? GgufCatalog.RecommendedEmbedder
                    : GgufCatalog.RecommendedJudge));

        // Present and has a model: ready to BIND. Whether the process happens to be up right now is not the
        // household's problem — starting it is ours.
        // LiveAsync, not ProbeAsync: this needs installed/serving, and the full probe additionally runs
        // llama-server twice for a build tag and a device list that this sentence never mentions.
        var state = await ctx.Llama.LiveAsync(ct);
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
                // The measurement travels with the MODEL, from the catalogue that pinned it — not compared
                // against one hardcoded id here, which would silently stop reporting the moment a second
                // measured model was added.
                Measured: GgufCatalog.Find(id)?.Measured,
                // The catalogue's own row text for a model we pinned; nothing for one the household dropped
                // in, rather than a sentence invented about a file nobody measured.
                Note: GgufCatalog.Find(id)?.Note))
            .ToList());

    /// <summary>Judge side: refuse an embedder by NAME before any call. Cheap and certain — we downloaded
    /// these files, so unlike the generic arm we know what they are without asking the server. Then prove the
    /// model does its job: a chat model must answer, a reranker must pass <see cref="ScreenRerankerAsync"/>.</summary>
    public async Task<string?> RejectAsync(MemorySourceContext ctx, string model, CancellationToken ct = default)
    {
        var kind = ResourceProvisioner.GgufKind(model);
        if (kind == GgufCapability.Embedding)
            return $"{model} 是嵌入模型,不能用来做判断 —— 判断需要一个对话模型或重排模型。";

        // Then PROVE it: installed is not usable, and a judge that cannot answer fails open, i.e. silently.
        if (!await ctx.Llama.EnsureServingAsync(ct))
            return "llama.cpp 没能启动 —— 请看「日志」里的原因。";
        if (kind == GgufCapability.Reranking) return await ScreenRerankerAsync(ctx, model, ct);
        return await ctx.Llama.WarmAsync(model, GgufCapability.Completion, ct)
            ? null
            : $"{model} 没能在 llama.cpp 上回答 —— 换一个模型,或看「日志」。";
    }

    /// <summary>A reranker must put the ANSWER first before it may bind. "It returned scores" is not enough:
    /// Lyntai found a converted model that ranked backwards while passing a looser check, and a fail-open
    /// verifier would turn that into recall that quietly gets worse.
    ///
    /// <para>Every document must be scored exactly once. llama.cpp's <c>relevance_score</c> is a raw logit and
    /// can be NEGATIVE, so an unfilled slot's default zero could outrank a real score and pass the screen —
    /// the same reason Lyntai's own rerank transport refuses a partial answer.</para></summary>
    private static async Task<string?> ScreenRerankerAsync(MemorySourceContext ctx, string model, CancellationToken ct)
    {
        var url = LlamaServerRuntime.ResolveBaseUrl(ctx.Settings.ResourcesPath);
        try
        {
            // Generous: this call also pays the model load (measured in docs/self-managed-llm-runtime.md).
            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(3) };
            using var content = new StringContent(
                JsonSerializer.Serialize(new { model, query = ScreenQuery, documents = ScreenDocuments, top_n = ScreenDocuments.Length }),
                new UTF8Encoding(false), "application/json");
            using var resp = await http.PostAsync($"{url}/v1/rerank", content, ct);
            if (!resp.IsSuccessStatusCode) return $"{model} 没能在 llama.cpp 上完成重排(HTTP {(int)resp.StatusCode})—— 看「日志」。";
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
            var scores = new double[ScreenDocuments.Length];
            var seen = new bool[ScreenDocuments.Length];
            foreach (var r in doc.RootElement.GetProperty("results").EnumerateArray())
            {
                var i = r.GetProperty("index").GetInt32();
                var s = r.GetProperty("relevance_score").GetDouble();
                if (i < 0 || i >= scores.Length || seen[i] || double.IsNaN(s) || double.IsInfinity(s))
                    return $"{model} 返回的重排结果无法使用。";
                scores[i] = s;
                seen[i] = true;
            }
            return Array.TrueForAll(seen, x => x) && scores[1] > scores[0]
                ? null
                : $"{model} 没有通过重排自检:答案没有排在前面 —— 这个模型文件可能转换有问题,换一个。";
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return $"{model} 没能在 llama.cpp 上完成重排 —— {ex.Message}";
        }
    }

    /// <summary>Semantic side: PROVE it embeds and report the width, exactly as the other arms do. This also
    /// front-loads the model load, so the first fact the household writes does not pay the 17 s.</summary>
    public async Task<EmbedProbe?> ProveAsync(MemorySourceContext ctx, string model, CancellationToken ct = default)
    {
        if (!await ctx.Llama.EnsureServingAsync(ct)) return null;
        var url = LlamaServerRuntime.ResolveBaseUrl(ctx.Settings.ResourcesPath);
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
