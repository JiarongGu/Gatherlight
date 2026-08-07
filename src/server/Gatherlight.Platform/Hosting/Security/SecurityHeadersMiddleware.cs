namespace Gatherlight.Server.Platform.Hosting.Security;

/// <summary>
/// Defense-in-depth response headers on every response. The CSP is calibrated to the app's real
/// needs (verified against the built client + a headless render):
/// <list type="bullet">
/// <item>all scripts are external + same-origin (Vite build has no inline scripts) → <c>script-src 'self'</c>;</item>
/// <item>antd v6 injects runtime cssinjs <c>&lt;style&gt;</c> and the app uses React <c>style={{}}</c>
///   attributes → <c>style-src 'unsafe-inline'</c> is required;</item>
/// <item>EVERY image is same-origin → <c>img-src 'self' data: blob:</c>. Map tiles, library covers,
///   an <c>Image</c> node's https src and a picture in plan markdown all route through
///   <c>/api/img</c>, so this no longer needs <c>https:</c>. That matters because <c>https:</c> let
///   any URL reaching a rendered page make the household's BROWSER call that host — leaking their IP
///   and that they were reading it, on render, unrecorded — and an image URL can come from agent
///   text. Adding <c>https:</c> back re-opens exactly that;</item>
/// <item>fetch + SSE are same-origin → <c>connect-src 'self'</c>.</item>
/// </list>
/// Framing is denied — the app never iframes itself and the desktop host loads <c>/manage</c> as a
/// top-level navigation.
/// </summary>
public sealed class SecurityHeadersMiddleware
{
    private const string Csp =
        "default-src 'self'; " +
        "script-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; " +
        "font-src 'self'; " +
        "connect-src 'self'; " +
        "worker-src 'self' blob:; " +
        "object-src 'none'; " +
        "base-uri 'self'; " +
        "frame-ancestors 'none'; " +
        "form-action 'self'";

    private readonly RequestDelegate _next;
    public SecurityHeadersMiddleware(RequestDelegate next) => _next = next;

    public Task Invoke(HttpContext ctx)
    {
        var h = ctx.Response.Headers;
        h["Content-Security-Policy"] = Csp;
        h["X-Content-Type-Options"] = "nosniff";
        h["X-Frame-Options"] = "DENY";
        h["Referrer-Policy"] = "strict-origin-when-cross-origin";
        h["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()";
        return _next(ctx);
    }
}
