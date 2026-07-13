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

        return ctx.Request.Cookies.TryGetValue(CookieName, out var cookie) && ValidateToken(cookie);
    }

    public void IssueCookie(HttpContext ctx) =>
        ctx.Response.Cookies.Append(CookieName, Encoding.UTF8.GetString(_token!), new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Lax,
            Secure = ctx.Request.IsHttps,
            MaxAge = TimeSpan.FromDays(30),
            Path = "/",
        });

    public void ClearCookie(HttpContext ctx) => ctx.Response.Cookies.Delete(CookieName);
}
