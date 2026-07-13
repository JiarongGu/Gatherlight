using System.Text.Json;
using Dapper;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Scoring.Models;

namespace Gatherlight.Server.Modules.Scoring.Services;

/// <summary>
/// Runs the registered <see cref="IScorer"/>s over a conversation and persists their verdicts
/// (Mastra's scorer-run + save-to-scores-store). Auto-invoked after a conversation commits (from
/// ChatSessionService, fire-and-forget) and on demand from the console (score one / score all).
/// </summary>
public interface IScoringService
{
    /// <summary>Run every applicable scorer over the context and return the verdicts WITHOUT persisting
    /// (the playground eval harness scores dry runs this way).</summary>
    Task<List<ScoredResult>> EvaluateAsync(ScoreContext ctx, CancellationToken ct = default);
    /// <summary>Run every applicable scorer over the given context and store the results.</summary>
    Task<int> ScoreAsync(ScoreContext ctx, CancellationToken ct = default);
    /// <summary>Rebuild the context from persisted data and score it (manual re-score).</summary>
    Task<int> ScoreSessionAsync(string sessionId, CancellationToken ct = default);
    /// <summary>Score every terminal conversation that has no scores yet. Returns how many were scored.</summary>
    Task<int> ScoreAllAsync(CancellationToken ct = default);
    Task<List<StoredScore>> GetAsync(string sessionId);
    Task<List<ScoreAggregate>> AggregateAsync();
    IReadOnlyList<IScorer> Scorers { get; }
}

public sealed class ScoringService : IScoringService
{
    private readonly IReadOnlyList<IScorer> _scorers;
    private readonly IScoreRepository _repo;
    private readonly IDbConnectionFactory _db;
    private readonly ILogger<ScoringService> _log;

    public ScoringService(IEnumerable<IScorer> scorers, IScoreRepository repo, IDbConnectionFactory db, ILogger<ScoringService> log)
    {
        _scorers = scorers.ToList();
        _repo = repo;
        _db = db;
        _log = log;
    }

    public IReadOnlyList<IScorer> Scorers => _scorers;

    public async Task<List<ScoredResult>> EvaluateAsync(ScoreContext ctx, CancellationToken ct = default)
    {
        var results = new List<ScoredResult>();
        foreach (var scorer in _scorers)
        {
            try
            {
                var r = await scorer.ScoreAsync(ctx, ct);
                if (r is null) continue;   // not applicable
                results.Add(new ScoredResult { ScorerId = scorer.Id, IsLlm = scorer.IsLlm, Score = Math.Clamp(r.Score, 0, 1), Reason = r.Reason });
            }
            catch (Exception ex)
            {
                _log.LogWarning("Scorer {Scorer} failed for {Session}: {Msg}", scorer.Id, ctx.SessionId, ex.Message);
            }
        }
        return results;
    }

    public async Task<int> ScoreAsync(ScoreContext ctx, CancellationToken ct = default)
    {
        var results = await EvaluateAsync(ctx, ct);
        foreach (var r in results)
            await _repo.UpsertAsync(ctx.SessionId, r.ScorerId, r.Score, r.Reason, r.IsLlm);
        return results.Count;
    }

    public async Task<int> ScoreSessionAsync(string sessionId, CancellationToken ct = default)
    {
        var ctx = await BuildContextAsync(sessionId);
        return ctx is null ? 0 : await ScoreAsync(ctx, ct);
    }

    public async Task<int> ScoreAllAsync(CancellationToken ct = default)
    {
        var ids = await _repo.UnscoredTerminalSessionIdsAsync(500);
        var total = 0;
        foreach (var id in ids)
        {
            if (ct.IsCancellationRequested) break;
            if (await ScoreSessionAsync(id, ct) > 0) total++;
        }
        return total;
    }

    public Task<List<StoredScore>> GetAsync(string sessionId) => _repo.GetAsync(sessionId);
    public Task<List<ScoreAggregate>> AggregateAsync() => _repo.AggregateAsync();

    // Reconstruct the scoring context from the persisted session + the committed event's file list.
    private async Task<ScoreContext?> BuildContextAsync(string sessionId)
    {
        using var conn = _db.Open();
        var row = await conn.QuerySingleOrDefaultAsync(
            "SELECT phase, mode, user_message, plan_text, commit_sha FROM chat_session WHERE id = @id",
            new { id = sessionId });
        if (row is null) return null;

        var files = new List<string>();
        var payload = await conn.QuerySingleOrDefaultAsync<string>(
            "SELECT payload_json FROM chat_event WHERE session_id = @id AND payload_json LIKE '%\"files\"%' ORDER BY seq DESC LIMIT 1",
            new { id = sessionId });
        if (payload is not null)
        {
            try
            {
                using var doc = JsonDocument.Parse(payload);
                var root = doc.RootElement;
                // The committed phase event is { kind, phase, data: { sha, files } } — files is nested
                // under "data"; fall back to a root-level "files" for safety.
                JsonElement arr = default;
                var found = (root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object
                                && data.TryGetProperty("files", out arr) && arr.ValueKind == JsonValueKind.Array)
                            || (root.TryGetProperty("files", out arr) && arr.ValueKind == JsonValueKind.Array);
                if (found)
                    files = arr.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).ToList();
            }
            catch { /* leave files empty */ }
        }

        return new ScoreContext
        {
            SessionId = sessionId,
            Phase = (string?)row.phase ?? "",
            Mode = (string?)row.mode ?? "plan",
            UserMessage = (string?)row.user_message ?? "",
            PlanText = (string?)row.plan_text ?? "",
            CommitSha = (string?)row.commit_sha,
            ChangedFiles = files,
        };
    }
}
