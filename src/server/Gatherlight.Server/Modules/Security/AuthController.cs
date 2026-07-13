using Gatherlight.Server.Modules.Security.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Security;

/// <summary>
/// The login surface the access gate leaves open. The SPA checks <c>status</c> on load and shows a
/// token prompt when access is required but the caller isn't authenticated (i.e. a remote client);
/// <c>login</c> validates the shared token and drops an httpOnly cookie so subsequent requests pass.
/// </summary>
[ApiController]
public sealed class AuthController : ControllerBase
{
    private readonly ISecurityGuard _guard;
    private readonly ILoginThrottle _throttle;
    public AuthController(ISecurityGuard guard, ILoginThrottle throttle)
    {
        _guard = guard;
        _throttle = throttle;
    }

    [HttpGet("api/auth/status")]
    public IActionResult Status() =>
        Ok(new { required = _guard.Enabled, authed = _guard.IsAuthenticated(HttpContext) });

    public sealed record LoginBody(string? Token);

    [HttpPost("api/auth/login")]
    public IActionResult Login([FromBody] LoginBody? body)
    {
        if (!_guard.Enabled) return Ok(new { ok = true });        // nothing to log into

        var key = HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        if (_throttle.IsLocked(key, out var retry))
        {
            var seconds = (int)Math.Ceiling(retry.TotalSeconds);
            Response.Headers.RetryAfter = seconds.ToString();
            return StatusCode(StatusCodes.Status429TooManyRequests,
                new { error = "尝试次数过多,请稍后再试", retryAfterSeconds = seconds });
        }

        if (!_guard.ValidateToken(body?.Token))
        {
            _throttle.RecordFailure(key);
            return Unauthorized(new { error = "访问令牌无效" });
        }

        _throttle.RecordSuccess(key);
        _guard.IssueCookie(HttpContext);
        return Ok(new { ok = true });
    }

    [HttpPost("api/auth/logout")]
    public IActionResult Logout()
    {
        _guard.ClearCookie(HttpContext);
        return Ok(new { ok = true });
    }
}
