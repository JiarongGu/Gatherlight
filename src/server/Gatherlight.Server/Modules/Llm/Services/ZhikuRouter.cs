using System.Text;
using System.Text.Json;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.Llm.Services;

public sealed record RoutingCategory(string Key, List<string> Match, List<string> Docs, bool Lite);

public sealed record RoutingResult(string CategoryKey, string PromptBlock);

/// <summary>
/// Deterministic server-side RAG router — replaces the agent-side 5-skill discovery round-trips
/// for recognizable task categories. Reads the user-editable {data}/.claude/routing.json
/// (hot-read per request, seeded with the knowledge-base template), keyword-matches the user
/// message, and builds a prompt block with the routed docs (small files inlined, large files
/// listed for Read). Zero tokens spent on routing; 100% gate compliance by construction.
/// No match / no routing.json → null, and the agent runs the full discovery gate as before.
/// </summary>
public interface IZhikuRouter
{
    RoutingResult? Route(string userMessage);
}

public sealed class ZhikuRouter : IZhikuRouter
{
    private const int InlineMaxBytes = 4096;   // docs at most this size are embedded verbatim
    private const int InlineBudgetBytes = 16384; // total embedded content cap per prompt

    private readonly IDataContext _data;
    private readonly ILogger<ZhikuRouter> _log;

    public ZhikuRouter(IDataContext data, ILogger<ZhikuRouter> log)
    {
        _data = data;
        _log = log;
    }

    public RoutingResult? Route(string userMessage)
    {
        var categories = LoadCategories();
        if (categories.Count == 0) return null;

        // First match wins — routing.json orders specific categories before broad ones.
        var category = categories.FirstOrDefault(c =>
            c.Match.Any(m => userMessage.Contains(m, StringComparison.OrdinalIgnoreCase)));
        if (category is null) return null;

        var inlined = new StringBuilder();
        var toRead = new List<string>();
        var budget = InlineBudgetBytes;
        foreach (var rel in category.Docs)
        {
            var abs = _data.ResolveDataPath(rel);
            if (abs is null || !File.Exists(abs)) continue; // user may have pruned a doc — skip silently
            var fi = new FileInfo(abs);
            if (fi.Length <= InlineMaxBytes && fi.Length <= budget)
            {
                inlined.Append($"[DOC {rel}]\n{File.ReadAllText(abs)}\n[/DOC]\n");
                budget -= (int)fi.Length;
            }
            else
            {
                toRead.Add(rel);
            }
        }
        if (inlined.Length == 0 && toRead.Count == 0) return null;

        var block = new StringBuilder();
        block.AppendLine("SERVER PRE-ROUTING (deterministic — the per-task gate's DISCOVERY has already run server-side):");
        block.AppendLine($"- Task category: {category.Key}");
        block.AppendLine("- The discovery skills (/doc-loader /skill-loader /tool-loader /pattern-finder) are SATISFIED by this block — do NOT invoke them again; re-running them duplicates work and wastes tokens. (/caveman still applies if the user asked for brevity.)");
        block.AppendLine("- The routed docs below are your required reading. Contents are inlined where small:");
        block.Append(inlined);
        if (toRead.Count > 0)
            block.AppendLine($"- Read these routed files yourself (too large to inline): {string.Join(", ", toRead)}");
        block.AppendLine("- Still scan .claude/rules/RULES_INDEX.md and obey matching rules — routing covers discovery, not the rules.");
        if (category.Lite)
            block.AppendLine("- LITE TASK: this is a single-file template task. After the routed reading, plan DIRECTLY — no further exploration unless something is genuinely missing.");
        block.AppendLine();
        return new RoutingResult(category.Key, block.ToString());
    }

    private List<RoutingCategory> LoadCategories()
    {
        var path = Path.Combine(_data.ZhikuPath, "routing.json");
        if (!File.Exists(path)) return new();
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var list = new List<RoutingCategory>();
            foreach (var c in doc.RootElement.GetProperty("categories").EnumerateArray())
            {
                list.Add(new RoutingCategory(
                    Key: c.GetProperty("key").GetString() ?? "",
                    Match: c.GetProperty("match").EnumerateArray().Select(m => m.GetString() ?? "").Where(m => m.Length > 0).ToList(),
                    Docs: c.GetProperty("docs").EnumerateArray().Select(d => d.GetString() ?? "").Where(d => d.Length > 0).ToList(),
                    Lite: c.TryGetProperty("lite", out var l) && l.ValueKind == JsonValueKind.True));
            }
            return list;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "routing.json unreadable — falling back to full agent-side gate");
            return new();
        }
    }
}
