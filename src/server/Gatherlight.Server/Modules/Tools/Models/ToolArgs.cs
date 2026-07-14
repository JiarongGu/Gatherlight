using System.Text.Json;
using System.Text.Json.Serialization;

namespace Gatherlight.Server.Modules.Tools.Models;

/// <summary>
/// Tool-argument binding. Fixed-shape tools declare their inputs as a typed record and call
/// <see cref="Parse{T}"/> (real deserialization — the fields are properly typed); a few tools that
/// read a single caller-chosen key generically (path resolvers, batch scrapers) use the
/// <see cref="Str"/>/<see cref="Req"/> element readers. Required-field presence is still enforced
/// upstream by the registry from the tool's <c>InputSchema</c> (the MCP contract the agent sees).
/// </summary>
public static class ToolArgs
{
    /// <summary>Web defaults (camelCase, case-insensitive) + tolerate a number sent as a JSON string
    /// (LLMs do that), so <c>"confidence":"0.9"</c> binds to a <c>double?</c>.</summary>
    public static readonly JsonSerializerOptions Opts = new(JsonSerializerDefaults.Web)
    {
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    /// <summary>Bind the args into <typeparamref name="T"/>; a malformed value (wrong JSON type for a
    /// field) surfaces as a clean 400 instead of an opaque 500.</summary>
    public static T Parse<T>(JsonElement args)
    {
        try { return args.Deserialize<T>(Opts) ?? throw new ToolException(400, "参数解析失败"); }
        // Report the offending field (ex.Path, e.g. "$.kind") — not STJ's type-name-laden message.
        catch (JsonException ex) { throw new ToolException(400, $"参数类型无效:{ex.Path ?? "?"}"); }
    }

    /// <summary>A required non-empty field of an already-parsed record, or a 400 (for the required
    /// fields a typed record binds as nullable, since presence is validated upstream, not by the type).</summary>
    public static string Req(string? value, string field) =>
        value is { Length: > 0 } ? value : throw new ToolException(400, $"{field} 必填");

    // --- element readers, for the few tools that read a single dynamic key rather than a typed record ---

    /// <summary>An optional non-empty string, or null (also for a present-but-non-string value).</summary>
    public static string? Str(JsonElement a, string key) =>
        a.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            && v.GetString() is { Length: > 0 } s ? s : null;

    /// <summary>A required non-empty string read from a dynamic key, or a 400 <see cref="ToolException"/>.</summary>
    public static string Req(JsonElement a, string key, string? message = null) =>
        Str(a, key) ?? throw new ToolException(400, message ?? $"{key} 必填");
}
