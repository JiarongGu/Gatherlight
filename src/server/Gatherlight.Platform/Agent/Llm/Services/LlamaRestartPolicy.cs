using Gatherlight.Server.Platform.Agent.Llm.Sources;
using Gatherlight.Server.Platform.Kernel.Services;
using Lyntai.Inference;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>May the app restart OUR llama-server right now? Asked by
/// <see cref="LlamaServerRuntime.EnsureServesAsync"/> before it restarts the router to load a model it does not
/// list.</summary>
public interface ILlamaRestartPolicy
{
    /// <summary>Null when the app may restart the router now; otherwise the sentence saying why not and what to
    /// do instead.</summary>
    string? WhyNotNow();
}

/// <summary>
/// Refuses a router restart while anything would WRITE through it — and while a binding that would is saved and
/// waiting for the service restart that wires it.
///
/// <para><b>Why a restart is not harmless.</b> For the seconds the router is down every call to it fails, and
/// what fails at WRITE time is lost for good. Lyntai's graph engine catches a failed write-time embed and stores
/// the fact anyway — without its vector (<c>GraphMemoryEngine.SearchAsync</c>: "storing without signals or
/// links"); the fact gets its graph reference, so nothing ever back-fills it. Annotation is fail-open the same
/// way: a fact written while a CHAT judge's router is down is stored without subject tags, permanently.</para>
///
/// <para><b>Refused because a restart LOSES something</b>, each with a sentence in the present tense: while 语义
/// RUNS on llama.cpp (its provider is registered), while 判断 RUNS on a llama.cpp chat model and its switch is on
/// (a reranker only verifies, and its tagging runs on the CLI; with 判断 switched off the <c>Switchable*</c>
/// policies make no call at all). The switch is read now, so it could be turned on during the 2–3 s the router is
/// down — a gap of one click in a few seconds, not worth a lock.</para>
///
/// <para><b>A reindex needs no check of its own</b>, and had one that was false. <c>ReindexSemanticAsync</c> takes
/// one of two paths: with no embedder registered (the Claude CLI arm) it runs <c>ExpandEachAsync</c>, whose
/// rephrasing goes through the DEFAULT text client, which is the CLI alone; otherwise it runs <c>RebuildAsync</c>,
/// which re-remembers every fact — embedding through the registered embedder (llama.cpp only when its provider is
/// registered: the 语义 check) and annotating through the judge (llama.cpp only for a running chat judge with the
/// switch on: the 判断 check). So every reindex that touches llama.cpp was already refused above, and one that
/// does not — 语义 on the built-in embedder or the CLI, no chat judge — was refused with 「会让正在重建的事实丢掉
/// 向量」, which it would not.</para>
///
/// <para><b>Refused because a service restart is OWED anyway</b>, and saying only that: a binding to llama.cpp that
/// is SAVED but not what runs — a rebind waiting for its restart, or a model that was missing when the container
/// was built. Restarting the router then loses nothing, so these sentences carry no loss clause; they refuse
/// because the service restart would load the new model too, and one restart is better than two.</para>
///
/// <para>What is left when none holds is a reranker judge's verification, or a chat judge switched off —
/// verification fails open to "no opinion" for the few seconds the router is down; nothing written, nothing
/// lost.</para>
///
/// <para><b>Every refusal ends with <see cref="ReselectAfterRestart"/></b>, because its one household-facing
/// caller is the BIND, which answers 409 and saves nothing: "restart the service" alone reads as "and then it is
/// done", while after the restart the router lists the new model and the binding is still whatever was saved
/// before. That saved binding is a different model from the one refused in every case but one — re-choosing the
/// very model already saved and not yet running — where choosing again is a harmless repeat; so the sentence is
/// true in all of them. (The startup warm also asks, but its router has just been started and lists every file
/// the resolver accepted, so it cannot reach a refusal; the 资源 start button's warm only logs it.)</para>
///
/// <para>No e2e drives this: the restart branch needs a router the app STARTED, and every fake router is
/// adopted. Verified on the real binary — <c>docs/self-managed-llm-runtime.md</c> §2026-09-23.</para>
/// </summary>
public sealed class LlamaRestartPolicy : ILlamaRestartPolicy
{
    private readonly ServerConfigService _config;
    private readonly IPlatformContext _platform;
    private readonly IEnumerable<IModelProvider> _providers;
    private readonly MemoryJudgeWiring _runningJudge;
    private readonly IAppConfigService _appConfig;

