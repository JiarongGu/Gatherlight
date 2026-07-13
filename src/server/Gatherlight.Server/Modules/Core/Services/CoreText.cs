using System.Text.Json;

namespace Gatherlight.Server.Modules.Core.Services;

/// <summary>Path text normalization shared across the git + fs-ops modules.</summary>
public static class PathText
{
    /// <summary>Forward-slash a repo/data-relative path and strip leading <c>./</c> segments.</summary>
    public static string Norm(string rel)
    {
        var s = rel.Replace('\\', '/');
        while (s.StartsWith("./", StringComparison.Ordinal)) s = s[2..];
        return s;
    }
}

/// <summary>Small JSON-element string readers used across modules that parse event / release / usage
/// payloads (Trace, Update, Scoring, the CLI runner).</summary>
public static class JsonEl
{
    /// <summary>String value of <paramref name="prop"/>, or "" when absent/non-string.</summary>
    public static string Str(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() ?? "" : "";

    /// <summary>First present non-empty string among <paramref name="props"/>, else null.</summary>
    public static string? FirstString(JsonElement el, params string[] props)
    {
        foreach (var prop in props)
            if (el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String && v.GetString() is { Length: > 0 } s)
                return s;
        return null;
    }
}
