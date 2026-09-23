using Gatherlight.Server.Platform.Agent.Llm.Sources;
using Gatherlight.Server.Platform.Kernel.Services;
using Lyntai.Inference;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>Would restarting OUR llama-server right now lose anything? Asked by
/// <see cref="LlamaServerRuntime.EnsureServesAsync"/> before it restarts the router to load a model it does not
/// list.</summary>
public interface ILlamaRestartPolicy
{
    /// <summary>Null when a restart loses nothing; otherwise the sentence saying why not and what to do
    /// instead.</summary>
    string? WhyNotNow();
}

/// <summary>
/// Refuses a router restart while anything would WRITE through it.
///
/// <para><b>Why a restart is not harmless.</b> For the seconds the router is down every embed fails, and
/// Lyntai's graph engine catches a failed write-time embed and stores the fact anyway — without its vector
/// (<c>GraphMemoryEngine.SearchAsync</c>: "storing without signals or links"). The fact gets its graph
/// reference, so nothing ever back-fills it: it is simply never found by meaning again, and no response says
/// so. The same mechanism stripped every vector on an upgrade (see <c>FactIndexStep</c>); a restart the app
/// chooses to make must not do it on purpose.</para>
///
/// <para>So a restart is refused while 语义 embeds through llama.cpp — RUNNING (its provider is registered)
/// or merely SAVED (a restart of the app is owed anyway) — and while a reindex runs, which re-remembers every
/// fact for as long as it takes. What is left when neither holds is 判断's verification, which fails open to
/// "no opinion" for the few seconds it is down.</para>
/// </summary>
public sealed class LlamaRestartPolicy : ILlamaRestartPolicy
{
    private readonly ServerConfigService _config;
    private readonly IPlatformContext _platform;
    private readonly IReindexStatus _reindex;
    private readonly IEnumerable<IModelProvider> _providers;

    public LlamaRestartPolicy(ServerConfigService config, IPlatformContext platform, IReindexStatus reindex,
        IEnumerable<IModelProvider> providers)
    {
        _config = config;
        _platform = platform;
        _reindex = reindex;
        _providers = providers;
    }

    public string? WhyNotNow()
    {
        var embedsHere =
            _providers.Any(p => string.Equals(p.Id, LlamaCppSource.EmbedProviderId, StringComparison.OrdinalIgnoreCase))
            || MemorySources.ResolveSemantic(new MemorySourceSettings(_config.Current.Memory, _platform.ResourcesPath))
                ?.Id == MemoryBackends.LlamaCpp;
        if (embedsHere)
            return "「语义」正在用这个 llama.cpp 做嵌入:重启它的那几秒里写入的事实会永久丢掉向量,所以应用不会自动重启它"
                + " —— 请重启服务,新模型会随 llama.cpp 一起载入。";
        if (_reindex.Current.Running)
            return "现在正在重建语义索引:这时重启 llama.cpp 会让正在重建的事实丢掉向量 —— 等重建完成后再试,或重启服务。";
        return null;
    }
}
