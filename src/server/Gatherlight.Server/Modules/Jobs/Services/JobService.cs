using System.Diagnostics;
using System.Text.Json;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.DataRepo.Services;
using Gatherlight.Server.Modules.Jobs.Models;
using Gatherlight.Server.Modules.Llm.Services;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Jobs.Services;

/// <summary>Create/update payload (from the AI tool or the console). Id null = create.</summary>
public sealed record JobInput
{
    public string? Id { get; init; }
    public required string Name { get; init; }
    public required string Kind { get; init; }
    public string ConfigJson { get; init; } = "{}";
    public required string ScheduleKind { get; init; }
    public string? Cron { get; init; }
    public string? RunAt { get; init; }
    public string? Timezone { get; init; }
    public bool Enabled { get; init; } = true;
    public bool AutoCommit { get; init; }
    public int? TimeoutSeconds { get; init; }
    public int? MaxRuns { get; init; }
}

/// <summary>
/// Background-jobs orchestration: CRUD + validation + schedule computation, AND the execution engine
/// that runs one job through its <see cref="IJobHandler"/> and applies the outcome (schedule advance,
/// failure/run-cap auto-disable). The scheduler loop and "run now" both go through <see cref="ExecuteAsync"/>,
/// so behaviour is identical. Staged agent diffs are approved/rejected here too.
/// </summary>
public interface IJobService
{
    Task<List<Job>> ListAsync();
    Task<Job?> GetAsync(string id);
    Task<List<JobRun>> RunsAsync(string id, int limit);
    Task<(Job? Job, string? Error)> UpsertAsync(JobInput input);
    Task<bool> SetEnabledAsync(string id, bool enabled);
    Task<bool> DeleteAsync(string id);
    /// <summary>Run immediately (bypasses the schedule/grace). Error when not found or the agent slot is busy.</summary>
    Task<(JobRun? Run, string? Error)> RunNowAsync(string id, CancellationToken ct = default);
    /// <summary>Scheduler entry point for a due job: fires it, or (if it came due past the grace
    /// window while offline) rolls it forward instead of firing late.</summary>
    Task ExecuteDueAsync(Job job, CancellationToken ct);
    Task<(bool Ok, string? Error, string? Sha)> ApproveStagedRunAsync(string runId, CancellationToken ct = default);
    Task<bool> RejectStagedRunAsync(string runId);
}

public sealed class JobService : IJobService
{
    private readonly IJobRepository _repo;
    private readonly IReadOnlyDictionary<string, IJobHandler> _handlers;
    private readonly ServerConfigService _config;
    private readonly INotificationService _notifications;
    private readonly IAgentGate _gate;
    private readonly IGitCliService _git;
    private readonly DataWriteLock _writeLock;
    private readonly IDataCommitRepository _commits;
    private readonly IPromptHarness _harness;
    private readonly ILogger<JobService> _log;

    public JobService(
        IJobRepository repo, IEnumerable<IJobHandler> handlers, ServerConfigService config,
        INotificationService notifications, IAgentGate gate, IGitCliService git, DataWriteLock writeLock,
        IDataCommitRepository commits, IPromptHarness harness, ILogger<JobService> log)
    {
        _repo = repo;
        _handlers = handlers.ToDictionary(h => h.Kind);
        _config = config;
        _notifications = notifications;
        _gate = gate;
        _git = git;
        _writeLock = writeLock;
        _commits = commits;
        _harness = harness;
        _log = log;
    }

    public Task<List<Job>> ListAsync() => _repo.ListAsync();
    public Task<Job?> GetAsync(string id) => _repo.GetAsync(id);
    public Task<List<JobRun>> RunsAsync(string id, int limit) => _repo.ListRunsAsync(id, limit);

    // --- CRUD -----------------------------------------------------------------------------

