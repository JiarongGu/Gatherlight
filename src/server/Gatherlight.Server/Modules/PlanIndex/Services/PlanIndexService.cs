using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Dapper;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.PlanIndex.Services;

public sealed record PlanIndexEntry(
    string Path, string Category, string? Subgroup, string Name, string Title,
    string? PlanDate, string ContentHash, long SizeBytes, string UpdatedAt);

public sealed record PlanAssetEntry(
    string Path, string Slug, string Category, string Kind, string Filename, long SizeBytes);

/// <summary>
/// Derived SQLite index over the markdown tree in the data folder — powers browse/search with
/// zero LLM tokens. Categorization/title/slug logic ported from the legacy viewer's
/// build-time glob (collectFiles.ts); the files themselves stay the source of truth.
/// </summary>
public interface IPlanIndexService
{
    /// <summary>Full rescan: walk the data folder, upsert every entry, remove vanished paths.</summary>
    Task RescanAsync(CancellationToken ct = default);
    List<PlanIndexEntry> List();
    List<PlanAssetEntry> ListAssets();
    List<PlanIndexEntry> Search(string query, int limit = 50);
}

public sealed partial class PlanIndexService : IPlanIndexService
{
    private readonly IDataContext _data;
    private readonly IDbConnectionFactory _db;
    private readonly ILogger<PlanIndexService> _log;

    public PlanIndexService(IDataContext data, IDbConnectionFactory db, ILogger<PlanIndexService> log)
    {
        _data = data;
        _db = db;
        _log = log;
    }

    public Task RescanAsync(CancellationToken ct = default)
    {
        var entries = new List<PlanIndexEntry>();
        var assets = new List<PlanAssetEntry>();

        foreach (var rel in EnumerateMarkdown())
        {
            ct.ThrowIfCancellationRequested();
            var abs = Path.Combine(_data.RootPath, rel.Replace('/', Path.DirectorySeparatorChar));
            string content;
            try { content = File.ReadAllText(abs); }
            catch (IOException) { continue; } // mid-write; the watcher will rescan again
            var fi = new FileInfo(abs);
            var (category, subgroup) = Categorise(rel);
            var name = rel.StartsWith(".claude/skills/")
                ? rel.Split('/')[^2]
                : Path.GetFileNameWithoutExtension(rel);
            entries.Add(new PlanIndexEntry(
                Path: rel,
                Category: category,
                Subgroup: subgroup,
                Name: name,
                Title: ExtractTitle(content, name),
                PlanDate: ExtractPlanDate(name),
                ContentHash: Hash(content),
                SizeBytes: fi.Length,
                UpdatedAt: fi.LastWriteTimeUtc.ToString("o")));
        }

        // Trip-paired non-markdown assets: plans/visa/<slug>/<file>.{pdf,json}
        var visaRoot = Path.Combine(_data.PlansPath, "visa");
        if (Directory.Exists(visaRoot))
        {
            foreach (var abs in Directory.EnumerateFiles(visaRoot, "*", SearchOption.AllDirectories))
            {
                var rel = _data.ToRelativePath(abs);
                if (rel is null) continue;
                var parts = rel.Split('/');
                if (parts.Length < 4) continue; // plans/visa/<slug>/<file>
                var ext = Path.GetExtension(abs).ToLowerInvariant();
                if (ext is not (".pdf" or ".json")) continue;
                assets.Add(new PlanAssetEntry(
                    Path: rel,
                    Slug: parts[2],
                    Category: "visa",
                    Kind: ext.TrimStart('.'),
                    Filename: string.Join('/', parts[3..]),
                    SizeBytes: new FileInfo(abs).Length));
            }
        }

        using var conn = _db.Open();
        using var tx = conn.BeginTransaction();
        conn.Execute("DELETE FROM plan_index", transaction: tx);
        conn.Execute(
            "INSERT INTO plan_index(path, category, subgroup, name, title, plan_date, content_hash, size_bytes, updated_at) " +
            "VALUES (@Path, @Category, @Subgroup, @Name, @Title, @PlanDate, @ContentHash, @SizeBytes, @UpdatedAt)",
            entries, transaction: tx);
        conn.Execute("DELETE FROM plan_asset", transaction: tx);
        conn.Execute(
            "INSERT INTO plan_asset(path, slug, category, kind, filename, size_bytes) " +
            "VALUES (@Path, @Slug, @Category, @Kind, @Filename, @SizeBytes)",
            assets, transaction: tx);
        tx.Commit();

        _log.LogInformation("Plan index rescanned: {Files} files, {Assets} assets", entries.Count, assets.Count);
        return Task.CompletedTask;
    }

    public List<PlanIndexEntry> List()
    {
        using var conn = _db.Open();
        return conn.Query<PlanIndexEntry>(
            "SELECT path, category, subgroup, name, title, plan_date, content_hash, size_bytes, updated_at " +
            "FROM plan_index ORDER BY category, name DESC").ToList();
    }

