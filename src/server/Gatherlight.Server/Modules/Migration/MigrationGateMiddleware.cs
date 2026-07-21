using Gatherlight.Server.Modules.Migration.Services;

namespace Gatherlight.Server.Modules.Migration;

/// <summary>While migration runs, return 503 {migrating:true} for /api + /mcp — EXCEPT /api/health (so
/// the Host keeps its heartbeat) and /api/migration/* (so /manage can render + drive the overlay). Static
/// /manage + /assets are not /api and pass straight through. Once migration lifts, this is a bool no-op.</summary>
public sealed class MigrationGateMiddleware
{
    private readonly RequestDelegate _next;
    private readonly MigrationState _state;
    public MigrationGateMiddleware(RequestDelegate next, MigrationState state) { _next = next; _state = state; }

    public async Task Invoke(HttpContext ctx)
    {
        if (_state.IsMigrating)
        {
            var path = ctx.Request.Path;
            var isApi = path.StartsWithSegments("/api") || path.StartsWithSegments("/mcp");
            var allowed = path.StartsWithSegments("/api/health") || path.StartsWithSegments("/api/migration");
            if (isApi && !allowed)
            {
                ctx.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
                await ctx.Response.WriteAsJsonAsync(new { migrating = true, error = "正在完成升级 / 启动,请稍候…" });
                return;
            }
        }
        await _next(ctx);
    }
}
