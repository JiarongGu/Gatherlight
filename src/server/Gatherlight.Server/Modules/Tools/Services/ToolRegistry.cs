using System.Text.Json;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Tools.Services;

public sealed record ToolDefinition(string Name, string Description, JsonElement InputSchema);

/// <summary>
/// The single source of truth for callable capabilities. DI-discovered
/// (<c>IEnumerable&lt;IGatherlightTool&gt;</c>); shared validation/timeout/error semantics so a
/// tool behaves identically whether the frontend calls it over HTTP or the spawned agent over MCP.
/// </summary>
public interface IToolRegistry
{
    /// <summary>MCP server name — the CLI sees tools as <c>mcp__{name}__{tool}</c>.</summary>
    string McpServerName { get; }
    List<ToolDefinition> List(string? surface = null);
    /// <summary>Fully-qualified MCP tool names to pre-approve on chat runs (--allowedTools).</summary>
    string[] McpAllowedToolNames();
    Task<string> RunAsync(string name, JsonElement args, string? surface, CancellationToken ct);
}

public sealed class ToolRegistry : IToolRegistry
{
    private static readonly TimeSpan ToolTimeout = TimeSpan.FromSeconds(120);
    private static readonly string[] AllSurfaces = { "http", "mcp" };

    private readonly Dictionary<string, IGatherlightTool> _tools;

    public ToolRegistry(IEnumerable<IGatherlightTool> tools) =>
        _tools = tools.ToDictionary(t => t.Name);

    public string McpServerName => "planner-tools";

    private static IReadOnlyList<string> SurfacesOf(IGatherlightTool t) =>
        t.Surfaces is { Count: > 0 } s ? s : AllSurfaces;

    public List<ToolDefinition> List(string? surface = null) =>
        _tools.Values
            .Where(t => surface is null || SurfacesOf(t).Contains(surface))
            .Select(t => new ToolDefinition(t.Name, t.Description, JsonDocument.Parse(t.InputSchema).RootElement))
            .ToList();

    public string[] McpAllowedToolNames() =>
        _tools.Values
            .Where(t => SurfacesOf(t).Contains("mcp"))
            .Select(t => $"mcp__{McpServerName}__{t.Name}")
            .ToArray();

    public async Task<string> RunAsync(string name, JsonElement args, string? surface, CancellationToken ct)
    {
        if (!_tools.TryGetValue(name, out var tool))
        {
            var known = _tools.Count > 0 ? string.Join(", ", _tools.Keys) : "(无)";
            throw new ToolException(400, $"未知工具:\"{name}\"。可用:{known}");
        }
        if (surface is not null && !SurfacesOf(tool).Contains(surface))
            throw new ToolException(404, $"工具 \"{name}\" 未在 {surface} 接口暴露。");

        ValidateRequired(tool, args);

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(ToolTimeout);
        try
        {
            return await tool.RunAsync(args, timeout.Token);
        }
        catch (ToolException) { throw; }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new ToolException(504, "工具执行超时或被中断。");
        }
        catch (Exception ex)
        {
            throw new ToolException(500, $"工具执行失败:{ex.Message}");
        }
    }

    /// <summary>Minimal required-field check against the tool's inputSchema.</summary>
    private static void ValidateRequired(IGatherlightTool tool, JsonElement args)
    {
        using var schema = JsonDocument.Parse(tool.InputSchema);
        if (!schema.RootElement.TryGetProperty("required", out var required)) return;
        foreach (var key in required.EnumerateArray())
        {
            var k = key.GetString()!;
            var ok = args.ValueKind == JsonValueKind.Object
                && args.TryGetProperty(k, out var v)
                && v.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined)
                && (v.ValueKind != JsonValueKind.String || v.GetString()!.Length > 0);
            if (!ok) throw new ToolException(400, $"缺少必填参数:\"{k}\"。");
        }
    }
}