    public async Task<(Job? Job, string? Error)> UpsertAsync(JobInput input)
    {
        if (string.IsNullOrWhiteSpace(input.Name)) return (null, "name 必填");
        if (!JobKind.IsValid(input.Kind)) return (null, $"未知的任务类型:{input.Kind}(可选:{string.Join('/', JobKind.All)})");
        if (!_handlers.ContainsKey(input.Kind)) return (null, $"任务类型 {input.Kind} 无处理器");

        var now = DateTime.UtcNow;
        var existing = input.Id is not null ? await _repo.GetAsync(input.Id) : null;
        var job = new Job
        {
            Id = existing?.Id ?? "j" + Guid.NewGuid().ToString("n")[..16],
            Name = input.Name.Trim(),
            Kind = input.Kind,
            ConfigJson = string.IsNullOrWhiteSpace(input.ConfigJson) ? "{}" : input.ConfigJson,
            ScheduleKind = input.ScheduleKind,
            Cron = input.Cron?.Trim(),
            RunAt = input.RunAt,
            Timezone = input.Timezone?.Trim(),
            Enabled = input.Enabled,
            AutoCommit = input.AutoCommit,
            TimeoutSeconds = input.TimeoutSeconds,
            MaxRuns = input.MaxRuns,
            RunCount = existing?.RunCount ?? 0,
            ConsecutiveFailures = existing?.ConsecutiveFailures ?? 0,
            LastRunAt = existing?.LastRunAt,
            LastStatus = existing?.LastStatus,
            CreatedAt = existing?.CreatedAt ?? now.ToString("o"),
            UpdatedAt = now.ToString("o"),
        };

        // Validate the config is parseable JSON (handlers read their own keys).
        try { JsonDocument.Parse(job.ConfigJson).Dispose(); } catch { return (null, "config 不是有效的 JSON"); }
        if (JobSchedule.Validate(job) is { } scheduleError) return (null, scheduleError);

        job.NextRunAt = JobSchedule.Iso(JobSchedule.FirstOccurrence(job, now));
        await _repo.UpsertAsync(job);
        return (job, null);
    }

    public async Task<bool> SetEnabledAsync(string id, bool enabled)
    {
        var job = await _repo.GetAsync(id);
        if (job is null) return false;
        job.Enabled = enabled;
        // Re-enabling → recompute next occurrence so a long-disabled cron job doesn't fire stale.
        if (enabled) job.NextRunAt = JobSchedule.Iso(JobSchedule.FirstOccurrence(job, DateTime.UtcNow));
        job.UpdatedAt = DateTime.UtcNow.ToString("o");
        await _repo.SaveRuntimeAsync(job);
        return true;
    }

    public async Task<bool> DeleteAsync(string id)
    {
        if (await _repo.GetAsync(id) is null) return false;
        await _repo.DeleteAsync(id);
        return true;
    }

    public async Task<(JobRun? Run, string? Error)> RunNowAsync(string id, CancellationToken ct = default)
    {
        var job = await _repo.GetAsync(id);
        if (job is null) return (null, "任务不存在");
        var run = await ExecuteAsync(job, ct);
        return run is null ? (null, "无法立即运行(AI 正忙或任务类型未知),请稍后重试。") : (run, null);
    }

    // --- execution engine (shared by the scheduler + run-now) -----------------------------

    public async Task ExecuteDueAsync(Job job, CancellationToken ct)
    {
        var cfg = _config.Current.Jobs;
        // Came due while offline, older than the grace window → don't fire late; roll forward.
        if (JobSchedule.TryParseInstant(job.NextRunAt, out var nextUtc)
            && DateTime.UtcNow - nextUtc > TimeSpan.FromHours(Math.Max(1, cfg.CatchUpGraceHours)))
        {
            await HandleMissedAsync(job);
            return;
        }
        await ExecuteAsync(job, ct);
    }

