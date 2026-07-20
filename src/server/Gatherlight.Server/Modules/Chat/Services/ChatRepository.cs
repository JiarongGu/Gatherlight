using Dapper;
using Gatherlight.Server.Modules.Core.Services;
using IConversationStore = Lyntai.Storage.IConversationStore;

namespace Gatherlight.Server.Modules.Chat.Services;

public sealed record ChatTurnRow(long Id, string Message, string Outcome, string CreatedAt);

/// <summary>The two-gate session state Gatherlight stores in the Lyntai thread's opaque JSON metadata
/// (Lyntai owns the lyntai_thread/lyntai_message schema; this is the app's own additional info inside the
/// metadata slot it's given). Written by <see cref="ChatRepository.UpsertSessionAsync"/>; read back by the
/// eval console + scoring via <see cref="Parse"/> — always through the IConversationStore API, never raw SQL.</summary>
public sealed record SessionMetadata(
    string? Phase = null, string? Mode = null, string? UserMessage = null, string? PlanText = null,
    string? ClaudeSessionId = null, string? CommitSha = null, string? Error = null, string? Attachments = null)
{
    public static readonly SessionMetadata Empty = new();

    // camelCase keys (phase/mode/userMessage/…) so the JSON matches the data-migration's json_object keys.
    private static readonly System.Text.Json.JsonSerializerOptions Json =
        new() { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase };

    public string Serialize() => System.Text.Json.JsonSerializer.Serialize(this, Json);

    /// <summary>Parse a thread's metadata blob; missing/malformed → <see cref="Empty"/> (never throws).</summary>
    public static SessionMetadata Parse(string? metadata)
    {
        if (string.IsNullOrWhiteSpace(metadata)) return Empty;
        try { return System.Text.Json.JsonSerializer.Deserialize<SessionMetadata>(metadata, Json) ?? Empty; }
        catch { return Empty; }
    }
}

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
    Task AppendEventAsync(string sessionId, string kind, string payloadJson);
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
    private readonly IConversationStore _convo;

    public ChatRepository(IDbConnectionFactory db, IConversationStore convo)
    {
        _db = db;
        _convo = convo;
    }

    // Session state lives in the Lyntai thread's opaque JSON metadata (Gatherlight owns the shape); the
    // eval console reads it back via json_extract. Writes go through the IConversationStore API so Lyntai
    // owns the lyntai_thread/lyntai_message schema (single source of truth — no app conversation tables).
    public async Task UpsertSessionAsync(string id, string phase, string mode, string userMessage,
        string? attachmentsJson, string? planText, string? claudeSessionId, string? commitSha,
        string? error, string createdAt)
    {
        var metadata = new SessionMetadata(phase, mode, userMessage, planText, claudeSessionId, commitSha,
            error, attachmentsJson).Serialize();
        var existing = await _convo.GetThreadAsync(id);
        if (existing is null) await _convo.CreateThreadAsync(id, title: null, metadata: metadata);
        else await _convo.SetThreadMetadataAsync(id, metadata);
    }

    // One agent event = one typed message on the thread; Lyntai assigns the GUID id + the 1-based per-thread
    // seq (append order). The live SSE frame id stays the in-memory log index (ChatSessionService.Emit).
    public async Task AppendEventAsync(string sessionId, string kind, string payloadJson) =>
        await _convo.AppendMessageAsync(sessionId, kind, payloadJson);

    public async Task<int> FailInterruptedSessionsAsync()
    {
        // Non-terminal threads left by a dead server → error. Through the IConversationStore API (list +
        // parse the metadata we own + rewrite) — no raw SQL against Lyntai's table. Startup-only + bounded.
        var threads = await _convo.ListThreadsAsync(limit: 1000);
        var n = 0;
        foreach (var t in threads)
        {
            var m = SessionMetadata.Parse(t.Metadata);
            if (m.Phase is null || Array.IndexOf(TerminalPhases, m.Phase) >= 0) continue;
            await _convo.SetThreadMetadataAsync(
                t.Id, (m with { Phase = "error", Error = "server restarted mid-run" }).Serialize());
            n++;
        }
        return n;
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
