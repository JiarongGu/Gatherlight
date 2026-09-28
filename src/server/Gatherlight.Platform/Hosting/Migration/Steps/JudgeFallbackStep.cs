using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Agent.Llm.Sources;
using Gatherlight.Server.Platform.Hosting.Migration.Services;
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

/// <summary>
/// SAY that 判断 fell back to the Claude CLI for this start, when its saved local model is not there — and what that costs,
/// what moved, and what brings it back. Any local judge: a llama.cpp model whose file is gone, or the 内置 reranker whose
/// files are (<see cref="IMemorySource.HasModel"/>, <see cref="IMemorySource.WhyNotHere"/> — the source's own clause, the
/// one the bind endpoint refuses with).
///
/// <para><b>Why a step of its own.</b> The warning lived in <see cref="LlamaWarmStep"/> while llama.cpp was the only local
/// judge, and read the llama.cpp source by id. The 内置 reranker falls back the same way — <c>MemorySources.ResolveJudge</c>
/// keeps a binding only while its model is there — so the sentence is asked of whichever source the settings NAME, and
/// the step that starts llama.cpp no longer speaks for a backend that never touches it. Without it the fallback is
/// silent: 判断 quietly on the CLI, spending quota nobody chose this start, with nothing saying why.</para>
///
/// <para>Runs after <see cref="ClaudeRuntimeStep"/>, whose probe it reads CACHED (<see cref="MemorySources.CliTaggingNow"/>):
/// a CLI that is missing or signed out takes over nothing, and the warning says so. Never essential, never throws.</para>
///
/// <para><b>Residuals, stated.</b> Only a gone MODEL is announced: a missing llama.cpp RUNTIME still falls back without a
/// word, as the built-in EMBEDDER's missing files do (dev-conventions). And the 内置 reranker's files present but damaged
/// pass <see cref="IMemorySource.HasModel"/> — the lazy load then fails at the first recall, logged at Warning, the judge
/// verifying nothing.</para>
/// </summary>
public sealed class JudgeFallbackStep : IMigrationStep
{
    private readonly ServerConfigService _config;
    private readonly IPlatformContext _platform;
    private readonly MigrationState _state;
    private readonly IClaudeCliRuntime _claude;
    private readonly IAppConfigService _appConfig;
    private readonly ILogger<JudgeFallbackStep> _log;

    public JudgeFallbackStep(ServerConfigService config, IPlatformContext platform, MigrationState state,
        IClaudeCliRuntime claude, IAppConfigService appConfig, ILogger<JudgeFallbackStep> log)
    {
        _config = config; _platform = platform; _state = state; _claude = claude; _appConfig = appConfig; _log = log;
    }

    public string Id => "judge-fallback";
    public string Title => "检查「判断」绑定的本机模型";
    public bool Essential => false;

    public Task RunAsync(CancellationToken ct)
    {
        var settings = new MemorySourceSettings(_config.Current.Memory, _platform.ResourcesPath);
        // The SAME resolution the DI wiring used, and the source the settings NAME. A saved CLI binding cannot fall back —
        // it is where a fallback goes — and a legacy transport names no local model (SavedJudgeSource).
        var judge = MemorySources.ResolveJudge(settings);
        var saved = MemorySources.FindJudge(MemorySources.SavedJudgeSource(settings.Config));
        if (saved is null || saved.Id == MemorySources.DefaultJudgeSource || judge.Id == saved.Id
            || settings.Config.JudgeModel is not { Length: > 0 } gone || saved.HasModel(settings, gone))
            return Task.CompletedTask;

        // WHAT THE FALLBACK COSTS, and WHAT MOVES — which depends on what was bound. A local CHAT judge did both halves on
        // this machine, so this start is the first time the household's facts go to Claude and the account pays for them.
        // A RERANKER only checked — llama.cpp's or 内置's: its tagging was on the CLI all along, so only the checking moves,
        // and saying 「标注与核对都改由它完成」 would misstate what changed. Asked of the source (ChecksOnly), the member the
        // bind toast reads. The tagging clause is MemorySources.CliTaggingCost — one writer, the one the reranker's cost
        // line and bind toast carry. 判断's own switch decides whether any of it is spent now, so "消耗账号额度" is never
        // said while nothing is being called; with it off, what matters is what happens when it is switched on, which is
        // both halves on the CLI whatever was bound.
        var cliTagging = "写入时" + MemorySources.CliTaggingCost;
        var cost = !MemoryEnrichment.IsOn(_appConfig)
            ? $"(「判断」现在是关着的,暂时不会调用;打开后标注与核对都由它完成:{cliTagging};检索时每次也调用一次)"
            : saved.ChecksOnly(gone)
                ? " —— 写入时的主题标注本来就由它完成(" + MemorySources.CliTaggingCost + ");"
                  + "现在检索时的核对也改由它完成:每次检索一次调用,同样消耗账号额度,候选事实的内容也会发给 Claude"
                : $" —— 标注与核对都改由它完成:{cliTagging};检索时每次也调用一次";
        // …AND WHETHER THE CLI CAN DO ANY OF IT. Everything above says what the CLI takes over; a CLI that is missing or
        // signed out takes over nothing — both policies are fail-open, so no fact is tagged and no recall is checked, and
        // nothing else reports it. Read from the CACHED probe (ClaudeRuntimeStep ran it earlier in this startup) through
        // MemorySources.CliTaggingNow, the reader the bind toast and the reranker's warm warning use; nothing when nobody
        // has probed. Its Why and Fix, not its Text: Text says 「检索时的核对照常」, true beside a running reranker and false
        // here, where the checking moved to this same CLI. Said whatever 判断's switch is: off, nothing happens now, and
        // switched on it still will not until the CLI works — true both ways.
        var cliNow = MemorySources.CliTaggingNow(_claude.Cached);
        var cliCannot = cliNow is { Works: false }
            ? $"注意:{cliNow.Why},在它能用之前,写入的事实不会被标注,检索时也不会核对 —— {cliNow.Fix}"
            : "";
        _log.LogWarning("memory judge is bound to {Source} model {Model}, which is not one of its models here; " +
            "falling back to the Claude CLI for this start", saved.Id, gone);
        _state.AddWarning($"「判断」绑定的本机模型用不了:{saved.WhyNotHere(settings, gone)}。"
            + $"这次启动「判断」退回 Claude CLI{cost}。处理好之后重启服务才会用回它;也可以在「记忆检索」另选一个。"
            + cliCannot);
        return Task.CompletedTask;
    }
}
