namespace Gatherlight.Server.Modules.Core.Services;

/// <summary>
/// The data folder is Gatherlight's single user-data root (configurable via
/// <c>GATHERLIGHT_DATA</c>, default <c>./local</c>). It holds the markdown artifacts the AI
/// agent works on (plans/, household/, the planner knowledge base in .claude/) under the folder's
/// own private git repo, plus app state under state/ (SQLite, settings) and uploads/ + cache/.
/// All artifact paths stored in the DB are data-root-relative with forward slashes;
/// <see cref="ResolveDataPath"/> is the one place that joins them back (guarding traversal).
/// </summary>
public interface IDataContext
{
    string RootPath { get; }
    string StatePath { get; }
    string DatabasePath { get; }
    string UploadsPath { get; }
    string CachePath { get; }
    string PlansPath { get; }
    string HouseholdPath { get; }
    /// <summary>Large downloadable resources (chromium, git, embedding model) provisioned at setup
    /// rather than bundled. Lives in the data folder so it survives app updates and is downloaded once.</summary>
    string ResourcesPath { get; }
    /// <summary>Daily-rolling plain-text app logs (<c>{yyyy-MM-dd}.log</c>) for error tracking.</summary>
    string LogsPath { get; }
    /// <summary>The planner knowledge base ({data}/.claude) the spawned agent runs on.</summary>
    string ZhikuPath { get; }

    /// <summary>Join a data-root-relative path to the root. Null if it escapes the root.
    /// Existence is NOT checked — callers decide (read targets vs write targets).</summary>
    string? ResolveDataPath(string relativePath);

    /// <summary>Data-root-relative form (forward slashes) of an absolute path under the root;
    /// null if outside.</summary>
    string? ToRelativePath(string absolutePath);
}

public sealed class DataContext : IDataContext
{
    public DataContext(GatherlightServerOptions options)
    {
        RootPath = Path.GetFullPath(options.DataPath);
        Directory.CreateDirectory(RootPath);
        Directory.CreateDirectory(StatePath);
        Directory.CreateDirectory(UploadsPath);
        Directory.CreateDirectory(CachePath);
        Directory.CreateDirectory(PlansPath);
        Directory.CreateDirectory(HouseholdPath);
    }

    public string RootPath { get; }
    public string StatePath => Path.Combine(RootPath, "state");
    public string DatabasePath => Path.Combine(StatePath, "gatherlight.db");
    public string UploadsPath => Path.Combine(RootPath, "uploads");
    public string CachePath => Path.Combine(RootPath, "cache");
    public string PlansPath => Path.Combine(RootPath, "plans");
    public string HouseholdPath => Path.Combine(RootPath, "household");
    public string ZhikuPath => Path.Combine(RootPath, ".claude");
    public string ResourcesPath => Path.Combine(StatePath, "resources");
    public string LogsPath => Path.Combine(StatePath, "logs");

    public string? ResolveDataPath(string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath)) return null;
        var full = Path.GetFullPath(Path.Combine(RootPath, relativePath));
        // Prefix match must be on a directory boundary, or a sibling like `…\local2` slips past
        // the guard for root `…\local`. Compare against root + separator (and allow the root itself).
        var rootWithSep = RootPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        var withinRoot = full.Equals(RootPath, StringComparison.OrdinalIgnoreCase)
            || full.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase);
        return withinRoot ? full : null;
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
