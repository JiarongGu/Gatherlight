using System.Text.Json;

namespace Gatherlight.Server.Platform.Capabilities.Tools.Models;

/// <summary>
/// One callable capability, MCP-shaped so a single definition serves BOTH surfaces:
/// HTTP (GET /api/tools + POST /api/tools/call, used by the frontend) and MCP
/// (the spawned claude agent calls it mid-conversation via the /mcp endpoint).
/// Add a capability = implement this + register in DI; it appears on both surfaces
/// unless it opts out via <see cref="Surfaces"/>.
/// </summary>
public interface IGatherlightTool
{
    string Name { get; }
    string Description { get; }
    /// <summary>JSON Schema for the arguments (MCP inputSchema) — build via <see cref="ToolSchema"/>.</summary>
    string InputSchema { get; }
    /// <summary>Where the tool is exposed; null/empty = both surfaces.</summary>
    IReadOnlyList<string>? Surfaces => null;
    /// <summary>Run and return the result text (JSON for structured results).</summary>
    Task<string> RunAsync(JsonElement args, CancellationToken ct);
}

/// <summary>Marks a tool that MUTATES the household's files, so it is pre-approved only on WRITE (execute)
/// runs — <see cref="Services.IToolRegistry.McpAllowedToolNames"/> drops it from a read-only plan run's
/// allow-list, keeping a real CLI from offering it there. The load-bearing gate is the tool's own
/// <c>IAgentRunScope</c> check (a fake CLI does not honour the allow-list); this marker is the second layer.</summary>
public interface IWriteScopedTool { }

/// <summary>Error carrying an HTTP status the route maps straight through.</summary>
public sealed class ToolException : Exception
{
    public int Status { get; }
    public ToolException(int status, string message) : base(message) => Status = status;
}
