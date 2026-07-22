using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.McpClient.Models;

namespace Gatherlight.Server.Modules.McpClient.Services.Transport;

public sealed class McpException : Exception
{
    public McpException(string message) : base(message) { }
}

/// <summary>A live connection to one external MCP server. Speaks JSON-RPC 2.0; one request in flight
/// at a time (serialized on <see cref="McpConnectionBase.Gate"/>).</summary>
public interface IMcpConnection : IAsyncDisposable
{
    /// <summary>Handshake: <c>initialize</c> + <c>notifications/initialized</c>.</summary>
    Task InitializeAsync(CancellationToken ct);
    Task<IReadOnlyList<McpToolInfo>> ListToolsAsync(CancellationToken ct);
    /// <summary>Call a tool; returns its text content (or raw result JSON when non-textual).</summary>
    Task<string> CallToolAsync(string tool, JsonElement args, CancellationToken ct);
}

/// <summary>
/// Minimal hand-rolled MCP client (the repo hand-rolls its MCP *server* too — no preview SDK
/// dependency). Shared JSON-RPC envelope + handshake here; transports fill in the wire in
/// <see cref="TransceiveAsync"/> / <see cref="SendNotificationAsync"/>.
/// </summary>
public abstract class McpConnectionBase : IMcpConnection
{
    // Broadly-supported MCP protocol revision (community servers negotiate down if older).
    private const string ProtocolVersion = "2024-11-05";

    private int _nextId;
    /// <summary>Serialize request/response on the single pipe — MCP is one-in-flight over stdio.</summary>
    protected readonly SemaphoreSlim Gate = new(1, 1);

    public async Task InitializeAsync(CancellationToken ct)
    {
        var init = new JsonObject
        {
            ["protocolVersion"] = ProtocolVersion,
            ["capabilities"] = new JsonObject(),
            ["clientInfo"] = new JsonObject { ["name"] = "gatherlight", ["version"] = AppVersion.Semver },
        };
        await RequestAsync("initialize", init, ct);
        await NotifyAsync("notifications/initialized", null, ct);
    }

    public async Task<IReadOnlyList<McpToolInfo>> ListToolsAsync(CancellationToken ct)
    {
        var result = await RequestAsync("tools/list", null, ct);
        return result.TryGetProperty("tools", out var tools)
            ? McpToolInfo.ParseArray(tools)
            : Array.Empty<McpToolInfo>();
    }

    public async Task<string> CallToolAsync(string tool, JsonElement args, CancellationToken ct)
    {
        var p = new JsonObject
        {
            ["name"] = tool,
            ["arguments"] = args.ValueKind is JsonValueKind.Object or JsonValueKind.Array
                ? JsonNode.Parse(args.GetRawText())
                : new JsonObject(),
        };
        var result = await RequestAsync("tools/call", p, ct);
        return ExtractContent(result);
    }

    /// <summary>Flatten an MCP <c>tools/call</c> result to a string; throw on <c>isError</c>.</summary>
    private static string ExtractContent(JsonElement result)
    {
        var isError = result.TryGetProperty("isError", out var e) && e.ValueKind == JsonValueKind.True;
        if (result.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
        {
            var texts = new List<string>();
            foreach (var item in content.EnumerateArray())
                if (item.TryGetProperty("type", out var ty) && ty.GetString() == "text"
                    && item.TryGetProperty("text", out var tx))
                    texts.Add(tx.GetString() ?? "");
            var joined = string.Join("\n", texts);
            if (isError) throw new McpException(joined.Length > 0 ? joined : "MCP tool reported an error");
            return joined.Length > 0 ? joined : result.GetRawText();
        }
        return result.GetRawText();
    }

    protected async Task<JsonElement> RequestAsync(string method, JsonNode? @params, CancellationToken ct)
    {
        var id = Interlocked.Increment(ref _nextId);
        var env = new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method };
        if (@params is not null) env["params"] = @params;
        var line = env.ToJsonString();

        await Gate.WaitAsync(ct);
        try
        {
            var respJson = await TransceiveAsync(line, id, ct);
            using var doc = JsonDocument.Parse(respJson);
            var root = doc.RootElement;
            if (root.TryGetProperty("error", out var err))
            {
                var msg = err.TryGetProperty("message", out var m) ? m.GetString() : "unknown error";
                throw new McpException($"MCP error ({method}): {msg}");
            }
            return root.TryGetProperty("result", out var res)
                ? res.Clone()
                : JsonDocument.Parse("{}").RootElement.Clone();
        }
        finally { Gate.Release(); }
    }

