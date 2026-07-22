using System.Text.Json.Nodes;
using Gatherlight.Server.Modules.McpClient.Models;
using Gatherlight.Server.Modules.McpClient.Services.Transport;

namespace Gatherlight.Server.Modules.McpClient.Services;

/// <summary>Payload to register an external MCP server (from the access-gated management API or the
/// chat confirmation gate). Secrets are login material (cookie/token) merged into env/headers at
/// connect time — stored server-side, never echoed back.</summary>
public sealed record McpAddRequest(
    string? Name,
    string? Transport,
    string? Command,
    string[]? Args,
    Dictionary<string, string>? Env,
    string? Url,
    Dictionary<string, string>? Headers,
    Dictionary<string, string>? Secrets,
    string? LoginKind = null,
    string? LoginTool = null,
    string? LoginCheckTool = null,
    bool Enabled = true);

/// <summary>
/// The privileged add/enable/disable/remove operations for external MCP servers — the single choke
/// point shared by the management controller (access-gated) and the chat confirmation gate (P2).
/// Persists config, then reconciles live connections via <see cref="IMcpConnectionManager"/>. The
/// scope-guarded agent can never reach this: it isn't on the agent's MCP surface.
/// </summary>
public interface IMcpProvisionService
{
    Task<McpServerConfig> AddAsync(McpAddRequest req, CancellationToken ct);
    Task<bool> SetEnabledAsync(string id, bool enabled, CancellationToken ct);
    Task<bool> RemoveAsync(string id, CancellationToken ct);
    Task<List<McpServerConfig>> ListAsync();
    Task<McpServerConfig?> GetAsync(string id);
}

public sealed class McpProvisionService : IMcpProvisionService
{
    private readonly IMcpServerStore _store;
    private readonly IMcpConnectionManager _mgr;

    public McpProvisionService(IMcpServerStore store, IMcpConnectionManager mgr)
    {
        _store = store;
        _mgr = mgr;
    }

    public Task<List<McpServerConfig>> ListAsync() => _store.ListAsync();
    public Task<McpServerConfig?> GetAsync(string id) => _store.GetAsync(id);

    public async Task<McpServerConfig> AddAsync(McpAddRequest req, CancellationToken ct)
    {
        var transport = req.Transport == McpTransportKind.Http ? McpTransportKind.Http : McpTransportKind.Stdio;
        var name = (req.Name ?? "").Trim();
        if (name.Length == 0) throw new McpException("name is required");

        if (transport == McpTransportKind.Stdio && string.IsNullOrWhiteSpace(req.Command))
            throw new McpException("stdio transport requires a command");
        if (transport == McpTransportKind.Http && string.IsNullOrWhiteSpace(req.Url))
            throw new McpException("http transport requires a url");

        var now = DateTime.UtcNow.ToString("o");
        var cfg = new McpServerConfig
        {
            Id = await UniqueIdAsync(name),
            Name = name,
            Transport = transport,
            Command = req.Command,
            ArgsJson = ToJsonArray(req.Args),
            EnvJson = ToJsonObject(req.Env),
            Url = req.Url,
            HeadersJson = ToJsonObject(req.Headers),
            SecretsJson = ToJsonObject(req.Secrets),
            LoginKind = req.LoginKind is McpLoginKind.Qr or McpLoginKind.Browser ? req.LoginKind : McpLoginKind.None,
            LoginTool = req.LoginTool,
            LoginCheckTool = req.LoginCheckTool,
            Enabled = req.Enabled,
            Status = req.Enabled ? McpServerStatus.Pending : McpServerStatus.Disabled,
            CreatedAt = now,
            UpdatedAt = now,
        };
        await _store.UpsertAsync(cfg);
        await _mgr.ReloadAsync(ct);
        // Return the freshest row (status/tools now reflect the connect attempt).
        return await _store.GetAsync(cfg.Id) ?? cfg;
    }

    public async Task<bool> SetEnabledAsync(string id, bool enabled, CancellationToken ct)
    {
        if (await _store.GetAsync(id) is null) return false;
        await _store.SetEnabledAsync(id, enabled);
        if (!enabled) await _store.SetStatusAsync(id, McpServerStatus.Disabled, null, null);
        await _mgr.ReloadAsync(ct);
        return true;
    }

    public async Task<bool> RemoveAsync(string id, CancellationToken ct)
    {
        if (await _store.GetAsync(id) is null) return false;
        await _store.DeleteAsync(id);
        await _mgr.ReloadAsync(ct);
        return true;
    }

    private async Task<string> UniqueIdAsync(string name)
    {
        var baseSlug = Slug(name);
        if (baseSlug.Length == 0) baseSlug = "mcp";
        if (await _store.GetAsync(baseSlug) is null) return baseSlug;
        for (var i = 2; i < 1000; i++)
        {
            var candidate = $"{baseSlug}-{i}";
            if (await _store.GetAsync(candidate) is null) return candidate;
        }
        return $"{baseSlug}-{Guid.NewGuid().ToString("N")[..6]}";
    }

    private static string Slug(string s)
    {
        var chars = s.Trim().ToLowerInvariant()
            .Select(c => char.IsAsciiLetterOrDigit(c) ? c : '-');
        var slug = string.Concat(chars);
        while (slug.Contains("--")) slug = slug.Replace("--", "-");
        return slug.Trim('-');
    }

    private static string? ToJsonArray(string[]? items) =>
        items is { Length: > 0 } ? new JsonArray(items.Select(x => (JsonNode)x!).ToArray()).ToJsonString() : null;

    private static string? ToJsonObject(Dictionary<string, string>? map)
    {
        if (map is null || map.Count == 0) return null;
        var obj = new JsonObject();
        foreach (var kv in map) obj[kv.Key] = kv.Value;
        return obj.ToJsonString();
    }
}
