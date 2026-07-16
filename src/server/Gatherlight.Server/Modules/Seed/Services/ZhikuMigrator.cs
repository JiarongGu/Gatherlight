using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.DataRepo.Services;
using Gatherlight.Server.Modules.Jobs.Models;
using Gatherlight.Server.Modules.Jobs.Services;
using Gatherlight.Server.Modules.Llm.Models;
using Gatherlight.Server.Modules.Llm.Services;

namespace Gatherlight.Server.Modules.Seed.Services;

public sealed record KbUpgrade(string Path);
public sealed record KbMigrationStatus(List<KbUpgrade> Available, bool HasStaged, List<DiffFile>? Staged, string? StagedAt);
public sealed record KbMigrationResult(int Merged, int Failed, bool Staged, string? Error);

/// <summary>
/// Knowledge-base upgrade migration (sub-project 2). Reconciles a user's CUSTOMIZED <c>.claude/</c>
/// files with shipped template improvements that <see cref="ZhikuSeeder"/> otherwise skips forever.
/// Detection is zero-LLM (hash comparison against the <c>shipped:{rel}</c> state). The merge is an
/// opt-in one-shot <c>claude</c> per file (2-way: user's current + new template → merged), staged for
/// human review via the same git patch-capture the background jobs use. See docs/kb-migration-design.md.
/// </summary>
public interface IZhikuMigrator
{
    Task<List<KbUpgrade>> DetectUpgradesAsync();
    /// <summary>Startup: notify once per changed candidate-set (no re-nag every boot). Returns count.</summary>
    Task<int> NotifyIfUpgradesAsync();
    Task<KbMigrationStatus> GetStatusAsync();
    Task<KbMigrationResult> RunMigrationAsync(CancellationToken ct = default);
    Task<(bool Ok, string? Error, string? Sha)> ApproveAsync(CancellationToken ct = default);
    Task<bool> RejectAsync();
}

