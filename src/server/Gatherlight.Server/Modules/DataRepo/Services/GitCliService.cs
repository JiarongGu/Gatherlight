using System.Diagnostics;
using System.Text;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.DataRepo.Services;

public sealed record DiffFile(string Path, string Status, bool IsClaudeInfra, string Diff);

public sealed record DataCommitInfo(string Sha, string Subject, string Date);

/// <summary>
/// Git operations on the DATA repo (the private repo inside the data folder — never this code
/// repo). Shells out to the git CLI: behavior parity with the prototype depends on CLI semantics
/// (`cat-file -e`, `diff --no-index` against NUL) and git is already a prerequisite alongside the
/// claude CLI. All paths are data-root-relative with forward slashes.
/// </summary>
public interface IGitCliService
{
    /// <summary>Init the data repo if missing + repo-local identity/CRLF config. Returns true
    /// when the repo was freshly initialized (caller makes the initial import commit).</summary>
    Task<bool> EnsureRepoAsync(CancellationToken ct = default);
    Task<bool> ExistsInHeadAsync(string rel, CancellationToken ct = default);
    /// <summary>Per-file diff for exactly the agent-touched paths. New files diff against NUL,
    /// modified/deleted against HEAD. No-op edits are skipped.</summary>
    Task<List<DiffFile>> BuildDiffAsync(IReadOnlyList<string> paths, CancellationToken ct = default);
    /// <summary>Stage + commit exactly the given paths. Returns the short sha.</summary>
    Task<string> CommitPathsAsync(IReadOnlyList<string> paths, string message, CancellationToken ct = default);
    /// <summary>Commit whatever is currently staged/dirty across the whole tree (seeder/import).
    /// Returns the short sha, or null when there was nothing to commit.</summary>
    Task<string?> CommitAllAsync(string message, CancellationToken ct = default);
    /// <summary>Discard changes to the given paths only: tracked → checkout HEAD, new → delete.</summary>
    Task RestorePathsAsync(IReadOnlyList<string> paths, CancellationToken ct = default);
    Task<bool> IsTrackedAsync(string rel, CancellationToken ct = default);
    Task<string> GetShortShaAsync(CancellationToken ct = default);
    Task<List<DataCommitInfo>> LogAsync(int count = 20, CancellationToken ct = default);
    /// <summary>Run an arbitrary git command in the data repo (plumbing for fs ops: rm/mv/add).</summary>
    Task<GitResult> RunAsync(string[] args, CancellationToken ct = default);
}

public sealed record GitResult(int ExitCode, string Stdout, string Stderr)
{
    public GitResult ThrowOnError(string what)
    {
        if (ExitCode != 0)
            throw new InvalidOperationException($"git {what} failed ({ExitCode}): {Stderr.Trim()}");
        return this;
    }
}

public sealed class GitCliService : IGitCliService
{
    private static readonly UTF8Encoding Utf8NoBom = new(false);
    private readonly IDataContext _data;
    private readonly ILogger<GitCliService> _log;

    public GitCliService(IDataContext data, ILogger<GitCliService> log)
    {
        _data = data;
        _log = log;
    }

