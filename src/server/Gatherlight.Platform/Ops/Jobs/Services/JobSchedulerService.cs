using Gatherlight.Server.Platform.Kernel.Services;
using Microsoft.Extensions.Hosting;

namespace Gatherlight.Server.Platform.Ops.Jobs.Services;

/// <summary>
/// The background job timer. Wakes every <c>jobs.pollSeconds</c>, and while the global kill-switch
/// (<c>jobs.enabled</c>) is on, hands each due job to <see cref="IJobService.ExecuteDueAsync"/>
/// SEQUENTIALLY. All the run logic (handler dispatch, catch-up, guardrails, schedule advance) lives
/// in <see cref="JobService"/> — shared with "run now" — so this class is only the clock.
/// </summary>
public sealed class JobSchedulerService : BackgroundService
{
    private readonly IJobRepository _repo;
    private readonly IJobService _jobs;
    private readonly ServerConfigService _config;
    private readonly ILogger<JobSchedulerService> _log;
    private readonly Hosting.Migration.Services.MigrationState? _migration;

    public JobSchedulerService(IJobRepository repo, IJobService jobs, ServerConfigService config, ILogger<JobSchedulerService> log,
        Hosting.Migration.Services.MigrationState? migration = null)
    {
        _repo = repo;
        _jobs = jobs;
        _config = config;
        _log = log;
        _migration = migration;
    }

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        // NOT BEFORE THE STARTUP MIGRATION HAS FINISHED — the gate the access middleware uses (MigrationState). A fixed
        // 5 s used to stand in for it, and a startup that takes longer — a layout rebuild or a re-embed of a large
        // corpus, a first-run git download — then had a scheduled job running beside it: a `remember_fact` tool job
        // writing facts while the startup rebuild cleared and re-indexed every ref. Waits for as long as the migration
        // runs, and for ever if an essential step failed (the app is not serving then either); TickAsync asks again, so a
        // Retry that re-runs the migration holds the jobs back too.
        try { await Task.Delay(TimeSpan.FromSeconds(5), stopping); } catch { return; }
        try
        {
            while (_migration?.IsMigrating == true) await Task.Delay(TimeSpan.FromMilliseconds(500), stopping);
        }
        catch { return; }
        _log.LogInformation("Job scheduler started (poll={Poll}s)", _config.Current.Jobs.PollSeconds);

        while (!stopping.IsCancellationRequested)
        {
            try { await TickAsync(stopping); }
            catch (Exception ex) { _log.LogError(ex, "Job scheduler tick failed"); }

            var poll = Math.Clamp(_config.Current.Jobs.PollSeconds, 5, 3600);
            try { await Task.Delay(TimeSpan.FromSeconds(poll), stopping); } catch { break; }
        }
    }

    private async Task TickAsync(CancellationToken ct)
    {
        if (!_config.Current.Jobs.Enabled) return;   // global kill-switch
        if (_migration?.IsMigrating == true) return;  // a Retry is re-running the startup migration (see ExecuteAsync)
        var due = await _repo.DueAsync(DateTime.UtcNow.ToString("o"));
        foreach (var job in due)
        {
            if (ct.IsCancellationRequested) break;
            await _jobs.ExecuteDueAsync(job, ct);
        }
    }
}
