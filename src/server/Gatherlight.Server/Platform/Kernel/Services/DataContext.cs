namespace Gatherlight.Server.Platform.Kernel.Services;

/// <summary>
/// The SITE — the agent's world. Its record directories (declared by the manifest), its knowledge
/// base, uploads and cache, all under the folder's own private git repo. Artifact paths stored in
/// the DB are site-root-relative with forward slashes; <see cref="ResolveSitePath"/> is the one
/// place that joins them back, and the one place that refuses an escape.
/// </summary>
public interface ISiteContext
{
    string RootPath { get; }
    string UploadsPath { get; }
    string CachePath { get; }
    /// <summary>The planner knowledge base ({data}/.claude) the spawned agent runs on.</summary>
    string ZhikuPath { get; }
    /// <summary>Absolute paths of the manifest-declared record directories.</summary>
    IReadOnlyList<string> RecordPaths { get; }

    /// <summary>Join a site-root-relative path to the root. Null if it escapes the root — including
    /// into platform state/. Existence is NOT checked; callers decide (read targets vs write targets).</summary>
    string? ResolveSitePath(string relativePath);

    /// <summary>Site-root-relative form (forward slashes) of an absolute path under the root;
    /// null if outside.</summary>
    string? ToRelativePath(string absolutePath);
}

/// <summary>
/// The PLATFORM — everything the site must never reach: the database, the access token, the TLS
/// key, provisioned resources, logs and update staging. It lives under <c>{data}/state</c>, outside
/// the site's jail, which is the property the judge tools already depend on.
/// </summary>
public interface IPlatformContext
{
    string StatePath { get; }
    string DatabasePath { get; }
    /// <summary>Large downloadable resources (chromium, git, node) provisioned at setup rather than
    /// bundled. Lives in the data folder so it survives app updates and is downloaded once.</summary>
    string ResourcesPath { get; }
    /// <summary>Daily-rolling plain-text app logs (<c>{yyyy-MM-dd}.log</c>).</summary>
    string LogsPath { get; }
}

public sealed class SiteContext : ISiteContext
{
    private readonly Gatherlight.Server.Platform.Site.Services.ISiteManifestStore _manifest;

    public SiteContext(GatherlightServerOptions options,
        Gatherlight.Server.Platform.Site.Services.ISiteManifestStore manifest)
    {
        _manifest = manifest;
        RootPath = Path.GetFullPath(options.DataPath);
        Directory.CreateDirectory(RootPath);
        Directory.CreateDirectory(UploadsPath);
        Directory.CreateDirectory(CachePath);
    }

    public string RootPath { get; }
    public string UploadsPath => Path.Combine(RootPath, "uploads");
    public string CachePath => Path.Combine(RootPath, "cache");
    public string ZhikuPath => Path.Combine(RootPath, ".claude");

    // Read the manifest LAZILY, never cached at construction: SiteManifestStep writes site.json
    // during startup migration, which is after DI builds this singleton. Caching here would pin the
    // defaults and silently disagree with the manifest for the rest of the process lifetime.
    public IReadOnlyList<string> RecordPaths
    {
        get
        {
            var dirs = _manifest.Current.Records.Select(r => Path.Combine(RootPath, r)).ToList();
            foreach (var d in dirs) Directory.CreateDirectory(d);
            return dirs;
        }
    }

    public string? ResolveSitePath(string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath)) return null;
        var full = Path.GetFullPath(Path.Combine(RootPath, relativePath));
        // Prefix match must be on a directory boundary, or a sibling like `…\local2` slips past
        // the guard for root `…\local`. Compare against root + separator (and allow the root itself).
        var rootWithSep = RootPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        var withinRoot = full.Equals(RootPath, StringComparison.OrdinalIgnoreCase)
            || full.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase);
        if (!withinRoot) return null;
        // state/ is the platform's, not the site's — refuse it even though it is under the root.
        // Both the directory ITSELF and anything beneath it: the bare form has no trailing
        // separator, so a prefix-only test would let `state` through while blocking `state/x`.
        var state = Path.Combine(RootPath, "state");
        if (full.Equals(state, StringComparison.OrdinalIgnoreCase)
            || full.StartsWith(state + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            return null;
        return full;
    }

    public string? ToRelativePath(string absolutePath)
    {
        var full = Path.GetFullPath(absolutePath);
        var rootWithSep = RootPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        if (!full.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase)) return null;
        return full[rootWithSep.Length..].Replace('\\', '/');
    }
}

public sealed class PlatformContext : IPlatformContext
{
    public PlatformContext(GatherlightServerOptions options)
    {
        StatePath = Path.Combine(Path.GetFullPath(options.DataPath), "state");
        Directory.CreateDirectory(StatePath);
    }

    public string StatePath { get; }
    public string DatabasePath => Path.Combine(StatePath, "gatherlight.db");
    public string ResourcesPath => Path.Combine(StatePath, "resources");
    public string LogsPath => Path.Combine(StatePath, "logs");
}
