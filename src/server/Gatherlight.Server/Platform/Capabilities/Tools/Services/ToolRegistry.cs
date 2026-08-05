using System.Text.Json;
using Gatherlight.Server.Platform.Capabilities.McpClient.Services;
using Gatherlight.Server.Platform.Capabilities.Models;
using Gatherlight.Server.Platform.Capabilities.Services;
using Gatherlight.Server.Platform.Capabilities.Tools.Models;

namespace Gatherlight.Server.Platform.Capabilities.Tools.Services;

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

    private readonly Dictionary<string, IGatherlightTool> _builtins;
    private readonly IScriptToolProvider _scripts;
    private readonly IExternalToolProvider _external;
    private readonly ICapabilityRegistry _capabilities;

    public ToolRegistry(IEnumerable<IGatherlightTool> tools, IScriptToolProvider scripts,
        IExternalToolProvider external, ICapabilityRegistry capabilities)
    {
        _builtins = tools.ToDictionary(t => t.Name);
        _scripts = scripts;
        _external = external;
        _capabilities = capabilities;
    }

    public string McpServerName => "planner-tools";

    private static IReadOnlyList<string> SurfacesOf(IGatherlightTool t) =>
        t.Surfaces is { Count: > 0 } s ? s : AllSurfaces;

    /// <summary>Every tool object that exists, regardless of whether the capability registry would
    /// let it be called — used only to tell "unknown name" apart from "known but withheld" when a
    /// call is refused.</summary>
    private Dictionary<string, IGatherlightTool> ResolveAll()
    {
        var all = new Dictionary<string, IGatherlightTool>(_builtins);
        foreach (var t in _scripts.Current)
            all.TryAdd(t.Name, t);
        foreach (var t in _external.Current)
            all.TryAdd(t.Name, t);
        return all;
    }

    /// <summary>Effective tool set, resolved at call time so hot-loaded script tools and
    /// newly-connected external MCP tools appear immediately. Built-ins win on a name collision,
    /// then script tools, then external MCP tools — then filtered to what
    /// <see cref="ICapabilityRegistry"/> says is <c>Available</c>, so a denied or not-yet-enabled
    /// capability is absent here exactly as it is absent from the console's own listing.</summary>
    private Dictionary<string, IGatherlightTool> Resolve()
    {
        var all = ResolveAll();
        var available = _capabilities.Available()
            .Select(c => c.Id)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        return all.Where(kv => available.Contains(kv.Key))
            .ToDictionary(kv => kv.Key, kv => kv.Value);
    }

    public List<ToolDefinition> List(string? surface = null) =>
        Resolve().Values
            .Where(t => surface is null || SurfacesOf(t).Contains(surface))
            .Select(t => new ToolDefinition(t.Name, t.Description, JsonDocument.Parse(t.InputSchema).RootElement))
            .ToList();

    public string[] McpAllowedToolNames() =>
        Resolve().Values
            .Where(t => SurfacesOf(t).Contains("mcp"))
            .Select(t => $"mcp__{McpServerName}__{t.Name}")
            .ToArray();

    public async Task<string> RunAsync(string name, JsonElement args, string? surface, CancellationToken ct)
    {
        var tools = Resolve();
        if (!tools.TryGetValue(name, out var tool))
        {
            // A capability that exists but is withheld by provenance/policy gets a refusal naming
            // the reason, not a bare "unknown tool" — the console shows the same reason.
            if (ResolveAll().ContainsKey(name))
            {
                var info = _capabilities.All()
                    .FirstOrDefault(c => string.Equals(c.Id, name, StringComparison.OrdinalIgnoreCase));
                var reason = info?.State switch
                {
                    CapabilityState.Denied => "已被禁用(site.json capabilities.deny)",
                    CapabilityState.NotEnabled => "尚未在 site.json 的 capabilities.enabled 中启用",
                    _ => "不可用",
                };
                throw new ToolException(403, $"工具 \"{name}\" {reason}。");
            }
            var known = tools.Count > 0 ? string.Join(", ", tools.Keys) : "(无)";
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
