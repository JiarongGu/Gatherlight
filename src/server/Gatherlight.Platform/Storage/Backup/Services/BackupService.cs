using System.IO.Compression;
using System.Text.Json;
using Gatherlight.Server.Platform.Capabilities.McpClient.Models;
using Gatherlight.Server.Platform.Capabilities.McpClient.Services;
using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Storage.DataRepo.Services;
using Gatherlight.Server.Platform.Storage.Memory.Services;

namespace Gatherlight.Server.Platform.Storage.Backup.Services;

/// <summary>Metadata at the root of a backup .zip — lets import validate it's ours + show a summary.
/// <c>ContainsCredentials</c> is stated rather than implied: the zip carries external MCP servers
/// with their env, so whoever holds the file holds those logins.</summary>
public sealed record BackupManifest(
    int GatherlightBackup, string CreatedAt, string Version, int Files,
    int MemoryLibrary, int MemoryKnowledge, int MemoryEntities, int MemoryCortex,
    int McpServers = 0, bool ContainsCredentials = false);

public sealed record BackupImportResult(
    int Files, int Library, int Knowledge, int Entities, int Cortex, int McpServers = 0);

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
/// <c>archive/</c>. The external MCP servers travel too (<c>mcp-servers.json</c>) WITH their
/// credentials, which makes the .zip itself a secret — so the manifest states that rather than
/// leaving it to be discovered. Import serializes on the <see cref="DataWriteLock"/>, replaces those
/// subtrees, reindexes, and commits.
/// </summary>
public sealed class BackupService : IBackupService
{
    // The data-folder subtrees that ARE local (records + git history). state/resources, state/logs,
    // state/cache, cache/, archive/ are regenerable/transient and left out.
    // `ui` is here because a site PAGE is household work: the agent authors it, a human approves it at
    // the diff gate, and it is tracked in the data repo like any record. Leaving it out made a restore
    // lose every page — and the loss was invisible, because the seeder immediately re-creates the
    // template's welcome page, so the directory came back looking intact with the household's own
    // dashboards gone.
    private static readonly string[] Folders = { "plans", "household", ".claude", "ui", "uploads", ".git" };
    // Individual site-root files (data-root-relative) that also travel.
    //
    // `site.json` is the SITE MANIFEST, and it is household configuration rather than app-managed
    // state: it carries `capabilities.enabled` (every Script/MCP capability a human promoted) and
    // `records` (which the scope guard renders its write-scope FROM). Restoring without it left
    // `SiteManifestStep` to write a fresh default, so a restore silently un-approved every capability
    // the household had granted and reverted any customised record set — the same class of quiet
    // regression as the scope guard rolling back to v4, and just as hard to notice, because the app
    // comes up working and merely forgets what it was allowed to do.
    private static readonly string[] RootFiles = { "CLAUDE.md", ".gitignore", "site.json" };
    // The server config lives under platform state/, not the site — travels too, resolved separately.
    private const string SettingsFile = "settings.json";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    /// <summary>The external MCP servers, with their env. WITH their credentials: a restore that gave
    /// back a server minus the token it needs would look complete and then fail at first use, and an
    /// interactive login the household did once would have to be redone with nothing saying so. The
    /// cost is stated in the manifest (<c>containsCredentials</c>) rather than left to be discovered —
    /// a backup .zip is now a secret, and it says so.</summary>
    private const string McpFile = "mcp-servers.json";

    private readonly ISiteContext _data;
    private readonly IPlatformContext _platform;
    private readonly IMemoryService _memory;
    private readonly IMcpServerStore _mcp;
    private readonly Site.Seed.Services.IAppManagedFiles _appManaged;
    private readonly IEnumerable<IRecordIndex> _indexes;
    private readonly Knowledge.Services.IFactIndex _factIndex;
    private readonly DataRepo.Services.IDataRepoMaintenance _maintenance;
    private readonly IGitCliService _git;
    private readonly DataWriteLock _writeLock;
    private readonly ILogger<BackupService> _log;

