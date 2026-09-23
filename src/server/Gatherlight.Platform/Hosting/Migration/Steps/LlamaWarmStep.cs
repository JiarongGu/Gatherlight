using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Agent.Llm.Sources;
using Gatherlight.Server.Platform.Hosting.Migration.Services;
using Gatherlight.Server.Platform.Hosting.Resources.Services;
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

/// <summary>
/// Start and WARM llama-server, but only when a recall layer is actually bound to it.
///
/// <para><b>Why warming is a startup step and not a lazy first-use.</b> llama-server's
/// <c>--models-max</c> is a cap, not a preload: the first request for a model spawns a child and waits for
/// it, measured at 17.3 s for a 1B q4. Left lazy, that cost lands on the household's first recall after
/// every restart — which is the same shape as the per-call CLI spawn this runtime was chosen to remove,
/// just once per restart instead of every time. Paying it here, behind the migration overlay that is
/// already on screen, is the difference between a slow boot and a product that feels broken.</para>
///
/// <para><b>Only when BOUND, because the alternative is a surprise.</b> A household who downloaded the
/// runtime but left 语义 on Ollama should not have 400 MB of weights loaded into their GPU on every boot.
/// So this reads the same binding the wiring reads, and does nothing at all when neither layer names
/// llama.cpp.</para>
///
/// <para><b>Never essential, and never throws.</b> Recall loses what runs here if the runtime will not
/// start — a real loss, and still not a reason to hold the boot on a model load. The failure is logged
/// and surfaced as a migration warning; the 资源 panel and 记忆检索 both stay reachable, which is what makes
/// the remedy one click away rather than behind the thing that is broken.</para>
/// </summary>
public sealed class LlamaWarmStep : IMigrationStep
{
    private readonly ILlamaServerRuntime _llama;
    private readonly ServerConfigService _config;
    private readonly IPlatformContext _platform;
    private readonly MigrationState _state;
    private readonly IClaudeCliRuntime _claude;
    private readonly IAppConfigService _appConfig;
    private readonly ILogger<LlamaWarmStep> _log;

    public LlamaWarmStep(ILlamaServerRuntime llama, ServerConfigService config, IPlatformContext platform,
        MigrationState state, IClaudeCliRuntime claude, IAppConfigService appConfig, ILogger<LlamaWarmStep> log)
    {
        _llama = llama; _config = config; _platform = platform; _state = state; _claude = claude;
        _appConfig = appConfig; _log = log;
    }

    public string Id => "llama-warm";
    public string Title => "启动本机模型运行时(llama.cpp)";
    public bool Essential => false;

