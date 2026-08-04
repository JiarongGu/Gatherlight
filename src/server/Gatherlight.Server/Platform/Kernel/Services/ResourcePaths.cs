namespace Gatherlight.Server.Platform.Kernel.Services;

/// <summary>
/// Resolves the shipped resource dirs (web client + site template) across both layouts:
/// the flat dev/output layout (<c>{base}/wwwroot</c>, <c>{base}/Assets/SiteTemplate</c>) and the
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

    /// <summary>The shipped site template (contains CLAUDE.md + site.json).</summary>
    public static string DataTemplate => First("CLAUDE.md",
        Path.Combine(Base, "Assets", "SiteTemplate"),
        Path.Combine(Base, "res", "template"),
        Path.Combine(Base, "..", "res", "template"));

    /// <summary>
    /// A Node leaf tool (<c>tools/&lt;name&gt;</c>), or <c>""</c> when absent. Two shapes, because a
    /// release ships the leaf PRE-BUNDLED: <c>res/tools/&lt;name&gt;/&lt;entry&gt;.cjs</c> — single files
    /// esbuild-bundled from the TypeScript sources, run by plain <c>node</c> with no npm install, no
    /// npx and no node_modules on the target. In the source repo the sub-project itself is found by
    /// walking up to the repo root, so a dev edit to <c>src/*.ts</c> takes effect without rebuilding.
    /// (Before this the walk-up was the ONLY lookup, so every leaf-backed tool — pdf_fill, pdf_merge,
    /// pdf_inspect, fill_itinerary — was dead in an installed copy: nothing under <c>tools/</c> was
    /// ever packed into the bundle.)
    /// </summary>
    public static string NodeLeaf(string name)
    {
        foreach (var d in new[] { Path.Combine(Base, "res", "tools", name), Path.Combine(Base, "..", "res", "tools", name) })
            if (Directory.Exists(d)) return Path.GetFullPath(d);
        for (var dir = new DirectoryInfo(Base); dir is not null; dir = dir.Parent)
        {
            var leaf = Path.Combine(dir.FullName, "tools", name);
            if (Directory.Exists(leaf)) return leaf;
        }
        return "";
    }

    private static string First(string marker, params string[] dirs)
    {
        foreach (var d in dirs)
            if (File.Exists(Path.Combine(d, marker)))
                return Path.GetFullPath(d);
        return Path.GetFullPath(dirs[0]);
    }
}
