using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.PlanIndex.Services;

/// <summary>
/// Deterministic iCalendar (.ics) export from a plan's markdown — a zero-LLM feature so
/// "add my trip to the calendar" costs no tokens. Extracts all-day events from dated headings:
/// trip day headings (<c>### … Day N — 2026-09-05 …</c>) become one event per day; a daily plan
/// (H1 = a date) becomes a single event. Headings that merely mention a date (changelogs, notes)
/// are ignored — an event needs a "Day N" marker, or the file is a daily plan.
/// </summary>
public interface IIcsExportService
{
    /// <summary>Null if the plan has no exportable dated entries.</summary>
    string? BuildIcs(string relPath);
}

public sealed partial class IcsExportService : IIcsExportService
{
    private readonly IDataContext _data;

    public IcsExportService(IDataContext data) => _data = data;

    public string? BuildIcs(string relPath)
    {
        var abs = _data.ResolveDataPath(relPath);
        if (abs is null || !File.Exists(abs)) return null;
        var content = File.ReadAllText(abs);
        var slug = Path.GetFileNameWithoutExtension(relPath);

        var events = new List<(DateOnly Date, string Summary)>();
        foreach (var line in content.Split('\n'))
        {
            var m = HeadingRegex().Match(line);
            if (!m.Success) continue;
            var text = m.Groups["text"].Value.Trim();
            var dm = DateRegex().Match(text);
            if (!dm.Success) continue;
            if (!DateOnly.TryParseExact(dm.Value, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                    DateTimeStyles.None, out var date)) continue;
            // A trip day (has a "Day N" marker) — else only accept it as the file's single date
            // when this is a daily plan (avoids changelog/note headings that just cite a date).
            var isDayHeading = DayMarkerRegex().IsMatch(text);
            var isDailyPlan = relPath.StartsWith("plans/daily/");
            if (!isDayHeading && !isDailyPlan) continue;
            events.Add((date, CleanSummary(text)));
        }

        // Fallback: a daily/weekly plan whose date lives only in the filename, not a heading.
        if (events.Count == 0)
        {
            var fnDate = DateRegex().Match(slug);
            if (fnDate.Success && DateOnly.TryParseExact(fnDate.Value, "yyyy-MM-dd",
                    CultureInfo.InvariantCulture, DateTimeStyles.None, out var d))
                events.Add((d, FirstH1(content) ?? slug));
        }
        if (events.Count == 0) return null;

        var stamp = DateTime.UtcNow.ToString("yyyyMMddTHHmmssZ");
        var sb = new StringBuilder();
        sb.Append("BEGIN:VCALENDAR\r\n");
        sb.Append("VERSION:2.0\r\n");
        sb.Append("PRODID:-//Gatherlight//Planner//EN\r\n");
        sb.Append("CALSCALE:GREGORIAN\r\n");
        sb.Append("METHOD:PUBLISH\r\n");
        foreach (var (date, summary) in events.DistinctBy(e => (e.Date, e.Summary)))
        {
            var d = date.ToString("yyyyMMdd");
            var uid = $"{Hash($"{relPath}|{d}|{summary}")}@gatherlight";
            sb.Append("BEGIN:VEVENT\r\n");
            Fold(sb, $"UID:{uid}");
            Fold(sb, $"DTSTAMP:{stamp}");
            Fold(sb, $"DTSTART;VALUE=DATE:{d}");
            Fold(sb, $"SUMMARY:{Escape(summary)}");
            sb.Append("END:VEVENT\r\n");
        }
        sb.Append("END:VCALENDAR\r\n");
        return sb.ToString();
    }

    /// <summary>Trim markdown/emoji noise from a heading so it reads as an event title.</summary>
    private static string CleanSummary(string text)
    {
        var s = EmojiPrefixRegex().Replace(text, "").Trim();
        s = s.Replace("**", "").Trim(' ', '—', '-');
        return s.Length > 0 ? s : text.Trim();
    }

    private static string? FirstH1(string content)
    {
        var m = H1Regex().Match(content);
        return m.Success ? CleanSummary(m.Groups[1].Value.Trim()) : null;
    }

    // RFC 5545: escape , ; \ and newlines; fold lines at 75 octets with a leading space.
    private static string Escape(string s) => s
        .Replace("\\", "\\\\").Replace(";", "\\;").Replace(",", "\\,")
        .Replace("\r\n", "\\n").Replace("\n", "\\n");

    private static void Fold(StringBuilder sb, string line)
    {
        var bytes = Encoding.UTF8.GetBytes(line);
        if (bytes.Length <= 75) { sb.Append(line).Append("\r\n"); return; }
        // Fold on octet boundaries without splitting a UTF-8 sequence.
        var pos = 0;
        var first = true;
        while (pos < bytes.Length)
        {
            var take = Math.Min(first ? 75 : 74, bytes.Length - pos);
            // Don't split a UTF-8 codepoint — back off while the NEXT byte is a continuation
            // byte (only meaningful when a next byte exists).
            while (take > 0 && pos + take < bytes.Length && (bytes[pos + take] & 0xC0) == 0x80) take--;
            if (!first) sb.Append(' ');
            sb.Append(Encoding.UTF8.GetString(bytes, pos, take)).Append("\r\n");
            pos += take;
            first = false;
        }
    }

    private static string Hash(string s) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s)))[..16].ToLowerInvariant();

    [GeneratedRegex(@"^#{1,6}\s+(?<text>.+)$")]
    private static partial Regex HeadingRegex();

    [GeneratedRegex(@"\b(\d{4}-\d{2}-\d{2})\b")]
    private static partial Regex DateRegex();

    [GeneratedRegex(@"\bDay\s*\d+\b", RegexOptions.IgnoreCase)]
    private static partial Regex DayMarkerRegex();

    [GeneratedRegex(@"^#\s+(.+)$", RegexOptions.Multiline)]
    private static partial Regex H1Regex();

    [GeneratedRegex(@"^[\p{So}\p{Cs}️\s]+")]
    private static partial Regex EmojiPrefixRegex();
}
