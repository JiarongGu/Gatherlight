namespace Gatherlight.Server.Modules.Jobs.Models;

/// <summary>Job kind = the <c>IJobHandler</c> that runs it. Generic seam: add a kind = add a handler.</summary>
public static class JobKind
{
    public const string Agent = "agent";     // headless planner run that may write (auto-commit / stage-for-review)
    public const string Tool = "tool";       // invoke a registered IGatherlightTool with fixed args (no LLM)
    public const string Notify = "notify";   // emit a notification
    public const string Report = "report";   // read-only agent run → saved markdown artifact
    public static readonly string[] All = { Agent, Tool, Notify, Report };
    public static bool IsValid(string? k) => k is not null && Array.IndexOf(All, k) >= 0;
}

public static class ScheduleKind
{
    public const string Once = "once";
    public const string Cron = "cron";
    public static bool IsValid(string? k) => k is Once or Cron;
}

public static class JobRunStatus
{
    public const string Running = "running";
    public const string Success = "success";
    public const string Failed = "failed";
    public const string Timeout = "timeout";
    public const string Staged = "staged";     // agent job produced edits awaiting human diff-approval
    public const string Rejected = "rejected"; // a staged run the user declined
    public const string Skipped = "skipped";   // due while offline, older than the catch-up grace window
}

public static class NotificationKind
{
    public const string Info = "info";
    public const string JobResult = "job-result";
    public const string Reminder = "reminder";
    public const string Error = "error";
}

/// <summary>A scheduled job. <see cref="ConfigJson"/> is the opaque per-handler payload; the runtime
/// columns (<see cref="RunCount"/>, <see cref="NextRunAt"/>, <see cref="LastStatus"/>, …) are owned by
/// the scheduler. Mutable class for Dapper (snake_case columns map via MatchNamesWithUnderscores).</summary>
public sealed class Job
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Kind { get; set; } = "";
    public string ConfigJson { get; set; } = "{}";
    public string ScheduleKind { get; set; } = Models.ScheduleKind.Once;
    public string? Cron { get; set; }
    public string? RunAt { get; set; }
    public string? Timezone { get; set; }
    public bool Enabled { get; set; } = true;
    public bool AutoCommit { get; set; }
    public int? TimeoutSeconds { get; set; }
    public int? MaxRuns { get; set; }
    public int RunCount { get; set; }
    public int ConsecutiveFailures { get; set; }
    public string? NextRunAt { get; set; }
    public string? LastRunAt { get; set; }
    public string? LastStatus { get; set; }
    public string CreatedAt { get; set; } = "";
    public string UpdatedAt { get; set; } = "";
}

public sealed class JobRun
{
    public string Id { get; set; } = "";
    public string JobId { get; set; } = "";
    public string StartedAt { get; set; } = "";
    public string? FinishedAt { get; set; }
    public string Status { get; set; } = JobRunStatus.Running;
    public string? Outcome { get; set; }
    public string? Detail { get; set; }
    public int? Tokens { get; set; }
    public long? DurationMs { get; set; }
}

public sealed class Notification
{
    public string Id { get; set; } = "";
    public string CreatedAt { get; set; } = "";
    public string Kind { get; set; } = NotificationKind.Info;
    public string Title { get; set; } = "";
    public string? Body { get; set; }
    public string? Link { get; set; }
    public bool Read { get; set; }
    public string? SourceJobId { get; set; }
}
