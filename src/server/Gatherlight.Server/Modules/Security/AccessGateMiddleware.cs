using Gatherlight.Server.Modules.Security.Services;

namespace Gatherlight.Server.Modules.Security;

/// <summary>
/// Enforces <see cref="ISecurityGuard"/> on the sensitive surfaces (<c>/api</c> + <c>/mcp</c>).
/// The auth endpoints stay open (so a remote user can log in) and static/SPA files stay open (the
/// client code isn't sensitive — the SPA gates itself on <c>/api/auth/status</c>). Disabled when no
/// token is configured. Registered before the endpoints so it runs ahead of controllers.
/// </summary>
public sealed class AccessGateMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ISecurityGuard _guard;

    public AccessGateMiddleware(RequestDelegate next, ISecurityGuard guard)
    {
        _next = next;
        _guard = guard;
    }

    public async Task Invoke(HttpContext ctx)
    {
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
