using Dapper;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.Eval.Services;

// Classes (SQLite dynamic typing breaks Dapper's positional-record materialization).
public sealed class ConversationRow
{
    public string Id { get; set; } = "";
    public string Phase { get; set; } = "";
    public string Mode { get; set; } = "";
    public string? UserMessage { get; set; }
    public string? CommitSha { get; set; }
    public string? Error { get; set; }
    public string CreatedAt { get; set; } = "";
    public int? Rating { get; set; }
    public string? Note { get; set; }
    public double? AvgScore { get; set; }     // mean of this conversation's automated scores (0..1)
    public int ScoreCount { get; set; }
}

public sealed class RatingBucket
{
    public int Rating { get; set; }
    public int Count { get; set; }
}

public sealed record EvalStats(int Total, int Rated, double AvgRating, List<RatingBucket> Distribution);

public sealed class EvalRecord
{
    public string Id { get; set; } = "";
    public string Mode { get; set; } = "";
    public string? Input { get; set; }        // the user's request
    public string? Plan { get; set; }         // the agent's proposed plan
    public string? CommitSha { get; set; }    // committed result (if any)
    public int Rating { get; set; }           // 1..5 (human)
    public string? Note { get; set; }
    public string CreatedAt { get; set; } = "";
    public Dictionary<string, double> Scores { get; set; } = new();  // automated scorer verdicts (0..1)
}

public sealed class TranscriptSession
{
    public string Id { get; set; } = "";
    public string Phase { get; set; } = "";
    public string Mode { get; set; } = "";
    public string? UserMessage { get; set; }
    public string? PlanText { get; set; }
    public string? CommitSha { get; set; }
    public string? Error { get; set; }
    public string CreatedAt { get; set; } = "";
    public int? Rating { get; set; }
    public string? Note { get; set; }
}

public sealed class TranscriptEvent
{
    public int Seq { get; set; }
    public string Kind { get; set; } = "";
    public string PayloadJson { get; set; } = "";
    public string CreatedAt { get; set; } = "";
}

public sealed record Transcript(TranscriptSession Session, List<TranscriptEvent> Events);

// Class (not a tuple/positional record) — SQLite dynamic typing breaks positional materialization.
public sealed class ScoreExportRow
{
    public string SessionId { get; set; } = "";
    public string ScorerId { get; set; } = "";
    public double Score { get; set; }
}

public interface IFeedbackStore
{
    Task RateAsync(string sessionId, int rating, string? note);
    Task<List<ConversationRow>> ConversationsAsync(int limit);
    Task<EvalStats> StatsAsync();
    Task<Transcript?> TranscriptAsync(string id);
    Task<List<EvalRecord>> EvalExportAsync();
}

public sealed class FeedbackStore : IFeedbackStore
{
    private readonly IDbConnectionFactory _db;
    public FeedbackStore(IDbConnectionFactory db) => _db = db;

    public async Task RateAsync(string sessionId, int rating, string? note)
    {
        rating = Math.Clamp(rating, 1, 5);
        using var conn = _db.Open();
        var now = DateTime.UtcNow.ToString("o");
        await conn.ExecuteAsync(
            """
            INSERT INTO chat_feedback(session_id, rating, note, created_at, updated_at)
            VALUES (@sessionId, @rating, @note, @now, @now)
            ON CONFLICT(session_id) DO UPDATE SET rating = excluded.rating, note = excluded.note, updated_at = excluded.updated_at
            """,
            new { sessionId, rating, note, now });
    }

    public async Task<List<ConversationRow>> ConversationsAsync(int limit)
    {
        using var conn = _db.Open();
        return (await conn.QueryAsync<ConversationRow>(
            """
            SELECT s.id, s.phase, s.mode, s.user_message, s.commit_sha, s.error, s.created_at,
                   f.rating, f.note,
                   (SELECT CAST(AVG(score) AS REAL) FROM chat_score c WHERE c.session_id = s.id) AS avg_score,
                   (SELECT COUNT(*) FROM chat_score c WHERE c.session_id = s.id) AS score_count
            FROM chat_session s LEFT JOIN chat_feedback f ON f.session_id = s.id
            ORDER BY s.created_at DESC LIMIT @limit
            """,
            new { limit = Math.Clamp(limit, 1, 500) })).ToList();
    }

    public async Task<EvalStats> StatsAsync()
    {
        using var conn = _db.Open();
        var total = await conn.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM chat_session");
        var rated = await conn.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM chat_feedback");
        var avg = await conn.ExecuteScalarAsync<double?>("SELECT AVG(CAST(rating AS REAL)) FROM chat_feedback") ?? 0;
        var dist = (await conn.QueryAsync<RatingBucket>(
            "SELECT rating, COUNT(*) AS count FROM chat_feedback GROUP BY rating ORDER BY rating DESC")).ToList();
        return new EvalStats(total, rated, Math.Round(avg, 2), dist);
    }

    public async Task<Transcript?> TranscriptAsync(string id)
    {
        using var conn = _db.Open();
        var session = await conn.QuerySingleOrDefaultAsync<TranscriptSession>(
            """
            SELECT s.id, s.phase, s.mode, s.user_message, s.plan_text, s.commit_sha, s.error, s.created_at,
                   f.rating, f.note
            FROM chat_session s LEFT JOIN chat_feedback f ON f.session_id = s.id
            WHERE s.id = @id
            """,
            new { id });
        if (session is null) return null;
        var events = (await conn.QueryAsync<TranscriptEvent>(
            "SELECT seq, kind, payload_json, created_at FROM chat_event WHERE session_id = @id ORDER BY seq",
            new { id })).ToList();
        return new Transcript(session, events);
    }

    public async Task<List<EvalRecord>> EvalExportAsync()
    {
        using var conn = _db.Open();
        var records = (await conn.QueryAsync<EvalRecord>(
            """
            SELECT s.id, s.mode, s.user_message AS input, s.plan_text AS plan, s.commit_sha,
                   f.rating, f.note, s.created_at
            FROM chat_session s JOIN chat_feedback f ON f.session_id = s.id
            ORDER BY s.created_at
            """)).ToList();

        // Attach the automated scorer verdicts so the tuning dataset carries both signals.
        var scores = await conn.QueryAsync<ScoreExportRow>(
            "SELECT session_id, scorer_id, CAST(score AS REAL) AS score FROM chat_score");
        var bySession = scores.GroupBy(x => x.SessionId).ToDictionary(g => g.Key, g => g.ToList());
        foreach (var r in records)
            if (bySession.TryGetValue(r.Id, out var rows))
                r.Scores = rows.ToDictionary(x => x.ScorerId, x => Math.Round(x.Score, 3));
        return records;
    }
}
