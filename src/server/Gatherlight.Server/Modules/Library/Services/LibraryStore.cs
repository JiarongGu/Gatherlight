using Dapper;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.Library.Services;

/// <summary>One verified reference entity in the knowledge library.</summary>
public sealed class LibraryItem
{
    public long Id { get; set; }
    public string Kind { get; set; } = "";
    public string Key { get; set; } = "";
    public string Name { get; set; } = "";
    public string? NameLocal { get; set; }
    public string? Region { get; set; }
    public string? Summary { get; set; }
    public string? Url { get; set; }
    public string? ImageUrl { get; set; }
    public double? Lat { get; set; }
    public double? Lng { get; set; }
    public string? Tags { get; set; }
    public string? Source { get; set; }
    public double Confidence { get; set; }
    public string? VerifiedAt { get; set; }
    public string CreatedAt { get; set; } = "";
    public string UpdatedAt { get; set; } = "";
}

/// <summary>Payload for an upsert — everything but the surrogate id and timestamps.</summary>
public sealed record LibraryUpsert(
    string Kind, string Key, string Name, string? NameLocal, string? Region, string? Summary,
    string? Url, string? ImageUrl, double? Lat, double? Lng, string? Tags, string? Source,
    double? Confidence, string? VerifiedAt);

// A class, not a positional record: SQLite's dynamic typing breaks Dapper's strict
// positional-record materialization (same reason KnowledgeStore maps by hand).
public sealed class Facet
{
    public string Value { get; set; } = "";
    public int Count { get; set; }
}

public sealed record LibraryFacets(List<Facet> Kinds, List<Facet> Regions, int Total);

public interface ILibraryRepository
{
    Task<LibraryItem> UpsertAsync(LibraryUpsert input);
    Task<List<LibraryItem>> QueryAsync(string? kind, string? region, string? q, int limit);
    Task<LibraryItem?> GetAsync(string kind, string key);
    Task<bool> DeleteAsync(string kind, string key);
    Task<LibraryFacets> FacetsAsync();
}

public sealed class LibraryRepository : ILibraryRepository
{
    // SQLite integer affinity: doubles stored as INTEGER materialize wrong unless CAST to REAL.
    private const string Cols =
        "id, kind, key, name, name_local, region, summary, url, image_url, " +
        "CAST(lat AS REAL) AS lat, CAST(lng AS REAL) AS lng, tags, source, " +
        "CAST(confidence AS REAL) AS confidence, verified_at, created_at, updated_at";

    // Same columns, qualified with the library_item alias `li` for the FTS join.
    private const string ColsLi =
        "li.id, li.kind, li.key, li.name, li.name_local, li.region, li.summary, li.url, li.image_url, " +
        "CAST(li.lat AS REAL) AS lat, CAST(li.lng AS REAL) AS lng, li.tags, li.source, " +
        "CAST(li.confidence AS REAL) AS confidence, li.verified_at, li.created_at, li.updated_at";

    private readonly IDbConnectionFactory _db;
    public LibraryRepository(IDbConnectionFactory db) => _db = db;

    public async Task<LibraryItem> UpsertAsync(LibraryUpsert input)
    {
        using var conn = _db.Open();
        var now = DateTime.UtcNow.ToString("o");
        await conn.ExecuteAsync(
            """
            INSERT INTO library_item
              (kind, key, name, name_local, region, summary, url, image_url, lat, lng, tags, source, confidence, verified_at, created_at, updated_at)
            VALUES
              (@Kind, @Key, @Name, @NameLocal, @Region, @Summary, @Url, @ImageUrl, @Lat, @Lng, @Tags, @Source, @Confidence, @VerifiedAt, @Now, @Now)
            ON CONFLICT(kind, key) DO UPDATE SET
              name = excluded.name, name_local = excluded.name_local, region = excluded.region,
              summary = excluded.summary, url = excluded.url, image_url = excluded.image_url,
              lat = excluded.lat, lng = excluded.lng, tags = excluded.tags, source = excluded.source,
              confidence = excluded.confidence, verified_at = excluded.verified_at, updated_at = excluded.updated_at
            """,
            new
            {
                input.Kind, input.Key, input.Name, input.NameLocal, input.Region, input.Summary,
                input.Url, input.ImageUrl, input.Lat, input.Lng, input.Tags, input.Source,
                Confidence = Math.Clamp(input.Confidence ?? 0.7, 0, 1),
                input.VerifiedAt, Now = now,
            });
        return (await GetAsync(input.Kind, input.Key))!;
    }

    public async Task<List<LibraryItem>> QueryAsync(string? kind, string? region, string? q, int limit)
    {
        using var conn = _db.Open();
        limit = Math.Clamp(limit, 1, 500);

        // FTS5 (BM25-ranked, trigram) when the query has a usable ≥3-char token; else LIKE.
        var match = FtsQuery.Build(q);
        if (match is not null)
        {
            return (await conn.QueryAsync<LibraryItem>(
                $"""
                SELECT {ColsLi} FROM library_fts JOIN library_item li ON li.id = library_fts.rowid
                WHERE library_fts MATCH @match
                  AND (@kind IS NULL OR li.kind = @kind)
                  AND (@region IS NULL OR li.region = @region)
                ORDER BY CAST(li.confidence AS REAL) DESC, bm25(library_fts)
                LIMIT @limit
                """,
                new { match, kind, region, limit })).ToList();
        }

        var like = q is { Length: > 0 } ? $"%{q}%" : null;
        return (await conn.QueryAsync<LibraryItem>(
            $"""
            SELECT {Cols} FROM library_item
            WHERE (@kind IS NULL OR kind = @kind)
              AND (@region IS NULL OR region = @region)
              AND (@like IS NULL OR name LIKE @like OR name_local LIKE @like OR summary LIKE @like OR tags LIKE @like)
            ORDER BY CAST(confidence AS REAL) DESC, name ASC
            LIMIT @limit
            """,
            new { kind, region, like, limit })).ToList();
    }

    public async Task<LibraryItem?> GetAsync(string kind, string key)
    {
        using var conn = _db.Open();
        return await conn.QuerySingleOrDefaultAsync<LibraryItem>(
            $"SELECT {Cols} FROM library_item WHERE kind = @kind AND key = @key", new { kind, key });
    }

    public async Task<bool> DeleteAsync(string kind, string key)
    {
        using var conn = _db.Open();
        return await conn.ExecuteAsync(
            "DELETE FROM library_item WHERE kind = @kind AND key = @key", new { kind, key }) > 0;
    }

    public async Task<LibraryFacets> FacetsAsync()
    {
        using var conn = _db.Open();
        var kinds = (await conn.QueryAsync<Facet>(
            "SELECT kind AS Value, COUNT(*) AS Count FROM library_item GROUP BY kind ORDER BY Count DESC, kind ASC")).ToList();
        var regions = (await conn.QueryAsync<Facet>(
            "SELECT region AS Value, COUNT(*) AS Count FROM library_item WHERE region IS NOT NULL AND region <> '' GROUP BY region ORDER BY Count DESC, region ASC")).ToList();
        var total = kinds.Sum(k => k.Count);
        return new LibraryFacets(kinds, regions, total);
    }
}
