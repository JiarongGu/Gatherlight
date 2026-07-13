namespace Gatherlight.Server.Modules.Scoring.Models;

/// <summary>
/// What a scorer receives to grade a conversation (Mastra's ScorerRunInput, mapped to the two-gate
/// chat): the user's request (input), the agent's plan + outcome (output), and the changed files
/// (the "trajectory" — used by guardrail scorers like scope-adherence).
/// </summary>
public sealed class ScoreContext
{
    public required string SessionId { get; init; }
    public required string UserMessage { get; init; }
    public required string PlanText { get; init; }
    public required string Phase { get; init; }             // committed / rejected / error / …
    public required string Mode { get; init; }              // "plan" or "system"
    public string? CommitSha { get; init; }
    public required IReadOnlyList<string> ChangedFiles { get; init; }
}

/// <summary>A scorer's verdict on one dimension: a 0–1 score + a short human reason.</summary>
public sealed class ScoreResult
{
    public required double Score { get; init; }             // normalized 0..1
    public string? Reason { get; init; }
}

/// <summary>A persisted score row (one dimension of one conversation).</summary>
public sealed class StoredScore
{
    public string SessionId { get; set; } = "";
    public string ScorerId { get; set; } = "";
    public double Score { get; set; }
    public string? Reason { get; set; }
    public bool IsLlm { get; set; }
    public string CreatedAt { get; set; } = "";
}

/// <summary>Per-scorer aggregate across all scored conversations (for the console panel).</summary>
public sealed class ScoreAggregate
{
    public string ScorerId { get; set; } = "";
    public double AvgScore { get; set; }
    public int Count { get; set; }
}

/// <summary>An in-memory scorer verdict (before persistence) — used by the playground eval harness,
/// which scores dry runs without writing them to chat_score.</summary>
public sealed class ScoredResult
{
    public string ScorerId { get; set; } = "";
    public bool IsLlm { get; set; }
    public double Score { get; set; }
    public string? Reason { get; set; }
}
