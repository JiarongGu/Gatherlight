using System.Text.Json;

namespace Gatherlight.Server.Modules.Tools.Models;

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

/// <summary>Error carrying an HTTP status the route maps straight through.</summary>
public sealed class ToolException : Exception
{
    public int Status { get; }
    public ToolException(int status, string message) : base(message) => Status = status;
}