    protected async Task NotifyAsync(string method, JsonNode? @params, CancellationToken ct)
    {
        var env = new JsonObject { ["jsonrpc"] = "2.0", ["method"] = method };
        if (@params is not null) env["params"] = @params;
        await Gate.WaitAsync(ct);
        try { await SendNotificationAsync(env.ToJsonString(), ct); }
        finally { Gate.Release(); }
    }

    /// <summary>Send one request, return the JSON of the response whose id matches.</summary>
    protected abstract Task<string> TransceiveAsync(string requestJson, int id, CancellationToken ct);
    protected abstract Task SendNotificationAsync(string json, CancellationToken ct);

    public abstract ValueTask DisposeAsync();
}

/// <summary>stdio transport: newline-delimited JSON-RPC over a child process's stdin/stdout.</summary>
public sealed class StdioMcpConnection : McpConnectionBase
{
    private static readonly UTF8Encoding Utf8NoBom = new(false);

    private readonly Process _proc;
    private readonly StreamWriter _stdin;
    private readonly StreamReader _stdout;

    private StdioMcpConnection(Process proc)
    {
        _proc = proc;
        _stdin = proc.StandardInput;
        _stdout = proc.StandardOutput;
    }

    public static StdioMcpConnection Start(string command, IReadOnlyList<string> args,
        IReadOnlyDictionary<string, string> env, ILogger log, string serverName)
    {
        var psi = new ProcessStartInfo
        {
            FileName = command,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardInputEncoding = Utf8NoBom,
            StandardOutputEncoding = Utf8NoBom,
            StandardErrorEncoding = Utf8NoBom,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        foreach (var kv in env) psi.Environment[kv.Key] = kv.Value;

        Process proc;
        try { proc = Process.Start(psi) ?? throw new McpException($"failed to start MCP server: {command}"); }
        catch (Exception ex) when (ex is not McpException) { throw new McpException($"failed to start MCP server '{command}': {ex.Message}"); }

        // Drain stderr so a chatty server can't deadlock on a full pipe; surface as debug logs.
        _ = Task.Run(async () =>
        {
            try
            {
                string? l;
                while ((l = await proc.StandardError.ReadLineAsync()) is not null)
                    log.LogDebug("[mcp:{Server}] {Line}", serverName, l);
            }
            catch { /* process gone */ }
        });
        return new StdioMcpConnection(proc);
    }

    protected override async Task<string> TransceiveAsync(string requestJson, int id, CancellationToken ct)
    {
        if (_proc.HasExited) throw new McpException($"MCP server exited (code {_proc.ExitCode})");
        await _stdin.WriteAsync(requestJson.AsMemory(), ct);
        await _stdin.WriteAsync("\n".AsMemory(), ct);
        await _stdin.FlushAsync(ct);

        while (true)
        {
            var raw = await _stdout.ReadLineAsync(ct);
            if (raw is null) throw new McpException("MCP server closed the connection");
            var line = raw.Trim();
            if (line.Length == 0) continue;
            JsonDocument doc;
            try { doc = JsonDocument.Parse(line); }
            catch { continue; } // stray non-JSON on stdout — ignore
            using (doc)
            {
                if (doc.RootElement.TryGetProperty("id", out var idEl)
                    && idEl.ValueKind == JsonValueKind.Number && idEl.TryGetInt32(out var got) && got == id)
                    return line;
            }
            // a notification or a different id → keep reading for ours
        }
    }

    protected override async Task SendNotificationAsync(string json, CancellationToken ct)
    {
        if (_proc.HasExited) return;
        await _stdin.WriteAsync(json.AsMemory(), ct);
        await _stdin.WriteAsync("\n".AsMemory(), ct);
        await _stdin.FlushAsync(ct);
    }

    public override ValueTask DisposeAsync()
    {
        try { if (!_proc.HasExited) _proc.Kill(entireProcessTree: true); } catch { /* already gone */ }
        try { _proc.Dispose(); } catch { /* ignore */ }
        return ValueTask.CompletedTask;
    }
}

/// <summary>Streamable-HTTP transport: POST JSON-RPC, read back application/json or a text/event-stream.</summary>
public sealed class HttpMcpConnection : McpConnectionBase
{
    private static readonly UTF8Encoding Utf8NoBom = new(false);

