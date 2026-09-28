using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Storage.DataRepo.Services;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>
/// Keeps the claude CLI's PROJECT configuration out of the data folder: <c>.claude/settings.json</c>,
/// <c>.claude/settings.local.json</c> and <c>.mcp.json</c>. The app never writes them — every run gets its settings
/// from <c>state/</c> through <c>--settings</c>, and its MCP servers through the loopback channel — and the agent may
/// not (PROTECTED, for Edit/Write and the file tools). But the CLI reads them ON ITS OWN from the working directory:
/// a <c>-p</c> run executes the project settings' hooks and starts a project <c>.mcp.json</c>'s servers, before any
/// human decision (measured at 0 tokens, CLI 2.1.283). So one that appears there by any route — a Bash token that
/// slipped the guard's best-effort scan, the folder-move escape the round-6 review found in the file tools, a backup,
/// or the household's own interactive <c>claude</c> in the folder — is run by the next agent run, the diff gate's
/// validation pass included, and Reject's restore never reaches it (the edit tracker never saw it).
///
/// <para><b>Moved, not deleted.</b> A file goes to <c>state/quarantine/&lt;UTC stamp&gt;/&lt;its path&gt;</c>, with a
/// Warning naming both, because the household's own file (Claude Code writes <c>.claude/settings.local.json</c> when a
/// permission is approved interactively) is still theirs to recover; <c>state/</c> is outside what the CLI reads, the
/// data repo and the backup.</para>
///
/// <para><b>When.</b> Around every agent run whose working directory is the data folder
/// (<see cref="AgentRunner"/> — before it, and after it whatever its outcome, so nothing an execute run left behind
/// survives to its diff gate, a Reject or the next run); at startup, in the app-managed re-issue; and on a backup
/// import, which strips what the archive restored (<see cref="SweepAll"/>).</para>
///
/// <para><b>Untracked only, except on import.</b> A file the data repo TRACKS was committed by somebody on purpose —
/// the app never commits one — and moving it would leave a working-tree deletion that a later commit could sweep up
/// unseen. An import strips even tracked ones, because the archive's own history is what tracks them there; its
/// restore commit then records the deletion.</para>
/// </summary>
public interface IProjectConfigSweep
{
    /// <summary>Whether <paramref name="workingDirectory"/> is the data folder — the one place the sweep applies.</summary>
    bool Covers(string? workingDirectory);

    /// <summary>Move the UNTRACKED project config files out of the data folder. Returns the data-root-relative paths
    /// moved; never throws.</summary>
    Task<IReadOnlyList<string>> SweepUntrackedAsync(CancellationToken ct = default);

    /// <summary>Move every project config file out of the data folder, tracked or not (a backup import).</summary>
    IReadOnlyList<string> SweepAll(string why);
}

public sealed class ProjectConfigSweep : IProjectConfigSweep
{
    /// <summary>The files the claude CLI loads from a project directory by itself. The first two are in PROTECTED
    /// (<c>SiteWriteScope</c>, both guards); <c>.mcp.json</c> too.</summary>
    public static readonly IReadOnlyList<string> Files = [".claude/settings.json", ".claude/settings.local.json", ".mcp.json"];

    private readonly ISiteContext _site;
    private readonly IPlatformContext _platform;
    private readonly IGitCliService _git;
    private readonly ILogger<ProjectConfigSweep> _log;

    public ProjectConfigSweep(ISiteContext site, IPlatformContext platform, IGitCliService git, ILogger<ProjectConfigSweep> log)
    {
        _site = site;
        _platform = platform;
        _git = git;
        _log = log;
    }

    public bool Covers(string? workingDirectory)
    {
        if (string.IsNullOrWhiteSpace(workingDirectory)) return false;
        try
        {
            return string.Equals(Full(workingDirectory), Full(_site.RootPath), StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    public async Task<IReadOnlyList<string>> SweepUntrackedAsync(CancellationToken ct = default)
    {
        var moved = new List<string>();
        foreach (var rel in Files)
        {
            if (!File.Exists(Abs(rel))) continue;
            bool tracked;
            try { tracked = await _git.IsTrackedAsync(rel, ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch { tracked = false; }   // git unanswerable: the hazard is the same, so fail closed
            if (tracked) continue;
            if (Quarantine(rel, "the claude CLI loads it on its own, and nothing the app runs may write it")) moved.Add(rel);
        }
        return moved;
    }

    public IReadOnlyList<string> SweepAll(string why)
    {
        var moved = new List<string>();
        foreach (var rel in Files)
            if (File.Exists(Abs(rel)) && Quarantine(rel, why)) moved.Add(rel);
        return moved;
    }

    private bool Quarantine(string rel, string why)
    {
        var from = Abs(rel);
        var stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff");
        var to = Path.Combine(_platform.StatePath, "quarantine", stamp, rel.Replace('/', Path.DirectorySeparatorChar));
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(to)!);
            File.Move(from, to, overwrite: true);
            _log.LogWarning("Project config: moved {Rel} out of the data folder to {To} — {Why}. It is kept there; "
                + "nothing in the app reads it.", rel, to, why);
            return true;
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Project config: could not move {Rel} out of the data folder — the next agent run may load it", rel);
            return false;
        }
    }

    private string Abs(string rel) => Path.Combine(_site.RootPath, rel.Replace('/', Path.DirectorySeparatorChar));

    private static string Full(string p) =>
        Path.GetFullPath(p).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
}
