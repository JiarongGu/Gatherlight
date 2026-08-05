using System.Text;
using System.Text.Json;
using Gatherlight.Server.Platform.Kernel.Services;
using ITool = Lyntai.Agents.ITool;

namespace Gatherlight.Server.Platform.Ops.Scoring.Services;

/// <summary>
/// The read jail shared by the judge tools. These tools are reachable ONLY from Lyntai's ephemeral MCP
/// tool host, which <c>ClaudeCliProvider</c> stands up for the duration of a one-shot <c>ILlmClient</c>
/// call — in this app, the two LLM-judge scorers and nothing else. They are strictly read-only.
///
/// <para>The jail deliberately mirrors the planner scope-guard's artifact subtrees
/// (<c>plans/ household/ .claude/</c>) and, just as deliberately, does NOT include <c>state/</c>: that
/// holds settings.json (the remote-access token), the TLS pfx and the SQLite database. A judge has no
/// business reading any of them, and the host is an executing endpoint — so the allow-list is positive
/// (name the readable subtrees) rather than a deny-list of things to remember to exclude.</para>
/// </summary>
internal static class JudgeJail
{
    /// <summary>The only subtrees a judge may read, data-root-relative.</summary>
    internal static readonly string[] Subtrees = ["plans", "household", ".claude"];

    /// <summary>Per-file cap. A judge reasons over prose; handing a multi-megabyte artifact to the CLI
    /// would blow the judge's context (and the token budget) for no gain, so truncate loudly instead.</summary>
    internal const int MaxBytes = 64 * 1024;

    /// <summary>Cap on a single listing — enough to locate an artifact, not enough to enumerate a tree
    /// into the judge's context.</summary>
    internal const int MaxListEntries = 200;

    // Judges read prose. Anything else (images, pdfs, sqlite, pfx) is refused rather than decoded as
    // text — a binary blob in the judge's context is pure noise and, for the credential-bearing ones,
    // worse than noise.
    private static readonly HashSet<string> TextExtensions =
        new(StringComparer.OrdinalIgnoreCase) { ".md", ".txt", ".json", ".csv", ".yml", ".yaml" };

    /// <summary>Resolve a data-root-relative path for reading. Returns null and sets
    /// <paramref name="error"/> when the path escapes the root, lands outside the readable subtrees,
    /// or resolves (via a symlink/junction) to somewhere it shouldn't.</summary>
    internal static string? Resolve(ISiteContext data, string relative, out string error)
    {
        error = "";
        if (string.IsNullOrWhiteSpace(relative))
        {
            error = "path is required";
            return null;
        }

        // ResolveSitePath already normalizes and rejects traversal out of the data root (incl. state/);
        // the subtree check below is the second, narrower gate.
        var full = data.ResolveSitePath(relative);
        if (full is null)
        {
            error = $"path escapes the data folder: {relative}";
            return null;
        }

        // A symlink/junction passes the textual prefix check while pointing anywhere on disk, so judge
        // the FINAL target, not the name. Non-links resolve to null — then the literal path stands.
        try
        {
            var link = File.ResolveLinkTarget(full, returnFinalTarget: true)
                       ?? Directory.ResolveLinkTarget(full, returnFinalTarget: true);
            if (link is not null) full = Path.GetFullPath(link.FullName);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            /* unresolvable link — the subtree check below still applies to the literal `full` */
        }

        if (!InSubtree(data, full))
        {
            error = $"outside the readable subtrees ({string.Join(", ", Subtrees)}/): {relative}";
            return null;
        }

        return full;
    }

