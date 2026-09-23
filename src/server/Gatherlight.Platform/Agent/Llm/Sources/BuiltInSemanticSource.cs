using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Hosting.Resources.Services;
using Lyntai;
using Microsoft.Extensions.DependencyInjection;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>
/// 语义 on a model that ships with the app — EmbeddingGemma 300M as ONNX, run in-process. Nothing to
/// install, no daemon, no port, no address to type.
///
/// <para><b>It removes 语义's need for a separate PROCESS — not, as originally written here, its need for a
/// manual install.</b> The claim used to be that 语义 was "the only recall layer a household could not
/// switch on without first installing a separate program", and that was false when written: 资源 had been
/// downloading and starting Ollama since 2026-08-21. The panel called that arm 本机 · Ollama — "your
/// Ollama" — and surfaced the app-managed half only in a failure message, which is how both a household
/// and this project could read a provisioned runtime as a manual prerequisite. What this backend actually
/// removes is the daemon: no second process, no port, nothing to start or keep alive.</para>
///
/// <para><b>And it is measured as DOMINATED on quality, which the panel must not hide.</b> `llama-server`
/// scores 9/10 top-1 against this arm's 8/10 on the same fixture, at 23 ms/query against 28, while also
/// serving 判断 — see <c>docs/self-managed-llm-runtime.md</c>. What is left uniquely here is the absence of
/// a process and the smallest total payload. That is a real advantage and a narrower one than the sentence
/// this replaced.</para>
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

    /// <summary>What this model IS, independent of whether it is on disk yet.
    ///
    /// <para>Hoisted out of <see cref="ModelsAsync"/> because 资源 must describe it BEFORE it is
    /// installed — a download row and an installed row are the same model in two states, so they have to
    /// read from the same facts. <c>ModelsAsync</c> returns exactly this when configured; the console reads
    /// it directly. Two copies of the size and the measurement is how a table ends up disagreeing with the
    /// row above it.</para></summary>
    public static readonly ModelOption Catalog = new(
        ModelId, "EmbeddingGemma 300M(内置)", Installed: true,
        SizeBytes: 222_000_000,
        // Compared with the SIBLING in the same 本机模型 group — llama.cpp's GGUF of the same model, whose row
        // carries 9/10 top-1 at 25 ms (GgufCatalog). It used to compare with an Ollama option that no longer
        // exists, and its "每次查询更快" was only ever true against Ollama's 69 ms. The trade-off is stated,
        // not steered: what it saves, and what it costs.
        Note: "EmbeddingGemma 在应用进程里直接运行:不用另外下载或启动运行时,没有常驻服务,总共约 222 MB。"
            + "与同组 llama.cpp 上的同一个模型相比,首位命中略低(10 题中 8 对 9),前三名同为 10 题,"
            + "每次查询相近(28 对 25 毫秒)。",
        Measured: new EmbeddingMeasurement(8, 10, 28, 10, "2026-08-22"));

    public string Id => MemoryBackends.BuiltIn;
    public string Name => "ONNX";

    public string Description =>
        "适合:想占地方最少、且完全不想多一个进程 —— 它在应用内直接运行,没有常驻服务,也没有端口。"
        + "总共约 222 MB(llama.cpp 那条是运行时 35 MB + 模型 334 MB),代价是 10 题里首位命中少一次"
        + "(8 题对 9 题,前三名命中同为 10 题)。";

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

    /// <summary>Register the embedder itself — no client, no URL. It is a Lyntai PROVIDER that produces
    /// vectors: the app owns the embedding backend, Lyntai owns the routing and the recall machinery.
    /// <para>Resolved from DI rather than constructed here so its <c>ILogger</c> is real and the session is
    /// disposed with the container — the model is 197 MB of mapped weights, which is not something to leak
    /// across a restart-in-place.</para></summary>
    /// <summary>Bundled: the ONNX session runs inside this process. The one backend with no second
    /// process anywhere — which, now that llama-server beats it on quality, is most of what it still
    /// uniquely offers.</summary>
    /// <summary>SelfContained — it runs inside our own process.</summary>
    public string Group => MemoryGroups.Managed;

    public RuntimeOrigin Origin(MemorySourceContext ctx) =>
        new(MemoryRuntimeOrigins.Bundled, "在应用内直接运行 —— 没有第二个进程,也没有端口");

    /// <summary>Register wires an embedder and a vector store, and the container is built once.</summary>
    public bool TakesEffectOnRestart => true;

    public void Register(LyntaiBuilder b, MemoryWiringContext ctx)
    {
        var dir = ModelDir(ctx.Settings);
        // A PROVIDER since Lyntai 3.2, which routes every embed over whichever registered backend produces
        // vectors. `declares` is what AddSemanticMemory reads at composition — a factory is opaque until it
        // runs, and an undeclared vector backend is a startup failure rather than a quiet absence.
        b.AddProvider(sp => new OnnxEmbedder(dir, sp.GetService<ILogger<OnnxEmbedder>>()), OnnxEmbedder.Declared)
         .AddVectorRecall();
    }

    public Task<SourceStatus> StatusAsync(MemorySourceContext ctx, CancellationToken ct = default) =>
        Task.FromResult(IsConfigured(ctx.Settings)
            ? SourceStatus.Ready
            // The fix is a download, and it names the resource so the panel can point at the row rather
            // than at the panel.
            : new SourceStatus(false,
                // What the download buys, said against nothing that no longer exists: it used to end with
                // "after which this layer no longer needs Ollama", a backend retired since 2026-08-22.
                "内置嵌入模型还没有下载 —— 在「资源 · Resources」面板下载「内置嵌入模型」(约 222 MB);"
                + "它在应用内运行,不需要另外下载或启动运行时。", ResourceId));

    public Task<IReadOnlyList<ModelOption>> ModelsAsync(
        MemorySourceContext ctx, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<ModelOption>>(IsConfigured(ctx.Settings)
            ? new[] { Catalog }
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

    /// <summary>The files were on disk (IsConfigured saw them), so no vector back means they did not LOAD —
    /// the fix is the download, not another model: this backend offers only the one.</summary>
    public string ProveFailed(string model) =>
        $"{model} 没有返回向量 —— 内置嵌入模型没能加载,文件可能不完整。"
        + "请在「资源 · Resources」面板把「内置嵌入模型」删除后重新下载。";
}
