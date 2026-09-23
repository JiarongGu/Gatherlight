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

    /// <summary><c>recall_facts</c>' default page, read from the tool that owns it. Lyntai: endorsing more
    /// than a page REPLACES the ranking instead of refining it, and the verifier is never told the caller's
    /// limit — so it has to be a constant, and the one constant that means "a page" is the tool's.</summary>
    private const int RerankEndorseCount = Storage.Knowledge.Tools.RecallFactsTool.DefaultRecallLimit;

    /// <summary>The screen a reranker must pass before it may bind. Chinese query, Chinese documents — the
    /// household's own case.
    ///
    /// <para><b>The DISTRACTOR shares more of the query than the answer does, on purpose.</b> One answer
    /// plus unrelated noise is passed by a model that only counts overlap — a lexical scorer, or a
    /// cross-encoder a bad conversion reduced to mean-pooled cosine — which is what Lyntai's
    /// <c>devtools/scripts/rerank-screen.mjs</c> records about its own first fixture (it passed a GGUF that
    /// ranks the discriminating pair BACKWARDS). Here the distractor repeats the question's words and never
    /// answers it; the answer states the price. By distinct query characters a lexical scorer rates them
    /// 1.000 against 0.667, and by character bigrams the distractor wins too — so overlap ranks it FIRST and
    /// fails. The answer is also SECOND in input order, so a model returning input order fails as well.
    /// The pair it replaced was worse than weak: overlap ranked its ANSWER first (0.750 against 0.125), so a
    /// lexical model passed it outright; the pair first proposed instead only tied.</para>
    ///
    /// <para><b>Measured 2026-09-23</b> on both catalogued rerankers through llama-server's router, pinned
    /// GGUFs sha-verified, three runs each with identical scores: LAMAR-600m.Q5_K_M puts the answer ahead by
    /// 4.131, bge-reranker-v2-m3-Q5_K_M by 3.400; reversing those real scores — a backwards GGUF — fails.
    /// Cold ~4.8 s (the model load), warm 25–33 ms. The screen still asserts only the ORDERING: a spread is
    /// one model's scale, and a household-dropped reranker may score on another
    /// (<c>docs/self-managed-llm-runtime.md</c>).</para></summary>
    private const string ScreenQuery = "游泳馆成人票多少钱?";
    private static readonly string[] ScreenDocuments =
    [
        "游泳馆成人票到底多少钱,很多人在门口问价格,工作人员说这个问题他们也不太清楚多少钱一张最准。",
        "游泳馆成人票每张四十元,儿童半价。",
    ];
    /// <summary>Which of <see cref="ScreenDocuments"/> answers <see cref="ScreenQuery"/>.</summary>
    private const int ScreenAnswer = 1;

    private readonly string _layer;

    /// <summary>One instance per layer. Which one this is decides what it offers and how it registers —
    /// see <see cref="Register"/>.</summary>
    public LlamaCppSource(string layer) => _layer = layer;

    public string Id => MemoryBackends.LlamaCpp;
    public string Name => "llama.cpp";

    public string Description =>
        "适合:大多数情况 —— 应用自己装好、自己启动,不用填地址,模型在「资源 · Resources」面板下载。"
        + "判断与语义共用同一个进程、各用自己的模型,所以两层都开也只有一个常驻服务。"
        + "实测语义检索 10 题首位命中 9 题、每次查询 0.025 秒;判断用对话模型时每次约 0.15–0.20 秒,"
        // Per call for a chat judge (docs/self-managed-llm-runtime.md); for a reranker the ADDED cost per
        // recall under partition (docs/judge-bench.md, Run 2) — the comparable figure, not the 0.47–0.49 s
        // whole recall the model notes quote, which includes the formula's own ~0.23 s.
        + "用重排模型时每次检索多约 0.23–0.26 秒(都是模型已加载后的实测)。";

    /// <summary>A chat model does both halves on our router. A RERANKER only scores, so it verifies and the
    /// default client (the Claude CLI) annotates — on <see cref="AnnotationModel"/>, which is where the
    /// reranker→CLI-model rule is written once.
    ///
    /// <para><b>This and <see cref="Register"/> must agree on the kind, and they do by construction</b>: both
    /// branch on the same <see cref="IsReranker"/>(<c>ctx.Model</c>) over the same context. That matters
    /// because <c>ScoringVerificationPolicy</c> THROWS at construction when its <c>ProviderId</c> names no
    /// registered backend — so the verifier below is only ever built when Register added
    /// <see cref="RerankProviderId"/>, and the chat branch never references it.</para></summary>
    public JudgeWiring Wiring(MemoryWiringContext ctx) =>
        !IsReranker(ctx.Model)
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
        IsReranker(model) ? MemorySources.DefaultJudgeModel : model;

    /// <summary>Side by side with <see cref="AnnotationModel"/> on purpose: both answer "does this model only
    /// check?", and if they disagreed the toast would describe one wiring while <see cref="Wiring"/> built the
    /// other. Both ask <see cref="IsReranker"/>.</summary>
    public bool ChecksOnly(string model) => IsReranker(model);

    /// <summary>The one question every reranker branch in this class asks, answered by the single writer of a
    /// GGUF's kind.</summary>
    private static bool IsReranker(string model) =>
        ResourceProvisioner.GgufKind(model) == GgufCapability.Reranking;

    public string Cost(string? model) =>
        model is not null && IsReranker(model)
            // BOTH halves, because they cost different things — and the second sentence is the one a household
            // relies on: their facts DO leave the machine, for tagging, and on their ACCOUNT. The clause is
            // MemorySources.CliTaggingCost; it once said only the first, which left 不消耗账号额度 above as the
            // one quota statement about this binding.
            ? "检索时的判断由本机重排模型完成:不消耗账号额度,不联网。"
              // No 仍 ("still"): for a household moving from a local CHAT judge, tagging moves to Claude for
              // the FIRST time with this binding, and "still" would hide exactly that.
              + "写入事实时的主题标注由 Claude CLI 完成 —— " + MemorySources.CliTaggingCost + ";"
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

        // Branches on the SAME IsReranker(ctx.Model) as Wiring, over the same context — which is what guarantees
        // the verifier Wiring builds names a provider registered here (ScoringVerificationPolicy throws on one
        // it cannot find).
        if (IsReranker(ctx.Model))
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
                    // Either kind can judge: a chat model does both halves, a reranker the checking.
                    : "运行时已就绪,但还没有对话模型或重排模型 —— 在「资源 · Resources」面板下载一个。",
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
        if (ResourceProvisioner.GgufKind(model) == GgufCapability.Embedding)
            return $"{model} 是嵌入模型,不能用来做判断 —— 判断需要一个对话模型或重排模型。";

        // Then PROVE it: installed is not usable, and a judge that cannot answer fails open, i.e. silently.
        if (!await ctx.Llama.EnsureServingAsync(ct))
            return "llama.cpp 没能启动 —— 请看「日志」里的原因。";
        if (IsReranker(model)) return await ScreenRerankerAsync(ctx, model, ct);
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
    /// the same reason Lyntai's own rerank transport refuses a partial answer.</para>
    ///
    /// <para><b>Every failure is a sentence, and a sentence that can be acted on.</b> Nothing here is logged
    /// and llama-server's own output is discarded, so pointing at 「日志」 pointed at nothing: a refusal carries
    /// the server's own words instead. A timeout is a sentence too — <c>HttpClient.Timeout</c> arrives as a
    /// cancellation, and only the caller's TOKEN tells the two apart; filtering on the exception's type let
    /// it escape as a bare 500.</para></summary>
    private static async Task<string?> ScreenRerankerAsync(MemorySourceContext ctx, string model, CancellationToken ct)
    {
        var url = LlamaServerRuntime.ResolveBaseUrl(ctx.Settings.ResourcesPath);
        bool succeeded;
        int status;
        string body;
        try
        {
            using var http = new HttpClient { Timeout = ScreenTimeout };
            using var content = new StringContent(
                JsonSerializer.Serialize(new { model, query = ScreenQuery, documents = ScreenDocuments, top_n = ScreenDocuments.Length }),
                new UTF8Encoding(false), "application/json");
            using var resp = await http.PostAsync($"{url}/v1/rerank", content, ct);
            (succeeded, status) = (resp.IsSuccessStatusCode, (int)resp.StatusCode);
            body = await resp.Content.ReadAsStringAsync(ct);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            return ex is OperationCanceledException
                ? $"{model} 在 {ScreenTimeout.TotalMinutes:0} 分钟内没有完成重排 —— 模型可能太大,或 llama.cpp 没有响应;换一个模型再试。"
                : $"{model} 没能在 llama.cpp 上完成重排:{ex.Message}";
        }

        if (!succeeded) return $"{model} 没能在 llama.cpp 上完成重排(HTTP {status}):{Detail(body)}";
        if (ScreenScores(body) is not { } scores) return $"{model} 返回的重排结果无法使用:{Detail(body)}";

        // ORDERING, never a margin: a household-dropped reranker may score on another scale, so the answer
        // strictly first is every model's assertion while a threshold would be one model's.
        return scores.Where((_, i) => i != ScreenAnswer).All(s => s < scores[ScreenAnswer])
            ? null
            : $"{model} 没有通过重排自检:答案没有排在前面 —— 这个模型文件可能转换有问题,换一个。";
    }

    /// <summary>Generous: the screen also pays the model load (measured in docs/self-managed-llm-runtime.md).</summary>
    private static readonly TimeSpan ScreenTimeout = TimeSpan.FromMinutes(3);

    /// <summary>The screen's scores in INPUT order, or null for anything unusable — invalid JSON, a missing or
    /// mistyped field, an index outside the batch or seen twice, a non-finite score, or FEWER results than
    /// documents. Reads <c>relevance_score</c> or <c>score</c>, as Lyntai's rerank transport does, so the
    /// screen accepts exactly the replies the verifier will be able to read.</summary>
    private static double[]? ScreenScores(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind != JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("results", out var results)
                || results.ValueKind != JsonValueKind.Array) return null;

            var scores = new double[ScreenDocuments.Length];
            var seen = new bool[ScreenDocuments.Length];
            foreach (var r in results.EnumerateArray())
            {
                if (r.ValueKind != JsonValueKind.Object
                    || !r.TryGetProperty("index", out var i) || i.ValueKind != JsonValueKind.Number
                    || !i.TryGetInt32(out var index) || index < 0 || index >= scores.Length || seen[index])
                    return null;
                if ((!r.TryGetProperty("relevance_score", out var s) || s.ValueKind != JsonValueKind.Number)
                    && (!r.TryGetProperty("score", out s) || s.ValueKind != JsonValueKind.Number))
                    return null;
                var value = s.GetDouble();
                if (!double.IsFinite(value)) return null;
                scores[index] = value;
                seen[index] = true;
            }
            return Array.TrueForAll(seen, x => x) ? scores : null;
        }
        catch (JsonException) { return null; }
    }

    /// <summary>What the server SAID, for a sentence the household can act on: llama-server's
    /// <c>error.message</c> when it sent one, otherwise the head of the body.</summary>
    private static string Detail(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("error", out var e))
            {
                if (e.ValueKind == JsonValueKind.Object && e.TryGetProperty("message", out var m)
                    && m.ValueKind == JsonValueKind.String) return Head(m.GetString()!);
                if (e.ValueKind == JsonValueKind.String) return Head(e.GetString()!);
            }
        }
        catch (JsonException) { /* not JSON: the raw head below is the best there is */ }
        return string.IsNullOrWhiteSpace(body) ? "没有返回任何内容" : Head(body);

        static string Head(string s)
        {
            s = s.Trim().ReplaceLineEndings(" ");
            return s.Length <= 160 ? s : s[..160] + "…";
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
