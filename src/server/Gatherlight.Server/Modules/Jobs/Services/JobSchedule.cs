using System.Globalization;
using Cronos;
using Gatherlight.Server.Modules.Jobs.Models;

namespace Gatherlight.Server.Modules.Jobs.Services;

/// <summary>
/// Pure schedule math: parse a job's schedule and compute its next UTC occurrence. Cron via Cronos
/// (5-field standard or 6-field with seconds), timezone/DST-aware; one-off from an ISO-8601 instant.
/// No I/O — the scheduler and the create/update path both call this.
/// </summary>
public static class JobSchedule
{
    /// <summary>IANA tz (e.g. <c>Asia/Tokyo</c>) → TimeZoneInfo; UTC on empty/unknown (net10 ICU
    /// resolves IANA ids on Windows). Never throws.</summary>
    public static TimeZoneInfo ResolveTz(string? tz)
    {
        if (string.IsNullOrWhiteSpace(tz)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(tz.Trim()); }
        catch { return TimeZoneInfo.Utc; }
    }

    /// <summary>Parse a cron string, auto-selecting 6-field (seconds) vs 5-field standard.</summary>
    public static CronExpression ParseCron(string cron)
    {
        var fields = cron.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length;
        return CronExpression.Parse(cron, fields >= 6 ? CronFormat.IncludeSeconds : CronFormat.Standard);
    }

    /// <summary>Validate a job's schedule fields; returns an error message or null if valid.</summary>
    public static string? Validate(Job job)
    {
        if (!ScheduleKind.IsValid(job.ScheduleKind)) return $"未知的 scheduleKind:{job.ScheduleKind}";
        if (job.ScheduleKind == ScheduleKind.Once)
        {
            if (!TryParseInstant(job.RunAt, out _)) return "一次性任务需要有效的 runAt (ISO-8601 时间)。";
        }
        else
        {
            if (string.IsNullOrWhiteSpace(job.Cron)) return "周期任务需要 cron 表达式。";
            try { ParseCron(job.Cron); } catch (Exception ex) { return $"cron 表达式无效:{ex.Message}"; }
        }
        return null;
    }

    /// <summary>The job's FIRST scheduled instant (UTC): the one-off's runAt as-is (may be past →
    /// fires on next tick / catch-up), or the next cron occurrence strictly after <paramref name="nowUtc"/>.</summary>
    public static DateTime? FirstOccurrence(Job job, DateTime nowUtc)
    {
        if (job.ScheduleKind == ScheduleKind.Once)
            return TryParseInstant(job.RunAt, out var at) ? at : null;
        return NextCron(job, nowUtc);
    }

    /// <summary>The next occurrence AFTER a job just fired: null for a one-off (it's spent), else the
    /// next cron occurrence strictly after <paramref name="fromUtc"/>.</summary>
    public static DateTime? NextAfterRun(Job job, DateTime fromUtc)
    {
        if (job.ScheduleKind == ScheduleKind.Once) return null;
        return NextCron(job, fromUtc);
    }

    private static DateTime? NextCron(Job job, DateTime fromUtc)
    {
        if (string.IsNullOrWhiteSpace(job.Cron)) return null;
        var expr = ParseCron(job.Cron);
        return expr.GetNextOccurrence(DateTime.SpecifyKind(fromUtc, DateTimeKind.Utc), ResolveTz(job.Timezone), inclusive: false);
    }

    public static bool TryParseInstant(string? iso, out DateTime utc)
    {
        utc = default;
        if (string.IsNullOrWhiteSpace(iso)) return false;
        if (!DateTime.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var dt)) return false;
        utc = dt.ToUniversalTime();
        return true;
    }

    /// <summary>ISO-8601 round-trip UTC string (the on-disk form for all instant columns), or null.</summary>
    public static string? Iso(DateTime? utc) => utc?.ToUniversalTime().ToString("o");
}