    public List<PlanAssetEntry> ListAssets()
    {
        using var conn = _db.Open();
        return conn.Query<PlanAssetEntry>(
            "SELECT path, slug, category, kind, filename, size_bytes FROM plan_asset ORDER BY path").ToList();
    }

    public List<PlanIndexEntry> Search(string query, int limit = 50)
    {
        using var conn = _db.Open();
        var like = $"%{query}%";
        return conn.Query<PlanIndexEntry>(
            "SELECT path, category, subgroup, name, title, plan_date, content_hash, size_bytes, updated_at " +
            "FROM plan_index WHERE title LIKE @like OR name LIKE @like OR path LIKE @like " +
            "ORDER BY updated_at DESC LIMIT @limit", new { like, limit }).ToList();
    }

    /// <summary>Markdown files the index covers: user content (plans/, household/) + the planner
    /// knowledge base categories the viewer displays.</summary>
    private IEnumerable<string> EnumerateMarkdown()
    {
        var roots = new[]
        {
            "plans", "household",
            ".claude/templates", ".claude/workflows", ".claude/rules", ".claude/skills",
            ".claude/keywords", ".claude/dev",
        };
        foreach (var root in roots)
        {
            var abs = Path.Combine(_data.RootPath, root.Replace('/', Path.DirectorySeparatorChar));
            if (!Directory.Exists(abs)) continue;
            foreach (var f in Directory.EnumerateFiles(abs, "*.md", SearchOption.AllDirectories))
            {
                var rel = _data.ToRelativePath(f);
                if (rel is not null) yield return rel;
            }
        }
        foreach (var single in new[] { ".claude/AI_GUIDE.md", ".claude/KEYWORDS_INDEX.md" })
        {
            if (File.Exists(Path.Combine(_data.RootPath, single.Replace('/', Path.DirectorySeparatorChar))))
                yield return single;
        }
    }

    internal static (string Category, string? Subgroup) Categorise(string path)
    {
        var filename = path.Split('/')[^1];
        if (path.StartsWith("plans/trips/")) return ("Trips", ExtractDestinationSlug(filename));
        if (path.StartsWith("plans/daily/")) return ("Daily", filename.Length >= 4 ? filename[..4] : null);
        if (path.StartsWith("plans/weekly/")) return ("Weekly", filename.Length >= 4 ? filename[..4] : null);
        if (path.StartsWith("plans/budgets/")) return ("Budgets", ExtractDestinationSlug(filename));
        if (path.StartsWith("plans/packing/")) return ("Packing", ExtractDestinationSlug(filename));
        if (path.StartsWith("plans/visa/"))
        {
            var parts = path.Split('/'); // plans / visa / <slug> / file
            return ("Visa", parts.Length > 2 ? parts[2] : null);
        }
        if (path.StartsWith("household/")) return ("Household", null);
        if (path.StartsWith(".claude/templates/")) return ("Templates", null);
        if (path.StartsWith(".claude/workflows/")) return ("Workflows", null);
        if (path.StartsWith(".claude/keywords/") || path is ".claude/AI_GUIDE.md" or ".claude/KEYWORDS_INDEX.md")
            return ("Index", null);
        if (path.StartsWith(".claude/rules/")) return ("Rules", null);
        if (path.StartsWith(".claude/skills/")) return ("Skills", null);
        if (path.StartsWith(".claude/dev/")) return ("Dev", null);
        return ("Other", null);
    }

    internal static string ExtractTitle(string content, string fallback)
    {
        var m = TitleRegex().Match(content);
        return m.Success ? m.Groups[1].Value.Trim() : fallback;
    }

    /// <summary>plans/trips/YYYY-MM-&lt;destination&gt;.md → destination (paired budgets/packing
    /// share the slug so files group under the same destination).</summary>
    internal static string? ExtractDestinationSlug(string filename)
    {
        var stripped = filename.EndsWith(".md") ? filename[..^3] : filename;
        var m = SlugRegex().Match(stripped);
        return m.Success ? m.Groups[1].Value : null;
    }

    /// <summary>Leading date prefix of the filename (YYYY-MM-DD or YYYY-MM) for zero-LLM sorting.</summary>
    internal static string? ExtractPlanDate(string name)
    {
        var m = DateRegex().Match(name);
        return m.Success ? m.Groups[1].Value : null;
    }

    private static string Hash(string content)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(content));
        return Convert.ToHexString(bytes, 0, 8).ToLowerInvariant();
    }

    [GeneratedRegex(@"^#\s+(.+)$", RegexOptions.Multiline)]
    private static partial Regex TitleRegex();

    [GeneratedRegex(@"^\d{4}-\d{2}-(.+)$")]
    private static partial Regex SlugRegex();

    [GeneratedRegex(@"^(\d{4}-\d{2}(?:-\d{2})?)")]
    private static partial Regex DateRegex();
}
