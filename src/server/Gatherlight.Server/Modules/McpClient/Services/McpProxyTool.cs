using System.Text.Json;
using Gatherlight.Server.Modules.McpClient.Models;
using Gatherlight.Server.Modules.Tools.Models;
using Gatherlight.Server.Modules.Tools.Services;

namespace Gatherlight.Server.Modules.McpClient.Services;

/// <summary>
/// A third dynamic source of <see cref="IGatherlightTool"/> for the <see cref="ToolRegistry"/>
/// (alongside built-ins + hot-loaded script tools): the tools discovered on connected external MCP
/// servers, proxied through <see cref="IMcpConnectionManager"/>. Resolved at call time so a
/// newly-connected server's tools appear without a restart.
/// </summary>
public interface IExternalToolProvider
{
    IReadOnlyList<IGatherlightTool> Current { get; }
}

public sealed class McpProxyToolProvider : IExternalToolProvider
{
    private readonly IMcpConnectionManager _mgr;
    public McpProxyToolProvider(IMcpConnectionManager mgr) => _mgr = mgr;

    public IReadOnlyList<IGatherlightTool> Current =>
        _mgr.Tools.Select(t => (IGatherlightTool)new McpProxyTool(_mgr, t.ServerId, t.Tool)).ToList();
}

/// <summary>One proxied external tool. Name is namespaced <c>{serverId}__{tool}</c> so multiple
/// servers can't collide and the origin stays legible in <c>mcp__planner-tools__{serverId}__{tool}</c>.</summary>
public sealed class McpProxyTool : IGatherlightTool
{
    private readonly IMcpConnectionManager _mgr;
    private readonly string _serverId;
    private readonly string _toolName;

    public McpProxyTool(IMcpConnectionManager mgr, string serverId, McpToolInfo info)
    {
        _mgr = mgr;
        _serverId = serverId;
        _toolName = info.Name;
        Name = Sanitize($"{serverId}__{info.Name}");
        Description = info.Description;
        InputSchema = info.InputSchema.GetRawText();
    }

    public string Name { get; }
    public string Description { get; }
    public string InputSchema { get; }

    public Task<string> RunAsync(JsonElement args, CancellationToken ct) =>
        _mgr.CallAsync(_serverId, _toolName, args, ct);

    /// <summary>MCP tool names must be <c>[A-Za-z0-9_-]</c>; fold anything else to '_'.</summary>
    private static string Sanitize(string s) =>
        string.Concat(s.Select(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' ? c : '_'));
}
