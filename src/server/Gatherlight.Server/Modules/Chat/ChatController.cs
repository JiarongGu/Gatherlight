using System.Text.Json;
using Gatherlight.Server.Modules.Chat.Services;
using Gatherlight.Server.Modules.Files.Services;
using Gatherlight.Server.Modules.Llm.Models;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Chat;

public sealed record StartChatRequest(string? Message, List<string>? Attachments, string? Mode);
public sealed record RefineRequest(string? Message);

[ApiController]
public sealed class ChatController : ControllerBase
{
    private readonly ChatSessionService _chat;
    private readonly IUploadService _uploads;

    public ChatController(ChatSessionService chat, IUploadService uploads)
    {
        _chat = chat;
        _uploads = uploads;
    }

    /// <summary>Gate 0 — start a task (agent plans read-only, then awaits approval).</summary>
    [HttpPost("api/chat")]
    public async Task<IActionResult> Start([FromBody] StartChatRequest req)
    {
        var message = req.Message?.Trim() ?? "";
        if (message.Length == 0) return BadRequest(new { error = "message is required" });

        // Validate each attachment ref is a real file inside uploads/ before it ever reaches
        // the agent (guards against path traversal in the ref).
        List<string> attachments;
        try
        {
            attachments = (req.Attachments ?? new()).Select(_uploads.ResolveAttachment).ToList();
        }
        catch (ArgumentException ex)
        {
            return BadRequest(new { error = ex.Message });
        }

        try
        {
            var mode = req.Mode == "system" ? "system" : "plan";
            var s = await _chat.StartChatAsync(message, attachments, mode);
            return Ok(new { id = s.Id, phase = s.Phase });
        }
        catch (InvalidOperationException ex) when (ex.Message == "BUSY")
        {
            return Conflict(new { error = "已有一个任务在进行中,请等它完成或撤销后再试。" });
        }
    }

    /// <summary>Snapshot of current state (used on (re)load to rehydrate the UI).</summary>
    [HttpGet("api/chat/{id}")]
    public IActionResult Snapshot(string id)
    {
        var s = _chat.Get(id);
        if (s is null) return NotFound(new { error = "session not found" });
        return Ok(new
        {
            id = s.Id,
            phase = s.Phase,
            mode = s.Mode,
            userMessage = s.UserMessage,
            plan = s.PlanText.Length > 0 ? s.PlanText : null,
            review = s.Review,
            commitSha = s.CommitSha,
            error = s.Error,
        });
    }

    /// <summary>Live event stream (SSE) with full replay of buffered events.</summary>
    [HttpGet("api/chat/{id}/stream")]
    public async Task Stream(string id, CancellationToken ct)
    {
        if (_chat.Get(id) is null)
        {
            Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        Response.Headers.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache, no-transform";
        Response.Headers["X-Accel-Buffering"] = "no";
        await Response.WriteAsync("retry: 3000\n\n", ct);
        await Response.Body.FlushAsync(ct);

        var (replay, live, unsubscribe) = _chat.Subscribe(id);
        using var _ = unsubscribe;
        try
        {
            foreach (var ev in replay) await WriteEventAsync(ev, ct);

            // Heartbeat so proxies don't drop the idle connection.
            using var heartbeat = new PeriodicTimer(TimeSpan.FromSeconds(15));
            var heartbeatTask = Task.Run(async () =>
            {
                while (await heartbeat.WaitForNextTickAsync(ct))
                {
                    await Response.WriteAsync(": keep-alive\n\n", ct);
                    await Response.Body.FlushAsync(ct);
                }
            }, ct);

            await foreach (var ev in live.ReadAllAsync(ct))
                await WriteEventAsync(ev, ct);
        }
        catch (OperationCanceledException) { /* client disconnected */ }
    }

    private async Task WriteEventAsync(AgentEvent ev, CancellationToken ct)
    {
        await Response.WriteAsync($"data: {JsonSerializer.Serialize(ev, AgentEvent.WireJson)}\n\n", ct);
        await Response.Body.FlushAsync(ct);
    }

    // --- gate 1 (plan) -------------------------------------------------------------------

    [HttpPost("api/chat/{id}/plan/approve")]
    public IActionResult ApprovePlan(string id) =>
        FireAndAck(() => _ = _chat.ApprovePlanAsync(id), id, ChatPhase.AwaitingPlanApproval);

    [HttpPost("api/chat/{id}/plan/reject")]
    public IActionResult RejectPlan(string id)
    {
        try
        {
            _chat.RejectPlan(id);
            return Ok(new { ok = true });
        }
        catch (InvalidOperationException ex)
        {
            return PhaseError(ex);
        }
    }

    [HttpPost("api/chat/{id}/plan/refine")]
    public IActionResult RefinePlan(string id, [FromBody] RefineRequest req)
    {
        var feedback = req.Message?.Trim() ?? "";
        if (feedback.Length == 0) return BadRequest(new { error = "message is required" });
        return FireAndAck(() => _ = _chat.RefinePlanAsync(id, feedback), id, ChatPhase.AwaitingPlanApproval);
    }

    // --- gate 2 (diff) -------------------------------------------------------------------

    [HttpPost("api/chat/{id}/diff/approve")]
    public IActionResult ApproveDiff(string id) =>
        FireAndAck(() => _ = _chat.ApproveDiffAsync(id), id, ChatPhase.AwaitingDiffApproval);

    [HttpPost("api/chat/{id}/diff/reject")]
    public IActionResult RejectDiff(string id) =>
        FireAndAck(() => _ = _chat.RejectDiffAsync(id), id, ChatPhase.AwaitingDiffApproval);

    [HttpPost("api/chat/{id}/diff/refine")]
    public IActionResult RefineDiff(string id, [FromBody] RefineRequest req)
    {
        var feedback = req.Message?.Trim() ?? "";
        if (feedback.Length == 0) return BadRequest(new { error = "message is required" });
        return FireAndAck(() => _ = _chat.RefineDiffAsync(id, feedback), id, ChatPhase.AwaitingDiffApproval);
    }

    /// <summary>Force-stop — valid from any non-terminal phase.</summary>
    [HttpPost("api/chat/{id}/cancel")]
    public async Task<IActionResult> Cancel(string id)
    {
        try
        {
            await _chat.CancelAsync(id);
            return Ok(new { ok = true });
        }
        catch (InvalidOperationException ex) when (ex.Message == "NOT_FOUND")
        {
            return NotFound(new { error = "session not found" });
        }
    }

    /// <summary>Ack immediately and run the gate action async — progress streams via SSE.
    /// The phase is validated up-front so a wrong-phase call still gets its 409.</summary>
    private IActionResult FireAndAck(Action start, string id, string expectedPhase)
    {
        var s = _chat.Get(id);
        if (s is null) return NotFound(new { error = "session not found" });
        if (s.Phase != expectedPhase)
            return Conflict(new { error = $"当前状态({s.Phase})不允许该操作。" });
        start();
        return Ok(new { ok = true });
    }

    private IActionResult PhaseError(InvalidOperationException ex)
    {
        var m = ex.Message;
        if (m == "NOT_FOUND") return NotFound(new { error = "session not found" });
        if (m.StartsWith("BAD_PHASE:"))
            return Conflict(new { error = $"当前状态({m[10..]})不允许该操作。" });
        return Conflict(new { error = m });
    }
}
