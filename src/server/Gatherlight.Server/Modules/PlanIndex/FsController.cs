using Gatherlight.Server.Modules.Chat.Services;
using Gatherlight.Server.Modules.PlanIndex.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.PlanIndex;

public sealed record DeleteRequest(List<string>? Paths, List<string>? Dirs, string? Label);
public sealed record RetitleRequest(string Path, string Title);
public sealed record RenameRequest(List<RenamePair> Renames, string? Label);
public sealed record RenamePair(string From, string To);

[ApiController]
[Route("api/fs")]
public sealed class FsController : ControllerBase
{
    private readonly IFsOpsService _fs;
    private readonly ChatSessionService _chat;

    public FsController(IFsOpsService fs, ChatSessionService chat)
    {
        _fs = fs;
        _chat = chat;
    }

    /// <summary>Direct fs ops are rejected while an AI task runs — its edits and a mechanical
    /// rename interleaving would corrupt the review diff.</summary>
    private IActionResult? BusyCheck() =>
        _chat.IsBusy() ? Conflict(new { error = "有 AI 任务进行中,请等它完成后再操作。" }) : null;

    [HttpPost("delete")]
    public async Task<IActionResult> Delete([FromBody] DeleteRequest req, CancellationToken ct)
    {
        if (BusyCheck() is { } busy) return busy;
        try
        {
            var subject = $"删除:{req.Label ?? req.Paths?.FirstOrDefault() ?? req.Dirs?.FirstOrDefault() ?? ""}";
            var (sha, removed) = await _fs.DeleteEntriesAsync(req.Paths ?? new(), req.Dirs ?? new(), subject, ct);
            return Ok(new { ok = true, sha, removed });
        }
        catch (ArgumentException ex) { return BadRequest(new { error = ex.Message }); }
    }

    [HttpPost("retitle")]
    public async Task<IActionResult> Retitle([FromBody] RetitleRequest req, CancellationToken ct)
    {
        if (BusyCheck() is { } busy) return busy;
        try
        {
            var sha = await _fs.RetitleAsync(req.Path, req.Title, $"改标题:{req.Title}", ct);
            return Ok(new { ok = true, sha });
        }
        catch (ArgumentException ex) { return BadRequest(new { error = ex.Message }); }
        catch (FileNotFoundException) { return NotFound(); }
    }

    [HttpPost("rename")]
    public async Task<IActionResult> Rename([FromBody] RenameRequest req, CancellationToken ct)
    {
        if (BusyCheck() is { } busy) return busy;
        try
        {
            var sha = await _fs.RenameEntriesAsync(
                req.Renames.Select(r => (r.From, r.To)).ToList(), $"重命名:{req.Label ?? ""}", ct);
            return Ok(new { ok = true, sha, renamed = req.Renames });
        }
        catch (ArgumentException ex) { return BadRequest(new { error = ex.Message }); }
    }
}
