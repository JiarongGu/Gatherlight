using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Hosting.Resources.Services;
using Lyntai;
using Microsoft.Extensions.DependencyInjection;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>
/// 语义 on a model that ships with the app — EmbeddingGemma 300M as ONNX, run in-process. Nothing to
/// install, no daemon, no port, no address to type.
///
/// <para><b>This is the backend that removes 语义's setup prerequisite.</b> Until it existed, 语义 was the
/// only recall layer a household could not switch on without first installing a separate program and
/// pulling a model into it — the CLI arm needs a login, but the app at least offers to fetch the CLI.</para>
///
/// <para><b>And it is the SMALLER path, which is the opposite of how "bundle a model runtime" sounds.</b>
/// 222 MB of model against Ollama's 622 MB model plus its own runtime download. The variant, tokenizer and
/// prompting were all chosen by measurement rather than preference — see <c>docs/builtin-model-runner.md</c>
/// and <see cref="OnnxEmbedder"/>.</para>
///
/// <para><b>It is very slightly WORSE at retrieval than the Ollama arm, and faster.</b> On the same 10-query
/// fixture the catalog uses (<c>dev.mjs embed-bench</c>, 2026-08-22): <b>8/10</b> top-1 and 10/10 top-3
/// against Ollama <c>embeddinggemma:300m</c>'s 9/10 and 10/10, at <b>28 ms</b> per query against 69 ms.</para>
///
/// <para>The earlier claim here was "ties on retrieval, ~21× faster", from the 8-query probe written while
/// choosing the runtime — and it was wrong twice. The tie was a 8/8-vs-8/8 result that a wider fixture
/// separates; the 21× compared a warm ONNX session against a COLD Ollama, and warm-against-warm the gap is
/// 2.5×. Same weights, different quantisation, so a small retrieval difference is the expected shape of
/// this trade — but "same score" was an overstatement, and the point of measuring is not to confirm the
/// thing you shipped.</para>
///
/// <para><b>A CURATED model, not a free-form field.</b> ONNX needs a per-model export plus its tokenizer,
/// so this backend offers the one model we export and pin — unlike the Ollama arm, where anything the
/// daemon can pull is fair game. That is the honest trade for a no-setup option, and the picker says so
/// rather than looking broken for having one entry.</para>
/// </summary>
public sealed class BuiltInSemanticSource : IMemorySemanticSource
{
    /// <summary>The resource id this backend's model arrives as — the same string 资源 provisions under, so
    /// "download it" has one answer.</summary>
    public const string ResourceId = "embed-model";

    /// <summary>What the picker offers, and the only thing it offers. The id is the RESOURCE, not an Ollama
    /// tag: nothing pulls this by name, so a model id here would imply a freedom that does not exist.
    /// <para>Public because the benchmark door (<c>POST /api/manage/models/embed</c>) reports which model it
    /// scored, and a literal there could drift from the one the picker names.</para></summary>
    public const string ModelId = "embeddinggemma-300m-onnx";

    public string Id => MemoryBackends.BuiltIn;
    public string Name => "内置(随应用附带)";

    public string Description =>
        "用应用自带的嵌入模型,在应用内直接运行:不用装 Ollama,没有常驻服务,也不用填地址。"
        + "实测检索质量与本机 Ollama 接近(前三名命中相同,首位命中少一次),每次查询更快;"
        + "模型约 222 MB,在「资源 · Resources」面板下载一次。";

    /// <summary>Where the provisioned model lives. Derived from the settings rather than injected, because
    /// this class is a stateless entry in a STATIC catalog — see <see cref="MemorySources"/> for why that
    /// catalog cannot hold DI-resolved dependencies.</summary>
    private static string ModelDir(MemorySourceSettings s) =>
        ResourceProvisioner.ProvisionedEmbedModel(s.ResourcesPath);

    /// <summary>No address: it runs inside this process.</summary>
    public bool NeedsEndpoint => false;
    public string? Endpoint(MemorySourceSettings s) => null;

    /// <summary>Configured = the model is actually on disk. Unlike the Ollama arm — where "not running" is
    /// recoverable at any moment — a missing model means there is nothing to embed WITH, so binding it
    /// would register an embedder that throws on the first fact written.</summary>
    public bool IsConfigured(MemorySourceSettings s) =>
        OnnxEmbedder.IsPresent(ModelDir(s));

    /// <summary>Register the embedder itself — no provider, no client, no URL. `AddEmbeddings` is Lyntai's
    /// own seam for exactly this: the app owns the embedding backend, Lyntai owns the recall machinery.
    /// <para>Resolved from DI rather than constructed here so its <c>ILogger</c> is real and the session is
    /// disposed with the container — the model is 197 MB of mapped weights, which is not something to leak
    /// across a restart-in-place.</para></summary>
    public void Register(LyntaiBuilder b, MemoryWiringContext ctx)
    {
        var dir = ModelDir(ctx.Settings);
        b.Services.AddSingleton<Lyntai.Embeddings.IEmbedder>(sp =>
            new OnnxEmbedder(dir, sp.GetService<ILogger<OnnxEmbedder>>()));
        b.UseSqliteVectorStore()
         .AddSemanticMemory();
    }

    public Task<SourceStatus> StatusAsync(MemorySourceContext ctx, CancellationToken ct = default) =>
        Task.FromResult(IsConfigured(ctx.Settings)
            ? SourceStatus.Ready
            // The fix is a download, and it names the resource so the panel can point at the row rather
            // than at the panel.
            : new SourceStatus(false,
                "内置嵌入模型还没有下载 —— 在「资源 · Resources」面板下载「内置嵌入模型」(约 222 MB),"
                + "之后这一层就不再需要 Ollama。", ResourceId));

    public Task<IReadOnlyList<ModelOption>> ModelsAsync(
        MemorySourceContext ctx, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<ModelOption>>(IsConfigured(ctx.Settings)
            ? new[]
            {
                new ModelOption(ModelId, "EmbeddingGemma 300M(内置)", Installed: true,
                    SizeBytes: 222_000_000,
                    Note: "与「本机 · Ollama」里推荐的是同一个模型,但量化方式不同 —— "
                        + "实测前三名命中相同(10/10),首位命中 8/10 对 9/10,而每次查询更快;在应用内直接运行。",
                    Measured: new EmbeddingMeasurement(8, 10, 28, 10, "2026-08-22")),
            }
            : Array.Empty<ModelOption>());

    /// <summary>PROVE it embeds, exactly as the other arms do. Here it also front-loads the 197 MB model
    /// load, so the first fact the household writes does not pay for it — and a corrupt or half-installed
    /// model is refused at BIND time rather than surfacing as recall that silently finds nothing.</summary>
    public async Task<EmbedProbe?> ProveAsync(
        MemorySourceContext ctx, string model, CancellationToken ct = default)
    {
        var dir = ModelDir(ctx.Settings);
        if (!OnnxEmbedder.IsPresent(dir)) return null;
        try
        {
            using var embedder = new OnnxEmbedder(dir);
            var started = System.Diagnostics.Stopwatch.StartNew();
            var v = await embedder.EmbedAsync(["记忆检索的探测文本 · embedding probe"], ct);
            return v.Count > 0 && v[0].Length > 0
                ? new EmbedProbe(v[0].Length, (int)started.ElapsedMilliseconds)
                : null;
        }
        catch { return null; }
    }
}
