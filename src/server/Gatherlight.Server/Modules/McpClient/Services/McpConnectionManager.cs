using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Gatherlight.Server.Modules.McpClient.Models;
using Gatherlight.Server.Modules.McpClient.Services.Transport;

namespace Gatherlight.Server.Modules.McpClient.Services;

/// <summary>
/// Owns the live connections to external MCP servers and the flattened set of their tools. Mirrors
/// <c>ScriptToolProvider</c>'s resilience: a server that fails to connect is marked
/// <c>error</c> in the store and simply contributes no tools — it never takes the host down.
/// <see cref="ReloadAsync"/> reconciles connections against the enabled config (called by the
/// startup migration step and after any provisioning change). Registered as an IHostedService only
/// to dispose connections (kill stdio subprocesses) on shutdown; the initial connect runs as an
/// ordered migration step, after the DB table exists.
/// </summary>
public interface IMcpConnectionManager
{
    /// <summary>Every currently-connected server's tools, tagged with the owning server id.</summary>
    IReadOnlyList<(string ServerId, McpToolInfo Tool)> Tools { get; }
    Task<string> CallAsync(string serverId, string tool, JsonElement args, CancellationToken ct);
    Task ReloadAsync(CancellationToken ct = default);
}

public sealed class McpConnectionManager : IMcpConnectionManager, IHostedService
{
    private sealed record Live(string Signature, IMcpConnection Conn, IReadOnlyList<McpToolInfo> Tools);

    private readonly IMcpServerStore _store;
    private readonly ILogger<McpConnectionManager> _log;
    private readonly ConcurrentDictionary<string, Live> _live = new();
    private readonly SemaphoreSlim _reloadGate = new(1, 1);
    private volatile IReadOnlyList<(string, McpToolInfo)> _tools = Array.Empty<(string, McpToolInfo)>();

    public McpConnectionManager(IMcpServerStore store, ILogger<McpConnectionManager> log)
    {
        _store = store;
        _log = log;
    }

    public IReadOnlyList<(string ServerId, McpToolInfo Tool)> Tools => _tools;

    public async Task<string> CallAsync(string serverId, string tool, JsonElement args, CancellationToken ct)
    {
        if (!_live.TryGetValue(serverId, out var live))
            throw new McpException($"MCP server '{serverId}' is not connected");
        try { return await live.Conn.CallToolAsync(tool, args, ct); }
        catch (McpException) { throw; }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex) { throw new McpException($"MCP call failed: {ex.Message}"); }
    }

    public async Task ReloadAsync(CancellationToken ct = default)
    {
        await _reloadGate.WaitAsync(ct);
        try
        {
            var enabled = await _store.ListEnabledAsync();
            var desired = enabled.ToDictionary(c => c.Id);

            // Drop servers no longer enabled/present.
            foreach (var id in _live.Keys.ToList())
                if (!desired.ContainsKey(id))
                    await DropAsync(id);

            // (Re)connect new or changed servers; leave unchanged ones alone.
            foreach (var cfg in enabled)
            {
                var sig = Signature(cfg);
                if (_live.TryGetValue(cfg.Id, out var cur) && cur.Signature == sig) continue;
                if (cur is not null) await DropAsync(cfg.Id);
                await ConnectAsync(cfg, sig, ct);
            }

            RebuildToolIndex();
        }
        finally { _reloadGate.Release(); }
    }

    private async Task ConnectAsync(McpServerConfig cfg, string sig, CancellationToken ct)
    {
        try
        {
            var conn = McpConnectionFactory.Create(cfg, _log);
            using var initCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            initCts.CancelAfter(TimeSpan.FromSeconds(30));
            await conn.InitializeAsync(initCts.Token);
            var tools = await conn.ListToolsAsync(initCts.Token);
            _live[cfg.Id] = new Live(sig, conn, tools);
            await _store.SetStatusAsync(cfg.Id, McpServerStatus.Connected, null, SerializeTools(tools));
            _log.LogInformation("MCP server '{Name}' ({Id}) connected: {Count} tools ({Names})",
                cfg.Name, cfg.Id, tools.Count, string.Join(", ", tools.Select(t => t.Name)));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "MCP server '{Name}' ({Id}) failed to connect", cfg.Name, cfg.Id);
            await _store.SetStatusAsync(cfg.Id, McpServerStatus.Error, Trunc(ex.Message), null);
        }
    }

    private async Task DropAsync(string id)
    {
        if (_live.TryRemove(id, out var live))
        {
            try { await live.Conn.DisposeAsync(); } catch { /* best effort */ }
        }
    }

    private void RebuildToolIndex()
    {
        var list = new List<(string, McpToolInfo)>();
        foreach (var (id, live) in _live)
            foreach (var t in live.Tools)
                list.Add((id, t));
        _tools = list;
    }

    /// <summary>Config fingerprint — a change here means reconnect on the next reload.</summary>
    private static string Signature(McpServerConfig c) => string.Join("",
        c.Transport, c.Command, c.ArgsJson, c.EnvJson, c.Url, c.HeadersJson, c.SecretsJson);

    private static string SerializeTools(IReadOnlyList<McpToolInfo> tools)
    {
        var arr = new JsonArray();
        foreach (var t in tools)
            arr.Add(new JsonObject
            {
                ["name"] = t.Name,
                ["description"] = t.Description,
                ["inputSchema"] = JsonNode.Parse(t.InputSchema.GetRawText()),
            });
        return arr.ToJsonString();
    }

    private static string Trunc(string s) => s.Length > 500 ? s[..500] : s;

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask; // initial connect = migration step

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        foreach (var id in _live.Keys.ToList())
            await DropAsync(id);
    }
}
