using Dapper;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Scoring.Models;

namespace Gatherlight.Server.Modules.Scoring.Services;

public interface IScoreRepository
{
    Task UpsertAsync(string sessionId, string scorerId, double score, string? reason, bool isLlm);
    Task<List<StoredScore>> GetAsync(string sessionId);
    Task<List<ScoreAggregate>> AggregateAsync();
    /// <summary>Terminal conversations that have no scores yet (for a batch scoring run).</summary>
    Task<List<string>> UnscoredTerminalSessionIdsAsync(int limit);
}

public sealed class ScoreRepository : IScoreRepository
{
    private static readonly string[] Terminal = { "committed", "rejected", "cancelled", "error" };

    private readonly IDbConnectionFactory _db;
    public ScoreRepository(IDbConnectionFactory db) => _db = db;

    public async Task UpsertAsync(string sessionId, string scorerId, double score, string? reason, bool isLlm)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            """
            INSERT INTO chat_score(session_id, scorer_id, score, reason, is_llm, created_at)
            VALUES (@sessionId, @scorerId, @score, @reason, @isLlm, @now)
            ON CONFLICT(session_id, scorer_id) DO UPDATE SET
                score = excluded.score, reason = excluded.reason, is_llm = excluded.is_llm, created_at = excluded.created_at
            """,
            new { sessionId, scorerId, score, reason, isLlm = isLlm ? 1 : 0, now = DateTime.UtcNow.ToString("o") });
    }

    public async Task<List<StoredScore>> GetAsync(string sessionId)
    {
        using var conn = _db.Open();
        return (await conn.QueryAsync<StoredScore>(
            """
            SELECT session_id, scorer_id, CAST(score AS REAL) AS score, reason,
                   is_llm AS IsLlm, created_at
            FROM chat_score WHERE session_id = @sessionId ORDER BY scorer_id
            """,
            new { sessionId })).ToList();
    }

    public async Task<List<ScoreAggregate>> AggregateAsync()
    {
        using var conn = _db.Open();
        return (await conn.QueryAsync<ScoreAggregate>(
            """
            SELECT scorer_id, CAST(AVG(score) AS REAL) AS avg_score, COUNT(*) AS count
            FROM chat_score GROUP BY scorer_id ORDER BY scorer_id
            """)).ToList();
    }

    public async Task<List<string>> UnscoredTerminalSessionIdsAsync(int limit)
    {
        using var conn = _db.Open();
        var rows = await conn.QueryAsync<string>(
            """
            SELECT s.id FROM chat_session s
            WHERE s.phase IN @terminal
              AND NOT EXISTS (SELECT 1 FROM chat_score c WHERE c.session_id = s.id)
            ORDER BY s.created_at DESC LIMIT @limit
            """,
            new { terminal = Terminal, limit = Math.Clamp(limit, 1, 500) });
        return rows.ToList();
    }
}
