using Dapper;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.Chat.Services;

public sealed record ChatTurnRow(long Id, string Message, string Outcome, string CreatedAt);

/// <summary>
/// Persistence for chat state: session snapshots (restart inspection), the per-session event
/// log (SSE replay + history), and the durable thread-context turns.
/// </summary>
public interface IChatRepository
{
    // thread context is derived on demand from chat_turn (PrepareThreadContextAsync) and never persisted
    // on chat_session, so it's not a parameter here.
    Task UpsertSessionAsync(string id, string phase, string mode, string userMessage,
        string? attachmentsJson, string? planText, string? claudeSessionId, string? commitSha,
        string? error, string createdAt);
    Task AppendEventAsync(string sessionId, int seq, string kind, string payloadJson);
    Task<List<string>> EventPayloadsAsync(string sessionId);
    /// <summary>Sessions left non-terminal by a dead server → error (an in-flight run cannot
    /// survive a restart; the working tree may hold partial edits the user can inspect).</summary>
    Task<int> FailInterruptedSessionsAsync();

    Task<List<ChatTurnRow>> TurnsAsync();
    Task AddTurnAsync(string message, string outcome);
    Task ClearTurnsAsync();
}

public sealed class ChatRepository : IChatRepository
{
    private static readonly string[] TerminalPhases = { "committed", "rejected", "cancelled", "error" };

    private readonly IDbConnectionFactory _db;

    public ChatRepository(IDbConnectionFactory db) => _db = db;

    public async Task UpsertSessionAsync(string id, string phase, string mode, string userMessage,
        string? attachmentsJson, string? planText, string? claudeSessionId, string? commitSha,
        string? error, string createdAt)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            """
            INSERT INTO chat_session(id, phase, mode, user_message, attachments_json, plan_text,
                claude_session_id, commit_sha, error, created_at, updated_at)
            VALUES (@id, @phase, @mode, @userMessage, @attachmentsJson, @planText,
                @claudeSessionId, @commitSha, @error, @createdAt, @now)
            ON CONFLICT(id) DO UPDATE SET
                phase = excluded.phase,
                plan_text = excluded.plan_text,
                claude_session_id = excluded.claude_session_id,
                commit_sha = excluded.commit_sha,
                error = excluded.error,
                updated_at = excluded.updated_at
            """,
            new
            {
                id, phase, mode, userMessage, attachmentsJson, planText,
                claudeSessionId, commitSha, error, createdAt,
                now = DateTime.UtcNow.ToString("o"),
            });
    }

    public async Task AppendEventAsync(string sessionId, int seq, string kind, string payloadJson)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            "INSERT INTO chat_event(session_id, seq, kind, payload_json, created_at) " +
            "VALUES (@sessionId, @seq, @kind, @payloadJson, @now)",
            new { sessionId, seq, kind, payloadJson, now = DateTime.UtcNow.ToString("o") });
    }

    public async Task<List<string>> EventPayloadsAsync(string sessionId)
    {
        using var conn = _db.Open();
        return (await conn.QueryAsync<string>(
            "SELECT payload_json FROM chat_event WHERE session_id = @sessionId ORDER BY seq",
            new { sessionId })).ToList();
    }

    public async Task<int> FailInterruptedSessionsAsync()
    {
        using var conn = _db.Open();
        return await conn.ExecuteAsync(
            "UPDATE chat_session SET phase = 'error', error = 'server restarted mid-run', " +
            "updated_at = @now WHERE phase NOT IN @terminal",
            new { now = DateTime.UtcNow.ToString("o"), terminal = TerminalPhases });
    }

    public async Task<List<ChatTurnRow>> TurnsAsync()
    {
        using var conn = _db.Open();
        return (await conn.QueryAsync<ChatTurnRow>(
            "SELECT id, message, outcome, created_at FROM chat_turn ORDER BY id")).ToList();
    }

    public async Task AddTurnAsync(string message, string outcome)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            "INSERT INTO chat_turn(message, outcome, created_at) VALUES (@message, @outcome, @now)",
            new { message, outcome, now = DateTime.UtcNow.ToString("o") });
    }

    public async Task ClearTurnsAsync()
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync("DELETE FROM chat_turn");
    }
}
