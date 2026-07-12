namespace Gatherlight.Server.Modules.Llm.Services;

/// <summary>
/// Accumulates the set of data-root-relative file paths the agent wrote during a run, read from
/// the Edit/Write/MultiEdit/NotebookEdit tool_use events. The chat pipeline stages + commits
/// exactly these paths, so pre-existing unrelated working-tree changes are never swept into the
/// agent's commit.
/// </summary>
public sealed class EditTracker
{
    private static readonly string[] WriteTools = { "Edit", "Write", "MultiEdit", "NotebookEdit" };

    private readonly string _rootPath;
    private readonly HashSet<string> _paths = new();
    private readonly object _lock = new();

    public EditTracker(string rootPath) => _rootPath = Path.GetFullPath(rootPath);

    /// <summary>Feed a tool_use block; records the path if it's a file-writing tool.</summary>
    public void Record(string toolName, string? filePath)
    {
        if (filePath is null || !WriteTools.Contains(toolName)) return;
        var abs = Path.IsPathRooted(filePath) ? filePath : Path.Combine(_rootPath, filePath);
        var full = Path.GetFullPath(abs);
        var rootWithSep = _rootPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        if (!full.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase)) return;
        var rel = full[rootWithSep.Length..].Replace('\\', '/');
        if (rel.Length == 0) return;
        lock (_lock) _paths.Add(rel);
    }

    public List<string> List()
    {
        lock (_lock) return _paths.Order().ToList();
    }
}
