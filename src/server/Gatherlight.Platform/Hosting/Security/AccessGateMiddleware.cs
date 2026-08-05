using System.Security.Cryptography;
using Gatherlight.Server.Platform.Hosting.Security.Services;

namespace Gatherlight.Server.Platform.Hosting.Security;

/// <summary>
/// Enforces <see cref="ISecurityGuard"/> on the sensitive surfaces (<c>/api</c> + <c>/mcp</c>).
/// The auth endpoints stay open (so a remote user can log in) and static/SPA files stay open (the
/// client code isn't sensitive — the SPA gates itself on <c>/api/auth/status</c>). Disabled when no
/// token is configured. Registered before the endpoints so it runs ahead of controllers.
/// <para>It also polices the agent's own loopback channel (<see cref="IInternalMcpEndpoint"/>) —
/// <c>/mcp</c> only, its own per-start bearer token — which is a SEPARATE rule set that runs even
/// when the public gate is disabled.</para>
/// </summary>
public sealed class AccessGateMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ISecurityGuard _guard;
    private readonly IInternalMcpEndpoint _internal;

    public AccessGateMiddleware(RequestDelegate next, ISecurityGuard guard, IInternalMcpEndpoint internalMcp)
    {
        _next = next;
        _guard = guard;
        _internal = internalMcp;
    }

    public async Task Invoke(HttpContext ctx)
    {
        // The agent's channel. Placed ahead of the Enabled check on purpose: when no token is
        // configured the public gate is off entirely, and an unrestricted internal port would then
        // serve /api too. Requests are told apart by the LOCAL port, which no client controls.
        if (_internal.Port != 0 && ctx.Connection.LocalPort == _internal.Port)
        {
            // Only /mcp. This is not a second door into /api — which matters most when
            // trustLoopback is false, a setting that exists because a same-host proxy can make
            // remote requests look local.
            if (!ctx.Request.Path.StartsWithSegments("/mcp"))
            {
                ctx.Response.StatusCode = StatusCodes.Status404NotFound;
                return;
            }
            var presented = ctx.Request.Headers.Authorization.ToString();
            var expected = "Bearer " + _internal.Token;
            // The byte-array overload RETURNS false on a length mismatch (the two-int overload
            // throws) — so a short wrong token is a 401, not a 500.
            if (!CryptographicOperations.FixedTimeEquals(
                    System.Text.Encoding.UTF8.GetBytes(presented),
                    System.Text.Encoding.UTF8.GetBytes(expected)))
            {
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }
            await _next(ctx);
            return;
        }

        if (!_guard.Enabled) { await _next(ctx); return; }

        var path = ctx.Request.Path;
        // Login/status must be reachable unauthenticated, or a remote user can never get in.
        if (path.StartsWithSegments("/api/auth")) { await _next(ctx); return; }

        var sensitive = path.StartsWithSegments("/api") || path.StartsWithSegments("/mcp");
        if (sensitive && !_guard.IsAuthenticated(ctx))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            ctx.Response.ContentType = "application/json";
            await ctx.Response.WriteAsync("{\"error\":\"authentication required\"}");
            return;
        }

        // CSRF: auth is a browser-attached cookie (and loopback is trusted), so a malicious page could
        // drive a state-changing request the browser auto-authenticates. Require mutating requests to be
        // same-origin. Non-browser clients (the claude CLI / MCP over the token) send no Origin/Sec-Fetch
        // headers and are unaffected — CSRF is a browser-only attack.
        if (sensitive && IsMutating(ctx.Request.Method) && !IsSameOriginOrNonBrowser(ctx))
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            ctx.Response.ContentType = "application/json";
            await ctx.Response.WriteAsync("{\"error\":\"cross-origin request rejected\"}");
            return;
        }

        await _next(ctx);
    }

    private static bool IsMutating(string method) =>
        HttpMethods.IsPost(method) || HttpMethods.IsPut(method) || HttpMethods.IsPatch(method) || HttpMethods.IsDelete(method);

    private static bool IsSameOriginOrNonBrowser(HttpContext ctx)
    {
        // Modern browsers stamp every request with Sec-Fetch-Site — trust only same-origin (or a
        // user-initiated `none`, e.g. an address-bar navigation).
        var secFetch = ctx.Request.Headers["Sec-Fetch-Site"].ToString();
        if (!string.IsNullOrEmpty(secFetch)) return secFetch is "same-origin" or "none";
        // Older/edge browsers: fall back to Origin vs Host. Absent Origin ⇒ a non-browser client (CLI/MCP).
        var origin = ctx.Request.Headers.Origin.ToString();
        if (string.IsNullOrEmpty(origin)) return true;
        return Uri.TryCreate(origin, UriKind.Absolute, out var o)
            && string.Equals(o.Authority, ctx.Request.Host.Value, StringComparison.OrdinalIgnoreCase);
    }
}
