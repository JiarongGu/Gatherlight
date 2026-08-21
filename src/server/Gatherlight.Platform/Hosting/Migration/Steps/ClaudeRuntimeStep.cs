using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Hosting.Migration.Services;
using Gatherlight.Server.Platform.Hosting.Resources.Services;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

/// <summary>
/// Point the agent at a usable claude CLI, and SAY so when there isn't one.
///
/// <para>Why this step exists: the CLI was the last runtime dependency we merely assumed was on the
/// machine. On a fresh install it wasn't, so the very first chat spawned a <c>claude</c> that did not
/// exist and died at spawn in 17ms; all the household saw was "计划阶段未能完成(CLI 报告错误),请重试" —
/// a sentence naming neither the cause nor a remedy, on a retry that could never succeed.</para>
///
/// <para><b>Deliberately NOT essential</b>, and that is the whole design. git is boot-essential — the data
/// repo is the audit trail the diff gate rests on — so <see cref="GitRuntimeStep"/> downloads it inline
/// rather than fail. The CLI is product-essential but not boot-essential: the app runs, settings work, the
/// 资源 panel works. Gating the boot on it would cost a ~265 MB download before the household could reach
/// any screen — including the panel that installs it — which is precisely how the git failure sealed the
/// door to its own fix. So this step never throws: it resolves, applies, probes, and records a warning the
/// console shows, leaving the remedy one click away.</para>
/// </summary>
public sealed class ClaudeRuntimeStep : IMigrationStep
{
    private readonly IClaudeCliRuntime _claude;
    private readonly IResourceProvisioner _resources;
    private readonly MigrationState _state;
    private readonly ILogger<ClaudeRuntimeStep> _log;

    public ClaudeRuntimeStep(IClaudeCliRuntime claude, IResourceProvisioner resources,
        MigrationState state, ILogger<ClaudeRuntimeStep> log)
    { _claude = claude; _resources = resources; _state = state; _log = log; }

    public string Id => "claude-runtime";
    public string Title => "准备 Claude CLI(智能体引擎)";
    public bool Essential => false;

    public async Task RunAsync(CancellationToken ct)
    {
        // First, and cheapest: if we provisioned a CLI into the data folder, make Lyntai spawn THAT one.
        // Must happen before anything downstream reaches for the agent.
        _claude.Apply();

        // Installed is not usable. Probe what we would actually run — a missing binary, a blocked exe and a
        // signed-out CLI are three different problems with three different fixes, and only the CLI itself
        // can tell them apart. Forced refresh: a cached answer from a previous life is worthless here.
        var state = await _claude.ProbeAsync(refresh: true, ct);

        if (state.Ready)
        {
            _log.LogInformation("Claude CLI ready: {Path} (version {Version}, account {Account})",
                state.Path, state.Version ?? "unknown", state.Account ?? "unknown");
        }
        else
        {
            // A warning, not a failure. The console surfaces it, the 资源 panel resolves it.
            _log.LogWarning("Claude CLI not usable: {Problem}", state.Problem);
            _state.AddWarning(state.Problem ?? "Claude CLI 不可用 —— 请在「资源」面板检查。");
        }

        // Ask the vendor what the current version is so the panel can offer an update. Detached on purpose:
        // it only populates a display field, and a household behind a dead network must not wait on it.
        _ = _resources.CheckUpdatesAsync(CancellationToken.None);
    }
}
