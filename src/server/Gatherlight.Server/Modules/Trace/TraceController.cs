using Gatherlight.Server.Modules.Trace.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Trace;

/// <summary>Run trace for one conversation — the phase timeline + tool calls + LLM runs + totals the
/// console renders when you inspect a conversation.</summary>
[ApiController]
public sealed class TraceController : ControllerBase
{
    private readonly ITraceService _trace;
    public TraceController(ITraceService trace) => _trace = trace;

    [HttpGet("api/manage/trace/{id}")]
    public async Task<IActionResult> Get(string id)
    {
        var t = await _trace.BuildAsync(id);
        return t is null ? NotFound(new { error = "not found" }) : Ok(t);
    }
}