    public BackupService(ISiteContext data, IPlatformContext platform, IMemoryService memory, IMcpServerStore mcp,
        IEnumerable<IRecordIndex> indexes, IGitCliService git, DataWriteLock writeLock,
        Site.Seed.Services.IAppManagedFiles appManaged, Knowledge.Services.IFactIndex factIndex,
        DataRepo.Services.IDataRepoMaintenance maintenance, ILogger<BackupService> log)
    {
        _data = data; _platform = platform; _memory = memory; _mcp = mcp;
        _indexes = indexes; _git = git; _writeLock = writeLock; _appManaged = appManaged;
        _factIndex = factIndex; _maintenance = maintenance; _log = log;
    }

    public async Task ExportAsync(Stream output, CancellationToken ct = default)
    {
        Directory.CreateDirectory(_data.CachePath);
        var tmp = Path.Combine(_data.CachePath, $"_export-{Guid.NewGuid():N}.zip");
        try
        {
            // Build the archive under the write lock so a concurrent commit / fs-op / seeder can't tear
            // the .git tree or record files mid-read. The lock is released before the (slow) client
            // stream at the bottom — we only serialize the snapshot, not the download.
            using (await _writeLock.AcquireAsync(ct))
            {
                var mem = await _memory.ExportAsync();
                var servers = await _mcp.ListAsync();
                // Build into a temp FILE (sync file IO is fine); Kestrel disallows sync IO on the response
                // body, and ZipArchive writes synchronously.
                using var zfs = File.Create(tmp);
                using var zip = new ZipArchive(zfs, ZipArchiveMode.Create);
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
                // Directory ENTRIES for the git skeleton. A file enumeration cannot express an empty
                // directory, and a packed repo has them: gc moves refs into packed-refs and deletes the
                // loose refs/heads/<branch>, after which git will not recognise the restored folder at
                // all. Import repairs this too — but only import; someone unzipping the archive by hand
                // gets whatever the archive says, so the archive should say the truth.
                if (Directory.Exists(Path.Combine(_data.RootPath, ".git")))
                    { }
                foreach (var file in RootFiles)
                {
                    var p = Path.Combine(_data.RootPath, file);
                    if (File.Exists(p)) AddFile(p, $"data/{file}");
                }
                var settingsAbs = Path.Combine(_platform.StatePath, SettingsFile);
                if (File.Exists(settingsAbs)) AddFile(settingsAbs, $"data/state/{SettingsFile}");

                // The DB half — the same portable memory bundle as /api/memory/export.
                using (var ms = zip.CreateEntry("memory.json", CompressionLevel.Optimal).Open())
                    JsonSerializer.Serialize(ms, mem, Json);

                // The external MCP servers. They live in the mcp_server table, which nothing else here
                // carried — so a restore used to come back complete in every visible way and silently
                // without them, and every server had to be re-added (and re-logged-into) by hand.
                using (var ms = zip.CreateEntry(McpFile, CompressionLevel.Optimal).Open())
                    JsonSerializer.Serialize(ms, servers, Json);

                var manifest = new BackupManifest(1, DateTime.UtcNow.ToString("O"), Ver(), files,
                    mem.Library.Count, mem.Knowledge.Count, mem.Entities.Count, mem.Cortex.Count,
                    servers.Count, ContainsCredentials: servers.Count > 0);
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

            // Declared out here because the write lock below is SCOPED rather than `using var`: the
            // re-issue after it calls the seeder, which takes this same lock — and DataWriteLock is a
            // non-reentrant SemaphoreSlim(1,1), so holding it across that call deadlocks the import
            // outright (found exactly that way: the suite hung at the import step rather than failing).
            var restored = 0;
            var mcpRestored = 0;
            MemoryImportResult mem = new(0, 0, 0, 0);

            // The lock covers the tree replacement; the re-issue takes it again on its own.
            using (await _writeLock.AcquireAsync(ct))
            {

            // Replace the record subtrees with the backup's copy.
            var dataDir = Path.Combine(staging, "data");
            foreach (var folder in Folders)
            {
                var src = Path.Combine(dataDir, folder);
                if (!Directory.Exists(src)) continue;
                var dest = Path.Combine(_data.RootPath, folder);
                ForceDeleteDir(dest); // git objects under .git are read-only — clear the bit before deleting
                CopyTree(src, dest, ref restored);
            }
            // RepairGitSkeleton(); // TEMPORARY
            foreach (var file in RootFiles)
            {
                var src = Path.Combine(dataDir, file.Replace('/', Path.DirectorySeparatorChar));
                if (!File.Exists(src)) continue;
                var dest = Path.Combine(_data.RootPath, file.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                File.Copy(src, dest, overwrite: true);
                restored++;
            }
            {
                var src = Path.Combine(dataDir, "state", SettingsFile);
                if (File.Exists(src))
                {
                    var dest = Path.Combine(_platform.StatePath, SettingsFile);
                    Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                    File.Copy(src, dest, overwrite: true);
                    restored++;
                }
            }

            // Restore the DB memory half (idempotent upsert).
            var memPath = Path.Combine(staging, "memory.json");
            if (File.Exists(memPath))
            {
                var bundle = JsonSerializer.Deserialize<MemoryBundle>(await File.ReadAllTextAsync(memPath, ct), Json);
                if (bundle is not null) mem = await _memory.ImportAsync(bundle);
            }

            // Restore the external MCP servers (upsert by id, so re-importing is idempotent). Absent in
            // a backup taken before they travelled — that is a fine older zip, not a broken one.
            var mcpPath = Path.Combine(staging, McpFile);
            if (File.Exists(mcpPath))
            {
                var servers = JsonSerializer.Deserialize<List<McpServerConfig>>(
                    await File.ReadAllTextAsync(mcpPath, ct), Json) ?? [];
                foreach (var s in servers)
                {
                    // Status is CONNECTION state, not configuration: a restored server has not been
                    // reached yet, and importing "connected" would make the console claim a live link
                    // to a process that does not exist. Back to pending; the connect pass decides.
                    s.Status = McpServerStatus.Pending;
                    s.LastError = null;
                    s.DiscoveredToolsJson = null;
                    await _mcp.UpsertAsync(s);
                    mcpRestored++;
                }
            }

            }   // ← write lock released; the re-issue below acquires it itself

            // The restore replaced .claude/ with the ARCHIVE's copy, so every app-owned file in there
            // is now whatever the backup was taken with — the scope guard rolled back to an older
            // version, the UI contract and form maps simply gone if the archive predates them. Those
            // are derived from the app version, not household content, exactly like the record index
            // rebuilt below; and the only other caller of the re-issue is startup, so without this the
            // downgrade would last until the next restart.
            var reissued = await _appManaged.ReissueAsync(ct);
            if (reissued.Count > 0)
                _log.LogInformation("restore: re-issued {N} app-managed file(s) over the imported ones", reissued.Count);

            foreach (var ix in _indexes) await ix.RebuildAsync(ct);
            // The fact index is derived too, but it is NOT an IRecordIndex — that collection is
            // rebuilt at every startup, which would erase the decay and link state this one
            // accumulates. Import is the one moment a full rebuild is right: the facts themselves were
            // just replaced, so every graph_ref restored from the archive addresses a node that this
            // install's index never had. Left alone, recall would rank confidently against nothing and
            // silently fall through to FTS for the household's entire history.
            var reindexed = await _factIndex.RebuildAsync(ct);
            if (reindexed > 0) _log.LogInformation("restore: re-indexed {N} fact(s) for recall", reindexed);
            // Re-taken for the commit, so the restored tree and the re-issued files land in one
            // commit and no other writer can interleave between them.
            using (await _writeLock.AcquireAsync(ct))
            {
                try { await _git.EnsureRepoAsync(ct); await _git.CommitAllAsync($"restore: import backup ({restored} files)"); }
                catch (Exception ex) { _log.LogWarning("restore commit skipped: {Msg}", ex.Message); }
            }

            // Pack the objects this restore just created, OUTSIDE the lock above — DataWriteLock is
            // non-reentrant and maintenance takes it itself. An import writes a whole tree as loose
            // objects, and a loose object is already-compressed data that a zip cannot squeeze: left
            // alone they ride into the NEXT export and grow it by roughly a megabyte per restore cycle
            // without the household adding anything. Measured on a real folder: 4.86 MB exported before
            // packing, 2.79 MB after — smaller than the archive taken before any of this.
            await _maintenance.RunAsync(force: true, ct);

            _log.LogInformation("Backup imported: {Files} files · memory lib+{Lib} kn+{Kn} · mcp servers {Mcp}", restored, mem.Library, mem.Knowledge, mcpRestored);
            return new BackupImportResult(restored, mem.Library, mem.Knowledge, mem.Entities, mem.Cortex, mcpRestored);
        }
        finally
        {
            try { File.Delete(tmpZip); } catch { /* best-effort */ }
            try { ForceDeleteDir(staging); } catch { /* best-effort */ }
        }
    }

    private static void CopyTree(string src, string dest, ref int count)
    {
        Directory.CreateDirectory(dest);
        var destFull = Path.GetFullPath(dest);
        var destWithSep = destFull.EndsWith(Path.DirectorySeparatorChar) ? destFull : destFull + Path.DirectorySeparatorChar;
        foreach (var f in Directory.EnumerateFiles(src, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(dest, Path.GetRelativePath(src, f));
            // Defense-in-depth (import is a privileged whole-install replace): never write outside dest,
            // even if a symlink/crafted entry in the uploaded archive resolves the target elsewhere.
            if (!Path.GetFullPath(target).StartsWith(destWithSep, StringComparison.OrdinalIgnoreCase)) continue;
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            if (File.Exists(target)) ClearReadOnly(target);
            File.Copy(f, target, overwrite: true);
            count++;
        }
    }

    // Delete a directory even if it holds read-only files (git keeps .git/objects/* read-only, which
    // otherwise makes Directory.Delete / File.Copy(overwrite) throw UnauthorizedAccessException).
    /// <summary>
    /// Re-create the directories git needs but a zip cannot carry.
    ///
    /// <para>A zip built from a FILE enumeration cannot represent an empty directory, and a packed repo
    /// has several: <c>git gc</c> moves every ref into <c>packed-refs</c> and deletes the loose
    /// <c>refs/heads/&lt;branch&gt;</c> file, leaving <c>refs/</c> empty. Git then refuses to recognise
    /// the restored directory at all — <c>fatal: not in a git directory</c> — and the very first thing
    /// startup does to a data folder is <c>git config</c>, so the failure lands as
    /// "初始化数据仓库 failed (128)" with no hint that the history is perfectly intact three inches
    /// away in <c>packed-refs</c>.</para>
    ///
    /// <para>This became reachable the moment the app started packing on its own
    /// (<see cref="DataRepo.Services.IDataRepoMaintenance"/>): before that, refs happened to stay loose
    /// and the gap never showed. Repairing on IMPORT rather than fixing the exporter is deliberate — it
    /// also rescues archives already in circulation, which the exporter cannot.</para>
    /// </summary>
    private void RepairGitSkeleton()
    {
        var git = Path.Combine(_data.RootPath, ".git");
        if (!Directory.Exists(git)) return;
        foreach (var rel in new[] { "refs/heads", "refs/tags", "objects/info", "objects/pack" })
        {
            var abs = Path.Combine(git, rel.Replace('/', Path.DirectorySeparatorChar));
            if (Directory.Exists(abs)) continue;
            Directory.CreateDirectory(abs);
            _log.LogInformation("restore: re-created .git/{Rel} (a zip cannot carry an empty directory)", rel);
        }
    }

    private static void ForceDeleteDir(string dir)
    {
        if (!Directory.Exists(dir)) return;
        foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)) ClearReadOnly(f);
        Directory.Delete(dir, recursive: true);
    }

    private static void ClearReadOnly(string file)
    {
        try
        {
            var attr = File.GetAttributes(file);
            if ((attr & FileAttributes.ReadOnly) != 0) File.SetAttributes(file, attr & ~FileAttributes.ReadOnly);
        }
        catch { /* best-effort */ }
    }

    private static string Ver() => AppVersion.Semver;
}
