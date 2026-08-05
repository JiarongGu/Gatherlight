using Gatherlight.Server.Platform.Hosting.Security.Services;
using Lyntai.Agents;
// Lyntai has an IToolRegistry of its own (the judges' in-process tool host); this file means the
// app's tool registry — the one that owns the MCP server NAME the allow-list is built from.
using IToolRegistry = Gatherlight.Server.Platform.Capabilities.Tools.Services.IToolRegistry;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>
/// How every spawned agent reaches this server's tool registry: the loopback channel
/// (<see cref="IInternalMcpEndpoint"/>), not the public listener — so the tools work whatever TLS,
/// access token or bind address the household configured for remote humans. Built per run from the
/// live port: no generated file, nothing on disk to go stale.
///
/// <para>One helper rather than the same three lines in each of the three run sites (chat, background
/// jobs, the eval playground) because the NAME is load-bearing and shared with something else:
/// <see cref="IToolRegistry.McpAllowedToolNames"/> builds <c>mcp__&lt;name&gt;__&lt;tool&gt;</c> from
/// <see cref="IToolRegistry.McpServerName"/>, so a server published under any other name would leave
/// every tool un-approved — silently, which is the exact failure mode this channel exists to end.
/// Taking the name from the registry itself makes the two impossible to drift apart.</para>
///
/// <para>Naming a server does NOT pre-approve its tools; <c>AllowedTools</c> still does that job at
/// each call site.</para>
/// </summary>
public static class AgentMcpWiring
{
    /// <summary>The app's own MCP servers for one agent run — empty before the channel has bound
    /// (the log line in <c>GatherlightApp</c>'s startup hook says so loudly when that happens).</summary>
    public static IReadOnlyList<AgentMcpServer> ServersFor(IInternalMcpEndpoint channel, IToolRegistry tools) =>
        channel.Port == 0
            ? []
            : [AgentMcpServer.Http(tools.McpServerName, channel.Url, channel.Token)];
}
