namespace Gatherlight.Server.Platform.Kernel.Services;

/// <summary>
/// A path that resolved INSIDE the data root by string prefix can still point OUT of it through a symlink:
/// <c>ResolveSitePath</c> blocks <c>..</c> and <c>state/</c> textually, but a reparse point (the file itself
/// or any parent directory) whose target sits elsewhere would still land under the prefix. Every seam that
/// resolves an agent-nameable path to a real file — the record-asset routes, the scoped file tools — walks the
/// chain and refuses any reparse point in it. Centralised here so the check is one reading.
/// </summary>
public static class ReparseGuard
{
    /// <summary>True when <paramref name="abs"/> and every directory up to <paramref name="root"/> is a real
    /// (non-reparse-point) entry. False on any symlink/junction in the chain, or on any error.
    /// <para>A path that does not EXIST yet is checked too — a move's target, above all: its missing tail (the file,
    /// any folders a move would create) cannot be a reparse point, so the walk skips it and checks every existing
    /// ancestor, where a junction would carry the write outside the data root. A missing entry used to fail the walk
    /// (a non-existent directory's attributes read as -1, every flag set), which is why the target check was once
    /// skipped for a new target altogether.</para></summary>
    public static bool NoSymlinkEscape(string abs, string root)
    {
        try
        {
            var rootFull = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
            var info = Directory.Exists(abs) ? new DirectoryInfo(abs) : (FileSystemInfo)new FileInfo(abs);
            if (info.Exists && info.Attributes.HasFlag(FileAttributes.ReparsePoint)) return false;
            var dir = info is DirectoryInfo d ? d.Parent : ((FileInfo)info).Directory;
            for (; dir is not null; dir = dir.Parent)
            {
                if (string.Equals(Path.GetFullPath(dir.FullName).TrimEnd(Path.DirectorySeparatorChar),
                        rootFull, StringComparison.OrdinalIgnoreCase))
                    return true;                                               // reached the data root — done
                if (!dir.Exists) continue;                                     // a folder a move would create
                if (dir.Attributes.HasFlag(FileAttributes.ReparsePoint)) return false;
            }
            return true;                                                      // walked out without hitting root (already inside-checked)
        }
        catch { return false; }
    }
}
