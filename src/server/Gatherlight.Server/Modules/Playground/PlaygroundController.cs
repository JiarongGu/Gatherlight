using Gatherlight.Server.Modules.Playground.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Playground;

/// <summary>
/// The eval-harness endpoint the <c>dev.mjs eval</c> CLI drives: run a set of scenarios through a dry
/// plan and return each output's quality scores + the aggregate. Behind the access gate; long-running
/// (spawns claude per scenario) so callers should use a generous timeout.
/// </summary>
[ApiController]
public sealed class PlaygroundController : ControllerBase
{
    private readonly IPlaygroundService _playground;
    public PlaygroundController(IPlaygroundService playground) => _playground = playground;

    public sealed record EvalRequest(List<EvalScenario>? Scenarios, string? Model);

    [HttpPost("api/manage/eval/run")]
    public async Task<IActionResult> Run([FromBody] EvalRequest req, CancellationToken ct)
    {
        if (req?.Scenarios is not { Count: > 0 } scenarios)
            return BadRequest(new { error = "scenarios required" });
        var run = await _playground.RunAsync(scenarios, string.IsNullOrWhiteSpace(req.Model) ? null : req.Model, ct);
        return Ok(run);
    }
}
