namespace Gatherlight.Server.Modules.Trace.Models;

/// <summary>One span in a conversation's run trace (Mastra's AI-tracing span, flattened): a phase
/// transition, a tool call, an LLM run (tokens/cost), or an error — with when it happened + how long
/// it took.</summary>
public sealed class TraceStep
{
    public int Seq { get; set; }
    public string Kind { get; set; } = "";        // phase | tool | usage | error
    public string Label { get; set; } = "";
    public string? Detail { get; set; }
    public string At { get; set; } = "";          // ISO timestamp
    public long DurationMs { get; set; }           // phases: to next phase; tools: to their result
    public long? InputTokens { get; set; }
    public long? OutputTokens { get; set; }
    public long? CacheReadTokens { get; set; }
    public double? CostUsd { get; set; }
}

/// <summary>The whole run trace for one conversation: the ordered spans + rolled-up totals.</summary>
public sealed class RunTrace
{
    public string SessionId { get; set; } = "";
    public string Mode { get; set; } = "";
    public string Phase { get; set; } = "";        // final phase
    public string? CommitSha { get; set; }
    public long TotalDurationMs { get; set; }
    public int ToolCalls { get; set; }
    public long InputTokens { get; set; }
    public long OutputTokens { get; set; }
    public long CacheReadTokens { get; set; }
    public double CostUsd { get; set; }
    public List<TraceStep> Steps { get; set; } = new();
}
