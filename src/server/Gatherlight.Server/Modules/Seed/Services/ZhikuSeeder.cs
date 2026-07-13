using System.Security.Cryptography;
using System.Text.Json;
using Dapper;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.DataRepo.Services;

namespace Gatherlight.Server.Modules.Seed.Services;

public sealed record ZhikuStatus(
    string Version, string RanAt,
    List<string> Seeded, List<string> Upgraded, List<string> Skipped);

/// <summary>
/// Seeds/updates the planner knowledge base (智库) in the data folder from the shipped template
/// (Assets/DataTemplate, copied next to the exe). Per file: absent → write; present and still
/// byte-identical to what WE last shipped → safe to upgrade; present but user-modified (or
/// pre-existing with no shipping record, e.g. an imported legacy workspace) → never touched,
/// reported instead. Writes commit to the data repo as one `zhiku: seed` commit.
/// </summary>
public interface IZhikuSeeder
{
    Task<ZhikuStatus?> SeedAsync(CancellationToken ct = default);
    Task<ZhikuStatus?> LastStatusAsync();
}

public sealed class ZhikuSeeder : IZhikuSeeder
{
    private readonly IDataContext _data;
    private readonly IDbConnectionFactory _db;
    private readonly IGitCliService _git;
    private readonly IDataCommitRepository _commits;
    private readonly DataWriteLock _writeLock;
    private readonly Knowledge.Services.IProcessLog _processLog;
    private readonly ILogger<ZhikuSeeder> _log;

    public ZhikuSeeder(
        IDataContext data, IDbConnectionFactory db, IGitCliService git,
        IDataCommitRepository commits, DataWriteLock writeLock,
        Knowledge.Services.IProcessLog processLog, ILogger<ZhikuSeeder> log)
    {
        _processLog = processLog;
        _data = data;
        _db = db;
        _git = git;
        _commits = commits;
        _writeLock = writeLock;
        _log = log;
    }

    public static string TemplateRoot => Path.Combine(AppContext.BaseDirectory, "Assets", "DataTemplate");

    public async Task<ZhikuStatus?> SeedAsync(CancellationToken ct = default)
    {
        if (!Directory.Exists(TemplateRoot))
        {
            _log.LogWarning("Knowledge-base template missing at {Root} — seeding skipped", TemplateRoot);
            return null;
        }

        var templateFiles = Directory.EnumerateFiles(TemplateRoot, "*", SearchOption.AllDirectories)
            .Select(abs => (Abs: abs, Rel: Path.GetRelativePath(TemplateRoot, abs).Replace('\\', '/')))
            .OrderBy(f => f.Rel, StringComparer.Ordinal)
            .ToList();

        // Version = aggregate of shipped content — changes exactly when the template does.
        var version = AggregateHash(templateFiles.Select(f => f.Abs));

        var seeded = new List<string>();
        var upgraded = new List<string>();
        var skipped = new List<string>();

        using var _ = await _writeLock.AcquireAsync(ct);
        foreach (var (abs, rel) in templateFiles)
        {
            var templateBytes = await File.ReadAllBytesAsync(abs, ct);
            var templateHash = Hash(templateBytes);
            var targetAbs = _data.ResolveDataPath(rel)!;
            var recorded = await GetStateAsync($"shipped:{rel}");

            if (!File.Exists(targetAbs))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(targetAbs)!);
                await File.WriteAllBytesAsync(targetAbs, templateBytes, ct);
                await SetStateAsync($"shipped:{rel}", templateHash);
                seeded.Add(rel);
                continue;
            }

            var currentHash = Hash(await File.ReadAllBytesAsync(targetAbs, ct));
            if (currentHash == templateHash)
            {
                // Already identical (fresh seed earlier, or user file that happens to match) —
                // record so future upgrades know this content came from us.
                if (recorded != templateHash) await SetStateAsync($"shipped:{rel}", templateHash);
                continue;
            }
            if (recorded is not null && currentHash == recorded)
            {
                // Unmodified since we shipped it → safe upgrade.
                await File.WriteAllBytesAsync(targetAbs, templateBytes, ct);
                await SetStateAsync($"shipped:{rel}", templateHash);
                upgraded.Add(rel);
                continue;
            }
            // User-modified, or pre-existing content we never shipped (imported workspace) —
            // their knowledge base, not ours to overwrite.
            skipped.Add(rel);
        }

        var status = new ZhikuStatus(version, DateTime.UtcNow.ToString("o"), seeded, upgraded, skipped);
        await SetStateAsync("last_report", JsonSerializer.Serialize(status));
        await _processLog.RecordAsync("zhiku-seed",
            seeded.Count + upgraded.Count > 0 ? "applied" : "no-op",
            version[..8], JsonSerializer.Serialize(status));

        var written = seeded.Concat(upgraded).ToList();
        if (written.Count > 0)
        {
            var sha = await _git.CommitPathsAsync(written, $"zhiku: seed template {version[..8]}", ct);
            _commits.Record(sha, $"zhiku: seed template {version[..8]}", "seed");
            _log.LogInformation("Knowledge base seeded: {Seeded} new, {Upgraded} upgraded, {Skipped} kept (user-modified)",
                seeded.Count, upgraded.Count, skipped.Count);
        }
        return status;
    }

    public async Task<ZhikuStatus?> LastStatusAsync()
    {
        var raw = await GetStateAsync("last_report");
        return raw is null ? null : JsonSerializer.Deserialize<ZhikuStatus>(raw);
    }

    private async Task<string?> GetStateAsync(string key)
    {
        using var conn = _db.Open();
        return await conn.QuerySingleOrDefaultAsync<string>(
            "SELECT value FROM zhiku_state WHERE key = @key", new { key });
    }

    private async Task SetStateAsync(string key, string value)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            "INSERT INTO zhiku_state(key, value) VALUES (@key, @value) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            new { key, value });
    }

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static string AggregateHash(IEnumerable<string> files)
    {
        using var sha = SHA256.Create();
        foreach (var f in files)
        {
            var content = File.ReadAllBytes(f);
            sha.TransformBlock(content, 0, content.Length, null, 0);
        }
        sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
        return Convert.ToHexString(sha.Hash!).ToLowerInvariant();
    }
}
