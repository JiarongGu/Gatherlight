using System.Text.Json;
using Gatherlight.Server.Modules.Jobs.Models;
using Gatherlight.Server.Modules.Jobs.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Jobs;

/// <summary>Browser/in-app notification feed: list + mark-read + a live SSE stream (mirrors
/// ChatController's SSE). The client fetches the backlog via GET, then opens the stream for new ones.</summary>
[ApiController]
public sealed class NotificationsController : ControllerBase
{
    private static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web);

    private readonly INotificationService _notifications;

    public NotificationsController(INotificationService notifications) => _notifications = notifications;

    [HttpGet("api/notifications")]
    public async Task<IActionResult> List([FromQuery] int limit = 50, [FromQuery] bool unread = false)
    {
        var items = await _notifications.ListAsync(limit, unread);
        var unreadCount = await _notifications.UnreadCountAsync();
        return Ok(new { items, unreadCount });
    }

    [HttpPost("api/notifications/{id}/read")]
    public async Task<IActionResult> MarkRead(string id)
    {
        await _notifications.MarkReadAsync(id);
        return Ok(new { ok = true });
    }

    [HttpPost("api/notifications/read-all")]
    public async Task<IActionResult> MarkAllRead()
    {
        await _notifications.MarkAllReadAsync();
        return Ok(new { ok = true });
    }

    /// <summary>Live SSE stream of NEW notifications (the client loads the backlog via GET first).</summary>
    [HttpGet("api/notifications/stream")]
    public async Task Stream(CancellationToken ct)
    {
        Response.Headers.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache, no-transform";
        Response.Headers["X-Accel-Buffering"] = "no";
        await Response.WriteAsync("retry: 3000\n\n", ct);
        await Response.Body.FlushAsync(ct);

        var (live, unsubscribe) = _notifications.Subscribe();
        using var _ = unsubscribe;

        // Response.Body forbids concurrent writes — serialize the heartbeat + event loop.
        using var writeGate = new SemaphoreSlim(1, 1);
        async Task Write(string payload)
        {
            await writeGate.WaitAsync(ct);
            try { await Response.WriteAsync(payload, ct); await Response.Body.FlushAsync(ct); }
            finally { writeGate.Release(); }
        }

        using var hbCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        try
        {
            using var heartbeat = new PeriodicTimer(TimeSpan.FromSeconds(15));
            var heartbeatTask = Task.Run(async () =>
            {
                try { while (await heartbeat.WaitForNextTickAsync(hbCts.Token)) await Write(": keep-alive\n\n"); }
                catch (OperationCanceledException) { /* stream ending */ }
            }, hbCts.Token);

            try
            {
                await foreach (var n in live.ReadAllAsync(ct))
                    await Write($"data: {JsonSerializer.Serialize(n, Wire)}\n\n");
            }
            finally
            {
                hbCts.Cancel();
                try { await heartbeatTask; } catch { /* observed; ended with the stream */ }
            }
        }
        catch (OperationCanceledException) { /* client disconnected */ }
    }
}
