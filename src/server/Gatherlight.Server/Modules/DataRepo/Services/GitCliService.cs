using System.Diagnostics;
using System.Text;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.DataRepo.Services;

public sealed record DiffFile(string Path, string Status, bool IsClaudeInfra, string Diff);

public sealed record DataCommitInfo(string Sha, string Subject, string Date);

/// <summary>
/// Git operations on the DATA repo (the private repo inside the data folder — never this code
/// repo). Shells out to the git CLI: behavior parity with the prototype depends on CLI semantics
/// (`cat-file -e`, `diff --no-index` against NUL). The CLI is resolved by <see cref="GitExe"/> —
/// a bundled portable git ships with the app, so no separate git install is needed on the host.
/// All paths are data-root-relative with forward slashes.
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
    /// <summary>Capture the current changes to <paramref name="paths"/> as a unified patch that
    /// <see cref="ApplyPatchAsync"/> can replay on a clean HEAD tree (new files via intent-to-add).
    /// Used to stage a background-job diff for later human approval without leaving the tree dirty.</summary>
    Task<string> CapturePatchAsync(IReadOnlyList<string> paths, CancellationToken ct = default);
    /// <summary>Apply a patch from <see cref="CapturePatchAsync"/> to the working tree. Returns false
    /// if it doesn't apply cleanly (the tree diverged since capture) — caller surfaces "re-run".</summary>
    Task<bool> ApplyPatchAsync(string patch, CancellationToken ct = default);
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

public class GitCliService : IGitCliService
{
    private static readonly UTF8Encoding Utf8NoBom = new(false);

    // The git executable, resolved per instance. An explicit GATHERLIGHT_GIT override wins (tests/dev);
    // else a portable git provisioned at setup into the data folder ({data}/state/resources/git); else a
    // copy bundled next to the host (libs/git); else "git" from PATH. Git is the data repo's engine
    // (init + diff + commit + restore), so provisioning it makes a fresh machine self-sufficient.
    private static string ResolveGit(string? resourcesDir)
    {
        var env = Environment.GetEnvironmentVariable("GATHERLIGHT_GIT");
        if (!string.IsNullOrWhiteSpace(env) && File.Exists(env)) return env;
        if (!string.IsNullOrEmpty(resourcesDir))
        {
            var provisioned = Path.Combine(resourcesDir, "git", "cmd", "git.exe");
            if (File.Exists(provisioned)) return provisioned;
        }
        var bundled = Path.Combine(AppContext.BaseDirectory, "git", "cmd", "git.exe");
        if (File.Exists(bundled)) return bundled;
        return "git";
    }

    private readonly string _root;
    private readonly ILogger _log;
    private readonly string GitExe;

    public GitCliService(IDataContext data, ILogger<GitCliService> log) : this(data.RootPath, log, data.ResourcesPath) { }

    protected GitCliService(string root, ILogger log, string? resourcesDir = null)
    {
        _root = Path.GetFullPath(root);
        _log = log;
        GitExe = ResolveGit(resourcesDir);
    }

