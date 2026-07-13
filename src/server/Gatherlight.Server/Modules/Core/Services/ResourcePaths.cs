namespace Gatherlight.Server.Modules.Core.Services;

/// <summary>
/// Resolves the shipped resource dirs (web client + knowledge-base template) across both layouts:
/// the flat dev/output layout (<c>{base}/wwwroot</c>, <c>{base}/Assets/DataTemplate</c>) and the
/// structured production bundle (<c>{base}/../res/wwwroot</c>, <c>{base}/../res/template</c> — the
/// exe lives in <c>libs/</c>). First existing candidate wins; falls back to the flat path.
/// </summary>
public static class ResourcePaths
{
    private static string Base => AppContext.BaseDirectory;

    /// <summary>The built web client (contains index.html).</summary>
    public static string Wwwroot => First("index.html",
        Path.Combine(Base, "wwwroot"),
        Path.Combine(Base, "res", "wwwroot"),
        Path.Combine(Base, "..", "res", "wwwroot"));

    /// <summary>The shipped knowledge-base template (contains CLAUDE.md).</summary>
    public static string DataTemplate => First("CLAUDE.md",
        Path.Combine(Base, "Assets", "DataTemplate"),
        Path.Combine(Base, "res", "template"),
        Path.Combine(Base, "..", "res", "template"));

    private static string First(string marker, params string[] dirs)
    {
        foreach (var d in dirs)
            if (File.Exists(Path.Combine(d, marker)))
                return Path.GetFullPath(d);
        return Path.GetFullPath(dirs[0]);
    }
}
