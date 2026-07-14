using Gatherlight.Server.Modules.Backup.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Backup;

/// <summary>
/// Whole-install backup / restore. <c>GET /api/backup/export</c> streams a .zip of the family's
/// records (plans + household + .claude + CLAUDE.md + uploads) AND the DB memory (memory.json);
/// <c>POST /api/backup/import</c> restores one (replaces those subtrees, imports the memory,
/// reindexes, commits). Unlike /api/memory (DB only), this is the complete, portable snapshot.
/// </summary>
[ApiController]
public sealed class BackupController : ControllerBase
{
    private readonly IBackupService _backup;
    public BackupController(IBackupService backup) => _backup = backup;

    [HttpGet("api/backup/export")]
    public async Task Export(CancellationToken ct)
    {
        var name = $"gatherlight-backup-{DateTime.Now:yyyyMMdd-HHmmss}.zip";
        Response.ContentType = "application/zip";
        Response.Headers.ContentDisposition = $"attachment; filename=\"{name}\"";
        await _backup.ExportAsync(Response.Body, ct);
    }

    // The .zip arrives as the raw request body (works for both the host bridge and a browser fetch).
    [HttpPost("api/backup/import")]
    [DisableRequestSizeLimit]
    public async Task<IActionResult> Import(CancellationToken ct)
    {
        try
        {
            var r = await _backup.ImportAsync(Request.Body, ct);
            return Ok(new { ok = true, restored = r });
        }
        catch (Exception ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }
}