    /// <summary>Whether an absolute path sits inside one of the readable subtrees. Compares on a
    /// directory boundary — a plain prefix match would let <c>plans-archive/</c> pass for <c>plans/</c>.</summary>
    internal static bool InSubtree(ISiteContext data, string fullPath)
    {
        foreach (var name in Subtrees)
        {
            var dir = Path.Combine(data.RootPath, name);
            var dirWithSep = dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                             + Path.DirectorySeparatorChar;
            if (fullPath.Equals(dir, StringComparison.OrdinalIgnoreCase)
                || fullPath.StartsWith(dirWithSep, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    internal static bool IsReadableText(string fullPath) =>
        TextExtensions.Contains(Path.GetExtension(fullPath));

    /// <summary>Pull a string argument out of the MCP arguments object. Tolerates an absent/empty
    /// arguments blob (the model may send <c>{}</c>) rather than throwing.</summary>
    internal static string? Arg(string argumentsJson, string name)
    {
        if (string.IsNullOrWhiteSpace(argumentsJson)) return null;
        try
        {
            using var doc = JsonDocument.Parse(argumentsJson);
            return doc.RootElement.ValueKind == JsonValueKind.Object
                   && doc.RootElement.TryGetProperty(name, out var el)
                   && el.ValueKind == JsonValueKind.String
                ? el.GetString()
                : null;
        }
        catch (JsonException) { return null; }
    }
}

/// <summary>
/// Lets an LLM-judge scorer read the FULL artifact instead of grading the truncated <c>PlanText</c> that
/// the score context carries (4–5k chars). Faithfulness in particular needs the real thing: to decide
/// whether a time-sensitive claim is actually backed, the judge has to be able to open the plan and the
/// household/knowledge file it cites.
/// </summary>
public sealed class JudgeReadFileTool(ISiteContext data) : ITool
{
    public string Name => "judge_read_file";

    public string? Description =>
        "Read a plan or household/knowledge file from the family data folder, so a scoring judgement is " +
        "made against the real artifact rather than a truncated excerpt. Read-only. Paths are data-root " +
        "relative with forward slashes and must sit under plans/, household/ or .claude/ — e.g. " +
        "'plans/daily/2026-07-14.md'. Use judge_list_files first if you don't know the exact path.";

    public string? ParametersJsonSchema => """
        {"type":"object","properties":{"path":{"type":"string","description":"Data-root-relative file path, e.g. plans/daily/2026-07-14.md"}},"required":["path"]}
        """;

    public Task<string> InvokeAsync(string argumentsJson, CancellationToken ct = default)
    {
        var rel = JudgeJail.Arg(argumentsJson, "path") ?? "";
        var full = JudgeJail.Resolve(data, rel, out var error);
        if (full is null) return Task.FromResult($"ERROR: {error}");
        if (!JudgeJail.IsReadableText(full))
            return Task.FromResult($"ERROR: not a readable text file: {rel}");
        if (!File.Exists(full)) return Task.FromResult($"ERROR: no such file: {rel}");

        var bytes = File.ReadAllBytes(full);
        if (bytes.Length <= JudgeJail.MaxBytes)
            return Task.FromResult(new UTF8Encoding(false).GetString(bytes));

        // Cut on a char boundary, not a byte one, or a truncated CJK artifact ends in a replacement char.
        var text = new UTF8Encoding(false).GetString(bytes, 0, JudgeJail.MaxBytes);
        if (text.Length > 0 && char.IsLowSurrogate(text[^1])) text = text[..^1];
        return Task.FromResult(text + $"\n\n[truncated at {JudgeJail.MaxBytes} bytes of {bytes.Length}]");
    }
}

/// <summary>
/// The discovery half of <see cref="JudgeReadFileTool"/>: the judge knows a plan exists but not its exact
/// path (the score context carries changed files only once a session has committed), so let it list the
/// readable subtrees rather than guess a filename and read an ERROR.
/// </summary>
public sealed class JudgeListFilesTool(ISiteContext data) : ITool
{
    public string Name => "judge_list_files";

    public string? Description =>
        "List readable artifact files (plans/, household/, .claude/) in the family data folder, to find " +
        "the path of a plan or source to read with judge_read_file. Read-only. Optional 'dir' narrows to " +
        "one subtree or folder, e.g. 'plans' or 'plans/daily'.";

    public string? ParametersJsonSchema => """
        {"type":"object","properties":{"dir":{"type":"string","description":"Optional data-root-relative folder to list, e.g. plans/daily. Omit to list all readable subtrees."}}}
        """;

    public Task<string> InvokeAsync(string argumentsJson, CancellationToken ct = default)
    {
        var dir = JudgeJail.Arg(argumentsJson, "dir");

        var roots = new List<string>();
        if (string.IsNullOrWhiteSpace(dir))
        {
            roots.AddRange(JudgeJail.Subtrees.Select(s => Path.Combine(data.RootPath, s)));
        }
        else
        {
            var full = JudgeJail.Resolve(data, dir, out var error);
            if (full is null) return Task.FromResult($"ERROR: {error}");
            roots.Add(full);
        }

        var hits = new List<string>();
        foreach (var root in roots)
        {
            if (!Directory.Exists(root)) continue;
            foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
            {
                ct.ThrowIfCancellationRequested();
                if (!JudgeJail.IsReadableText(file)) continue;
                var rel = data.ToRelativePath(file);
                if (rel is null) continue;
                // Re-check every hit: enumeration can walk THROUGH a junction and surface a path that
                // resolves outside the jail.
                if (JudgeJail.Resolve(data, rel, out _) is null) continue;
                hits.Add(rel);
                if (hits.Count >= JudgeJail.MaxListEntries) break;
            }
            if (hits.Count >= JudgeJail.MaxListEntries) break;
        }

        if (hits.Count == 0) return Task.FromResult("(no readable files)");
        hits.Sort(StringComparer.OrdinalIgnoreCase);
        var body = string.Join("\n", hits);
        return Task.FromResult(hits.Count >= JudgeJail.MaxListEntries
            ? body + $"\n[listing capped at {JudgeJail.MaxListEntries} entries]"
            : body);
    }
}
