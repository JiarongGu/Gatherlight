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

        await _next(ctx);
    }
}
