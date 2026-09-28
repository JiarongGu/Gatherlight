using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>
/// Undoes an agent run that CHANGED or CREATED the claude CLI's project configuration in the data folder —
/// <c>.claude/settings.json</c>, <c>.claude/settings.local.json</c>, <c>.mcp.json</c> — and touches nothing else.
///
/// <para><b>What reads these files, since round 6.</b> The app's own runs do not read the LOCAL settings or
/// <c>.mcp.json</c> at all (<see cref="ClaudeCliRuntime.IsolationArgs"/>: <c>--setting-sources project
/// --strict-mcp-config</c>); they still read the PROJECT <c>.claude/settings.json</c>, because the project scope is
/// also what loads the site's knowledge base. The household's own INTERACTIVE <c>claude</c> in the data folder reads
/// all three — that is where Claude Code saves the permissions they approve. So these are the household's files,
/// and an earlier version of this class that moved them out of the folder around every run took the household's
/// interactive configuration away, repeatedly, to protect against a reader the flags now remove.</para>
///
/// <para><b>What it still guards against</b> is an agent WRITING one: a hook planted in <c>.claude/settings.json</c>
/// runs in the app's next run, and one planted in either file runs in the household's next interactive session. The
/// guards already refuse such a write (PROTECTED: solid for Edit/Write and the file tools, best effort for Bash —
/// the three legs), so this is the backstop for the best-effort leg: a snapshot of the three files before a run in the
/// data folder, compared after it whatever the outcome. A file the run CREATED is moved out; one it CHANGED gets its
/// pre-run content back; one it DELETED is put back — each with a Warning, and the run's version kept in
/// <c>state/quarantine/&lt;UTC stamp&gt;/</c>. A file the run left alone is never touched.</para>
///
/// <para><b>The residual, stated.</b> The snapshot cannot tell the agent from the household: an edit the household
/// makes through its own interactive <c>claude</c> WHILE an app run is in flight is undone at the run's end (and kept in
/// the quarantine, so nothing is lost).</para>
/// </summary>
public interface IProjectConfigBackstop
{
    /// <summary>A snapshot of the three files when <paramref name="workingDirectory"/> is the data folder; else null.</summary>
    ProjectConfigSnapshot? Take(string? workingDirectory);

    /// <summary>Undo what changed since <paramref name="snapshot"/>. Returns the data-root-relative paths put right;
    /// never throws.</summary>
    IReadOnlyList<string> Restore(ProjectConfigSnapshot snapshot);
}

/// <summary>The three files before a run.</summary>
public sealed class ProjectConfigSnapshot
{
    internal ProjectConfigSnapshot(IReadOnlyDictionary<string, ProjectConfigBackstop.FileState> before) => Before = before;
    internal IReadOnlyDictionary<string, ProjectConfigBackstop.FileState> Before { get; }
}

public sealed class ProjectConfigBackstop : IProjectConfigBackstop
{
    /// <summary>The files the claude CLI loads from a project directory by itself. All three are PROTECTED
    /// (<c>SiteWriteScope</c>, both guards).</summary>
    public static readonly IReadOnlyList<string> Files = [".claude/settings.json", ".claude/settings.local.json", ".mcp.json"];

    // Far above any real settings file. A larger one is compared by length and time only, and cannot be put back
    // (its content was never read), which is logged.
    private const long MaxBytes = 4 * 1024 * 1024;

    /// <summary>One file's state: absent, or present with its length, time and — when small enough — its bytes.</summary>
    internal sealed record FileState(bool Exists, long Length, DateTime Written, byte[]? Bytes)
    {
        public static readonly FileState Absent = new(false, 0, default, null);
        public bool SameAs(FileState other) =>
            Exists == other.Exists && (!Exists || (Length == other.Length
                && (Bytes is not null && other.Bytes is not null ? Bytes.AsSpan().SequenceEqual(other.Bytes) : Written == other.Written)));
    }

    private readonly ISiteContext _site;
    private readonly IPlatformContext _platform;
    private readonly ILogger<ProjectConfigBackstop> _log;

    public ProjectConfigBackstop(ISiteContext site, IPlatformContext platform, ILogger<ProjectConfigBackstop> log)
    {
        _site = site;
        _platform = platform;
        _log = log;
    }

    public ProjectConfigSnapshot? Take(string? workingDirectory)
    {
        if (!Covers(workingDirectory)) return null;
        var before = new Dictionary<string, FileState>(StringComparer.Ordinal);
        foreach (var rel in Files) before[rel] = Read(Abs(rel));
        return new ProjectConfigSnapshot(before);
    }

    public IReadOnlyList<string> Restore(ProjectConfigSnapshot snapshot)
    {
        var fixedUp = new List<string>();
        string? stamp = null;
        foreach (var rel in Files)
        {
            try
            {
                var abs = Abs(rel);
                var before = snapshot.Before.GetValueOrDefault(rel) ?? FileState.Absent;
                var now = Read(abs);
                if (before.SameAs(now)) continue;
                if (!now.Exists && Directory.Exists(abs)) continue;          // not a settings file the CLI can load
                if (before.Exists && before.Bytes is null)
                {
                    _log.LogWarning("Project config: an agent run changed {Rel}, which is too large to have been snapshotted — "
                        + "left as it is; check it.", rel);
                    continue;
                }
                stamp ??= DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff");
                var kept = now.Exists ? Keep(abs, rel, stamp) : null;
                if (!before.Exists)
                {
                    _log.LogWarning("Project config: an agent run CREATED {Rel} — moved out of the data folder to {Kept}. "
                        + "The app never writes it and the agent may not.", rel, kept);
                }
                else
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(abs)!);
                    File.WriteAllBytes(abs, before.Bytes!);
                    if (now.Exists)
                        _log.LogWarning("Project config: an agent run CHANGED {Rel} — its content before the run is back; "
                            + "the changed copy is kept at {Kept}.", rel, kept);
                    else
                        _log.LogWarning("Project config: an agent run DELETED {Rel} — put back as it was before the run.", rel);
                }
                fixedUp.Add(rel);
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "Project config: could not undo an agent run's change to {Rel}", rel);
            }
        }
        return fixedUp;
    }

    private bool Covers(string? workingDirectory)
    {
        if (string.IsNullOrWhiteSpace(workingDirectory)) return false;
        try { return string.Equals(Full(workingDirectory), Full(_site.RootPath), StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }

    // Move the run's version into the quarantine (so nothing is destroyed) and return where it went.
    private string Keep(string abs, string rel, string stamp)
    {
        var to = Path.Combine(_platform.StatePath, "quarantine", stamp, rel.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(to)!);
        File.Move(abs, to, overwrite: true);
        return to;
    }

    private static FileState Read(string abs)
    {
        try
        {
            var fi = new FileInfo(abs);
            if (!fi.Exists) return FileState.Absent;
            return new FileState(true, fi.Length, fi.LastWriteTimeUtc, fi.Length > MaxBytes ? null : File.ReadAllBytes(abs));
        }
        catch { return FileState.Absent; }
    }

    private string Abs(string rel) => Path.Combine(_site.RootPath, rel.Replace('/', Path.DirectorySeparatorChar));

    private static string Full(string p) =>
        Path.GetFullPath(p).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
}
