using System.Text;
using System.Text.Json;
using Gatherlight.Server.Platform.Agent.Llm.Services;
using Lyntai;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>
/// Any local runtime that speaks the OpenAI-compatible API: <c>llama.cpp</c>'s <c>llama-server</c>,
/// LM Studio, vLLM, Jan, LocalAI, KoboldCpp — the household brings the address.
///
/// <para><b>One class for the whole family, not one per product.</b> They all serve
/// <c>/v1/models</c> · <c>/v1/chat/completions</c> · <c>/v1/embeddings</c>, so enumerating products would
/// mean a release of ours every time somebody ships a new runtime — the same staleness that left
/// <see cref="EmbeddingCatalog"/> shipping without the two best models that already existed. What the
/// household supplies is a URL, and the endpoint's own <c>/v1/models</c> is the authority on what is
/// there.</para>
///
/// <para><b>It implements BOTH layer interfaces</b>, which is the first backend to do so and the case the
/// per-layer design was built for: one endpoint can judge and embed, so one class appears in both toggles.
/// Two INSTANCES though, one per layer — the judge and the embedder may be different servers (llama-server
/// on :8080 for one, LM Studio on :1234 for the other), so each instance carries which layer it answers
/// for and reads that layer's own address.</para>
///
/// <para><b>Why Ollama keeps its own source anyway.</b> Not because it is special as a runtime — it is
/// reached through this same API — but because the app MANAGES it: <c>/api/tags</c>, <c>/api/pull</c> and
/// <c>/api/delete</c> are what make 资源's download buttons possible. A generic endpoint can only be
/// pointed at; the household brings their own models. Listing that difference honestly is better than
/// pretending one source can do both jobs.</para>
///
/// <para><b>LOOPBACK, enforced.</b> Embedding a fact hands the household's private material to whatever is
/// at that address, on every write — so a non-loopback URL is refused unless an operator sets
/// <c>GATHERLIGHT_LLM_ALLOW_REMOTE=1</c> deliberately. Same posture, same reasoning and the same env-var
/// shape as <see cref="OllamaRuntime.ResolveBaseUrl"/>; the difference is that here the URL comes from a
/// text box, which is exactly why the guard cannot be advisory.</para>
/// </summary>
public sealed class OpenAiCompatibleSource : IMemoryJudgeSource, IMemorySemanticSource
{
    public const string ProviderId = "openai-compat";
    public const string ClientId = "memory-judge-endpoint";

    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };
    private static readonly UTF8Encoding Utf8NoBom = new(false);

    private readonly string _layer;

    /// <param name="layer">Which layer this instance answers for — <see cref="MemoryLayers.Judge"/> or
    /// <see cref="MemoryLayers.Semantic"/>. It decides which configured address is read, so the two layers
    /// can point at different servers.</param>
    public OpenAiCompatibleSource(string layer) => _layer = layer;

    public string Id => MemoryBackends.OpenAiCompatible;
    public string Name => "其他本机服务";

    public string Description =>
        "适合:你已经有一个在跑的服务,或者想用应用没有收录的模型 —— LM Studio、vLLM、Jan、LocalAI、"
        + "你自己起的 llama-server 都可以。填一个地址,模型由那个服务自己提供;这里不负责下载或删除它的模型。"
        + "地址必须是本机(127.0.0.1),否则事实会被发到别处去。";

    public string? ClientName => ClientId;
    public IReadOnlyList<string> CandidateProviderIds => new[] { ProviderId };

    /// <summary>The one backend that does: we do not manage this service, so only the household knows
    /// where it is listening.</summary>
    public bool NeedsEndpoint => true;

    /// <summary>The address THIS LAYER is configured to use, already loopback-checked. Null when unset or
    /// refused. The layer discriminator is the whole reason this class is instantiated twice.</summary>
    public string? Endpoint(MemorySourceSettings s) => ResolveLocal(
        _layer == MemoryLayers.Semantic ? s.Config.SemanticEndpoint : s.Config.JudgeEndpoint);

    /// <summary>Unlike the other backends this one CAN be half-configured — its address comes from a text
    /// box and may be absent or refused — so a binding without a usable address must not be wired.</summary>
    public bool IsConfigured(MemorySourceSettings s) => Endpoint(s) is not null;

    private string? Url(MemorySourceContext ctx) => Endpoint(ctx.Settings);

    /// <summary>A base URL we are willing to send household facts to: absolute, http(s), and LOOPBACK
    /// unless an operator explicitly opted out. Null for anything else — a refusal, not a fallback, because
    /// silently substituting a different address is how an install ends up embedding somewhere nobody
    /// chose.</summary>
    public static string? ResolveLocal(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out var u)) return null;
        if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps) return null;
        if (!u.IsLoopback && Environment.GetEnvironmentVariable("GATHERLIGHT_LLM_ALLOW_REMOTE") != "1")
            return null;
        return raw.Trim().TrimEnd('/');
    }

    /// <summary>Always the household's: this backend exists precisely for a service we do not manage, which
    /// is why it is the only one that asks for an address.</summary>
    public RuntimeOrigin Origin(MemorySourceContext ctx) =>
        new(MemoryRuntimeOrigins.Household, "你自己运行的服务 —— 应用只按你填的地址连接");

    public void Register(LyntaiBuilder b, MemoryWiringContext ctx)
    {
        // One class, two layers, two registrations — the judge needs a provider plus a named client, the
        // embedder needs an embedder plus a vector store. Branching on the instance's own layer rather than
        // on anything the caller passes: the caller does not know which of the two this instance is.
        if (_layer == MemoryLayers.Semantic)
        {
            b.AddOpenAiCompatibleEmbedder(ProviderId, o =>
             {
                 o.BaseUrl = ctx.Endpoint;
                 o.Model = ctx.Model;
                 // Keyless: a local server takes no bearer token, and inventing one would only make a
                 // misconfigured remote endpoint look authenticated.
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

    public async Task<SourceStatus> StatusAsync(MemorySourceContext ctx, CancellationToken ct = default)
    {
        var raw = _layer == MemoryLayers.Semantic ? ctx.Config.SemanticEndpoint : ctx.Config.JudgeEndpoint;
        if (string.IsNullOrWhiteSpace(raw))
            return new SourceStatus(false,
                "还没有填地址 —— 例如 llama-server 的 http://127.0.0.1:8080 或 LM Studio 的 http://127.0.0.1:1234。");

        var url = ResolveLocal(raw);
        if (url is null)
            return new SourceStatus(false,
                $"这个地址不能用:{raw}。必须是 http(s) 且指向本机(127.0.0.1)—— 事实会发到那个地址上,"
                + "所以远程地址需要运维显式设置 GATHERLIGHT_LLM_ALLOW_REMOTE=1 才允许。");

        var models = await ModelIdsAsync(url, ct);
        if (models is null)
            return new SourceStatus(false, $"{url} 没有响应 —— 那个服务在运行吗?(检查的是 {url}/v1/models)");
        if (models.Count == 0)
            return new SourceStatus(false, $"{url} 有响应,但没有列出任何模型 —— 请在那个服务里先载入一个。");

        return SourceStatus.Ready;
    }

    public async Task<IReadOnlyList<ModelOption>> ModelsAsync(
        MemorySourceContext ctx, CancellationToken ct = default)
    {
        var url = Url(ctx);
        if (url is null) return Array.Empty<ModelOption>();

        // The ENDPOINT's own list is the authority. There is nothing to download here, so every model it
        // reports is installed by definition — and a model it does not report cannot be used, which is a
        // sharper answer than any list of ours could give.
        var ids = await ModelIdsAsync(url, ct) ?? new List<string>();
        return ids.Select(id => new ModelOption(id, id, Installed: true)).ToList();
    }

    /// <summary>What <c>/v1/models</c> reports, or null when nothing answered. Never throws: an endpoint
    /// that is down is a fact about the machine, not an error to surface as a stack trace.</summary>
    private static async Task<List<string>?> ModelIdsAsync(string baseUrl, CancellationToken ct)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(4));   // behind a panel poll: "down" must be a fast answer
            using var resp = await Http.GetAsync($"{baseUrl}/v1/models", cts.Token);
            if (!resp.IsSuccessStatusCode) return null;
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(cts.Token));
            if (!doc.RootElement.TryGetProperty("data", out var arr) || arr.ValueKind != JsonValueKind.Array)
                return new List<string>();
            return arr.EnumerateArray()
                .Select(m => m.TryGetProperty("id", out var id) ? id.GetString() ?? "" : "")
                .Where(s => s.Length > 0)
                .ToList();
        }
        catch { return null; }
    }

    /// <summary>Judge side: PROVE it can answer before saving.
    /// <para>Unlike Ollama, a generic endpoint reports no capabilities — <c>/v1/models</c> gives ids and
    /// nothing else — so there is no cheap NO available here. A real one-token completion is the only
    /// honest check, and it has to happen: both memory policies are fail-open, so an endpoint that cannot
    /// complete would surface as recall that quietly never improves.</para></summary>
    public async Task<string?> RejectAsync(MemorySourceContext ctx, string model, CancellationToken ct = default)
    {
        var url = Url(ctx);
        if (url is null) return "先填一个可用的本机地址,再选模型。";
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{url}/v1/chat/completions")
            {
                Content = new StringContent(JsonSerializer.Serialize(new
                {
                    model,
                    max_tokens = 1,
                    messages = new[] { new { role = "user", content = "ok" } },
                }), Utf8NoBom, "application/json"),
            };
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromMinutes(2));   // a cold model loads from disk on the first call
            using var resp = await Http.SendAsync(req, cts.Token);
            return resp.IsSuccessStatusCode
                ? null
                : $"{model} 在 {url} 上没能回答({(int)resp.StatusCode})—— 换一个模型,或确认那个服务已载入它。";
        }
        catch (Exception ex)
        {
            return $"调用 {url} 失败:{ex.Message}";
        }
    }

    /// <summary>Semantic side: PROVE it embeds, and report the width it returned — the same rule the Ollama
    /// arm follows, for the same reason. Being listed is not being able to embed, and a mismatch surfaces
    /// only as recall that finds nothing.</summary>
    public async Task<EmbedProbe?> ProveAsync(MemorySourceContext ctx, string model, CancellationToken ct = default)
    {
        var url = Url(ctx);
        if (url is null) return null;
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{url}/v1/embeddings")
            {
                Content = new StringContent(
                    JsonSerializer.Serialize(new { model, input = "记忆检索的探测文本 · embedding probe" }),
                    Utf8NoBom, "application/json"),
            };
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromMinutes(3));
            var started = System.Diagnostics.Stopwatch.StartNew();
            using var resp = await Http.SendAsync(req, cts.Token);
            if (!resp.IsSuccessStatusCode) return null;
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(cts.Token));
            if (!doc.RootElement.TryGetProperty("data", out var data) || data.GetArrayLength() == 0) return null;
            if (!data[0].TryGetProperty("embedding", out var vec) || vec.ValueKind != JsonValueKind.Array) return null;
            var dims = vec.GetArrayLength();
            return dims > 0 ? new EmbedProbe(dims, (int)started.ElapsedMilliseconds) : null;
        }
        catch { return null; }
    }
}