    public LlamaRestartPolicy(ServerConfigService config, IPlatformContext platform,
        IEnumerable<IModelProvider> providers, MemoryJudgeWiring runningJudge, IAppConfigService appConfig)
    {
        _config = config;
        _platform = platform;
        _providers = providers;
        _runningJudge = runningJudge;
        _appConfig = appConfig;
    }

    /// <summary>What the household does after the service restart a refusal asks for — see the class comment.
    /// Shared with <see cref="LlamaServerRuntime"/>'s port-release refusal, which reaches the same bind.</summary>
    internal const string ReselectAfterRestart = "这次的选择没有保存,重启后在「记忆检索」里再选一次这个模型。";

    public string? WhyNotNow()
    {
        // --- a restart would LOSE something ------------------------------------------------------------------
        if (_providers.Any(p => string.Equals(p.Id, LlamaCppSource.EmbedProviderId, StringComparison.OrdinalIgnoreCase)))
            return "「语义」正在用这个 llama.cpp 做嵌入:重启它的那几秒里写入的事实会永久丢掉向量,所以应用不会自动重启它"
                + " —— 请重启服务,新模型会随 llama.cpp 一起载入;" + ReselectAfterRestart;

        if (MemoryEnrichment.IsOn(_appConfig) && AnnotatesHere(_runningJudge.Transport, _runningJudge.Model))
            return "「判断」正在用这个 llama.cpp 的对话模型给写入的事实做主题标注:重启它的那几秒里写入的事实会永久没有标注,"
                + "所以应用不会自动重启它 —— 请重启服务,新模型会随 llama.cpp 一起载入;" + ReselectAfterRestart;

        // --- a service restart is OWED anyway --------------------------------------------------------------
        // The running checks above failed, so a saved 语义 on llama.cpp is not what runs. Worded NEUTRALLY — "the
        // setting names this llama.cpp, and is not in effect yet" — because not-running is not always a switch: it
        // is also a model that was missing when the container was built and has come back since, where 「已改用」
        // ("has switched to") claimed a change nobody made.
        var settings = new MemorySourceSettings(_config.Current.Memory, _platform.ResourcesPath);
        if (MemorySources.ResolveSemantic(settings)?.Id == MemoryBackends.LlamaCpp)
            return "「语义」设置的是这个 llama.cpp 的嵌入模型,但还没有生效 —— 要重启服务才会生效,请现在重启,"
                + "新模型会随 llama.cpp 一起载入;" + ReselectAfterRestart;

        // Only when the saved judge is NOT the running one: the running one with its switch off loses nothing, and
        // saying it is not in effect would be false.
        var savedJudge = MemorySources.ResolveJudge(settings).Id;
        var savedModel = MemorySources.ResolveJudgeModel(settings);
        var savedIsRunning =
            string.Equals(savedJudge, _runningJudge.Transport, StringComparison.OrdinalIgnoreCase)
            && string.Equals(savedModel, _runningJudge.Model, StringComparison.OrdinalIgnoreCase);
        if (!savedIsRunning && AnnotatesHere(savedJudge, savedModel))
            return "「判断」设置的是这个 llama.cpp 的对话模型,但还没有生效 —— 要重启服务才会生效,请现在重启,"
                + "新模型会随 llama.cpp 一起载入;" + ReselectAfterRestart;

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
