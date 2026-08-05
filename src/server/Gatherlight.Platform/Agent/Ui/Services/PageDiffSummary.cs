using Gatherlight.Server.Platform.Agent.Ui.Models;

namespace Gatherlight.Server.Platform.Agent.Ui.Services;

/// <summary>
/// Plain-language account of what changed between two page trees, counted by component type. No LLM:
/// the household is being asked to approve a change, and the description of that change must come
/// from the change itself.
/// </summary>
public static class PageDiffSummary
{
    public static string Describe(UiNode? before, UiNode? after)
    {
        if (after is null) return "这个页面将被删除。";
        if (before is null) return $"新页面,包含 {Count(after)} 个组件。";

        var b = Tally(before);
        var a = Tally(after);
        var added = new List<string>();
        var removed = new List<string>();
        foreach (var type in a.Keys.Union(b.Keys).OrderBy(t => t, StringComparer.Ordinal))
        {
            var delta = a.GetValueOrDefault(type) - b.GetValueOrDefault(type);
            if (delta > 0) added.Add($"{delta} 个 {type}");
            else if (delta < 0) removed.Add($"{-delta} 个 {type}");
        }

        var parts = new List<string>();
        if (added.Count > 0) parts.Add("新增 " + string.Join("、", added));
        if (removed.Count > 0) parts.Add("移除 " + string.Join("、", removed));
        // Same components, different content — a text edit. Say so rather than "no change", which
        // would be false and would make the gate look broken.
        return parts.Count == 0 ? "组件结构未变,内容有改动。" : string.Join(";", parts) + "。";
    }

    private static int Count(UiNode n) => 1 + n.Children.Sum(Count);

    private static Dictionary<string, int> Tally(UiNode root)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        void Walk(UiNode n)
        {
            counts[n.Type] = counts.GetValueOrDefault(n.Type) + 1;
            foreach (var c in n.Children) Walk(c);
        }
        Walk(root);
        return counts;
    }
}
