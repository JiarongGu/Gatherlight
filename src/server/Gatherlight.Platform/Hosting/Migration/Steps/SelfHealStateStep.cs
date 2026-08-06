using Gatherlight.Server.Platform.Agent.Chat.Services;
using Gatherlight.Server.Platform.Storage.DataRepo.Services;
using Gatherlight.Server.Platform.Ops.Jobs.Services;
using Gatherlight.Server.Platform.Hosting.Migration.Services;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

public sealed class SelfHealStateStep : IMigrationStep
{
    private readonly IChatRepository _chat;
    private readonly IJobRepository _jobs;
    private readonly IGitCliService _git;
    private readonly MigrationState _state;
    private readonly ChatSessionService _sessions;
    private readonly ILogger<SelfHealStateStep> _log;
    public SelfHealStateStep(IChatRepository chat, IJobRepository jobs, IGitCliService git,
        MigrationState state, ChatSessionService sessions, ILogger<SelfHealStateStep> log)
    { _chat = chat; _jobs = jobs; _git = git; _state = state; _sessions = sessions; _log = log; }

    public string Id => "self-heal-state";
    public string Title => "检查中断的任务与改动";
    public bool Essential => false;
    public async Task RunAsync(CancellationToken ct)
    {
        // A session that was MID-RUN cannot survive a restart — its child process is gone — and still
        // becomes error. A session PARKED ON A HUMAN DECISION is the opposite: nothing in flight, and
        // its state already durable, so it comes back and the decision can still be made. That matters
        // more since auto-update restarts the server: approving an update should not throw away the
        // plan sitting at the diff gate. Restore is best-effort — a failure here leaves the old
        // behaviour, and this step is non-essential by design.
        if (await _chat.ReconcileInterruptedAsync() is { } parked)
        {
            try
            {
                if (!await _sessions.RestoreParkedAsync(parked.Id, parked.Meta))
                    _state.AddWarning("上次有一个待你决定的对话未能恢复,请重新发起。");
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "self-heal: could not restore parked session {Session}", parked.Id);
                _state.AddWarning("上次有一个待你决定的对话未能恢复,请重新发起。");
            }
        }
        var reconciled = await _jobs.FailInterruptedRunsAsync();
        if (reconciled > 0) _log.LogInformation("self-heal: reconciled {N} interrupted job run(s) → failed", reconciled);

        // Surface — never auto-mutate — an unexpected dirty data-repo tree (e.g. an aborted commit's
        // leftovers). state/ uploads/ cache/ are gitignored, so only real planner/KB changes show.
        var status = await _git.RunAsync(new[] { "status", "--porcelain" }, ct);
        var dirty = status.Stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (dirty.Length > 0)
        {
            _log.LogWarning("self-heal: data repo has {N} uncommitted change(s) from an interrupted task: {Files}",
                dirty.Length, string.Join(", ", dirty[..Math.Min(dirty.Length, 10)]));
            _state.AddWarning($"数据仓库有 {dirty.Length} 处未提交改动(可能来自中断的任务)— 请在管理台检查处理。");
        }
    }
}
