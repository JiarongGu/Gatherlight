using System.IO.Compression;
using System.Text.Json;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.DataRepo.Services;
using Gatherlight.Server.Modules.Memory.Services;
using Gatherlight.Server.Modules.PlanIndex.Services;

namespace Gatherlight.Server.Modules.Backup.Services;

/// <summary>Metadata at the root of a backup .zip — lets import validate it's ours + show a summary.</summary>
public sealed record BackupManifest(
    int GatherlightBackup, string CreatedAt, string Version, int Files,
    int MemoryLibrary, int MemoryKnowledge, int MemoryEntities, int MemoryCortex);

public sealed record BackupImportResult(int Files, int Library, int Knowledge, int Entities, int Cortex);

public interface IBackupService
{
    /// <summary>Write a full backup .zip (data-folder records + the DB memory) to <paramref name="output"/>.</summary>
    Task ExportAsync(Stream output, CancellationToken ct = default);
    /// <summary>Restore a backup .zip: replace the record subtrees, import the memory, reindex, commit.</summary>
    Task<BackupImportResult> ImportAsync(Stream input, CancellationToken ct = default);
}

/// <summary>
/// The whole-install backup: EVERYTHING in the data folder that matters, in one .zip, so a data folder
/// is disposable + portable — export here, import there (or after a wipe) restores it. Contents: the
/// records (plans / household / .claude / CLAUDE.md / uploads), the git history (<c>.git</c>, the audit
/// trail), the server config (<c>state/settings.json</c>), and the DB memory (<c>memory.json</c> — the
/// same bundle as /api/memory; the raw DB isn't copied because its durable half travels here and the
/// rest — plan index, chat — is rebuildable). Only the regenerable/transient bits are left out:
/// <c>state/resources</c> (from nuget), <c>state/logs</c>, <c>state/cache</c>, <c>cache/</c>,
/// <c>archive/</c>. Import serializes on the <see cref="DataWriteLock"/>, replaces those subtrees,
/// reindexes, and commits.
/// </summary>
public sealed class BackupService : IBackupService
{
    // The data-folder subtrees that ARE local (records + git history). state/resources, state/logs,
    // state/cache, cache/, archive/ are regenerable/transient and left out.
    private static readonly string[] Folders = { "plans", "household", ".claude", "uploads", ".git" };
    // Individual files (data-root-relative) that also travel — top-level + the server config.
    private static readonly string[] RootFiles = { "CLAUDE.md", ".gitignore", "state/settings.json" };

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly IDataContext _data;
    private readonly IMemoryService _memory;
    private readonly IPlanIndexService _index;
    private readonly IGitCliService _git;
    private readonly DataWriteLock _writeLock;
    private readonly ILogger<BackupService> _log;

    public BackupService(IDataContext data, IMemoryService memory, IPlanIndexService index,
        IGitCliService git, DataWriteLock writeLock, ILogger<BackupService> log)
    {
        _data = data; _memory = memory; _index = index; _git = git; _writeLock = writeLock; _log = log;
    }

    public async Task ExportAsync(Stream output, CancellationToken ct = default)
    {
        var mem = await _memory.ExportAsync();
        Directory.CreateDirectory(_data.CachePath);
        var tmp = Path.Combine(_data.CachePath, $"_export-{Guid.NewGuid():N}.zip");
        try
        {
            // Build into a temp FILE (sync file IO is fine); Kestrel disallows sync IO on the response
            // body, and ZipArchive writes synchronously.
            using (var zfs = File.Create(tmp))
            using (var zip = new ZipArchive(zfs, ZipArchiveMode.Create))
            {
                var files = 0;
                void AddFile(string abs, string entryPath)
                {
                    var entry = zip.CreateEntry(entryPath.Replace('\\', '/'), CompressionLevel.Optimal);
                    using var es = entry.Open();
                    using var src = File.OpenRead(abs);
                    src.CopyTo(es);
                    files++;
                }

                foreach (var folder in Folders)
                {
                    var dir = Path.Combine(_data.RootPath, folder);
                    if (!Directory.Exists(dir)) continue;
                    foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
                        AddFile(f, $"data/{folder}/{Path.GetRelativePath(dir, f)}");
                }
                foreach (var file in RootFiles)
                {
                    var p = Path.Combine(_data.RootPath, file);
                    if (File.Exists(p)) AddFile(p, $"data/{file}");
                }

                // The DB half — the same portable memory bundle as /api/memory/export.
                using (var ms = zip.CreateEntry("memory.json", CompressionLevel.Optimal).Open())
                    JsonSerializer.Serialize(ms, mem, Json);

                var manifest = new BackupManifest(1, DateTime.UtcNow.ToString("O"), Ver(), files,
                    mem.Library.Count, mem.Knowledge.Count, mem.Entities.Count, mem.Cortex.Count);
                using (var ms = zip.CreateEntry("manifest.json", CompressionLevel.Optimal).Open())
                    JsonSerializer.Serialize(ms, manifest, Json);
            }

            await using var read = File.OpenRead(tmp);
            await read.CopyToAsync(output, ct);
        }
        finally { try { File.Delete(tmp); } catch { /* best-effort */ } }
    }

