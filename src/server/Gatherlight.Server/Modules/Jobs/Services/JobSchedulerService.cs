using Gatherlight.Server.Modules.Core.Services;
using Microsoft.Extensions.Hosting;

namespace Gatherlight.Server.Modules.Jobs.Services;

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

    public JobSchedulerService(IJobRepository repo, IJobService jobs, ServerConfigService config, ILogger<JobSchedulerService> log)
    {
        _repo = repo;
        _jobs = jobs;
        _config = config;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        // Let startup (migrations + seed + index) settle before the first tick.
        try { await Task.Delay(TimeSpan.FromSeconds(5), stopping); } catch { return; }
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
        var due = await _repo.DueAsync(DateTime.UtcNow.ToString("o"));
        foreach (var job in due)
        {
            if (ct.IsCancellationRequested) break;
            await _jobs.ExecuteDueAsync(job, ct);
        }
    }
}
