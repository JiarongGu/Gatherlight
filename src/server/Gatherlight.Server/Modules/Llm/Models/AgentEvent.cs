using System.Text.Json;
using System.Text.Json.Serialization;

namespace Gatherlight.Server.Modules.Llm.Models;

/// <summary>
/// A normalized event the claude runner emits and the chat pipeline forwards to the UI over SSE.
/// Shape is wire-compatible with the legacy viewer (kind/phase/text/tool/sessionId/data).
/// </summary>
public sealed record AgentEvent
{
    /// <summary>phase | text | text-delta | thinking | tool | tool-result | system | notice | error | done</summary>
    public required string Kind { get; init; }
    public string? Phase { get; init; }
    public string? Text { get; init; }
    public ToolInfo? Tool { get; init; }
    public string? SessionId { get; init; }
    /// <summary>Arbitrary structured payload (plan, diff review, commit sha, …).</summary>
    public object? Data { get; init; }

    /// <summary>SSE/persistence serializer — camelCase, nulls dropped (legacy wire shape).</summary>
    public static readonly JsonSerializerOptions WireJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}

public sealed record ToolInfo(string Name, string? Detail);
