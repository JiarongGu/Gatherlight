using System.Text.Json;
using Dapper;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.Scoring.Services;

/// <summary>
/// Orchestrates Lyntai's scoring framework over Gatherlight conversations: builds a Lyntai
/// <see cref="Lyntai.Cortex.ScoreContext"/> from the session, runs Lyntai's <c>IScoringService</c> (which
/// upserts each verdict into Lyntai's <c>IScoreStore</c> = <c>lyntai_score_result</c>), and reads
/// verdicts/aggregates back. Scorers, judge, and persistence are all Lyntai's; only the session-context
/// rebuild + the backlog query (which need the app's own <c>chat_session</c> table) stay here.
/// </summary>
public interface IScoringService
{
    /// <summary>Run every applicable scorer over the context and return the verdicts WITHOUT persisting
    /// (the playground eval harness scores dry runs this way).</summary>
    Task<IReadOnlyList<Lyntai.Cortex.ScoredResult>> EvaluateAsync(Lyntai.Cortex.ScoreContext ctx, CancellationToken ct = default);
    /// <summary>Run every applicable scorer over the given context and store the results.</summary>
    Task<int> ScoreAsync(Lyntai.Cortex.ScoreContext ctx, CancellationToken ct = default);
    /// <summary>Rebuild the context from persisted data and score it (manual re-score).</summary>
    Task<int> ScoreSessionAsync(string sessionId, CancellationToken ct = default);
    /// <summary>Score every terminal conversation that has no scores yet. Returns how many were scored.</summary>
    Task<int> ScoreAllAsync(CancellationToken ct = default);
    Task<IReadOnlyList<Lyntai.Cortex.ScoredResult>> GetAsync(string sessionId);
    Task<IReadOnlyList<Lyntai.Cortex.ScorerAggregate>> AggregateAsync();
    IReadOnlyList<Lyntai.Cortex.IScorer> Scorers { get; }
}

public sealed class ScoringService : IScoringService
{
    private static readonly string[] Terminal = { "committed", "rejected", "cancelled", "error" };

    private readonly Lyntai.Cortex.IScoringService _scoring; // iterates the registered scorers, fail-open, persists
    private readonly Lyntai.Storage.IScoreStore _store;      // upsert (session,scorer) + cross-session aggregate
    private readonly IReadOnlyList<Lyntai.Cortex.IScorer> _scorers;
    private readonly IDbConnectionFactory _db;

    public ScoringService(Lyntai.Cortex.IScoringService scoring, Lyntai.Storage.IScoreStore store,
        IEnumerable<Lyntai.Cortex.IScorer> scorers, IDbConnectionFactory db)
    {
        _scoring = scoring;
        _store = store;
        _scorers = scorers.ToList();
        _db = db;
    }

    public IReadOnlyList<Lyntai.Cortex.IScorer> Scorers => _scorers;

    public Task<IReadOnlyList<Lyntai.Cortex.ScoredResult>> EvaluateAsync(Lyntai.Cortex.ScoreContext ctx, CancellationToken ct = default) =>
        _scoring.EvaluateAsync(ctx, persist: false, ct);

    public async Task<int> ScoreAsync(Lyntai.Cortex.ScoreContext ctx, CancellationToken ct = default)
    {
        // persist:true — Lyntai's IScoringService upserts each verdict into IScoreStore (re-scoring replaces)
        var results = await _scoring.EvaluateAsync(ctx, persist: true, ct);
        return results.Count;
    }

    public async Task<int> ScoreSessionAsync(string sessionId, CancellationToken ct = default)
    {
        var ctx = await BuildContextAsync(sessionId);
        return ctx is null ? 0 : await ScoreAsync(ctx, ct);
    }

    public async Task<int> ScoreAllAsync(CancellationToken ct = default)
    {
        List<string> ids;
        using (var conn = _db.Open())
        {
            // terminal conversations with no scores yet — join the app's session table to Lyntai's store
            ids = (await conn.QueryAsync<string>("""
                SELECT s.id FROM chat_session s
                WHERE s.phase IN @terminal
                  AND NOT EXISTS (SELECT 1 FROM lyntai_score_result r WHERE r.session_id = s.id)
                ORDER BY s.created_at DESC LIMIT 500
                """, new { terminal = Terminal })).ToList();
        }
        var total = 0;
        foreach (var id in ids)
        {
            if (ct.IsCancellationRequested) break;
            if (await ScoreSessionAsync(id, ct) > 0) total++;
        }
        return total;
    }

    public Task<IReadOnlyList<Lyntai.Cortex.ScoredResult>> GetAsync(string sessionId) => _store.GetAsync(sessionId);
    public Task<IReadOnlyList<Lyntai.Cortex.ScorerAggregate>> AggregateAsync() => _store.AggregateAsync();

    // Reconstruct the scoring context from the persisted session + the committed event's file list.
    private async Task<Lyntai.Cortex.ScoreContext?> BuildContextAsync(string sessionId)
    {
        using var conn = _db.Open();
        var row = await conn.QuerySingleOrDefaultAsync(
            "SELECT phase, mode, user_message, plan_text, commit_sha FROM chat_session WHERE id = @id",
            new { id = sessionId });
        if (row is null) return null;

        var files = new List<string>();
        // The committed phase event carries data:{ sha, files }. Require BOTH markers so an unrelated
        // event that merely mentions "files" (a plan, a tool detail, an error) can't be picked instead
        // and silently zero the scope-adherence scorer.
        var payload = await conn.QuerySingleOrDefaultAsync<string>(
            "SELECT payload_json FROM chat_event WHERE session_id = @id AND payload_json LIKE '%\"files\"%' AND payload_json LIKE '%\"sha\"%' ORDER BY seq DESC LIMIT 1",
            new { id = sessionId });
        if (payload is not null)
        {
            try
            {
                using var doc = JsonDocument.Parse(payload);
                var root = doc.RootElement;
                JsonElement arr = default;
                var found = (root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object
                                && data.TryGetProperty("files", out arr) && arr.ValueKind == JsonValueKind.Array)
                            || (root.TryGetProperty("files", out arr) && arr.ValueKind == JsonValueKind.Array);
                if (found)
                    files = arr.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).ToList();
            }
            catch { /* leave files empty */ }
        }

        return ScoringContext.Build(sessionId, (string?)row.user_message ?? "", (string?)row.plan_text ?? "",
            (string?)row.phase ?? "", (string?)row.mode ?? "plan", (string?)row.commit_sha, files);
    }
}

/// <summary>Packs Gatherlight's domain dimensions into Lyntai's generic <see cref="Lyntai.Cortex.ScoreContext"/>:
/// Input=user message, Output=plan, and phase/mode/commit/changed-files into <c>Extra</c> (the intended
/// extension pattern — list values serialized to JSON; the scorers read them back via ScoreCtxExt).</summary>
public static class ScoringContext
{
    public static Lyntai.Cortex.ScoreContext Build(string sessionId, string userMessage, string planText,
        string phase, string mode, string? commitSha, IReadOnlyList<string> changedFiles) =>
        new()
        {
            SessionId = sessionId,
            Input = userMessage,
            Output = planText,
            Extra = new Dictionary<string, string>
            {
                ["phase"] = phase,
                ["mode"] = mode,
                ["commitSha"] = commitSha ?? "",
                ["changedFiles"] = JsonSerializer.Serialize(changedFiles),
            },
        };
}
