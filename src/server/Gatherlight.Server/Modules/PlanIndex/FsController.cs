using Gatherlight.Server.Modules.PlanIndex.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.PlanIndex;

public sealed record DeleteRequest(List<string>? Paths, List<string>? Dirs, string? Subject);
public sealed record RetitleRequest(string Path, string Title, string? Subject);
public sealed record RenameRequest(List<RenamePair> Renames, string? Subject);
public sealed record RenamePair(string From, string To);

[ApiController]
[Route("api/fs")]
public sealed class FsController : ControllerBase
{
    private readonly IFsOpsService _fs;

    public FsController(IFsOpsService fs) => _fs = fs;

    [HttpPost("delete")]
    public async Task<IActionResult> Delete([FromBody] DeleteRequest req, CancellationToken ct)
    {
        try
        {
            var (sha, removed) = await _fs.DeleteEntriesAsync(
                req.Paths ?? new(), req.Dirs ?? new(), req.Subject ?? "delete files", ct);
            return Ok(new { sha, removed });
        }
        catch (ArgumentException ex) { return BadRequest(new { error = ex.Message }); }
    }

    [HttpPost("retitle")]
    public async Task<IActionResult> Retitle([FromBody] RetitleRequest req, CancellationToken ct)
    {
        try
        {
            var sha = await _fs.RetitleAsync(req.Path, req.Title, req.Subject ?? $"retitle {req.Path}", ct);
            return Ok(new { sha });
        }
        catch (ArgumentException ex) { return BadRequest(new { error = ex.Message }); }
        catch (FileNotFoundException) { return NotFound(); }
    }

    [HttpPost("rename")]
    public async Task<IActionResult> Rename([FromBody] RenameRequest req, CancellationToken ct)
    {
        try
        {
            var sha = await _fs.RenameEntriesAsync(
                req.Renames.Select(r => (r.From, r.To)).ToList(), req.Subject ?? "rename files", ct);
            return Ok(new { sha, renamed = req.Renames });
        }
        catch (ArgumentException ex) { return BadRequest(new { error = ex.Message }); }
    }
}
