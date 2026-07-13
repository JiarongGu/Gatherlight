using Dapper;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Knowledge.Services;
using Gatherlight.Server.Modules.Library.Services;

namespace Gatherlight.Server.Modules.Memory.Services;

// Classes (not positional records): SQLite's dynamic typing breaks Dapper's strict
// positional-record materialization — same reason LibraryItem/Facet are classes.
public sealed class KnowledgeExport
{
    public string Kind { get; set; } = "";
    public string Topic { get; set; } = "";
    public string Content { get; set; } = "";
    public string? Source { get; set; }
    public double Confidence { get; set; }
}

public sealed class EntityExport
{
    public string Kind { get; set; } = "";
    public string Key { get; set; } = "";
    public string ValueJson { get; set; } = "";
}

/// <summary>A portable snapshot of the durable DB "memory" — the knowledge library + learned facts
/// + generic entity store. Transferable between installs (export here → import there). Markdown
/// plans/household ride along in the data folder's git repo; this bundle is the DB half.</summary>
public sealed class MemoryBundle
{
    public int GatherlightMemory { get; set; } = 1;
    public string ExportedAt { get; set; } = "";
    public List<LibraryItem> Library { get; set; } = new();
    public List<KnowledgeExport> Knowledge { get; set; } = new();
    public List<EntityExport> Entities { get; set; } = new();
}

public sealed record MemoryImportResult(int Library, int Knowledge, int Entities);

public interface IMemoryService
{
    Task<MemoryBundle> ExportAsync();
    /// <summary>Idempotent merge — every row is an upsert, so importing the same bundle twice is safe.</summary>
    Task<MemoryImportResult> ImportAsync(MemoryBundle bundle);
}

public sealed class MemoryService : IMemoryService
{
    private readonly IDbConnectionFactory _db;
    private readonly ILibraryRepository _library;
    private readonly IKnowledgeStore _knowledge;
    private readonly IEntityStore _entity;

    public MemoryService(IDbConnectionFactory db, ILibraryRepository library, IKnowledgeStore knowledge, IEntityStore entity)
    {
        _db = db;
        _library = library;
        _knowledge = knowledge;
        _entity = entity;
    }

    public async Task<MemoryBundle> ExportAsync()
    {
        using var conn = _db.Open();
        var library = (await conn.QueryAsync<LibraryItem>(
            "SELECT id, kind, key, name, name_local, region, summary, url, image_url, " +
            "CAST(lat AS REAL) AS lat, CAST(lng AS REAL) AS lng, tags, source, " +
            "CAST(confidence AS REAL) AS confidence, verified_at, created_at, updated_at " +
            "FROM library_item ORDER BY kind, key")).ToList();
        var knowledge = (await conn.QueryAsync<KnowledgeExport>(
            "SELECT kind, topic, content, source, CAST(confidence AS REAL) AS confidence FROM knowledge ORDER BY id")).ToList();
        var entities = (await conn.QueryAsync<EntityExport>(
            "SELECT kind, key, value_json FROM entity ORDER BY kind, key")).ToList();
        return new MemoryBundle
        {
            ExportedAt = DateTime.UtcNow.ToString("o"),
            Library = library,
            Knowledge = knowledge,
            Entities = entities,
        };
    }

    public async Task<MemoryImportResult> ImportAsync(MemoryBundle bundle)
    {
        var lib = 0;
        foreach (var it in bundle.Library ?? new())
        {
            if (string.IsNullOrEmpty(it.Kind) || string.IsNullOrEmpty(it.Key) || string.IsNullOrEmpty(it.Name)) continue;
            await _library.UpsertAsync(new LibraryUpsert(
                it.Kind, it.Key, it.Name, it.NameLocal, it.Region, it.Summary, it.Url, it.ImageUrl,
                it.Lat, it.Lng, it.Tags, it.Source, it.Confidence, it.VerifiedAt));
            lib++;
        }
        var kn = 0;
        foreach (var k in bundle.Knowledge ?? new())
        {
            if (string.IsNullOrEmpty(k.Kind) || string.IsNullOrEmpty(k.Topic)) continue;
            await _knowledge.LearnAsync(k.Kind, k.Topic, k.Content, k.Source, k.Confidence);
            kn++;
        }
        var ent = 0;
        foreach (var e in bundle.Entities ?? new())
        {
            if (string.IsNullOrEmpty(e.Kind) || string.IsNullOrEmpty(e.Key)) continue;
            await _entity.SetAsync(e.Kind, e.Key, e.ValueJson);
            ent++;
        }
        return new MemoryImportResult(lib, kn, ent);
    }
}
