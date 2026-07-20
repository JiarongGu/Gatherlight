using Dapper;
using Gatherlight.Server.Modules.Chat.Services;
using Gatherlight.Server.Modules.Core.Services;
using IConversationStore = Lyntai.Storage.IConversationStore;
using IScoreStore = Lyntai.Storage.IScoreStore;

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

public interface IFeedbackStore
{
    Task RateAsync(string sessionId, int rating, string? note);
    Task<List<ConversationRow>> ConversationsAsync(int limit);
    Task<EvalStats> StatsAsync();
    Task<Transcript?> TranscriptAsync(string id);
    Task<List<EvalRecord>> EvalExportAsync();
}

/// <summary>
/// Read/write side of the eval console. Conversations + their event transcripts live in Lyntai's
/// conversation store and the automated scores in Lyntai's score store — read through their APIs
/// (<c>IConversationStore</c> / <c>IScoreStore</c>), never raw SQL against the <c>lyntai_*</c> tables.
/// Only the app's OWN human-rating table (<c>chat_feedback</c>) is SQL. Session state is parsed from the
/// thread's JSON metadata (<see cref="SessionMetadata"/>) the app wrote.
/// </summary>
public sealed class FeedbackStore : IFeedbackStore
{
    private readonly IDbConnectionFactory _db;
    private readonly IConversationStore _convo;
    private readonly IScoreStore _scores;

    public FeedbackStore(IDbConnectionFactory db, IConversationStore convo, IScoreStore scores)
    {
        _db = db;
        _convo = convo;
        _scores = scores;
    }

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
        var threads = await _convo.ListThreadsAsync(Math.Clamp(limit, 1, 500));
        var scores = await ScoreIndexAsync();
        var feedback = await FeedbackIndexAsync();
        return threads.Select(t =>
        {
            var m = SessionMetadata.Parse(t.Metadata);
            var (avg, count) = scores.GetValueOrDefault(t.Id);
            var (rating, note) = feedback.GetValueOrDefault(t.Id);
            return new ConversationRow
            {
                Id = t.Id, Phase = m.Phase ?? "", Mode = m.Mode ?? "", UserMessage = m.UserMessage,
                CommitSha = m.CommitSha, Error = m.Error, CreatedAt = t.CreatedAt.ToString("o"),
                Rating = rating, Note = note,
                AvgScore = count > 0 ? avg : null, ScoreCount = count,
            };
        }).ToList();
    }

    public async Task<EvalStats> StatsAsync()
    {
        // No count on IConversationStore — list + count (bounded; a self-hosted family planner's conversation
        // set is small). Ratings are the app's own chat_feedback table.
        var total = (await _convo.ListThreadsAsync(limit: 100_000)).Count;
        using var conn = _db.Open();
        var rated = await conn.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM chat_feedback");
        var avg = await conn.ExecuteScalarAsync<double?>("SELECT AVG(CAST(rating AS REAL)) FROM chat_feedback") ?? 0;
        var dist = (await conn.QueryAsync<RatingBucket>(
            "SELECT rating, COUNT(*) AS count FROM chat_feedback GROUP BY rating ORDER BY rating DESC")).ToList();
        return new EvalStats(total, rated, Math.Round(avg, 2), dist);
    }

    public async Task<Transcript?> TranscriptAsync(string id)
    {
        var thread = await _convo.GetThreadAsync(id);
        if (thread is null) return null;
        var m = SessionMetadata.Parse(thread.Metadata);
        var (rating, note) = (await FeedbackIndexAsync()).GetValueOrDefault(id);
        var session = new TranscriptSession
        {
            Id = id, Phase = m.Phase ?? "", Mode = m.Mode ?? "", UserMessage = m.UserMessage,
            PlanText = m.PlanText, CommitSha = m.CommitSha, Error = m.Error,
            CreatedAt = thread.CreatedAt.ToString("o"), Rating = rating, Note = note,
        };
        var events = (await _convo.GetMessagesAsync(id)).Select(x => new TranscriptEvent
        {
            Seq = (int)x.Seq, Kind = x.Kind, PayloadJson = x.Payload, CreatedAt = x.CreatedAt.ToString("o"),
        }).ToList();
        return new Transcript(session, events);
    }

    public async Task<List<EvalRecord>> EvalExportAsync()
    {
        // The tuning dataset = rated conversations + both signals (human rating + automated scores).
        var feedback = await FeedbackIndexAsync();
        var scoresBySession = (await _scores.ExportAsync())
            .GroupBy(x => x.SessionId)
            .ToDictionary(g => g.Key, g => g.ToDictionary(x => x.ScorerId, x => Math.Round(x.Score, 3)));
        var threads = await _convo.ListThreadsAsync(limit: 100_000);
        var records = new List<EvalRecord>();
        foreach (var t in threads.OrderBy(t => t.CreatedAt))
        {
            if (!feedback.TryGetValue(t.Id, out var f) || f.Rating is null) continue; // rated conversations only
            var m = SessionMetadata.Parse(t.Metadata);
            records.Add(new EvalRecord
            {
                Id = t.Id, Mode = m.Mode ?? "", Input = m.UserMessage, Plan = m.PlanText, CommitSha = m.CommitSha,
                Rating = f.Rating.Value, Note = f.Note, CreatedAt = t.CreatedAt.ToString("o"),
                Scores = scoresBySession.GetValueOrDefault(t.Id) ?? new(),
            });
        }
        return records;
    }

    // session -> (avg score, count) from Lyntai's score store (API, not SQL).
    private async Task<Dictionary<string, (double Avg, int Count)>> ScoreIndexAsync() =>
        (await _scores.ExportAsync()).GroupBy(r => r.SessionId)
            .ToDictionary(g => g.Key, g => (g.Average(x => x.Score), g.Count()));

    // session -> (rating, note) from the app's OWN chat_feedback table.
    private async Task<Dictionary<string, (int? Rating, string? Note)>> FeedbackIndexAsync()
    {
        using var conn = _db.Open();
        var rows = await conn.QueryAsync<FeedbackRow>("SELECT session_id AS SessionId, rating, note FROM chat_feedback");
        return rows.ToDictionary(r => r.SessionId, r => ((int?)r.Rating, r.Note));
    }

    private sealed class FeedbackRow
    {
        public string SessionId { get; set; } = "";
        public int Rating { get; set; }
        public string? Note { get; set; }
    }
}