    private readonly HttpClient _http;
    private readonly string _url;
    private readonly Dictionary<string, string> _headers;
    private string? _sessionId;

    public HttpMcpConnection(string url, IReadOnlyDictionary<string, string> headers)
    {
        _url = url;
        _headers = new Dictionary<string, string>(headers, StringComparer.OrdinalIgnoreCase);
        _http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan }; // per-request timeout via ct
    }

    protected override async Task<string> TransceiveAsync(string requestJson, int id, CancellationToken ct)
    {
        using var req = BuildPost(requestJson);
        using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        CaptureSession(resp);
        if (!resp.IsSuccessStatusCode)
            throw new McpException($"MCP http {(int)resp.StatusCode} from {_url}");

        var media = resp.Content.Headers.ContentType?.MediaType ?? "";
        if (media.Contains("text/event-stream", StringComparison.OrdinalIgnoreCase))
            return await ReadSseForId(resp, id, ct);
        return await resp.Content.ReadAsStringAsync(ct);
    }

    protected override async Task SendNotificationAsync(string json, CancellationToken ct)
    {
        using var req = BuildPost(json);
        using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        CaptureSession(resp); // 202 Accepted, no body
    }

    private HttpRequestMessage BuildPost(string json)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, _url)
        {
            Content = new StringContent(json, Utf8NoBom, "application/json"),
        };
        req.Headers.TryAddWithoutValidation("Accept", "application/json, text/event-stream");
        foreach (var kv in _headers) req.Headers.TryAddWithoutValidation(kv.Key, kv.Value);
        if (_sessionId is not null) req.Headers.TryAddWithoutValidation("Mcp-Session-Id", _sessionId);
        return req;
    }

    private void CaptureSession(HttpResponseMessage resp)
    {
        if (resp.Headers.TryGetValues("Mcp-Session-Id", out var vals))
            _sessionId = vals.FirstOrDefault() ?? _sessionId;
    }

    private static async Task<string> ReadSseForId(HttpResponseMessage resp, int id, CancellationToken ct)
    {
        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream, Utf8NoBom);
        var data = new StringBuilder();
        string? line;
        while ((line = await reader.ReadLineAsync(ct)) is not null)
        {
            if (line.Length == 0) // event boundary
            {
                if (data.Length > 0)
                {
                    var payload = data.ToString();
                    data.Clear();
                    if (TryMatchId(payload, id)) return payload;
                }
                continue;
            }
            if (line.StartsWith("data:", StringComparison.Ordinal))
                data.Append(line.AsSpan(5).TrimStart());
        }
        if (data.Length > 0 && TryMatchId(data.ToString(), id)) return data.ToString();
        throw new McpException("MCP http stream ended without a matching response");
    }

    private static bool TryMatchId(string payload, int id)
    {
        try
        {
            using var doc = JsonDocument.Parse(payload);
            return doc.RootElement.TryGetProperty("id", out var idEl)
                && idEl.ValueKind == JsonValueKind.Number && idEl.TryGetInt32(out var got) && got == id;
        }
        catch { return false; }
    }

    public override ValueTask DisposeAsync()
    {
        _http.Dispose();
        return ValueTask.CompletedTask;
    }
}

/// <summary>Builds the right connection for a config, merging secrets into env (stdio) / headers (http).</summary>
public static class McpConnectionFactory
{
    public static IMcpConnection Create(McpServerConfig cfg, ILogger log)
    {
        if (cfg.Transport == McpTransportKind.Http)
        {
            if (string.IsNullOrWhiteSpace(cfg.Url)) throw new McpException("http transport requires a url");
            var headers = new Dictionary<string, string>(cfg.Headers(), StringComparer.OrdinalIgnoreCase);
            foreach (var kv in cfg.Secrets()) headers[kv.Key] = kv.Value;   // secrets → headers
            return new HttpMcpConnection(cfg.Url!, headers);
        }

        if (string.IsNullOrWhiteSpace(cfg.Command)) throw new McpException("stdio transport requires a command");
        var env = new Dictionary<string, string>(cfg.Env(), StringComparer.Ordinal);
        foreach (var kv in cfg.Secrets()) env[kv.Key] = kv.Value;           // secrets → env
        return StdioMcpConnection.Start(cfg.Command!, cfg.Args(), env, log, cfg.Name);
    }
}
