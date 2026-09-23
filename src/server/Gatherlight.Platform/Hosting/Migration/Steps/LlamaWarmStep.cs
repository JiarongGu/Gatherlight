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
    private readonly ILogger<LlamaWarmStep> _log;

    public LlamaWarmStep(ILlamaServerRuntime llama, ServerConfigService config, IPlatformContext platform,
        MigrationState state, IClaudeCliRuntime claude, ILogger<LlamaWarmStep> log)
    { _llama = llama; _config = config; _platform = platform; _state = state; _claude = claude; _log = log; }

    public string Id => "llama-warm";
    public string Title => "启动本机模型运行时(llama.cpp)";
    public bool Essential => false;

    public async Task RunAsync(CancellationToken ct)
    {
        var settings = new MemorySourceSettings(_config.Current.Memory, _platform.ResourcesPath);

        // The SAME resolution the DI wiring uses, so this step cannot warm a backend the app did not bind.
        var judge = MemorySources.ResolveJudge(settings);
        var semantic = MemorySources.ResolveSemantic(settings);

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
            if (await _llama.WarmAsync(model!, ResourceProvisioner.GgufKind(model!), ct)) continue;
            _log.LogWarning("warming {Layer} model {Model} failed", layer, model);
            _state.AddWarning($"「{layer}」的本机模型 {model} 没能载入 —— {loss}。");
        }
    }
}
