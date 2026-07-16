using System.Text.RegularExpressions;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.DataRepo.Services;

namespace Gatherlight.Server.Modules.PlanIndex.Services;

/// <summary>
/// Mechanical file operations on the data tree — no AI involved. Each operation commits to the
/// data repo immediately (user already confirmed in the UI). Direct user actions are restricted
/// to user content only: plans/ and household/ — the knowledge base (.claude/) is managed
/// through the AI assistant with its review gates.
/// </summary>
public interface IFsOpsService
{
    Task<(string? Sha, List<string> Removed)> DeleteEntriesAsync(
        IReadOnlyList<string> paths, IReadOnlyList<string> dirs, string subject, CancellationToken ct = default);
    Task<string> RetitleAsync(string path, string newTitle, string subject, CancellationToken ct = default);
    Task<string> RenameEntriesAsync(
        IReadOnlyList<(string From, string To)> renames, string subject, CancellationToken ct = default);
}

public sealed partial class FsOpsService : IFsOpsService
{
    private static readonly string[] AllowedDirs = { "plans", "household" };

    private readonly IDataContext _data;
    private readonly IGitCliService _git;
    private readonly IDataCommitRepository _commits;
    private readonly IPlanIndexService _index;
    private readonly DataWriteLock _writeLock;

    public FsOpsService(
        IDataContext data, IGitCliService git, IDataCommitRepository commits,
        IPlanIndexService index, DataWriteLock writeLock)
    {
        _data = data;
        _git = git;
        _commits = commits;
        _index = index;
        _writeLock = writeLock;
    }

    public async Task<(string? Sha, List<string> Removed)> DeleteEntriesAsync(
        IReadOnlyList<string> paths, IReadOnlyList<string> dirs, string subject, CancellationToken ct = default)
    {
        foreach (var p in paths.Concat(dirs)) AssertInScope(p);
        using var _ = await _writeLock.AcquireAsync(ct);

        var removed = new List<string>();
        foreach (var rel in paths.Select(Norm))
        {
            if (await _git.IsTrackedAsync(rel, ct))
                (await _git.RunAsync(new[] { "rm", "-f", "--", rel }, ct)).ThrowOnError("rm");
            else if (_data.ResolveDataPath(rel) is { } abs && File.Exists(abs))
                File.Delete(abs);
            removed.Add(rel);
        }
        foreach (var dir in dirs.Select(Norm))
        {
            // git rm -r only works if something under the dir is tracked.
            var r = await _git.RunAsync(new[] { "rm", "-r", "-f", "--", dir }, ct);
            if (r.ExitCode != 0 && _data.ResolveDataPath(dir) is { } abs && Directory.Exists(abs))
                Directory.Delete(abs, recursive: true);
            removed.Add(dir + "/");
        }

        // Commit only when something was actually staged (untracked deletes stage nothing).
        var staged = await _git.RunAsync(new[] { "diff", "--cached", "--quiet" }, ct);
        string? sha = null;
        if (staged.ExitCode != 0)
        {
            (await _git.RunAsync(new[] { "commit", "-m", CommitBody(subject) }, ct)).ThrowOnError("commit");
            sha = await _git.GetShortShaAsync(ct);
            _commits.Record(sha, subject, "fs-op");
        }
        await _index.RescanAsync(ct);
        return (sha, removed);
    }

    public async Task<string> RetitleAsync(string path, string newTitle, string subject, CancellationToken ct = default)
    {
        AssertInScope(path);
        var title = newTitle.Trim();
        if (title.Length == 0) throw new ArgumentException("标题不能为空");
        using var _ = await _writeLock.AcquireAsync(ct);

        var rel = Norm(path);
        var abs = _data.ResolveDataPath(rel) ?? throw new ArgumentException($"路径越界:{path}");
        var content = await File.ReadAllTextAsync(abs, ct);
        var next = H1Regex().IsMatch(content)
            ? H1Regex().Replace(content, $"# {title}", 1)
            : $"# {title}\n\n{content}";
        await File.WriteAllTextAsync(abs, next, ct);

        var sha = await _git.CommitPathsAsync(new[] { rel }, CommitBody(subject), ct);
        _commits.Record(sha, subject, "fs-op");
        await _index.RescanAsync(ct);
        return sha;
    }

    public async Task<string> RenameEntriesAsync(
        IReadOnlyList<(string From, string To)> renames, string subject, CancellationToken ct = default)
    {
        foreach (var (from, to) in renames)
        {
            AssertInScope(from);
            AssertInScope(to);
        }
        using var _ = await _writeLock.AcquireAsync(ct);

        foreach (var (fromRaw, toRaw) in renames)
        {
            var from = Norm(fromRaw);
            var to = Norm(toRaw);
            var toAbs = _data.ResolveDataPath(to)!;
            // Never silently overwrite an existing in-scope file (data loss, and no git record of the
            // clobbered file until the following add) — surface a conflict instead. Dropping `-f` /
            // overwrite makes git mv / File.Move themselves refuse too.
            if (File.Exists(toAbs) || Directory.Exists(toAbs))
                throw new InvalidOperationException($"重命名目标已存在:{to}");
            Directory.CreateDirectory(Path.GetDirectoryName(toAbs)!);
            if (await _git.IsTrackedAsync(from, ct))
            {
                (await _git.RunAsync(new[] { "mv", "--", from, to }, ct)).ThrowOnError("mv");
            }
            else
            {
                File.Move(_data.ResolveDataPath(from)!, toAbs);
                (await _git.RunAsync(new[] { "add", "--", to }, ct)).ThrowOnError("add");
            }
        }
        (await _git.RunAsync(new[] { "commit", "-m", CommitBody(subject) }, ct)).ThrowOnError("commit");
        var sha = await _git.GetShortShaAsync(ct);
        _commits.Record(sha, subject, "fs-op");
        await _index.RescanAsync(ct);
        return sha;
    }

    private static string Norm(string rel) => PathText.Norm(rel);

    private static void AssertInScope(string rel)
    {
        var norm = Norm(rel);
        // Reject any `..` SEGMENT, not just a leading one: Norm doesn't collapse `..`, so a tracked
        // path like `plans/../.claude/x` would otherwise pass the prefix check below and reach
        // `git rm -- plans/../.claude/x`, which git resolves out of scope into .claude/.
        if (Path.IsPathRooted(norm) || norm.Split('/').Any(seg => seg == ".."))
            throw new ArgumentException($"路径越界:{rel}");
        var ok = AllowedDirs.Any(d => norm == d || norm.StartsWith(d + "/"));
        if (!ok) throw new ArgumentException($"不允许操作该路径(仅限 plans/ 和 household/):{rel}");
    }

    private static string CommitBody(string subject) =>
        $"{subject}\n\nDirect file operation via Gatherlight UI (user-confirmed).";

    [GeneratedRegex(@"^#\s+.+$", RegexOptions.Multiline)]
    private static partial Regex H1Regex();
}
