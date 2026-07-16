using Dapper;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.Knowledge.Services;

// ---------------------------------------------------------------------------------------------
// Entity store — generic JSON documents by kind+key. New data kinds need no migration.
// ---------------------------------------------------------------------------------------------

public interface IEntityStore
{
    Task<string?> GetAsync(string kind, string key);
    Task SetAsync(string kind, string key, string valueJson);
    Task DeleteAsync(string kind, string key);
    Task<List<(string Key, string ValueJson)>> ListAsync(string kind);
}

public sealed class EntityStore : IEntityStore
{
    private readonly IDbConnectionFactory _db;
    public EntityStore(IDbConnectionFactory db) => _db = db;

    public async Task<string?> GetAsync(string kind, string key)
    {
        using var conn = _db.Open();
        return await conn.QuerySingleOrDefaultAsync<string>(
            "SELECT value_json FROM entity WHERE kind = @kind AND key = @key", new { kind, key });
    }

    public async Task SetAsync(string kind, string key, string valueJson)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            "INSERT INTO entity(kind, key, value_json, updated_at) VALUES (@kind, @key, @valueJson, @now) " +
            "ON CONFLICT(kind, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            new { kind, key, valueJson, now = DateTime.UtcNow.ToString("o") });
    }

    public async Task DeleteAsync(string kind, string key)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync("DELETE FROM entity WHERE kind = @kind AND key = @key", new { kind, key });
    }

    public async Task<List<(string, string)>> ListAsync(string kind)
    {
        using var conn = _db.Open();
        return (await conn.QueryAsync<(string, string)>(
            "SELECT key, value_json FROM entity WHERE kind = @kind ORDER BY key", new { kind })).ToList();
    }
}

// ---------------------------------------------------------------------------------------------
// Knowledge store — learned facts with confidence + EMA reinforcement (sibling-project
// LearnedScoring lineage). The agent writes/queries via the remember_fact / recall_facts tools;
// curated markdown (.claude rules, household) stays canonical for policies and preferences —
// this holds granular verified facts (a verified URL, a price with a date, a venue status).
// ---------------------------------------------------------------------------------------------

public sealed record KnowledgeRow(
    long Id, string Kind, string Topic, string Content, string? Source,
    double Confidence, int Hits, string CreatedAt, string UpdatedAt);

public interface IKnowledgeStore
{
    Task<long> LearnAsync(string kind, string topic, string content, string? source, double confidence);
    Task<List<KnowledgeRow>> RecallAsync(string query, string? kind, int limit);
    /// <summary>EMA reinforcement: confirmations pull confidence toward 1, refutations toward 0.</summary>
    Task ReinforceAsync(long id, bool positive);
}

public sealed class KnowledgeStore : IKnowledgeStore
{
    private const double Alpha = 0.3;

    private readonly IDbConnectionFactory _db;
    public KnowledgeStore(IDbConnectionFactory db) => _db = db;

    public async Task<long> LearnAsync(string kind, string topic, string content, string? source, double confidence)
    {
        using var conn = _db.Open();
        var now = DateTime.UtcNow.ToString("o");
        // Same kind+topic = the fact evolved → update in place (highest-confidence wins history).
        var existing = await conn.QuerySingleOrDefaultAsync<long?>(
            "SELECT id FROM knowledge WHERE kind = @kind AND topic = @topic", new { kind, topic });
        if (existing is { } id)
        {
            await conn.ExecuteAsync(
                "UPDATE knowledge SET content = @content, source = @source, confidence = @confidence, updated_at = @now WHERE id = @id",
                new { content, source, confidence = Math.Clamp(confidence, 0, 1), now, id });
            return id;
        }
        return await conn.ExecuteScalarAsync<long>(
            "INSERT INTO knowledge(kind, topic, content, source, confidence, hits, created_at, updated_at) " +
            "VALUES (@kind, @topic, @content, @source, @confidence, 0, @now, @now); SELECT last_insert_rowid();",
            new { kind, topic, content, source, confidence = Math.Clamp(confidence, 0, 1), now });
    }

