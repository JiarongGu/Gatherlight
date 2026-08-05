using Dapper;
using Gatherlight.Server.Platform.Kernel.Services;
using IConversationStore = Lyntai.Storage.IConversationStore;

namespace Gatherlight.Server.Platform.Agent.Chat.Services;

public sealed record ChatTurnRow(long Id, string Message, string Outcome, string CreatedAt);

/// <summary>One conversation in the history list. <c>Title</c> is the first turn's user message,
/// truncated — no LLM call to name a thread, and nothing new to persist.</summary>
public sealed record ChatHistoryRow(
    string Id, string Title, string Phase, string Mode, string CreatedAt, int Turns);

/// <summary>A conversation's stored transcript. <c>Events</c> are the persisted SSE payloads,
/// verbatim and in order — the client replays them through the SAME reducer the live stream feeds,
/// so this MUST stay the wire shape rather than a projection of it.</summary>
public sealed record ChatTranscript(
    string Id, string Title, string Phase, string Mode, string CreatedAt,
    List<System.Text.Json.JsonElement> Events);

/// <summary>The two-gate session state Gatherlight stores in the Lyntai thread's opaque JSON metadata
/// (Lyntai owns the lyntai_thread/lyntai_message schema; this is the app's own additional info inside the
/// metadata slot it's given). Written by <see cref="ChatRepository.UpsertSessionAsync"/>; read back by the
/// eval console + scoring via <see cref="Parse"/> — always through the IConversationStore API, never raw SQL.</summary>
public sealed record SessionMetadata(
    string? Phase = null, string? Mode = null, string? UserMessage = null, string? PlanText = null,
    string? ClaudeSessionId = null, string? CommitSha = null, string? Error = null, string? Attachments = null,
    string? ConversationId = null)
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

    /// <summary>Conversations, newest first. A conversation is the group of turns sharing a
    /// ConversationId; a turn whose metadata predates that field is its own conversation.</summary>
    Task<List<ChatHistoryRow>> HistoryAsync(int limit);

    /// <summary>Every stored event of every turn in one conversation, in order. Null if unknown.</summary>
    Task<ChatTranscript?> TranscriptAsync(string conversationId);

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

    // --- history (read back what every turn already stored) --------------------------------

    private static string TitleOf(string? userMessage)
    {
        var m = string.Join(' ', (userMessage ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (m.Length == 0) return "(无标题)";
        return m.Length <= 60 ? m : m[..60] + "…";
    }

    // A turn's conversation: the ConversationId it was written with, or — for a thread written
    // before that field existed — the turn's own id, so old data lists as one conversation each
    // instead of collapsing into a single bucket keyed by null.
    private static string ConversationOf(SessionMetadata m, string threadId) =>
        string.IsNullOrWhiteSpace(m.ConversationId) ? threadId : m.ConversationId!;

    public async Task<List<ChatHistoryRow>> HistoryAsync(int limit)
    {
        var take = Math.Clamp(limit, 1, 200);
        // Pull generously then group: `limit` counts CONVERSATIONS, and one can span several turns.
        var threads = await _convo.ListThreadsAsync(limit: Math.Clamp(take * 8, 50, 2000));
        var groups = threads
            .Select(t => (Thread: t, Meta: SessionMetadata.Parse(t.Metadata)))
            .GroupBy(x => ConversationOf(x.Meta, x.Thread.Id));

        return groups
            .Select(g =>
            {
                var ordered = g.OrderBy(x => x.Thread.CreatedAt).ToList();
                var first = ordered[0];
                var last = ordered[^1];
                return new ChatHistoryRow(
                    Id: g.Key,
                    Title: TitleOf(first.Meta.UserMessage),
                    Phase: last.Meta.Phase ?? "",
                    Mode: last.Meta.Mode ?? "plan",
                    CreatedAt: last.Thread.CreatedAt.ToString("o"),
                    Turns: ordered.Count);
            })
            .OrderByDescending(r => r.CreatedAt, StringComparer.Ordinal)
            .Take(take)
            .ToList();
    }

    public async Task<ChatTranscript?> TranscriptAsync(string conversationId)
    {
        var threads = await _convo.ListThreadsAsync(limit: 2000);
        var turns = threads
            .Select(t => (Thread: t, Meta: SessionMetadata.Parse(t.Metadata)))
            .Where(x => ConversationOf(x.Meta, x.Thread.Id) == conversationId)
            .OrderBy(x => x.Thread.CreatedAt)
            .ToList();
        if (turns.Count == 0) return null;

        var events = new List<System.Text.Json.JsonElement>();
        foreach (var (thread, _) in turns)
        {
            foreach (var msg in (await _convo.GetMessagesAsync(thread.Id)).OrderBy(m => m.Seq))
            {
                // A malformed payload is skipped, never thrown: one bad row must not make a whole
                // conversation unreadable.
                try { events.Add(System.Text.Json.JsonDocument.Parse(msg.Payload).RootElement.Clone()); }
                catch (System.Text.Json.JsonException) { }
            }
        }

        var first = turns[0];
        var last = turns[^1];
        return new ChatTranscript(
            conversationId, TitleOf(first.Meta.UserMessage), last.Meta.Phase ?? "",
            last.Meta.Mode ?? "plan", first.Thread.CreatedAt.ToString("o"), events);
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
