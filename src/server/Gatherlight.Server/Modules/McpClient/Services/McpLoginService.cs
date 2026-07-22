using System.Text.Json;
using System.Text.RegularExpressions;
using Gatherlight.Server.Modules.McpClient.Models;
using Gatherlight.Server.Modules.McpClient.Services.Transport;

namespace Gatherlight.Server.Modules.McpClient.Services;

/// <summary>What the login tool handed back to show the human: a QR image (data URI) to scan, a URL
/// to open, and/or explanatory text.</summary>
public sealed record McpLoginChallenge(string Kind, string? ImageDataUri, string? Url, string? Text, string Message);

/// <summary>Poll result: is the server logged in yet?</summary>
public sealed record McpLoginStatus(bool LoggedIn, string Detail);

/// <summary>
/// Generic interactive-login driver for external MCP servers — NOT Xiaohongshu-specific. Given a
/// server that declares <c>login_tool</c> (+ <c>login_check_tool</c>), it calls the login tool and
/// renders whatever it returns (a QR image, a URL, or text), then polls the check tool for success.
/// Any MCP server that exposes a "start login → poll status" pair works with zero new code; the
/// server persists its own session under <c>{data}/state/mcp/&lt;id&gt;/</c> so it survives restarts.
/// </summary>
public interface IMcpLoginService
{
    Task<McpLoginChallenge> StartAsync(string serverId, CancellationToken ct);
    Task<McpLoginStatus> StatusAsync(string serverId, CancellationToken ct);
}

public sealed class McpLoginService : IMcpLoginService
{
    private readonly IMcpServerStore _store;
    private readonly IMcpConnectionManager _mgr;

    public McpLoginService(IMcpServerStore store, IMcpConnectionManager mgr)
    {
        _store = store;
        _mgr = mgr;
    }

    private static readonly JsonElement EmptyArgs = JsonDocument.Parse("{}").RootElement;

    public async Task<McpLoginChallenge> StartAsync(string serverId, CancellationToken ct)
    {
        var cfg = await _store.GetAsync(serverId) ?? throw new McpException("server not found");
        if (!cfg.NeedsLogin) throw new McpException("this server has no login step");
        var result = await _mgr.CallRawAsync(serverId, cfg.LoginTool!, EmptyArgs, ct);
        return InterpretChallenge(cfg.LoginKind, result);
    }

    public async Task<McpLoginStatus> StatusAsync(string serverId, CancellationToken ct)
    {
        var cfg = await _store.GetAsync(serverId) ?? throw new McpException("server not found");
        if (string.IsNullOrWhiteSpace(cfg.LoginCheckTool)) throw new McpException("this server has no login-check tool");
        var result = await _mgr.CallRawAsync(serverId, cfg.LoginCheckTool!, EmptyArgs, ct);
        var text = FlattenText(result);
        return new McpLoginStatus(LooksLoggedIn(text), text);
    }

    /// <summary>Pull a QR image / URL / text out of the login tool's raw MCP result — server-agnostic.</summary>
    private static McpLoginChallenge InterpretChallenge(string kind, JsonElement result)
    {
        string? imageDataUri = null;
        string? url = null;
        var textParts = new List<string>();

        // Preferred: proper MCP content items — [{type:"image", data, mimeType}, {type:"text", text}].
        if (result.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in content.EnumerateArray())
            {
                var type = item.TryGetProperty("type", out var t) ? t.GetString() : null;
                if (type == "image" && item.TryGetProperty("data", out var d) && d.ValueKind == JsonValueKind.String)
                {
                    var mime = item.TryGetProperty("mimeType", out var m) ? m.GetString() ?? "image/png" : "image/png";
                    imageDataUri = $"data:{mime};base64,{d.GetString()}";
                }
                else if (type == "text" && item.TryGetProperty("text", out var tx))
                {
                    textParts.Add(tx.GetString() ?? "");
                }
            }
        }

        var text = string.Join("\n", textParts);

        // Fallbacks for servers that don't use image content: a data: URI or an http URL embedded in
        // the text/JSON, or a common base64 field (qrcode/qr/image).
        var raw = text.Length > 0 ? text : result.GetRawText();
        if (imageDataUri is null)
        {
            var dm = Regex.Match(raw, @"data:image/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+");
            if (dm.Success) imageDataUri = dm.Value;
        }
        if (imageDataUri is null)
        {
            foreach (var field in new[] { "qrcode", "qr_code", "qr", "image", "qrCode", "qrImage" })
            {
                var fm = Regex.Match(raw, "\"" + field + "\"\\s*:\\s*\"([A-Za-z0-9+/=]{32,})\"");
                if (fm.Success) { imageDataUri = $"data:image/png;base64,{fm.Groups[1].Value}"; break; }
            }
        }
        var um = Regex.Match(raw, @"https?://[^\s""'<>]+");
        if (um.Success) url = um.Value;

        var message = imageDataUri is not null ? "用手机 App 扫描二维码登录"
            : url is not null ? "在浏览器打开链接完成登录"
            : "按提示完成登录后点「我已登录」";
        return new McpLoginChallenge(kind, imageDataUri, url, text.Length > 0 ? text : null, message);
    }

    private static string FlattenText(JsonElement result)
    {
        if (result.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
        {
            var parts = new List<string>();
            foreach (var item in content.EnumerateArray())
                if (item.TryGetProperty("type", out var ty) && ty.GetString() == "text"
                    && item.TryGetProperty("text", out var tx))
                    parts.Add(tx.GetString() ?? "");
            if (parts.Count > 0) return string.Join("\n", parts);
        }
        return result.GetRawText();
    }

    /// <summary>Best-effort success detection across servers' varied status shapes.</summary>
    private static bool LooksLoggedIn(string text)
    {
        var low = text.ToLowerInvariant().Replace(" ", "");
        return low.Contains("loggedin")
            || low.Contains("logged_in\":true")
            || low.Contains("islogged_in\":true")
            || low.Contains("isloggedin\":true")
            || low.Contains("login\":true")
            || low.Contains("success\":true")
            || low.Contains("已登录")
            || low.Contains("登录成功");
    }
}
