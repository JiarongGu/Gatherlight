using System.Text.Json;
using Gatherlight.Server.Modules.Chat.Services;
using Gatherlight.Server.Modules.Files.Services;
using Gatherlight.Server.Modules.Llm.Models;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Chat;

public sealed record StartChatRequest(string? Message, List<string>? Attachments, string? Mode);
public sealed record RefineRequest(string? Message);
public sealed record McpApproveRequest(Dictionary<string, string>? Secrets);

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

    /// <summary>The current live session (holding the agent lease), or none. The client hits this on
    /// mount / on a BUSY reply to re-attach to a session it lost track of (blip, reload, other browser) —
    /// e.g. one parked at awaiting-input — so it can reply or cancel instead of being wedged.</summary>
    [HttpGet("api/chat/active")]
    public IActionResult Active()
    {
        var s = _chat.ActiveSession();
        return Ok(s is null ? new { active = false, id = (string?)null, phase = (string?)null }
                            : new { active = true, id = (string?)s.Id, phase = (string?)s.Phase });
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
            mcpProposal = s.McpProposal is null ? null : ChatSessionService.McpProposalView(s.McpProposal),
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

        // Resume: skip anything the client already received before a reconnect (browser EventSource
        // sends the last id it saw). -1 = a fresh connection wants the full replay.
        var lastSeen = int.TryParse(Request.Headers["Last-Event-ID"].ToString(), out var le) ? le : -1;

        var (replay, live, unsubscribe) = _chat.Subscribe(id);
        using var _ = unsubscribe;

        // Serialize ALL writes to Response.Body — the heartbeat task and the event loop run
        // concurrently, and Response.Body forbids concurrent writes (would throw / corrupt SSE framing).
        using var writeGate = new SemaphoreSlim(1, 1);
        async Task Write(string payload)
        {
            await writeGate.WaitAsync(ct);
            try { await Response.WriteAsync(payload, ct); await Response.Body.FlushAsync(ct); }
            finally { writeGate.Release(); }
        }
        // Each frame carries its seq as the SSE id so a reconnect can resume past it.
        static string Frame(int seq, AgentEvent ev) => $"id: {seq}\ndata: {JsonSerializer.Serialize(ev, AgentEvent.WireJson)}\n\n";

        // Stop the heartbeat when the event loop ends, so it can't touch writeGate/Response after scope exit.
        using var hbCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        try
        {
            for (var i = 0; i < replay.Count; i++)
                if (i > lastSeen) await Write(Frame(i, replay[i]));

            // Heartbeat so proxies don't drop the idle connection.
            using var heartbeat = new PeriodicTimer(TimeSpan.FromSeconds(15));
            var heartbeatTask = Task.Run(async () =>
            {
                try { while (await heartbeat.WaitForNextTickAsync(hbCts.Token)) await Write(": keep-alive\n\n"); }
                catch (OperationCanceledException) { /* stream ending */ }
            }, hbCts.Token);

            try
            {
                await foreach (var (seq, ev) in live.ReadAllAsync(ct))
                    if (seq > lastSeen) await Write(Frame(seq, ev));
            }
            finally
            {
                hbCts.Cancel();
                try { await heartbeatTask; } catch { /* observed; ended with the stream */ }
            }
        }
        catch (OperationCanceledException) { /* client disconnected */ }
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

    // --- pause: agent asked for input ---------------------------------------------------

    /// <summary>Reply to an agent that paused for a decision (awaiting-input). The agent resumes
    /// the same session with your answer and keeps going — partial edits so far are kept.</summary>
    [HttpPost("api/chat/{id}/input")]
    public IActionResult RespondInput(string id, [FromBody] RefineRequest req)
    {
        var message = req.Message?.Trim() ?? "";
        if (message.Length == 0) return BadRequest(new { error = "message is required" });
        return FireAndAck(() => _ = _chat.RespondInputAsync(id, message), id, ChatPhase.AwaitingInput);
    }

    // --- gate: approve/reject adding an external MCP server (awaiting-mcp-approval) ------

    /// <summary>Approve the agent's MCP-server proposal. Optional <c>secrets</c> are the credential
    /// values the human entered at the gate (keyed by the proposal's <c>neededCredentials</c>); they
    /// go straight to the provision service and are never echoed back.</summary>
    [HttpPost("api/chat/{id}/mcp/approve")]
    public IActionResult ApproveMcp(string id, [FromBody] McpApproveRequest? req) =>
        FireAndAck(() => _ = _chat.ApproveMcpAsync(id, req?.Secrets), id, ChatPhase.AwaitingMcpApproval);

    [HttpPost("api/chat/{id}/mcp/reject")]
    public IActionResult RejectMcp(string id) =>
        FireAndAck(() => _ = _chat.RejectMcpAsync(id), id, ChatPhase.AwaitingMcpApproval);

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