    public async Task RunAsync(CancellationToken ct)
    {
        var settings = new MemorySourceSettings(_config.Current.Memory, _platform.ResourcesPath);

        // The SAME resolution the DI wiring uses, so this step cannot warm a backend the app did not bind.
        var judge = MemorySources.ResolveJudge(settings);
        var semantic = MemorySources.ResolveSemantic(settings);

        // A binding whose MODEL is not one of the layer's files now falls back (MemorySources.ResolveJudge/
        // ResolveSemantic). Say so, in the log as well as the overlay — the overlay is gone once migration ends:
        // otherwise 判断 is quietly on the CLI and 语义 quietly off, and nothing tells the household why. Before the
        // fallback existed the warm below said it instead, with 没能载入 — for a layer still wired to the file.
        // WHY and the fix are the source's clause (WhyNotHere), the same one the bind endpoint refuses with.
        // Only the model is announced: a missing runtime, or the built-in embedder's missing files, still fall back
        // without a word here (a residual dev-conventions records).
        var llamaJudge = MemorySources.FindJudge(MemoryBackends.LlamaCpp);
        if (MemorySources.SavedIs(settings.Config, MemoryBackends.LlamaCpp) && judge.Id != MemoryBackends.LlamaCpp
            && settings.Config.JudgeModel is { Length: > 0 } goneJudge && llamaJudge is not null
            && !llamaJudge.HasModel(settings, goneJudge))
        {
            // WHAT THE FALLBACK COSTS: for a household that chose a local judge, this start is the first time their
            // facts go to Claude and the account pays. The quota clause is MemorySources.CliTaggingCost — one writer,
            // the one the reranker's cost line and bind toast carry. 判断's own switch decides whether any of it is
            // spent now, so "消耗账号额度" is never said while nothing is being called.
            var cli = "标注与核对都改由它完成:写入时" + MemorySources.CliTaggingCost + ";检索时每次也调用一次";
            var cost = MemoryEnrichment.IsOn(_appConfig)
                ? $" —— {cli}"
                : $"(「判断」现在是关着的,暂时不会调用;打开后{cli})";
            _log.LogWarning("memory judge is bound to llama.cpp model {Model}, which is not one of its models on disk; " +
                "falling back to the Claude CLI for this start", goneJudge);
            _state.AddWarning($"「判断」绑定的本机模型用不了:{llamaJudge.WhyNotHere(settings, goneJudge)}。"
                + $"这次启动「判断」退回 Claude CLI{cost}。处理好之后重启服务才会用回它;也可以在「记忆检索」另选一个。");
        }
        var llamaSemantic = MemorySources.FindSemantic(MemoryBackends.LlamaCpp);
        if (string.Equals(settings.Config.SemanticSource, MemoryBackends.LlamaCpp, StringComparison.OrdinalIgnoreCase)
            && semantic?.Id != MemoryBackends.LlamaCpp
            && settings.Config.EmbeddingModel is { Length: > 0 } goneEmbed && llamaSemantic is not null
            && !llamaSemantic.HasModel(settings, goneEmbed))
        {
            _log.LogWarning("semantic recall is bound to llama.cpp model {Model}, which is not one of its embedders " +
                "on disk; the layer is off for this start", goneEmbed);
            // The REBUILD belongs in the remedy: a fact written while the layer is off is stored without a vector,
            // and only a rebuild ever gives it one — getting the model back and restarting does not.
            _state.AddWarning($"「语义」绑定的本机模型用不了:{llamaSemantic.WhyNotHere(settings, goneEmbed)}。"
                + "这次启动语义检索不会生效,这段时间写入的事实不带向量。处理好之后重启服务,再在「记忆检索」"
                + "重新建立一次语义索引,这些事实才会补上向量;也可以在「记忆检索」另选一个。");
        }

        var judgeModel = judge.Id == MemoryBackends.LlamaCpp
            ? MemorySources.ResolveJudgeModel(settings) : null;
        var embedModel = semantic?.Id == MemoryBackends.LlamaCpp
            ? settings.Config.EmbeddingModel : null;

        if (judgeModel is null && embedModel is null)
        {
            _log.LogDebug("llama-warm: no layer is bound to llama.cpp — nothing to start.");
            return;
        }

        // WHAT IS LOST, per layer — asked of the source, because for a reranker it is only half of 判断: the
        // checking runs here, the tagging never did. "Falls back to 公式" was true of a chat judge and false
        // of a reranker, whose tagging goes on through the CLI while llama.cpp is down — IF the CLI can tag.
        // That is read from its CACHED probe (ClaudeRuntimeStep ran it earlier in this startup): signed out means
        // no tagging either, and an unknown state is left unsaid rather than guessed.
        var tagging = judgeModel is not null && judge.ChecksOnly(judgeModel)
            ? MemorySources.CliTaggingNow(_claude.Cached) : null;
        var judgeLoss = judgeModel is null ? null
            : !judge.ChecksOnly(judgeModel) ? "「判断」这次启动不会生效"
            : tagging is null ? "「判断」检索时的核对这次启动不会生效"
            : tagging.Works ? "「判断」检索时的核对这次启动不会生效(写入时的主题标注照常由 Claude CLI 完成)"
            : $"「判断」检索时的核对这次启动不会生效,写入时的主题标注也不会进行({tagging.Why})";
        var embedLoss = embedModel is null ? null : "「语义」这次启动不会生效";

        if (!await _llama.EnsureServingAsync(ct))
        {
            var problem = (await _llama.ProbeAsync(refresh: true, ct)).Problem ?? "未能启动。";
            _log.LogWarning("llama-server did not start: {Problem}", problem);
            _state.AddWarning($"本机模型运行时(llama.cpp)没能启动:{problem} "
                + string.Join(";", new[] { embedLoss, judgeLoss }.Where(x => x is not null)) + "。");
            return;
        }

        // Warm each bound model. A failure here is per-model: one layer can be usable while the other is
        // not, and reporting them together would hide which.
        foreach (var (model, layer, loss) in new[]
                 {
                     (embedModel, "语义", embedLoss),
                     (judgeModel, "判断", judgeLoss),
                 })
        {
            if (string.IsNullOrWhiteSpace(model)) continue;
            // The runtime's own sentence when it cannot serve the model at all — an ADOPTED router that never
            // listed it names the process to end. It used to reach only the log, and the warning said just
            // 没能载入, which gives the household nothing to do.
            if (await _llama.EnsureServesAsync(model!, ct) is { } unserved)
            {
                _log.LogWarning("warming {Layer} model {Model} skipped: {Why}", layer, model, unserved);
                _state.AddWarning($"「{layer}」的本机模型 {model} 没能载入:{unserved.TrimEnd('。')} —— {loss}。");
                continue;
            }
            if (await _llama.WarmAsync(model!, ResourceProvisioner.GgufKind(model!), ct)) continue;
            _log.LogWarning("warming {Layer} model {Model} failed", layer, model);
            _state.AddWarning($"「{layer}」的本机模型 {model} 没能载入 —— {loss}。");
        }
    }
}
