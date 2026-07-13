using System.Text.RegularExpressions;

namespace Gatherlight.Server.Modules.Library.Services;

/// <summary>
/// Migrates a markdown reference library (the old "JAPAN_ATTRACTIONS.md" pattern — `## region` →
/// `### entry` → bullet fields) into structured <see cref="LibraryUpsert"/> rows. Deterministic,
/// zero-token. Extracts ONLY durable reference facts (name, region, a public summary, image,
/// coordinates, official URL, type→tags) — it never reads the trip/family planning lines
/// (适合 / 📅 / 特色), so private planning context stays out of the library.
/// </summary>
public static partial class MarkdownLibraryImporter
{
    public static List<LibraryUpsert> Parse(string markdown, string defaultKind = "attraction", string? regionOverride = null)
    {
        var lines = markdown.Replace("\r\n", "\n").Split('\n');
        var results = new List<LibraryUpsert>();
        var region = regionOverride ?? "";
        var skip = false; // inside a meta section (How to Use / Legend / …) — not a place
        string? heading = null;
        var body = new List<string>();
        var usedKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void Flush()
        {
            if (heading is not null && !skip)
            {
                var item = BuildEntry(heading, body, region, defaultKind, usedKeys);
                if (item is not null) results.Add(item);
            }
            heading = null;
            body.Clear();
        }

        foreach (var raw in lines)
        {
            var line = raw.TrimEnd();
            if (line.StartsWith("### "))
            {
                Flush();
                heading = line[4..].Trim();
            }
            else if (line.StartsWith("## "))
            {
                Flush();
                var cleaned = CleanRegion(line[3..]);
                skip = MetaSectionRegex().IsMatch(cleaned);
                if (regionOverride is null) region = cleaned;
            }
            else if (heading is not null)
            {
                body.Add(line);
            }
        }
        Flush();
        return results;
    }

    private static LibraryUpsert? BuildEntry(string heading, List<string> body, string region, string defaultKind, HashSet<string> usedKeys)
    {
        var (name, nameLocal) = ParseName(heading);
        if (name.Length == 0) return null;

        var text = string.Join("\n", body);
        var kind = DetectKind($"{heading}\n{TypeValue(text)}", defaultKind);

        // Summary: the first non-warning blockquote only (public Wikipedia text). Never the
        // 特色/适合/📅 bullets — those can carry private trip context.
        string? summary = null;
        foreach (var b in body)
        {
            var m = BlockquoteRegex().Match(b);
            if (!m.Success) continue;
            var q = m.Groups[1].Value.Trim();
            if (q.Contains('⚠') || q.Length < 12) continue;
            summary = CleanSummary(q);
            break;
        }

        var image = ImageRegex().Match(text) is { Success: true } im ? im.Groups[1].Value : null;
        double? lat = null, lng = null;
        if (CoordRegex().Match(text) is { Success: true } cm
            && double.TryParse(cm.Groups[1].Value, out var la) && double.TryParse(cm.Groups[2].Value, out var ln))
        { lat = la; lng = ln; }

        var url = OfficialUrl(body);
        var hasWiki = text.Contains("wikipedia", StringComparison.OrdinalIgnoreCase);
        var tags = TypeValue(text);
        var confidence = summary is not null && text.Contains("verified", StringComparison.OrdinalIgnoreCase) ? 0.85
            : text.Contains('⚠') ? 0.6 : 0.7;

        var key = UniqueKey(name, nameLocal, usedKeys);
        return new LibraryUpsert(
            kind, key, name, nameLocal, region.Length > 0 ? region : null, summary,
            url, image, lat, lng, tags, hasWiki ? "wikipedia" : "curated", confidence, null);
    }

    // ---- field helpers ----

    private static (string Name, string? NameLocal) ParseName(string heading)
    {
        // Strip leading emoji/symbols, then any trailing "(...)" annotation.
        var s = LeadingSymbolsRegex().Replace(heading, "").Trim();
        s = TrailingParenRegex().Replace(s, "").Trim();
        var cjk = LeadingCjkRegex().Match(s);
        if (cjk.Success)
        {
            var local = cjk.Groups[1].Value.Trim();
            var rest = s[cjk.Length..].Trim();
            return rest.Length > 0 ? (rest, local) : (local, null);
        }
        return (s, null);
    }

