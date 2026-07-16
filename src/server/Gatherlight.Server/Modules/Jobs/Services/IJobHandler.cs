using Gatherlight.Server.Modules.Jobs.Models;

namespace Gatherlight.Server.Modules.Jobs.Services;

/// <summary>Everything a handler needs for one run: the job, its fresh run row, the effective
/// timeout (job override or the global default), and the scheduler's cancellation token.</summary>
public sealed record JobRunContext
{
    public required Job Job { get; init; }
    public required JobRun Run { get; init; }
    public required int TimeoutSeconds { get; init; }
    public CancellationToken Ct { get; init; }
}

/// <summary>Outcome of a handler run. <see cref="Deferred"/> means the agent slot was busy and
/// nothing ran — the scheduler leaves <c>next_run_at</c> untouched and retries next tick (not a
/// failure). Otherwise <see cref="Status"/> is a <see cref="JobRunStatus"/> and drives the run
/// record + the job's success/failure bookkeeping.</summary>
public sealed record JobHandlerResult
{
    public required string Status { get; init; }
    public string? Outcome { get; init; }
    public string? Detail { get; init; }
    public bool Deferred { get; init; }
    /// <summary>Whether a failure is worth retrying (transient CLI/tool error). Config errors and
    /// timeouts set this false — retrying won't help. Ignored on success. (Mastra: non-retryable error.)</summary>
    public bool Retryable { get; init; } = true;

    public static JobHandlerResult Defer() => new() { Status = JobRunStatus.Skipped, Deferred = true };
    public static JobHandlerResult Success(string outcome, string? detail = null) =>
        new() { Status = JobRunStatus.Success, Outcome = outcome, Detail = detail };
    public static JobHandlerResult StagedForReview(string outcome, string detail) =>
        new() { Status = JobRunStatus.Staged, Outcome = outcome, Detail = detail };
    public static JobHandlerResult Failed(string status, string outcome, bool retryable = true) =>
        new() { Status = status, Outcome = outcome, Retryable = retryable };
}

/// <summary>
/// One job kind. The generic seam: a kind IS a handler, discovered as a DI collection
/// (<c>IEnumerable&lt;IJobHandler&gt;</c>) exactly like <c>IGatherlightTool</c>. Add a kind = add a
/// handler + one registration — never an if/else on <c>job.kind</c>. <see cref="Job.ConfigJson"/> is
/// the opaque per-handler payload.
/// </summary>
public interface IJobHandler
{
    string Kind { get; }
    /// <summary>Whether this kind spawns an agent (needs the single agent slot). The scheduler skips
    /// such a job for the tick when chat / another job holds the slot, instead of churning a run row.</summary>
    bool UsesAgentGate => false;
    /// <summary>Run the job. Throw for an unexpected failure (the scheduler records it as failed);
    /// return <see cref="JobHandlerResult.Defer"/> when the agent slot is busy.</summary>
    Task<JobHandlerResult> RunAsync(JobRunContext ctx);
}