    public async Task<GitResult> RunAsync(string[] args, CancellationToken ct = default)
    {
        var psi = new ProcessStartInfo
        {
            FileName = GitExe,
            WorkingDirectory = _root,
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
        _log.LogInformation("Data repo git: {Git}", GitExe);
        var fresh = !Directory.Exists(Path.Combine(_root, ".git"));
        if (fresh)
        {
            (await RunAsync(new[] { "init" }, ct)).ThrowOnError("init");
            _log.LogInformation("Initialized data repo at {Root}", _root);
        }
        // Every boot (not just fresh): an imported/user-edited .gitignore that dropped a line must not
        // silently let `git add -A` commit app state into the audit trail.
        EnsureDataGitignore();
        // Commits must work on a fresh machine with no global identity, and CRLF churn must not
        // pollute diffs. Local (repo-level) settings only.
        if ((await RunAsync(new[] { "config", "user.name" }, ct)).ExitCode != 0)
            (await RunAsync(new[] { "config", "user.name", "Gatherlight" }, ct)).ThrowOnError("config user.name");
        if ((await RunAsync(new[] { "config", "user.email" }, ct)).ExitCode != 0)
            (await RunAsync(new[] { "config", "user.email", "gatherlight@localhost" }, ct)).ThrowOnError("config user.email");
        (await RunAsync(new[] { "config", "core.autocrlf", "false" }, ct)).ThrowOnError("config autocrlf");
        return fresh;
    }

    // App state must NEVER enter the data repo's audit trail (state/settings.json holds the access token,
    // uploads/cache/ hold user files). These lines are load-bearing for the `git add -A` seeder/import path.
    private static readonly string[] RequiredIgnores =
    {
        "state/", "uploads/", "cache/", "archive/", "sensitive-patterns.txt",
        ".claude/settings.local.json", ".claude/scheduled_tasks.lock", ".claude/plans/",
    };

    /// <summary>Ensure every required ignore is present — appends any missing (idempotent), so a
    /// dropped line in an imported/edited .gitignore can't expose app state to the audit trail.</summary>
    private void EnsureDataGitignore()
    {
        const string header = "# Gatherlight data folder — private repo. App state/caches stay out of the audit trail.";
        var path = Path.Combine(_root, ".gitignore");
        var lines = File.Exists(path) ? File.ReadAllLines(path).ToList() : new List<string> { header };
        var have = lines.Select(l => l.Trim()).ToHashSet();
        var changed = false;
        foreach (var ig in RequiredIgnores)
            if (have.Add(ig)) { lines.Add(ig); changed = true; }
        if (changed || !File.Exists(path))
            File.WriteAllText(path, string.Join('\n', lines) + "\n");
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
            var abs = Path.Combine(_root, rel.Replace('/', Path.DirectorySeparatorChar));
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
                var abs = Path.Combine(_root, rel.Replace('/', Path.DirectorySeparatorChar));
                if (abs is not null && File.Exists(abs)) File.Delete(abs);
            }
        }
    }

    public async Task<string> CapturePatchAsync(IReadOnlyList<string> paths, CancellationToken ct = default)
    {
        var rels = paths.Select(Norm).ToArray();
        if (rels.Length == 0) return "";
        // Intent-to-add so brand-new files show in the diff; capture worktree-vs-index (== HEAD for
        // tracked files); then undo the intent-add so the tree is back to its pre-capture state.
        await RunAsync(new[] { "add", "-N", "--" }.Concat(rels).ToArray(), ct);
        var diff = await RunAsync(new[] { "diff", "--no-color", "--binary", "--" }.Concat(rels).ToArray(), ct);
        await RunAsync(new[] { "reset", "-q", "--" }.Concat(rels).ToArray(), ct);
        return diff.Stdout;
    }

    public async Task<bool> ApplyPatchAsync(string patch, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(patch)) return true;
        // Stage the patch inside .git/ (never in the tracked tree) and apply from there.
        var tmp = Path.Combine(_root, ".git", $"gl-apply-{Guid.NewGuid():N}.patch");
        await File.WriteAllTextAsync(tmp, patch, Utf8NoBom, ct);
        try
        {
            var r = await RunAsync(new[] { "apply", "--whitespace=nowarn", tmp }, ct);
            if (r.ExitCode != 0) _log.LogWarning("git apply of staged job patch failed: {Err}", r.Stderr.Trim());
            return r.ExitCode == 0;
        }
        finally { try { File.Delete(tmp); } catch { /* best effort */ } }
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

    // The single choke point for every `git … -- <path>` invocation. Callers pass data-root-relative
    // paths (plans/…, household/…, .claude/…); reject an absolute/drive/UNC path or a `..` segment so a
    // caller assembling an agent-influenced path list can't drive git at a file outside the data root.
    private static string Norm(string rel)
    {
        var s = PathText.Norm(rel);
        if (Path.IsPathRooted(s) || s.Split('/').Any(seg => seg == ".."))
            throw new InvalidOperationException($"Refusing git path outside the data root: '{rel}'");
        return s;
    }

    private static bool IsClaudeInfra(string rel) => rel == ".claude" || rel.StartsWith(".claude/");
}
