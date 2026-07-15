using Dapper;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Jobs.Models;

namespace Gatherlight.Server.Modules.Jobs.Services;

/// <summary>
/// Persistence for background jobs + their run history (the <c>job</c> / <c>job_run</c> tables).
/// Notifications live in <see cref="NotificationService"/>. Dapper + hand-written SQL; snake_case
/// columns map onto the model props via the global <c>MatchNamesWithUnderscores</c>.
/// </summary>
public interface IJobRepository
{
    Task UpsertAsync(Job job);
    Task<Job?> GetAsync(string id);
    Task<List<Job>> ListAsync();
    Task DeleteAsync(string id);
    /// <summary>Enabled jobs whose <c>next_run_at</c> is at or before <paramref name="nowIso"/>,
    /// soonest first — the scheduler's due query.</summary>
    Task<List<Job>> DueAsync(string nowIso);
    /// <summary>Persist the scheduler-owned runtime columns after a run (or an enable/disable).</summary>
    Task SaveRuntimeAsync(Job job);
    Task SetEnabledAsync(string id, bool enabled);

    Task InsertRunAsync(JobRun run);
    Task UpdateRunAsync(JobRun run);
    Task<JobRun?> GetRunAsync(string id);
    Task<List<JobRun>> ListRunsAsync(string jobId, int limit);
    Task<List<JobRun>> RecentRunsAsync(int limit);
}

public sealed class JobRepository : IJobRepository
{
    private readonly IDbConnectionFactory _db;
    public JobRepository(IDbConnectionFactory db) => _db = db;

    private const string JobCols =
        "id, name, kind, config_json, schedule_kind, cron, run_at, timezone, enabled, auto_commit, " +
        "timeout_seconds, max_runs, run_count, consecutive_failures, next_run_at, last_run_at, " +
        "last_status, created_at, updated_at";

    public async Task UpsertAsync(Job job)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            $"""
            INSERT INTO job({JobCols})
            VALUES (@Id, @Name, @Kind, @ConfigJson, @ScheduleKind, @Cron, @RunAt, @Timezone, @Enabled,
                    @AutoCommit, @TimeoutSeconds, @MaxRuns, @RunCount, @ConsecutiveFailures, @NextRunAt,
                    @LastRunAt, @LastStatus, @CreatedAt, @UpdatedAt)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name, kind = excluded.kind, config_json = excluded.config_json,
                schedule_kind = excluded.schedule_kind, cron = excluded.cron, run_at = excluded.run_at,
                timezone = excluded.timezone, enabled = excluded.enabled, auto_commit = excluded.auto_commit,
                timeout_seconds = excluded.timeout_seconds, max_runs = excluded.max_runs,
                next_run_at = excluded.next_run_at, updated_at = excluded.updated_at
            """,
            job);
    }

    public async Task<Job?> GetAsync(string id)
    {
        using var conn = _db.Open();
        return await conn.QuerySingleOrDefaultAsync<Job>(
            $"SELECT {JobCols} FROM job WHERE id = @id", new { id });
    }

    public async Task<List<Job>> ListAsync()
    {
        using var conn = _db.Open();
        return (await conn.QueryAsync<Job>(
            $"SELECT {JobCols} FROM job ORDER BY created_at DESC")).ToList();
    }

    public async Task DeleteAsync(string id)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync("DELETE FROM job_run WHERE job_id = @id; DELETE FROM job WHERE id = @id;", new { id });
    }

    public async Task<List<Job>> DueAsync(string nowIso)
    {
        using var conn = _db.Open();
        return (await conn.QueryAsync<Job>(
            $"""
            SELECT {JobCols} FROM job
            WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= @nowIso
            ORDER BY next_run_at ASC
            """,
            new { nowIso })).ToList();
    }

    public async Task SaveRuntimeAsync(Job job)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            """
            UPDATE job SET
                enabled = @Enabled, run_count = @RunCount, consecutive_failures = @ConsecutiveFailures,
                next_run_at = @NextRunAt, last_run_at = @LastRunAt, last_status = @LastStatus,
                updated_at = @UpdatedAt
            WHERE id = @Id
            """,
            job);
    }

    public async Task SetEnabledAsync(string id, bool enabled)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            "UPDATE job SET enabled = @enabled, updated_at = @now WHERE id = @id",
            new { id, enabled, now = DateTime.UtcNow.ToString("o") });
    }

    public async Task InsertRunAsync(JobRun run)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            """
            INSERT INTO job_run(id, job_id, started_at, finished_at, status, outcome, detail, tokens, duration_ms)
            VALUES (@Id, @JobId, @StartedAt, @FinishedAt, @Status, @Outcome, @Detail, @Tokens, @DurationMs)
            """,
            run);
    }

    public async Task UpdateRunAsync(JobRun run)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            """
            UPDATE job_run SET
                finished_at = @FinishedAt, status = @Status, outcome = @Outcome,
                detail = @Detail, tokens = @Tokens, duration_ms = @DurationMs
            WHERE id = @Id
            """,
            run);
    }

    public async Task<JobRun?> GetRunAsync(string id)
    {
        using var conn = _db.Open();
        return await conn.QuerySingleOrDefaultAsync<JobRun>(
            "SELECT id, job_id, started_at, finished_at, status, outcome, detail, tokens, duration_ms FROM job_run WHERE id = @id",
            new { id });
    }

    public async Task<List<JobRun>> ListRunsAsync(string jobId, int limit)
    {
        using var conn = _db.Open();
        return (await conn.QueryAsync<JobRun>(
            """
            SELECT id, job_id, started_at, finished_at, status, outcome, detail, tokens, duration_ms
            FROM job_run WHERE job_id = @jobId ORDER BY started_at DESC LIMIT @limit
            """,
            new { jobId, limit = Math.Clamp(limit, 1, 200) })).ToList();
    }

    public async Task<List<JobRun>> RecentRunsAsync(int limit)
    {
        using var conn = _db.Open();
        return (await conn.QueryAsync<JobRun>(
            """
            SELECT id, job_id, started_at, finished_at, status, outcome, detail, tokens, duration_ms
            FROM job_run ORDER BY started_at DESC LIMIT @limit
            """,
            new { limit = Math.Clamp(limit, 1, 200) })).ToList();
    }
}
