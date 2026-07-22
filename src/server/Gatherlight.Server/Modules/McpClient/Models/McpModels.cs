using System.Text.Json;
using System.Text.Json.Nodes;

namespace Gatherlight.Server.Modules.McpClient.Models;

public static class McpTransportKind
{
    public const string Stdio = "stdio";
    public const string Http = "http";
}

public static class McpServerStatus
{
    public const string Pending = "pending";
    public const string Connected = "connected";
    public const string Error = "error";
    public const string Disabled = "disabled";
}

public static class McpLoginKind
{
    public const string None = "none";
    public const string Qr = "qr";        // login tool returns a QR image to scan
    public const string Browser = "browser"; // login tool returns a URL to open
}

/// <summary>
/// One external MCP server's persisted config (the <c>mcp_server</c> row). snake_case columns map
/// onto these props via the global <c>MatchNamesWithUnderscores</c>. <see cref="SecretsJson"/> is
/// server-side only — it is NEVER placed in a <see cref="McpServerDto"/> or shown to the agent.
/// </summary>
public sealed class McpServerConfig
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Transport { get; set; } = McpTransportKind.Stdio;
    public string? Command { get; set; }
    public string? ArgsJson { get; set; }
    public string? EnvJson { get; set; }
    public string? Url { get; set; }
    public string? HeadersJson { get; set; }
    public string? SecretsJson { get; set; }
    public bool Enabled { get; set; } = true;
    public string Status { get; set; } = McpServerStatus.Pending;
    public string? LastError { get; set; }
    public string? DiscoveredToolsJson { get; set; }
    // Generic interactive login (see McpLoginService). LoginKind 'none' = no login step.
    public string LoginKind { get; set; } = McpLoginKind.None;
    public string? LoginTool { get; set; }
    public string? LoginCheckTool { get; set; }
    public string CreatedAt { get; set; } = "";
    public string UpdatedAt { get; set; } = "";

    public bool NeedsLogin => LoginKind != McpLoginKind.None && !string.IsNullOrWhiteSpace(LoginTool);

    public string[] Args() => ParseStringArray(ArgsJson);
    public Dictionary<string, string> Env() => ParseStringMap(EnvJson);
    public Dictionary<string, string> Headers() => ParseStringMap(HeadersJson);
    public Dictionary<string, string> Secrets() => ParseStringMap(SecretsJson);
    public bool HasSecrets => Secrets().Count > 0;

    public IReadOnlyList<McpToolInfo> DiscoveredTools() => McpToolInfo.ParseList(DiscoveredToolsJson);

    private static string[] ParseStringArray(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return Array.Empty<string>();
        try
        {
            var arr = JsonNode.Parse(json) as JsonArray;
            return arr?.Select(n => n?.GetValue<string>() ?? "").Where(s => s.Length > 0).ToArray()
                   ?? Array.Empty<string>();
        }
        catch { return Array.Empty<string>(); }
    }

    private static Dictionary<string, string> ParseStringMap(string? json)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(json)) return map;
        try
        {
            if (JsonNode.Parse(json) is JsonObject obj)
                foreach (var kv in obj)
                    if (kv.Value is not null) map[kv.Key] = kv.Value.GetValue<string>();
        }
        catch { /* malformed → empty */ }
        return map;
    }
}

/// <summary>A tool discovered from an external MCP server (its <c>tools/list</c> entry).</summary>
public sealed record McpToolInfo(string Name, string Description, JsonElement InputSchema)
{
    public static IReadOnlyList<McpToolInfo> ParseList(string? toolsJson)
    {
        if (string.IsNullOrWhiteSpace(toolsJson)) return Array.Empty<McpToolInfo>();
        try
        {
            using var doc = JsonDocument.Parse(toolsJson);
            return ParseArray(doc.RootElement);
        }
        catch { return Array.Empty<McpToolInfo>(); }
    }

    /// <summary>Parse a JSON array of MCP tool descriptors (the <c>result.tools</c> element).</summary>
    public static IReadOnlyList<McpToolInfo> ParseArray(JsonElement toolsArray)
    {
        var list = new List<McpToolInfo>();
        if (toolsArray.ValueKind != JsonValueKind.Array) return list;
        foreach (var t in toolsArray.EnumerateArray())
        {
            var name = t.TryGetProperty("name", out var n) ? n.GetString() : null;
            if (string.IsNullOrWhiteSpace(name)) continue;
            var desc = t.TryGetProperty("description", out var d) ? d.GetString() ?? "" : "";
            var schema = t.TryGetProperty("inputSchema", out var s) && s.ValueKind == JsonValueKind.Object
                ? s.Clone()
                : JsonDocument.Parse("""{"type":"object","properties":{}}""").RootElement.Clone();
            list.Add(new McpToolInfo(name!, desc, schema));
        }
        return list;
    }
}

/// <summary>Client-safe view of a server — NO secrets. What the management API + client ever see.</summary>
public sealed record McpServerDto(
    string Id,
    string Name,
    string Transport,
    string? Command,
    string[] Args,
    string? Url,
    bool Enabled,
    string Status,
    string? LastError,
    bool HasSecrets,
    string LoginKind,
    bool NeedsLogin,
    IReadOnlyList<McpToolSummary> Tools)
{
    public static McpServerDto From(McpServerConfig c) => new(
        c.Id, c.Name, c.Transport, c.Command, c.Args(), c.Url, c.Enabled, c.Status, c.LastError,
        c.HasSecrets, c.LoginKind, c.NeedsLogin,
        c.DiscoveredTools().Select(t => new McpToolSummary(t.Name, t.Description)).ToArray());
}

public sealed record McpToolSummary(string Name, string Description);
