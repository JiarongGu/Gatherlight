// MigrationModels.cs
namespace Gatherlight.Server.Modules.Migration.Models;

public static class MigrationPhase
{
    public const string Running = "running";
    public const string Completed = "completed";
    public const string Failed = "failed";
}

public static class StepStatus
{
    public const string Pending = "pending";
    public const string Running = "running";
    public const string Ok = "ok";
    public const string Failed = "failed";
    public const string Skipped = "skipped";
}

/// <summary>Live, mutable status of one step (the runner updates it as it progresses).</summary>
public sealed class MigrationStepState
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public required bool Essential { get; init; }
    public string Status { get; set; } = StepStatus.Pending;
    public string? Error { get; set; }
    public long Ms { get; set; }
}

/// <summary>Immutable snapshot returned by GET /api/migration/status (serialized camelCase).</summary>
public sealed record MigrationSnapshot(
    string Phase, bool IsUpgrade, string FromVersion, string ToVersion,
    IReadOnlyList<MigrationStepView> Steps, IReadOnlyList<string> Warnings, string? Error);

public sealed record MigrationStepView(string Id, string Title, bool Essential, string Status, string? Error, long Ms);
