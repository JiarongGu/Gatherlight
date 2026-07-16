using Gatherlight.Server.Modules.Chat.Services;
using Gatherlight.Server.Modules.Seed.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Seed;

/// <summary>Console surface for the knowledge-base upgrade migration: see available upgrades + any
/// staged review, run the (opt-in) LLM merge, and approve/reject the staged diff.</summary>
[ApiController]
public sealed class ZhikuMigrationController : ControllerBase
{
    private readonly IZhikuMigrator _migrator;
    private readonly ChatSessionService _chat;
    public ZhikuMigrationController(IZhikuMigrator migrator, ChatSessionService chat)
    {
        _migrator = migrator;
        _chat = chat;
    }

    // The merge/apply write the data repo; refuse to interleave with an in-flight two-gate chat, whose
    // uncommitted staged edits a mechanical merge would otherwise clobber (mirrors FsController.BusyCheck).
    private IActionResult? BusyCheck() =>
        _chat.IsBusy() ? Conflict(new { error = "有 AI 任务进行中,请等它完成后再运行知识库迁移。" }) : null;

    [HttpGet("api/manage/kb-upgrades")]
    public async Task<IActionResult> Status() => Ok(await _migrator.GetStatusAsync());

    [HttpPost("api/manage/kb-upgrades/run")]
    public async Task<IActionResult> Run(CancellationToken ct)
    {
        if (BusyCheck() is { } busy) return busy;
        var r = await _migrator.RunMigrationAsync(ct);
        return r.Error is not null && !r.Staged ? BadRequest(new { error = r.Error, r.Merged, r.Failed }) : Ok(r);
    }

    [HttpPost("api/manage/kb-upgrades/approve")]
    public async Task<IActionResult> Approve(CancellationToken ct)
    {
        if (BusyCheck() is { } busy) return busy;
        var (ok, error, sha) = await _migrator.ApproveAsync(ct);
        return ok ? Ok(new { ok = true, sha }) : BadRequest(new { error });
    }

    [HttpPost("api/manage/kb-upgrades/reject")]
    public async Task<IActionResult> Reject() =>
        await _migrator.RejectAsync() ? Ok(new { ok = true }) : BadRequest(new { error = "没有待审阅的升级" });
}
