using Gatherlight.Server.Modules.Seed.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Seed;

/// <summary>Console surface for the knowledge-base upgrade migration: see available upgrades + any
/// staged review, run the (opt-in) LLM merge, and approve/reject the staged diff.</summary>
[ApiController]
public sealed class ZhikuMigrationController : ControllerBase
{
    private readonly IZhikuMigrator _migrator;
    public ZhikuMigrationController(IZhikuMigrator migrator) => _migrator = migrator;

    [HttpGet("api/manage/kb-upgrades")]
    public async Task<IActionResult> Status() => Ok(await _migrator.GetStatusAsync());

    [HttpPost("api/manage/kb-upgrades/run")]
    public async Task<IActionResult> Run(CancellationToken ct)
    {
        var r = await _migrator.RunMigrationAsync(ct);
        return r.Error is not null && !r.Staged ? BadRequest(new { error = r.Error, r.Merged, r.Failed }) : Ok(r);
    }

    [HttpPost("api/manage/kb-upgrades/approve")]
    public async Task<IActionResult> Approve(CancellationToken ct)
    {
        var (ok, error, sha) = await _migrator.ApproveAsync(ct);
        return ok ? Ok(new { ok = true, sha }) : BadRequest(new { error });
    }

    [HttpPost("api/manage/kb-upgrades/reject")]
    public async Task<IActionResult> Reject() =>
        await _migrator.RejectAsync() ? Ok(new { ok = true }) : BadRequest(new { error = "没有待审阅的升级" });
}
