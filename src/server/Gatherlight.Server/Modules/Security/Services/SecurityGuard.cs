using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;

namespace Gatherlight.Server.Modules.Security.Services;

/// <summary>
/// The access gate for remote exposure. Model: <b>loopback is trusted, remote needs the token.</b>
/// The local machine already fully controls the server (it spawns the authenticated claude CLI),
/// so localhost requests bypass the check; anything arriving over the network must present the
/// shared access token (Bearer / <c>X-Gatherlight-Token</c> header / <c>gl_auth</c> cookie). When
/// no token is configured the guard is disabled and the binding check keeps the server loopback-only.
/// </summary>
public interface ISecurityGuard
{
    /// <summary>True when an access token is configured (remote access is possible + gated).</summary>
    bool Enabled { get; }
    /// <summary>Constant-time compare of a candidate against the configured token.</summary>
    bool ValidateToken(string? candidate);
    /// <summary>Loopback client, or a valid token in header/cookie.</summary>
    bool IsAuthenticated(HttpContext ctx);
    void IssueCookie(HttpContext ctx);
    void ClearCookie(HttpContext ctx);
}

public sealed class SecurityGuard : ISecurityGuard
{
    public const string CookieName = "gl_auth";
    public const string HeaderName = "X-Gatherlight-Token";

    private readonly byte[]? _token;
    private readonly bool _trustLoopback;

    // Opaque browser sessions: the cookie carries a random session id (not the shared secret), validated
    // against this server-side set. In-memory → cleared on restart (users re-log in), which is fine for a
    // self-hosted app and strictly better than a never-expiring raw-token cookie.
    private readonly ConcurrentDictionary<string, DateTime> _sessions = new();
    private static readonly TimeSpan SessionTtl = TimeSpan.FromDays(30);

    public SecurityGuard(GatherlightServerOptions options)
    {
        _token = string.IsNullOrEmpty(options.AccessToken) ? null : Encoding.UTF8.GetBytes(options.AccessToken);
        _trustLoopback = options.TrustLoopback;
    }

    public bool Enabled => _token is not null;

    public bool ValidateToken(string? candidate)
    {
        if (_token is null) return true;                       // no token configured = nothing to check
        if (string.IsNullOrEmpty(candidate)) return false;
        // FixedTimeEquals returns false (not throws) on length mismatch — no early-out timing leak.
        return CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(candidate), _token);
    }

    public bool IsAuthenticated(HttpContext ctx)
    {
        if (_token is null) return true;

        // Trust the local machine (unless disabled for a same-host proxy). Use the REAL connection
        // IP — never a forwarded header, or a remote client could spoof loopback via X-Forwarded-For.
        if (_trustLoopback)
        {
            var ip = ctx.Connection.RemoteIpAddress;
            if (ip is not null && IPAddress.IsLoopback(ip)) return true;
        }

        var header = ctx.Request.Headers[HeaderName].ToString();
        if (string.IsNullOrEmpty(header))
        {
            var auth = ctx.Request.Headers.Authorization.ToString();
            if (auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) header = auth["Bearer ".Length..].Trim();
        }
        if (ValidateToken(header)) return true;

        // The cookie holds an opaque session id (issued at login), never the token itself.
        return ctx.Request.Cookies.TryGetValue(CookieName, out var cookie) && ValidSession(cookie);
    }

    public void IssueCookie(HttpContext ctx)
    {
        var sid = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        PruneSessions();
        _sessions[sid] = DateTime.UtcNow;
        ctx.Response.Cookies.Append(CookieName, sid, new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Lax,
            Secure = ctx.Request.IsHttps,
            MaxAge = SessionTtl,
            Path = "/",
        });
    }

    public void ClearCookie(HttpContext ctx)
    {
        if (ctx.Request.Cookies.TryGetValue(CookieName, out var sid)) _sessions.TryRemove(sid, out _);
        ctx.Response.Cookies.Delete(CookieName);
    }

    private bool ValidSession(string sid) =>
        !string.IsNullOrEmpty(sid) && _sessions.TryGetValue(sid, out var created) && DateTime.UtcNow - created < SessionTtl;

    // Opportunistic cleanup so expired sessions don't accumulate on a long-lived process.
    private void PruneSessions()
    {
        if (_sessions.Count < 512) return;
        var cutoff = DateTime.UtcNow - SessionTtl;
        foreach (var kv in _sessions)
            if (kv.Value < cutoff) _sessions.TryRemove(kv.Key, out _);
    }
}
