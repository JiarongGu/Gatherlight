using Gatherlight.Server.Modules.Cortex.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Cortex;

/// <summary>
/// Cortex tuning surface for the management console: read the prompt-template registry + model
/// routing, override any of them, and reset back to the shipped default. Every knob lives in
/// <c>app_config</c> and takes effect on the next LLM call — no restart. This is the "tune the
/// cortex" half of the LLM-ops loop (its read half is <c>/api/manage/*</c> eval observability).
/// </summary>
[ApiController]
public sealed class CortexController : ControllerBase
{
    private readonly ICortexConfigService _cortex;
    public CortexController(ICortexConfigService cortex) => _cortex = cortex;

    [HttpGet("api/manage/cortex")]
    public IActionResult Get() => Ok(new { prompts = _cortex.Prompts(), models = _cortex.Models() });

    public sealed record PromptBody(string? Value);

    [HttpPut("api/manage/cortex/prompt/{name}")]
    public IActionResult SetPrompt(string name, [FromBody] PromptBody body)
    {
        if (string.IsNullOrWhiteSpace(body?.Value)) return BadRequest(new { error = "value required" });
        var r = _cortex.SetPrompt(name, body.Value);
        if (!r.Found) return NotFound(new { error = "unknown prompt" });
        if (r.MissingPlaceholders.Count > 0)
            return BadRequest(new { error = "missing placeholders", missing = r.MissingPlaceholders });
        return Ok(new { ok = true });
    }

    [HttpDelete("api/manage/cortex/prompt/{name}")]
    public IActionResult ResetPrompt(string name)
        => _cortex.ResetPrompt(name) ? Ok(new { ok = true }) : NotFound(new { error = "unknown prompt" });

    public sealed record ModelBody(string? Value);

    [HttpPut("api/manage/cortex/model/{consumer}")]
    public IActionResult SetModel(string consumer, [FromBody] ModelBody body)
        => _cortex.SetModel(consumer, body?.Value) ? Ok(new { ok = true }) : NotFound(new { error = "unknown consumer" });

    [HttpDelete("api/manage/cortex/model/{consumer}")]
    public IActionResult ResetModel(string consumer)
        => _cortex.ResetModel(consumer) ? Ok(new { ok = true }) : NotFound(new { error = "unknown consumer" });
}
