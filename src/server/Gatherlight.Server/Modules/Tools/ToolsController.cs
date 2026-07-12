using System.Text.Json;
using Gatherlight.Server.Modules.Tools.Models;
using Gatherlight.Server.Modules.Tools.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Tools;

public sealed record ToolCallRequest(string? Name, JsonElement? Arguments);

[ApiController]
public sealed class ToolsController : ControllerBase
{
    private static readonly JsonElement EmptyArgs = JsonDocument.Parse("{}").RootElement;

    private readonly IToolRegistry _registry;

    public ToolsController(IToolRegistry registry) => _registry = registry;

    /// <summary>tools/list — catalog (name + description + inputSchema) for discovery / UI.</summary>
    [HttpGet("api/tools")]
    public IActionResult List() => Ok(new { tools = _registry.List("http") });

    /// <summary>tools/call — invoke a tool by name with arguments (awaits the result).</summary>
    [HttpPost("api/tools/call")]
    public async Task<IActionResult> Call([FromBody] ToolCallRequest req, CancellationToken ct)
    {
        var name = req.Name?.Trim() ?? "";
        if (name.Length == 0) return BadRequest(new { error = "name is required" });
        try
        {
            var result = await _registry.RunAsync(name, req.Arguments ?? EmptyArgs, "http", ct);
            return Ok(new { ok = true, name, result });
        }
        catch (ToolException ex)
        {
            return StatusCode(ex.Status, new { error = ex.Message });
        }
    }
}