    private static string CleanRegion(string h2)
    {
        var s = LeadingSymbolsRegex().Replace(h2, "").Trim();
        s = TrailingParenRegex().Replace(s, "").Trim();
        return s;
    }

    private static string CleanSummary(string q)
    {
        // Drop a leading "**Wikipedia** (verified 2026-05-20): " style prefix.
        var s = SummaryPrefixRegex().Replace(q, "").Trim();
        return s.Length > 400 ? s[..400].TrimEnd() + "…" : s;
    }

    private static string? OfficialUrl(List<string> body)
    {
        // Prefer a line marked Official/Info; take its first non-wikipedia link.
        foreach (var b in body)
        {
            if (!b.Contains("Official") && !b.Contains("官方") && !b.Contains("Info")) continue;
            foreach (Match m in LinkRegex().Matches(b))
            {
                var u = m.Groups[1].Value;
                if (!u.Contains("wikipedia", StringComparison.OrdinalIgnoreCase)) return u;
            }
        }
        return null;
    }

    private static string? TypeValue(string text)
    {
        var m = TypeRegex().Match(text);
        if (!m.Success) return null;
        var v = m.Groups[1].Value.Trim().Trim('*').Trim();
        return v.Length > 0 ? v : null;
    }

    private static string DetectKind(string s, string fallback)
    {
        if (RestaurantHint().IsMatch(s)) return "restaurant";
        if (HotelHint().IsMatch(s)) return "hotel";
        return fallback;
    }

    private static string UniqueKey(string name, string? nameLocal, HashSet<string> used)
    {
        var basis = SlugAsciiRegex().Replace(name.ToLowerInvariant(), "-").Trim('-');
        if (basis.Length == 0) basis = "entry";
        if (basis.Length > 48) basis = basis[..48].Trim('-');
        var key = basis;
        var i = 2;
        while (!used.Add(key)) key = $"{basis}-{i++}";
        return key;
    }

    [GeneratedRegex(@"^\s*>\s?(.*)$")] private static partial Regex BlockquoteRegex();
    [GeneratedRegex(@"!\[[^\]]*\]\(([^)\s]+)")] private static partial Regex ImageRegex();
    [GeneratedRegex(@"(\d{1,3}\.\d+)\s*°?\s*N\s*[,，]?\s*(\d{1,3}\.\d+)\s*°?\s*E", RegexOptions.IgnoreCase)] private static partial Regex CoordRegex();
    [GeneratedRegex(@"\]\(([^)\s]+)\)")] private static partial Regex LinkRegex();
    [GeneratedRegex(@"类型\**\s*[:：]\s*\**([^·\n]+)")] private static partial Regex TypeRegex();
    [GeneratedRegex(@"^[^\p{L}\p{N}]+")] private static partial Regex LeadingSymbolsRegex();
    [GeneratedRegex(@"[（(][^）)]*[）)]\s*$")] private static partial Regex TrailingParenRegex();
    [GeneratedRegex(@"^([㐀-鿿぀-ヿ]+)")] private static partial Regex LeadingCjkRegex();
    [GeneratedRegex(@"^\*\*[^*]+\*\*\s*(?:\([^)]*\))?\s*[:：]\s*")] private static partial Regex SummaryPrefixRegex();
    [GeneratedRegex(@"[^a-z0-9]+")] private static partial Regex SlugAsciiRegex();
    [GeneratedRegex(@"餐|寿司|鮨|烧肉|焼肉|拉面|拉麵|居酒屋|米其林|米其林|restaurant|sushi|ramen|yakiniku", RegexOptions.IgnoreCase)] private static partial Regex RestaurantHint();
    [GeneratedRegex(@"酒店|旅館|旅馆|ryokan|hotel|温泉旅", RegexOptions.IgnoreCase)] private static partial Regex HotelHint();
    // Doc/usage sections that are not places — their ### items must not become library entries.
    [GeneratedRegex(@"how to use|legend|index|contents|table of contents|tips|notes|about|usage|reference guide|说明|图例|目录|用法|关于|使用方法|图例说明", RegexOptions.IgnoreCase)] private static partial Regex MetaSectionRegex();
}
