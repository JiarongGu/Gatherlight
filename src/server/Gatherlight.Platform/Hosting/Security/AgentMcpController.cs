using Gatherlight.Server.Platform.Hosting.Security.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Platform.Hosting.Security;

/// <summary>
/// Diagnosis for the agent's MCP channel — see <see cref="IInternalMcpEndpoint"/>.
/// </summary>
[ApiController]
public sealed class AgentMcpController : ControllerBase
{
    private readonly IInternalMcpEndpoint _internalMcp;
    public AgentMcpController(IInternalMcpEndpoint internalMcp) => _internalMcp = internalMcp;

    /// <summary>The agent's MCP channel, for diagnosis: this is exactly what the spawned CLI is
    /// handed. "The agent says the tool is missing" is otherwise unanswerable from outside the
    /// process, because the port and token are deliberately in memory only. The token is regenerated
    /// every start and the endpoint is loopback-only, so surfacing it on the already-gated management
    /// surface tells an operator what they need without widening anything.</summary>
    [HttpGet("api/manage/agent-mcp")]
    public IActionResult AgentMcp() =>
        Ok(new { port = _internalMcp.Port, url = _internalMcp.Url, token = _internalMcp.Token });
}
