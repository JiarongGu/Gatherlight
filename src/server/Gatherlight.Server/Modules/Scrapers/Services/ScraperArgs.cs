using System.Text.Json;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Scrapers.Services;

/// <summary>
/// Argument helpers shared by the scraper tools — batch-`queries` parsing, optional string reads,
/// digits-only numeric coercion — one definition instead of a copy per tool.
/// </summary>
public static class ScraperArgs
{
    /// <summary>Optional string property; null when absent, empty, or a present-but-non-string value.</summary>
    public static string? Str(JsonElement e, string key) => ToolArgs.Str(e, key);

    /// <summary>Digits-only integer coercion ("A$1,148" → 1148); null when there are no digits.</summary>
    public static int? Digits(string raw)
    {
        var d = new string(raw.Where(char.IsDigit).ToArray());
        return int.TryParse(d, out var n) ? n : null;
    }

    /// <summary>Truncate for compact notes/log lines.</summary>
    public static string Trunc(string s, int n) => s.Length <= n ? s : s[..n];

    /// <summary>
    /// Parse a `queries`-style string argument (a JSON array of objects) and map each element.
    /// Throws <see cref="ToolException"/>(400) on bad JSON / non-array / empty. The map runs inside
    /// the document's lifetime, so callers get materialized results, not dangling JsonElements.
    /// </summary>
    public static List<T> ParseArray<T>(JsonElement args, string key, Func<JsonElement, T> map)
    {
        var raw = args.GetProperty(key).GetString() ?? "";
        JsonDocument doc;
        try { doc = JsonDocument.Parse(raw); }
        catch (JsonException) { throw new ToolException(400, $"{key} 必须是合法 JSON"); }
        using (doc)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Array) throw new ToolException(400, $"{key} 必须是 JSON 数组");
            var list = doc.RootElement.EnumerateArray().Select(map).ToList();
            if (list.Count == 0) throw new ToolException(400, $"{key} 为空");
            return list;
        }
    }
}