public sealed class ZhikuMigrator : IZhikuMigrator
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly IDataContext _data;
    private readonly IDbConnectionFactory _db;
    private readonly IClaudeCliRunner _runner;
    private readonly IPromptHarness _harness;
    private readonly IAppConfigService _appConfig;
    private readonly IGitCliService _git;
    private readonly DataWriteLock _writeLock;
    private readonly IDataCommitRepository _commits;
    private readonly INotificationService _notifications;
    private readonly ILogger<ZhikuMigrator> _log;

    public ZhikuMigrator(
        IDataContext data, IDbConnectionFactory db, IClaudeCliRunner runner, IPromptHarness harness,
        IAppConfigService appConfig, IGitCliService git, DataWriteLock writeLock, IDataCommitRepository commits,
        INotificationService notifications, ILogger<ZhikuMigrator> log)
    {
        _data = data;
        _db = db;
        _runner = runner;
        _harness = harness;
        _appConfig = appConfig;
        _git = git;
        _writeLock = writeLock;
        _commits = commits;
        _notifications = notifications;
        _log = log;
    }

    private string StagedPath => Path.Combine(_data.StatePath, "kb-migration-staged.json");

    // Scope (per decision): the .claude/ knowledge base + CLAUDE.md only.
    private static bool InScope(string rel) => rel == "CLAUDE.md" || rel.StartsWith(".claude/");

    public async Task<List<KbUpgrade>> DetectUpgradesAsync()
    {
        var root = ZhikuSeeder.TemplateRoot;
        if (!Directory.Exists(root)) return new();

        var result = new List<KbUpgrade>();
        foreach (var abs in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(root, abs).Replace('\\', '/');
            if (!InScope(rel)) continue;
            var target = _data.ResolveDataPath(rel);
            if (target is null || !File.Exists(target)) continue;      // absent → seeder writes it fresh, not a merge

            var shipped = await GetStateAsync($"shipped:{rel}");
            if (shipped is null) continue;                              // no record (imported) → can't tell customization from base

            var current = Hash(await File.ReadAllBytesAsync(target));
            var template = Hash(await File.ReadAllBytesAsync(abs));
            if (current == template) continue;                          // already current
            if (current == shipped) continue;                           // unmodified → seeder auto-upgrades it
            if (template == shipped) continue;                          // template unchanged → no upstream improvement
            result.Add(new KbUpgrade(rel));                             // modified AND template changed → merge candidate
        }
        return result;
    }

    public async Task<int> NotifyIfUpgradesAsync()
    {
        var up = await DetectUpgradesAsync();
        if (up.Count == 0) return 0;
        // Notify only when the candidate SET changes — no re-nag on every boot.
        var setKey = Hash(Encoding.UTF8.GetBytes(string.Join(",", up.Select(u => u.Path).OrderBy(x => x, StringComparer.Ordinal))));
        if (await GetStateAsync("kb_upgrade_notified") == setKey) return up.Count;
        await SetStateAsync("kb_upgrade_notified", setKey);
        await _notifications.CreateAsync(
            NotificationKind.Info, "知识库有可用升级",
            $"{up.Count} 个自定义文件可与新模板合并 —— 在「校准 · Cortex」中审阅。", link: "kb-upgrades");
        _log.LogInformation("Knowledge-base upgrades available: {N} file(s)", up.Count);
        return up.Count;
    }

    public async Task<KbMigrationStatus> GetStatusAsync()
    {
        var available = await DetectUpgradesAsync();
        var staged = await ReadStagedAsync();
        return new KbMigrationStatus(available, staged is not null, staged?.Files, staged?.CreatedAt);
    }

    public async Task<KbMigrationResult> RunMigrationAsync(CancellationToken ct = default)
    {
        var candidates = await DetectUpgradesAsync();
        if (candidates.Count == 0) return new KbMigrationResult(0, 0, false, "没有可用升级");

        var root = ZhikuSeeder.TemplateRoot;
        var changed = new List<string>();
        var shippedUpdates = new Dictionary<string, string>();
        var failed = 0;

        using (await _writeLock.AcquireAsync(ct))
        {
            foreach (var c in candidates)
            {
                var target = _data.ResolveDataPath(c.Path)!;
                var abs = Path.Combine(root, c.Path.Replace('/', Path.DirectorySeparatorChar));
                var userContent = await File.ReadAllTextAsync(target, ct);
                var templateBytes = await File.ReadAllBytesAsync(abs, ct);
                var templateContent = Encoding.UTF8.GetString(templateBytes);

                var merged = await MergeOneAsync(c.Path, userContent, templateContent, ct);
                if (string.IsNullOrWhiteSpace(merged)) { failed++; _log.LogWarning("KB merge produced nothing for {File}", c.Path); continue; }
                merged = merged.TrimEnd() + "\n";

                shippedUpdates[c.Path] = Hash(templateBytes);           // reconciled against this template version
                if (merged == userContent) continue;                    // no-op merge → nothing to stage, just reconcile state
                await File.WriteAllTextAsync(target, merged, new UTF8Encoding(false), ct);
                changed.Add(c.Path);
            }

            if (changed.Count == 0)
            {
                // Some no-op reconciliations may still need the shipped-state bumped so we don't re-nag.
                foreach (var kv in shippedUpdates) await SetStateAsync($"shipped:{kv.Key}", kv.Value);
                return new KbMigrationResult(0, failed, false, failed > 0 ? "合并失败,未产出改动" : "合并后无实际改动");
            }

            var files = await _git.BuildDiffAsync(changed, ct);
            var patch = await _git.CapturePatchAsync(changed, ct);
            await _git.RestorePathsAsync(changed, ct);                  // tree clean; changes live in the staged patch
            await WriteStagedAsync(new StagedMigration(patch, files, shippedUpdates, DateTime.UtcNow.ToString("o")), ct);
        }

        await _notifications.CreateAsync(
            NotificationKind.Info, "知识库升级已就绪", $"{changed.Count} 个文件已合并,待你审阅。", link: "kb-upgrades");
        _log.LogInformation("KB migration staged: {N} merged, {F} failed", changed.Count, failed);
        return new KbMigrationResult(changed.Count, failed, true, null);
    }

    public async Task<(bool Ok, string? Error, string? Sha)> ApproveAsync(CancellationToken ct = default)
    {
        var staged = await ReadStagedAsync();
        if (staged?.Patch is null || staged.Files is not { Count: > 0 }) return (false, "没有待审阅的升级", null);
        var rels = staged.Files.Select(f => f.Path).ToList();

        string sha;
        using (await _writeLock.AcquireAsync(ct))
        {
            if (!await _git.ApplyPatchAsync(staged.Patch, ct))
                return (false, "改动无法干净应用(数据自合并后已变更),请重新运行迁移。", null);
            sha = await _git.CommitPathsAsync(rels, "zhiku: migrate knowledge base", ct);
            foreach (var kv in staged.Shipped) await SetStateAsync($"shipped:{kv.Key}", kv.Value);
        }
        _commits.Record(sha, "zhiku: migrate knowledge base", "migrate");
        TryDeleteStaged();
        await _notifications.CreateAsync(NotificationKind.Info, "知识库升级已应用", $"{rels.Count} 个文件 · {sha}", link: "kb-upgrades");
        return (true, null, sha);
    }

    public async Task<bool> RejectAsync()
    {
        var staged = await ReadStagedAsync();
        if (staged is null) return false;
        // Keeping your version for this template version → bump shipped-state so it isn't re-offered.
        foreach (var kv in staged.Shipped) await SetStateAsync($"shipped:{kv.Key}", kv.Value);
        TryDeleteStaged();
        return true;
    }

    private async Task<string> MergeOneAsync(string path, string userContent, string templateContent, CancellationToken ct)
    {
        var res = await _runner.RunAsync(new ClaudeRunOptions
        {
            Prompt = _harness.KbMergePrompt(path, userContent, templateContent),
            Cwd = Path.GetTempPath(),   // neutral: the merge is self-contained in the prompt
            ReadOnly = true,
            Model = _appConfig.Get("llm.model.chat"),
            Label = $"kb-merge:{path}",
            OnEvent = _ => { },
        }, ct);
        return res.FinalText;
    }

    private sealed record StagedMigration(string Patch, List<DiffFile> Files, Dictionary<string, string> Shipped, string CreatedAt);

    private async Task<StagedMigration?> ReadStagedAsync()
    {
        if (!File.Exists(StagedPath)) return null;
        try { return JsonSerializer.Deserialize<StagedMigration>(await File.ReadAllTextAsync(StagedPath), Json); }
        catch { return null; }
    }
    private async Task WriteStagedAsync(StagedMigration s, CancellationToken ct) =>
        await File.WriteAllTextAsync(StagedPath, JsonSerializer.Serialize(s, Json), ct);
    private void TryDeleteStaged() { try { if (File.Exists(StagedPath)) File.Delete(StagedPath); } catch { } }

    private async Task<string?> GetStateAsync(string key)
    {
        using var conn = _db.Open();
        return await conn.QuerySingleOrDefaultAsync<string>("SELECT value FROM zhiku_state WHERE key = @key", new { key });
    }
    private async Task SetStateAsync(string key, string value)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            "INSERT INTO zhiku_state(key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            new { key, value });
    }

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
