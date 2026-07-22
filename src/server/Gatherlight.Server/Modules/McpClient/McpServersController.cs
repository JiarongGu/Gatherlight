using Gatherlight.Server.Modules.McpClient.Models;
using Gatherlight.Server.Modules.McpClient.Services;
using Gatherlight.Server.Modules.McpClient.Services.Transport;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.McpClient;

public sealed record SetEnabledRequest(bool Enabled);

/// <summary>
/// Access-gated management of external MCP servers (<c>/api/manage/mcp-servers</c>). List/add/toggle/
/// remove. Secrets are accepted on add but NEVER returned — the DTO projection drops them. This
/// surface requires the access token (or loopback trust) — it is NOT on the agent's MCP surface, so
/// the scope-guarded agent can't self-register a server. In P2 the chat confirmation gate becomes a
/// second, human-confirmed entry that funnels into the same <see cref="IMcpProvisionService"/>.
/// </summary>
[ApiController]
[Route("api/manage/mcp-servers")]
public sealed class McpServersController : ControllerBase
{
    private readonly IMcpProvisionService _provision;
    private readonly IMcpLoginService _login;

    public McpServersController(IMcpProvisionService provision, IMcpLoginService login)
    {
        _provision = provision;
        _login = login;
    }

    [HttpGet]
    public async Task<IActionResult> List()
    {
        var servers = await _provision.ListAsync();
        return Ok(servers.Select(McpServerDto.From));
    }

    [HttpPost]
    public async Task<IActionResult> Add([FromBody] McpAddRequest req, CancellationToken ct)
    {
        try
        {
            var cfg = await _provision.AddAsync(req, ct);
            return Ok(McpServerDto.From(cfg));
        }
        catch (McpException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    [HttpPost("{id}/enabled")]
    public async Task<IActionResult> SetEnabled(string id, [FromBody] SetEnabledRequest req, CancellationToken ct)
    {
        var ok = await _provision.SetEnabledAsync(id, req.Enabled, ct);
        if (!ok) return NotFound(new { error = "server not found" });
        var cfg = await _provision.GetAsync(id);
        return Ok(cfg is null ? null : McpServerDto.From(cfg));
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Remove(string id, CancellationToken ct)
    {
        var ok = await _provision.RemoveAsync(id, ct);
        return ok ? Ok(new { ok = true }) : NotFound(new { error = "server not found" });
    }

    // --- generic interactive login (QR / browser) ---------------------------------------

    /// <summary>Start login on a server that declares a login tool — returns the QR image / URL / text
    /// to show the human. Generic: works for any server following the login-tool + check-tool shape.</summary>
    [HttpPost("{id}/login/start")]
    public async Task<IActionResult> LoginStart(string id, CancellationToken ct)
    {
        try { return Ok(await _login.StartAsync(id, ct)); }
        catch (McpException ex) { return BadRequest(new { error = ex.Message }); }
    }

    /// <summary>Poll whether the server is logged in yet (the client calls this on a timer after Start).</summary>
    [HttpGet("{id}/login/status")]
    public async Task<IActionResult> LoginStatus(string id, CancellationToken ct)
    {
        try { return Ok(await _login.StatusAsync(id, ct)); }
        catch (McpException ex) { return BadRequest(new { error = ex.Message }); }
    }
}