    /// <summary>Run one job now: gate pre-check → run row → handler (timeout-bounded) → outcome.
    /// Returns the finalized run, or null when it didn't run (agent slot busy / unknown kind).</summary>
    private async Task<JobRun?> ExecuteAsync(Job job, CancellationToken ct)
    {
        var cfg = _config.Current.Jobs;
        if (!_handlers.TryGetValue(job.Kind, out var handler))
        {
            await DisableAsync(job, $"未知的任务类型:{job.Kind}");
            return null;
        }
        if (handler.UsesAgentGate && _gate.IsBusy)
        {
            _log.LogInformation("Job {Id} deferred — agent slot busy ({Owner})", job.Id, _gate.CurrentOwner);
            return null;
        }

        var run = new JobRun
        {
            Id = "r" + Guid.NewGuid().ToString("n")[..16],
            JobId = job.Id,
            StartedAt = DateTime.UtcNow.ToString("o"),
            Status = JobRunStatus.Running,
        };
        await _repo.InsertRunAsync(run);
        _log.LogInformation("Job {Id} ({Kind}) '{Name}' run {Run} starting", job.Id, job.Kind, job.Name, run.Id);

        var timeout = job.TimeoutSeconds ?? cfg.DefaultTimeoutSeconds;
        var maxRetries = Math.Max(0, cfg.MaxRetries);
        var sw = Stopwatch.StartNew();

        // Whole-fire budget: all attempts + backoffs SHARE roughly one timeout, so a long-timeout job with
        // retries can't hold the (sequential) scheduler + agent slot for timeout×(retries+1) — hours. A
        // retry only runs if earlier attempts failed fast enough to leave budget.
        using var fireCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        fireCts.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(timeout, 10, 3600) + 60));

        // Retry loop: a transient (retryable) failure is retried up to maxRetries with exponential
        // backoff WITHIN this fire, so a rate-limit blip doesn't count toward auto-disable. Config
        // errors + timeouts are non-retryable → fail fast. (Mastra step-retry pattern, single-attempt-row.)
        JobHandlerResult result;
        var attempt = 0;
        while (true)
        {
            result = await RunHandlerOnceAsync(handler, job, run, timeout, ct, fireCts.Token);
            if (result.Deferred)
            {
                await _repo.DeleteRunAsync(run.Id);   // lost the gate race; keep history clean, retry next tick
                return null;
            }
            // Server shutting down mid-run: not a job failure — drop the run row and stop, so it doesn't
            // count toward auto-disable or advance the schedule off a half-run.
            if (ct.IsCancellationRequested)
            {
                try { await _repo.DeleteRunAsync(run.Id); } catch { /* shutting down */ }
                return null;
            }
            var ok = result.Status is JobRunStatus.Success or JobRunStatus.Staged;
            if (ok || !result.Retryable || attempt >= maxRetries) break;

            attempt++;
            var backoff = TimeSpan.FromSeconds(Math.Clamp(cfg.RetryBackoffSeconds, 1, 300) * Math.Pow(2, attempt - 1));
            _log.LogInformation("Job {Id} run {Run} transient failure ({Outcome}); retry {Att}/{Max} after {Backoff}s",
                job.Id, run.Id, result.Outcome, attempt, maxRetries, backoff.TotalSeconds);
            try { await Task.Delay(backoff, fireCts.Token); }
            catch (OperationCanceledException) { break; }   // fire-budget exhausted or shutting down → stop retrying
        }
        sw.Stop();

        run.Status = result.Status;
        run.Outcome = attempt > 0 ? $"{result.Outcome}(重试 {attempt} 次)" : result.Outcome;
        run.Detail = result.Detail;
        run.DurationMs = sw.ElapsedMilliseconds;
        run.FinishedAt = DateTime.UtcNow.ToString("o");
        await _repo.UpdateRunAsync(run);
        _log.LogInformation("Job {Id} run {Run} → {Status} ({Outcome}) in {Ms}ms",
            job.Id, run.Id, result.Status, run.Outcome, sw.ElapsedMilliseconds);

        await ApplyOutcomeAsync(job, cfg, result);
        return run;
    }

    /// <summary>One handler attempt, timeout-bounded, with exceptions classified into a retryable/
    /// non-retryable failure (ToolException 4xx = config/won't-fix = non-retryable; 5xx + unexpected =
    /// transient = retryable; a scheduler-timeout is non-retryable).</summary>
    private async Task<JobHandlerResult> RunHandlerOnceAsync(
        IJobHandler handler, Job job, JobRun run, int timeout, CancellationToken shutdownCt, CancellationToken fireCt)
    {
        try
        {
            using var runCts = CancellationTokenSource.CreateLinkedTokenSource(fireCt);
            runCts.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(timeout, 10, 3600) + 30));
            return await handler.RunAsync(new JobRunContext { Job = job, Run = run, TimeoutSeconds = timeout, Ct = runCts.Token });
        }
        catch (OperationCanceledException) when (shutdownCt.IsCancellationRequested)
        {
            // Server shutting down — non-retryable; ExecuteAsync sees shutdownCt cancelled and drops the
            // run rather than recording a failure that would count toward auto-disable.
            return JobHandlerResult.Failed(JobRunStatus.Timeout, "服务器停止,任务中断", retryable: false);
        }
        catch (OperationCanceledException)
        {
            // Per-attempt timeout OR the whole-fire budget — non-retryable (a retry would re-hit the budget).
            return JobHandlerResult.Failed(JobRunStatus.Timeout, "任务超时(调度器强制终止或超出总时限)", retryable: false);
        }
        catch (ToolException tex)
        {
            return JobHandlerResult.Failed(JobRunStatus.Failed, tex.Message, retryable: tex.Status >= 500);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Job {Id} ({Kind}) run {Run} threw", job.Id, job.Kind, run.Id);
            return JobHandlerResult.Failed(JobRunStatus.Failed, ex.Message, retryable: true);
        }
    }

    private async Task ApplyOutcomeAsync(Job job, JobsConfig cfg, JobHandlerResult result)
    {
        var ok = result.Status is JobRunStatus.Success or JobRunStatus.Staged;
        var now = DateTime.UtcNow;
        job.RunCount += 1;
        job.LastRunAt = now.ToString("o");
        job.LastStatus = result.Status;
        job.UpdatedAt = now.ToString("o");
        job.ConsecutiveFailures = ok ? 0 : job.ConsecutiveFailures + 1;

        var next = JobSchedule.NextAfterRun(job, now);
        job.NextRunAt = JobSchedule.Iso(next);
        if (next is null) job.Enabled = false;   // one-off spent

        string? disableReason = null;
        if (!ok && job.ConsecutiveFailures >= Math.Max(1, cfg.MaxConsecutiveFailures))
            disableReason = $"连续失败 {job.ConsecutiveFailures} 次,已自动停用。";
        else if (job.MaxRuns is { } cap && job.RunCount >= cap)
            disableReason = $"已达运行上限({cap} 次),已自动停用。";

        if (disableReason is not null)
        {
            job.Enabled = false;
            await _repo.SaveRuntimeAsync(job);
            await _notifications.CreateAsync(NotificationKind.Error, $"定时任务已停用:{job.Name}", disableReason, link: $"job:{job.Id}", sourceJobId: job.Id);
            _log.LogWarning("Job {Id} auto-disabled: {Reason}", job.Id, disableReason);
            return;
        }
        await _repo.SaveRuntimeAsync(job);
    }

    private async Task HandleMissedAsync(Job job)
    {
        _log.LogInformation("Job {Id} missed (due {Due}, past grace) — rolling forward", job.Id, job.NextRunAt);
        if (job.Kind == JobKind.Notify)
            await _notifications.CreateAsync(NotificationKind.Reminder, $"错过的提醒:{job.Name}", "应用离线期间错过了这条提醒。", link: $"job:{job.Id}", sourceJobId: job.Id);

        var now = DateTime.UtcNow;
        var next = JobSchedule.NextAfterRun(job, now);
        job.NextRunAt = JobSchedule.Iso(next);
        job.LastStatus = JobRunStatus.Skipped;
        job.UpdatedAt = now.ToString("o");
        if (next is null) job.Enabled = false;
        await _repo.SaveRuntimeAsync(job);
    }

    private async Task DisableAsync(Job job, string reason)
    {
        job.Enabled = false;
        job.LastStatus = "error";
        job.UpdatedAt = DateTime.UtcNow.ToString("o");
        await _repo.SaveRuntimeAsync(job);
        await _notifications.CreateAsync(NotificationKind.Error, $"定时任务已停用:{job.Name}", reason, link: $"job:{job.Id}", sourceJobId: job.Id);
    }

    // --- staged agent diff: approve / reject ----------------------------------------------

    public async Task<(bool Ok, string? Error, string? Sha)> ApproveStagedRunAsync(string runId, CancellationToken ct = default)
    {
        var run = await _repo.GetRunAsync(runId);
        if (run is null) return (false, "运行记录不存在", null);
        if (run.Status != JobRunStatus.Staged || string.IsNullOrEmpty(run.Detail))
            return (false, "该运行没有待审阅的改动", null);

        StagedDetail? staged;
        try { staged = JsonSerializer.Deserialize<StagedDetail>(run.Detail, Web); }
        catch { return (false, "暂存的改动数据损坏,无法应用", null); }
        if (staged?.Patch is null || staged.Files is not { Count: > 0 }) return (false, "暂存的改动为空", null);

        var job = await _repo.GetAsync(run.JobId);
        var jobName = job?.Name ?? "job";
        var paths = staged.Files.Select(f => f.Path).ToList();

        string sha;
        using (await _writeLock.AcquireAsync(ct))
        {
            if (!await _git.ApplyPatchAsync(staged.Patch, ct))
                return (false, "改动无法干净地应用(数据自任务运行后已变更),请重新运行该任务。", null);
            sha = await _git.CommitPathsAsync(paths, _harness.JobCommitMessage(jobName, paths, autoApproved: false), ct);
        }
        _commits.Record(sha, $"job: {jobName}", "job", run.JobId);

        run.Status = JobRunStatus.Success;
        run.Outcome = $"已提交 {sha}({paths.Count} 文件)";
        run.FinishedAt = DateTime.UtcNow.ToString("o");
        await _repo.UpdateRunAsync(run);
        await _notifications.CreateAsync(NotificationKind.JobResult, $"改动已提交:{jobName}", $"{paths.Count} 个文件 · {sha}", link: $"jobrun:{run.Id}", sourceJobId: run.JobId);
        return (true, null, sha);
    }

    public async Task<bool> RejectStagedRunAsync(string runId)
    {
        var run = await _repo.GetRunAsync(runId);
        if (run is null || run.Status != JobRunStatus.Staged) return false;
        run.Status = JobRunStatus.Rejected;
        run.Outcome = "已拒绝暂存的改动";
        run.FinishedAt = DateTime.UtcNow.ToString("o");
        await _repo.UpdateRunAsync(run);
        return true;
    }

    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
    private sealed record StagedDetail(string? Type, string? Patch, List<StagedFile>? Files);
    private sealed record StagedFile(string Path, string? Status, bool IsClaudeInfra, string? Diff);
}