    public async Task<GitResult> RunAsync(string[] args, CancellationToken ct = default)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "git",
            WorkingDirectory = _data.RootPath,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Utf8NoBom,
            StandardErrorEncoding = Utf8NoBom,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var proc = new Process { StartInfo = psi };
        proc.Start();
        var stdoutTask = proc.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = proc.StandardError.ReadToEndAsync(ct);
        await proc.WaitForExitAsync(ct);
        return new GitResult(proc.ExitCode, await stdoutTask, await stderrTask);
    }

    public async Task<bool> EnsureRepoAsync(CancellationToken ct = default)
    {
        var fresh = !Directory.Exists(Path.Combine(_data.RootPath, ".git"));
        if (fresh)
        {
            (await RunAsync(new[] { "init" }, ct)).ThrowOnError("init");
            EnsureDataGitignore();
            _log.LogInformation("Initialized data repo at {Root}", _data.RootPath);
        }
        // Commits must work on a fresh machine with no global identity, and CRLF churn must not
        // pollute diffs. Local (repo-level) settings only.
        if ((await RunAsync(new[] { "config", "user.name" }, ct)).ExitCode != 0)
            (await RunAsync(new[] { "config", "user.name", "Gatherlight" }, ct)).ThrowOnError("config user.name");
        if ((await RunAsync(new[] { "config", "user.email" }, ct)).ExitCode != 0)
            (await RunAsync(new[] { "config", "user.email", "gatherlight@localhost" }, ct)).ThrowOnError("config user.email");
        (await RunAsync(new[] { "config", "core.autocrlf", "false" }, ct)).ThrowOnError("config autocrlf");
        return fresh;
    }

    /// <summary>App state must never enter the data repo's audit trail.</summary>
    private void EnsureDataGitignore()
    {
        var path = Path.Combine(_data.RootPath, ".gitignore");
        if (File.Exists(path)) return;
        File.WriteAllText(path,
            "# Gatherlight data folder — private repo. App state/caches stay out of the audit trail.\n" +
            "state/\nuploads/\ncache/\narchive/\nsensitive-patterns.txt\n" +
            ".claude/settings.local.json\n.claude/scheduled_tasks.lock\n.claude/plans/\n");
    }

    public async Task<bool> ExistsInHeadAsync(string rel, CancellationToken ct = default) =>
        (await RunAsync(new[] { "cat-file", "-e", $"HEAD:{Norm(rel)}" }, ct)).ExitCode == 0;

    public async Task<bool> IsTrackedAsync(string rel, CancellationToken ct = default) =>
        (await RunAsync(new[] { "ls-files", "--error-unmatch", "--", Norm(rel) }, ct)).ExitCode == 0;

    public async Task<List<DiffFile>> BuildDiffAsync(IReadOnlyList<string> paths, CancellationToken ct = default)
    {
        var files = new List<DiffFile>();
        foreach (var raw in paths)
        {
            var rel = Norm(raw);
            var inHead = await ExistsInHeadAsync(rel, ct);
            var abs = _data.ResolveDataPath(rel);
            var onDisk = abs is not null && File.Exists(abs);

            string status;
            string diff;
            if (inHead && onDisk)
            {
                status = "modified";
                diff = (await RunAsync(new[] { "diff", "--no-color", "HEAD", "--", rel }, ct)).Stdout;
                // No actual change (a denied edit still emits a tool_use, or a no-op rewrite) →
                // skip so the UI + commit only show real changes.
                if (string.IsNullOrWhiteSpace(diff)) continue;
            }
            else if (inHead)
            {
                status = "deleted";
                diff = (await RunAsync(new[] { "diff", "--no-color", "HEAD", "--", rel }, ct)).Stdout;
            }
            else
            {
                status = "added";
                // Untracked: diff against NUL so the UI shows the full new content.
                // --no-index exits 1 when files differ — that IS the success path.
                var r = await RunAsync(new[] { "diff", "--no-color", "--no-index", "--", "NUL", rel }, ct);
                diff = r.Stdout;
            }

            files.Add(new DiffFile(rel, status, IsClaudeInfra(rel), diff));
        }
        return files;
    }

    public async Task<string> CommitPathsAsync(IReadOnlyList<string> paths, string message, CancellationToken ct = default)
    {
        var rels = paths.Select(Norm).ToArray();
        (await RunAsync(new[] { "add", "--" }.Concat(rels).ToArray(), ct)).ThrowOnError("add");
        (await RunAsync(new[] { "commit", "-m", message, "--" }.Concat(rels).ToArray(), ct)).ThrowOnError("commit");
        return await GetShortShaAsync(ct);
    }

    public async Task<string?> CommitAllAsync(string message, CancellationToken ct = default)
    {
        (await RunAsync(new[] { "add", "-A" }, ct)).ThrowOnError("add -A");
        var staged = await RunAsync(new[] { "diff", "--cached", "--quiet" }, ct);
        if (staged.ExitCode == 0) return null; // nothing staged
        (await RunAsync(new[] { "commit", "-m", message }, ct)).ThrowOnError("commit");
        return await GetShortShaAsync(ct);
    }

    public async Task RestorePathsAsync(IReadOnlyList<string> paths, CancellationToken ct = default)
    {
        var rels = paths.Select(Norm).ToArray();
        // Unstage anything that may have been intent-added (defensive; ignore failures).
        await RunAsync(new[] { "reset", "-q", "HEAD", "--" }.Concat(rels).ToArray(), ct);
        foreach (var rel in rels)
        {
            if (await ExistsInHeadAsync(rel, ct))
            {
                await RunAsync(new[] { "checkout", "-q", "HEAD", "--", rel }, ct);
            }
            else
            {
                var abs = _data.ResolveDataPath(rel);
                if (abs is not null && File.Exists(abs)) File.Delete(abs);
            }
        }
    }

    public async Task<string> GetShortShaAsync(CancellationToken ct = default) =>
        (await RunAsync(new[] { "rev-parse", "--short", "HEAD" }, ct)).ThrowOnError("rev-parse").Stdout.Trim();

    public async Task<List<DataCommitInfo>> LogAsync(int count = 20, CancellationToken ct = default)
    {
        var r = await RunAsync(new[] { "log", $"-{count}", "--pretty=format:%h%x1f%s%x1f%cI" }, ct);
        if (r.ExitCode != 0) return new(); // empty repo
        return r.Stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Split('\x1f'))
            .Where(p => p.Length == 3)
            .Select(p => new DataCommitInfo(p[0], p[1], p[2]))
            .ToList();
    }

    private static string Norm(string rel)
    {
        var s = rel.Replace('\\', '/');
        while (s.StartsWith("./", StringComparison.Ordinal)) s = s[2..];
        return s;
    }

    private static bool IsClaudeInfra(string rel) => rel == ".claude" || rel.StartsWith(".claude/");
}
