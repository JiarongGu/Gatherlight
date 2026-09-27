using System.Diagnostics;

namespace Gatherlight.Server.Platform.Storage.DataRepo.Services;

/// <summary>
/// The environment every git this app spawns runs in: confined to the ONE repository its working directory holds —
/// never one the launching process's environment names. The single place that rule lives; every git spawn goes through
/// <see cref="ConfineTo"/> (today that is <see cref="GitCliService.RunAsync"/>, which the code-repo git of 系统模式
/// inherits).
///
/// <para><b>Two halves, because git chooses a repository two ways.</b> By DISCOVERY — walking up from the working
/// directory — which <c>GIT_CEILING_DIRECTORIES</c> bounds (below). And by NAME, from the environment, which skips
/// discovery altogether: git's own documentation says the ceiling "will not exclude … a GIT_DIR set on the command line or
/// in the environment". So a ceiling alone left the second door open.</para>
///
/// <para><b>The incident that opened it (2026-09-27).</b> A debugging agent ran <c>git bisect run</c> from a linked
/// worktree, and bisect run exports <c>GIT_DIR</c> (<c>.git/worktrees/&lt;name&gt;</c>) and <c>GIT_EXEC_PATH</c> to
/// every child — measured, with <c>GIT_CONFIG_PARAMETERS</c> too when it was started as <c>git -c k=v bisect run</c>.
/// A fixture server inherited them and passed them on, so its data-repo commands ran against the developer's MAIN
/// repository: <c>git init</c> set <c>core.bare = true</c> there, the fixture's commits landed on the worktree's HEAD,
/// and <see cref="DataRepoMaintenance"/>'s <c>reflog expire --expire=now --all</c> and <c>gc --prune=now</c> erased every
/// reflog. The same class of trap as the walk-up the ceiling had already closed. Proof: <c>e2e-p49</c> case F, against a
/// scratch repo of that shape, confirmed to fail without this.</para>
/// </summary>
public static class GitEnvironment
{
    /// <summary>Removed from every git child's environment. Each one either NAMES the repository (or a part of it) a
    /// command works on, or reconfigures one from outside it — and none of them is ever ours to inherit: the app locates
    /// its repositories by working directory and configures them in their own <c>.git/config</c>.
    /// <list type="bullet">
    /// <item><c>GIT_DIR</c>, <c>GIT_WORK_TREE</c>, <c>GIT_COMMON_DIR</c> — the repository, its working tree, the shared
    /// half of a worktree's repository.</item>
    /// <item><c>GIT_INDEX_FILE</c>, <c>GIT_OBJECT_DIRECTORY</c>, <c>GIT_ALTERNATE_OBJECT_DIRECTORIES</c>,
    /// <c>GIT_NAMESPACE</c> — its index, its object store (written to, and read from), its ref namespace.</item>
    /// <item><c>GIT_CONFIG</c> — makes <c>git config</c> read AND WRITE that file instead of the repository's: the data
    /// repo's <c>git config user.name Gatherlight</c> would land in someone else's file.</item>
    /// <item><c>GIT_CONFIG_PARAMETERS</c>, <c>GIT_CONFIG_COUNT</c> and its <c>GIT_CONFIG_KEY_n</c>/<c>GIT_CONFIG_VALUE_n</c>
    /// pairs (<see cref="StrippedPrefixes"/>) — configuration given to the PARENT's command (<c>git -c</c>), exported to
    /// its children; it can carry <c>core.worktree</c> or <c>core.bare</c>, and it answers the data repo's
    /// <c>git config user.name</c> probe, so an injected identity would sign every commit of the audit trail.</item>
    /// <item><c>GIT_EXEC_PATH</c> — the PARENT git's helper directory. Ours may be another build (the provisioned MinGit
    /// beside a system git), and would then run that build's helpers; unset, each git finds its own.</item>
    /// </list>
    /// <para><b>Kept, and why.</b> <c>GIT_CONFIG_GLOBAL</c> / <c>GIT_CONFIG_SYSTEM</c> / <c>GIT_CONFIG_NOSYSTEM</c> choose which
    /// of the household's OWN config files are read — never which repository — and the app writes only repository-local
    /// config. <c>GIT_DISCOVERY_ACROSS_FILESYSTEM</c> only widens the walk-up, which the ceiling bounds anyway. Identity and
    /// date overrides (<c>GIT_AUTHOR_*</c>, <c>GIT_COMMITTER_*</c>) change what a commit says, not where it lands (git hands
    /// <c>GIT_AUTHOR_*</c> to a hook, measured — one more reason never to start the app from one). <c>GIT_EDITOR</c>, <c>GIT_PREFIX</c>, <c>GIT_TRACE*</c>, <c>GIT_PAGER</c> select
    /// nothing. <c>GIT_CEILING_DIRECTORIES</c> is set here, over whatever was inherited.</para></summary>
    public static readonly IReadOnlyList<string> Stripped =
    [
        "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR",
        "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
        "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
        "GIT_EXEC_PATH",
    ];

    /// <summary>Stripped as families: the numbered pairs <c>GIT_CONFIG_COUNT</c> counts.</summary>
    public static readonly IReadOnlyList<string> StrippedPrefixes = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];

    /// <summary>Confine <paramref name="psi"/>'s git to the repository at <paramref name="repoRoot"/>: strip what would
    /// name another (<see cref="Stripped"/>), and bound discovery at the root's parent.
    /// <para><b>The ceiling</b> stops git walking up. Without one, a git command run in a folder whose own repo is missing
    /// or damaged discovers the nearest ANCESTOR repo and operates on that — silently and successfully. Observed for real:
    /// a restore into a data folder with a broken .git committed the surrounding project's staged changes under the message
    /// "restore: import backup (N files)". It is the root's PARENT, so discovery may find <c>{root}/.git</c> and may not
    /// climb past it; <c>git init</c> still works — the ceiling bounds the search, not creation — and a genuinely missing
    /// repo now fails where it should.</para>
    /// <para>Names are matched case-insensitively on Windows, where the environment is.</para></summary>
    public static void ConfineTo(ProcessStartInfo psi, string repoRoot)
    {
        var env = psi.Environment;
        var cmp = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        foreach (var key in env.Keys.ToList())
            if (Stripped.Any(n => string.Equals(key, n, cmp)) || StrippedPrefixes.Any(p => key.StartsWith(p, cmp)))
                env.Remove(key);

        var root = Path.GetFullPath(repoRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var parent = Path.GetDirectoryName(root);
        if (!string.IsNullOrEmpty(parent)) env["GIT_CEILING_DIRECTORIES"] = parent;
    }
}
