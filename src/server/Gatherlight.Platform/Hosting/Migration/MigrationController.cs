using Gatherlight.Server.Platform.Hosting.Migration.Models;
using Gatherlight.Server.Platform.Hosting.Migration.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Platform.Hosting.Migration;

[ApiController]
[Route("api/migration")]
public sealed class MigrationController : ControllerBase
{
    private readonly MigrationState _state;
    private readonly StartupMigrationRunner _runner;
    private readonly IHostApplicationLifetime _life;
    public MigrationController(MigrationState state, StartupMigrationRunner runner, IHostApplicationLifetime life)
    { _state = state; _runner = runner; _life = life; }

    [HttpGet("status")]
    public IActionResult Status() => Ok(_state.Snapshot());

    [HttpPost("retry")]
    public IActionResult Retry()
    {
        if (_state.Snapshot().Phase != MigrationPhase.Failed)
            return Conflict(new { error = "没有失败的迁移可重试。" });
        _state.Reset();
        _ = Task.Run(async () =>
        {
            try { await _runner.RunAsync(_life.ApplicationStopping); }
            catch (Exception ex) { _state.Fail(ex.Message); }
        });
        return Ok(new { ok = true });
    }
}