    public async Task<List<KnowledgeRow>> RecallAsync(string query, string? kind, int limit)
    {
        using var conn = _db.Open();
        // FTS5 (BM25-ranked, trigram) when the query has a usable ≥3-char token; else LIKE.
        var match = FtsQuery.Build(query);
        var raw = match is not null
            ? await conn.QueryAsync(
                "SELECT k.id, k.kind, k.topic, k.content, k.source, k.confidence, k.hits, k.created_at, k.updated_at " +
                "FROM knowledge_fts JOIN knowledge k ON k.id = knowledge_fts.rowid " +
                "WHERE knowledge_fts MATCH @match AND (@kind IS NULL OR k.kind = @kind) " +
                // Confidence first (verified facts surface first — the established contract), bm25
                // relevance as the tiebreaker among equally-trusted matches.
                "ORDER BY CAST(k.confidence AS REAL) DESC, bm25(knowledge_fts) LIMIT @limit",
                new { match, kind, limit })
            : await conn.QueryAsync(
                "SELECT id, kind, topic, content, source, confidence, hits, created_at, updated_at " +
                "FROM knowledge WHERE (topic LIKE @like ESCAPE '\\' OR content LIKE @like ESCAPE '\\') AND (@kind IS NULL OR kind = @kind) " +
                "ORDER BY CAST(confidence AS REAL) DESC, updated_at DESC LIMIT @limit",
                new { like = $"%{FtsQuery.EscapeLike(query)}%", kind, limit });
        // Manual mapping: SQLite's dynamic typing (NUMERIC/BLOB affinity surprises) breaks
        // Dapper's strict positional-record materialization — coerce each column explicitly.
        var rows = raw
            .Select(d => new KnowledgeRow(
                Convert.ToInt64(d.id), (string)d.kind, (string)d.topic, (string)d.content,
                (string?)d.source, CoerceDouble((object)d.confidence), Convert.ToInt32(d.hits),
                (string)d.created_at, (string)d.updated_at))
            .ToList();
        if (rows.Count > 0)
        {
            await conn.ExecuteAsync(
                $"UPDATE knowledge SET hits = hits + 1 WHERE id IN ({string.Join(',', rows.Select(r => r.Id))})");
        }
        return rows;
    }

    private static double CoerceDouble(object v) => v switch
    {
        double x => x,
        long l => l,
        string s => double.TryParse(s, out var p) ? p : 0,
        byte[] b => double.TryParse(System.Text.Encoding.UTF8.GetString(b), out var p) ? p : 0,
        _ => 0,
    };

    public async Task ReinforceAsync(long id, bool positive)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            "UPDATE knowledge SET confidence = CAST(confidence AS REAL) * (1 - @a) + @a * @target, updated_at = @now WHERE id = @id",
            new { a = Alpha, target = positive ? 1.0 : 0.0, now = DateTime.UtcNow.ToString("o"), id });
    }
}

// ---------------------------------------------------------------------------------------------
// Process log — one trail for background processes (seeder runs, imports, future jobs).
// ---------------------------------------------------------------------------------------------

public interface IProcessLog
{
    Task RecordAsync(string kind, string status, string? refId = null, string? detailJson = null);
    Task<List<ProcessLogRow>> RecentAsync(string? kind = null, int limit = 50);
}

public sealed record ProcessLogRow(long Id, string Kind, string? RefId, string Status, string? DetailJson, string CreatedAt);

public sealed class ProcessLog : IProcessLog
{
    private readonly IDbConnectionFactory _db;
    public ProcessLog(IDbConnectionFactory db) => _db = db;

    public async Task RecordAsync(string kind, string status, string? refId = null, string? detailJson = null)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            "INSERT INTO process_log(kind, ref_id, status, detail_json, created_at) " +
            "VALUES (@kind, @refId, @status, @detailJson, @now)",
            new { kind, refId, status, detailJson, now = DateTime.UtcNow.ToString("o") });
    }

    public async Task<List<ProcessLogRow>> RecentAsync(string? kind = null, int limit = 50)
    {
        using var conn = _db.Open();
        return (await conn.QueryAsync<ProcessLogRow>(
            "SELECT id, kind, ref_id, status, detail_json, created_at FROM process_log " +
            "WHERE (@kind IS NULL OR kind = @kind) ORDER BY id DESC LIMIT @limit",
            new { kind, limit })).ToList();
    }
}
