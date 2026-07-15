using System.Collections.Concurrent;
using System.Threading.Channels;
using Dapper;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Jobs.Models;

namespace Gatherlight.Server.Modules.Jobs.Services;

/// <summary>
/// The browser/in-app notification feed. Every notification is persisted to the <c>notification</c>
/// table (so a client that wasn't connected sees it unread on next open) AND fanned out to any live
/// SSE subscribers (so an open client shows it immediately via the browser Notification API).
/// Jobs, the scheduler, and the <c>notify_user</c> tool all create through here.
/// </summary>
public interface INotificationService
{
    Task<Notification> CreateAsync(string kind, string title, string? body = null, string? link = null, string? sourceJobId = null);
    Task<List<Notification>> ListAsync(int limit = 50, bool unreadOnly = false);
    Task<int> UnreadCountAsync();
    Task MarkReadAsync(string id);
    Task MarkAllReadAsync();
    /// <summary>Subscribe to live notifications (new ones only — fetch the backlog via ListAsync).
    /// Dispose to detach.</summary>
    (ChannelReader<Notification> Live, IDisposable Unsubscribe) Subscribe();
}

public sealed class NotificationService : INotificationService
{
    private const string Cols = "id, created_at, kind, title, body, link, read, source_job_id";

    private readonly IDbConnectionFactory _db;
    private readonly ConcurrentDictionary<Channel<Notification>, byte> _subs = new();

    public NotificationService(IDbConnectionFactory db) => _db = db;

    public async Task<Notification> CreateAsync(string kind, string title, string? body = null, string? link = null, string? sourceJobId = null)
    {
        var n = new Notification
        {
            Id = "n" + Guid.NewGuid().ToString("n")[..16],
            CreatedAt = DateTime.UtcNow.ToString("o"),
            Kind = NotificationKind_OrInfo(kind),
            Title = title,
            Body = body,
            Link = link,
            Read = false,
            SourceJobId = sourceJobId,
        };
        using (var conn = _db.Open())
        {
            await conn.ExecuteAsync(
                $"INSERT INTO notification({Cols}) VALUES (@Id, @CreatedAt, @Kind, @Title, @Body, @Link, @Read, @SourceJobId)",
                n);
        }
        // Fan out to live clients (persist first, so a missed push is still recoverable via the list).
        foreach (var ch in _subs.Keys) ch.Writer.TryWrite(n);
        return n;
    }

    public async Task<List<Notification>> ListAsync(int limit = 50, bool unreadOnly = false)
    {
        using var conn = _db.Open();
        var where = unreadOnly ? "WHERE read = 0" : "";
        return (await conn.QueryAsync<Notification>(
            $"SELECT {Cols} FROM notification {where} ORDER BY created_at DESC LIMIT @limit",
            new { limit = Math.Clamp(limit, 1, 200) })).ToList();
    }

    public async Task<int> UnreadCountAsync()
    {
        using var conn = _db.Open();
        return await conn.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM notification WHERE read = 0");
    }

    public async Task MarkReadAsync(string id)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync("UPDATE notification SET read = 1 WHERE id = @id", new { id });
    }

    public async Task MarkAllReadAsync()
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync("UPDATE notification SET read = 1 WHERE read = 0");
    }

    public (ChannelReader<Notification> Live, IDisposable Unsubscribe) Subscribe()
    {
        var ch = Channel.CreateUnbounded<Notification>();
        _subs.TryAdd(ch, 0);
        return (ch.Reader, new Unsubscriber(() => { _subs.TryRemove(ch, out _); ch.Writer.TryComplete(); }));
    }

    private static string NotificationKind_OrInfo(string kind) => string.IsNullOrWhiteSpace(kind) ? NotificationKind.Info : kind;

    private sealed class Unsubscriber(Action dispose) : IDisposable
    {
        public void Dispose() => dispose();
    }
}
