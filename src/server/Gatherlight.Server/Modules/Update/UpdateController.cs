using Gatherlight.Server.Modules.Update.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Update;

/// <summary>
/// The management console's self-update surface: check the configured release, download + stage an
/// update in the background, and poll its state. Applying the staged files happens on the next
/// restart via the native launcher (the console's restart-for-update action) — a running exe can't
/// replace itself, so there is no "apply now" endpoint here.
/// </summary>
[ApiController]
public sealed class UpdateController : ControllerBase
{
    private readonly IUpdateService _update;
    public UpdateController(IUpdateService update) => _update = update;

    [HttpGet("api/manage/update/check")]
    public async Task<IActionResult> Check() => Ok(await _update.CheckAsync());

    [HttpGet("api/manage/update/state")]
    public IActionResult State() => Ok(_update.GetState());

    [HttpPost("api/manage/update/download")]
    public IActionResult Download()
    {
        var state = _update.GetState();
        if (!state.Configured) return BadRequest(new { error = "updates are not configured" });
        if (state.Downloading) return Ok(new { ok = true, alreadyRunning = true });
        _update.StartDownload();
        return Ok(new { ok = true });
    }
}
