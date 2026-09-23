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
/// <para><b>Why a restart is not harmless.</b> For the seconds the router is down every call to it fails, and
/// what fails at WRITE time is lost for good. Lyntai's graph engine catches a failed write-time embed and stores
/// the fact anyway — without its vector (<c>GraphMemoryEngine.SearchAsync</c>: "storing without signals or
/// links"); the fact gets its graph reference, so nothing ever back-fills it. Annotation is fail-open the same
/// way: a fact written while a CHAT judge's router is down is stored without subject tags, permanently.</para>
///
/// <para>So a restart is refused while 语义 embeds through llama.cpp, while 判断 ANNOTATES through it (a chat
/// model — a reranker only verifies, and its tagging runs on the CLI), each RUNNING or merely SAVED (a restart of
/// the app is owed anyway), and while a reindex runs. What is left when none holds is a reranker judge's
/// verification, which fails open to "no opinion" for the few seconds it is down — nothing written, nothing
/// lost.</para>
///
/// <para>No e2e drives this: the restart branch needs a router the app STARTED, and every fake router is
/// adopted. Verified on the real binary — <c>docs/self-managed-llm-runtime.md</c> §2026-09-23.</para>
/// </summary>
public sealed class LlamaRestartPolicy : ILlamaRestartPolicy
{
    private readonly ServerConfigService _config;
    private readonly IPlatformContext _platform;
    private readonly IReindexStatus _reindex;
    private readonly IEnumerable<IModelProvider> _providers;
    private readonly MemoryJudgeWiring _runningJudge;

    public LlamaRestartPolicy(ServerConfigService config, IPlatformContext platform, IReindexStatus reindex,
        IEnumerable<IModelProvider> providers, MemoryJudgeWiring runningJudge)
    {
        _config = config;
        _platform = platform;
        _reindex = reindex;
        _providers = providers;
        _runningJudge = runningJudge;
    }

    public string? WhyNotNow()
    {
        var settings = new MemorySourceSettings(_config.Current.Memory, _platform.ResourcesPath);

        var embedsHere =
            _providers.Any(p => string.Equals(p.Id, LlamaCppSource.EmbedProviderId, StringComparison.OrdinalIgnoreCase))
            || MemorySources.ResolveSemantic(settings)?.Id == MemoryBackends.LlamaCpp;
        if (embedsHere)
            return "「语义」正在用这个 llama.cpp 做嵌入:重启它的那几秒里写入的事实会永久丢掉向量,所以应用不会自动重启它"
                + " —— 请重启服务,新模型会随 llama.cpp 一起载入。";

        if (AnnotatesHere(_runningJudge.Transport, _runningJudge.Model)
            || AnnotatesHere(MemorySources.ResolveJudge(settings).Id, MemorySources.ResolveJudgeModel(settings)))
            return "「判断」正在用这个 llama.cpp 的对话模型给写入的事实做主题标注:重启它的那几秒里写入的事实会永久没有标注,"
                + "所以应用不会自动重启它 —— 请重启服务,新模型会随 llama.cpp 一起载入。";

        if (_reindex.Current.Running)
            return "现在正在重建语义索引:这时重启 llama.cpp 会让正在重建的事实丢掉向量 —— 等重建完成后再试,或重启服务。";
        return null;
    }

    /// <summary>Does a judge bound to <paramref name="sourceId"/>/<paramref name="model"/> annotate through the
    /// router? Only llama.cpp, and only when the model is not checks-only (a reranker's tagging is the CLI's) —
    /// asked of the SOURCE, the same answer the toast and the cost line use.</summary>
    private static bool AnnotatesHere(string? sourceId, string? model) =>
        string.Equals(sourceId, MemoryBackends.LlamaCpp, StringComparison.OrdinalIgnoreCase)
        && model is { Length: > 0 }
        && MemorySources.FindJudge(MemoryBackends.LlamaCpp) is { } judge
        && !judge.ChecksOnly(model);
}
