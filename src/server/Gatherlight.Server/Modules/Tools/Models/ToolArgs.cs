using System.Text.Json;

namespace Gatherlight.Server.Modules.Tools.Models;

/// <summary>
/// Shared readers for tool arguments (the <see cref="JsonElement"/> a tool receives) — one home for
/// the optional/required/number parsing every <see cref="IGatherlightTool"/> needs, instead of each
/// tool redefining its own <c>Opt</c>/<c>Req</c>/<c>Dbl</c> helpers.
/// </summary>
public static class ToolArgs
{
    /// <summary>An optional non-empty string, or null. Returns null (not a throw) for a present-but-
    /// non-string value (e.g. the model emits a number/array), so a malformed arg degrades gracefully.</summary>
    public static string? Str(JsonElement a, string key) =>
        a.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            && v.GetString() is { Length: > 0 } s ? s : null;

    /// <summary>A required non-empty string, or a 400 <see cref="ToolException"/>.</summary>
    public static string Req(JsonElement a, string key, string? message = null) =>
        Str(a, key) ?? throw new ToolException(400, message ?? $"{key} 必填");

    /// <summary>An optional double (present + numeric), or null.</summary>
    public static double? Dbl(JsonElement a, string key) =>
        a.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;

    /// <summary>An optional int (present + integral), or <paramref name="fallback"/>.</summary>
    public static int Int(JsonElement a, string key, int fallback) =>
        a.TryGetProperty(key, out var v) && v.TryGetInt32(out var n) ? n : fallback;
}