    public async Task<BackupImportResult> ImportAsync(Stream input, CancellationToken ct = default)
    {
        Directory.CreateDirectory(_data.CachePath);
        var tmpZip = Path.Combine(_data.CachePath, $"_import-{Guid.NewGuid():N}.zip");
        var staging = Path.Combine(_data.CachePath, $"_restore-{Guid.NewGuid():N}");
        Directory.CreateDirectory(staging);
        try
        {
            // Copy the request body to a temp file async (Kestrel disallows sync IO on the body), then
            // extract from the file.
            await using (var fs = File.Create(tmpZip)) await input.CopyToAsync(fs, ct);
            ZipFile.ExtractToDirectory(tmpZip, staging, overwriteFiles: true);

            var manifestPath = Path.Combine(staging, "manifest.json");
            if (!File.Exists(manifestPath)) throw new InvalidOperationException("不是有效的 Gatherlight 备份(缺少 manifest.json)");
            var manifest = JsonSerializer.Deserialize<BackupManifest>(await File.ReadAllTextAsync(manifestPath, ct), Json);
            if (manifest is null || manifest.GatherlightBackup < 1) throw new InvalidOperationException("不是有效的 Gatherlight 备份");

            using var _ = await _writeLock.AcquireAsync(ct);

            // Replace the record subtrees with the backup's copy.
            var dataDir = Path.Combine(staging, "data");
            var restored = 0;
            foreach (var folder in Folders)
            {
                var src = Path.Combine(dataDir, folder);
                if (!Directory.Exists(src)) continue;
                var dest = Path.Combine(_data.RootPath, folder);
                if (Directory.Exists(dest)) Directory.Delete(dest, recursive: true);
                CopyTree(src, dest, ref restored);
            }
            foreach (var file in RootFiles)
            {
                var src = Path.Combine(dataDir, file.Replace('/', Path.DirectorySeparatorChar));
                if (!File.Exists(src)) continue;
                var dest = Path.Combine(_data.RootPath, file.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                File.Copy(src, dest, overwrite: true);
                restored++;
            }

            // Restore the DB memory half (idempotent upsert).
            MemoryImportResult mem = new(0, 0, 0, 0);
            var memPath = Path.Combine(staging, "memory.json");
            if (File.Exists(memPath))
            {
                var bundle = JsonSerializer.Deserialize<MemoryBundle>(await File.ReadAllTextAsync(memPath, ct), Json);
                if (bundle is not null) mem = await _memory.ImportAsync(bundle);
            }

            await _index.RescanAsync(ct);
            try { await _git.EnsureRepoAsync(ct); await _git.CommitAllAsync($"restore: import backup ({restored} files)"); }
            catch (Exception ex) { _log.LogWarning("restore commit skipped: {Msg}", ex.Message); }

            _log.LogInformation("Backup imported: {Files} files · memory lib+{Lib} kn+{Kn}", restored, mem.Library, mem.Knowledge);
            return new BackupImportResult(restored, mem.Library, mem.Knowledge, mem.Entities, mem.Cortex);
        }
        finally
        {
            try { File.Delete(tmpZip); } catch { /* best-effort */ }
            try { Directory.Delete(staging, recursive: true); } catch { /* best-effort */ }
        }
    }

    private static void CopyTree(string src, string dest, ref int count)
    {
        Directory.CreateDirectory(dest);
        foreach (var f in Directory.EnumerateFiles(src, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(dest, Path.GetRelativePath(src, f));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(f, target, overwrite: true);
            count++;
        }
    }

    private static string Ver() => typeof(BackupService).Assembly.GetName().Version?.ToString() ?? "?";
}
