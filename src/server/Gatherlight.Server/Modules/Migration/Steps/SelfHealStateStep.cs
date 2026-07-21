using Gatherlight.Server.Modules.Chat.Services;
using Gatherlight.Server.Modules.DataRepo.Services;
using Gatherlight.Server.Modules.Jobs.Services;
using Gatherlight.Server.Modules.Migration.Services;

namespace Gatherlight.Server.Modules.Migration.Steps;

public sealed class SelfHealStateStep : IMigrationStep
{
    private readonly IChatRepository _chat;
    private readonly IJobRepository _jobs;
    private readonly IGitCliService _git;
    private readonly MigrationState _state;
    private readonly ILogger<SelfHealStateStep> _log;
    public SelfHealStateStep(IChatRepository chat, IJobRepository jobs, IGitCliService git,
        MigrationState state, ILogger<SelfHealStateStep> log)
    { _chat = chat; _jobs = jobs; _git = git; _state = state; _log = log; }

    public string Id => "self-heal-state";
    public string Title => "检查中断的任务与改动";
    public bool Essential => false;
    public async Task RunAsync(CancellationToken ct)
    {
        // Sessions/job runs left non-terminal by a previous death → error/failed (inspectable, not resumed).
        await _chat.FailInterruptedSessionsAsync();
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
