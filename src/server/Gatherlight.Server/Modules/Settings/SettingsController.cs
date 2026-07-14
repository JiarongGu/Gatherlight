using System.Net;
using Gatherlight.Server.Modules.Core.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Settings;

/// <summary>
/// Read + edit the persisted server settings (<c>state/settings.json</c>) from the management console
/// — port, remote-access binding + token, TLS, update source — instead of hand-editing JSON. Secrets
/// (access token, cert password) are never returned, only whether they're set. Most values apply at
/// STARTUP, so a save is followed by 「重启服务」. GATHERLIGHT_* env overrides shadow the file and are
/// reported so the UI can warn a change won't take effect until the override is cleared (a dev concern;
/// the shipped launcher sets none). The fail-closed rule is enforced here too — a config that would
/// expose a non-loopback bind with no token is rejected, never persisted.
/// </summary>
[ApiController]
public sealed class SettingsController : ControllerBase
{
    private readonly ServerConfigService _config;
    public SettingsController(ServerConfigService config) => _config = config;

    private static readonly (string Env, string Field)[] Overrides =
    {
        ("GATHERLIGHT_PORT", "port"), ("GATHERLIGHT_BIND", "bindAddress"),
        ("GATHERLIGHT_ACCESS_TOKEN", "accessToken"), ("GATHERLIGHT_TRUST_LOOPBACK", "trustLoopback"),
        ("GATHERLIGHT_ALLOW_LAN", "allowLanWithoutToken"), ("GATHERLIGHT_LOG_LEVEL", "logLevel"),
        ("GATHERLIGHT_TLS", "tls.enabled"), ("GATHERLIGHT_TLS_CERT", "tls.certPath"),
        ("GATHERLIGHT_UPDATE_REPO", "selfUpdate.githubRepo"), ("GATHERLIGHT_UPDATE_API", "selfUpdate.apiUrl"),
    };

    [HttpGet("api/manage/settings")]
    public IActionResult Get()
    {
        var c = _config.Current;
        var envSet = Overrides.Where(o => !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(o.Env)))
            .Select(o => o.Field).ToArray();
        return Ok(new
        {
            serverName = c.ServerName,
            port = c.Port,
            logLevel = c.LogLevel,
            hostCloseAction = c.HostCloseAction,
            bindAddress = c.Security.BindAddress,
            trustLoopback = c.Security.TrustLoopback,
            allowLanWithoutToken = c.Security.AllowLanWithoutToken,
            hasAccessToken = !string.IsNullOrEmpty(c.Security.AccessToken),
            tls = new
            {
                enabled = c.Security.Tls.Enabled,
                certPath = c.Security.Tls.CertPath,
                hasCertPassword = !string.IsNullOrEmpty(c.Security.Tls.CertPassword),
            },
            selfUpdate = new { githubRepo = c.SelfUpdate.GithubRepo, apiUrl = c.SelfUpdate.ApiUrl },
            envOverrides = envSet,
        });
    }

    public sealed record TlsBody(bool? Enabled, string? CertPath, string? CertPassword, bool? ClearCertPassword);
    public sealed record UpdateBody(string? GithubRepo, string? ApiUrl);
    public sealed record SettingsBody(
        string? ServerName, int? Port, string? LogLevel, string? HostCloseAction,
        string? BindAddress, bool? TrustLoopback, bool? AllowLanWithoutToken,
        string? AccessToken, bool? ClearAccessToken, TlsBody? Tls, UpdateBody? SelfUpdate);

    [HttpPut("api/manage/settings")]
    public IActionResult Put([FromBody] SettingsBody body)
    {
        if (body is null) return BadRequest(new { error = "body required" });
        var c = _config.Current;

        if (body.Port is { } p && (p < 1024 || p > 65535))
            return BadRequest(new { error = "端口需在 1024–65535 之间 / port must be 1024–65535" });
        var newBind = string.IsNullOrWhiteSpace(body.BindAddress) ? c.Security.BindAddress : body.BindAddress.Trim();
        if (!string.IsNullOrWhiteSpace(body.BindAddress) && !IPAddress.TryParse(newBind, out _))
            return BadRequest(new { error = "绑定地址需是 IP(如 127.0.0.1 或 0.0.0.0)/ bindAddress must be an IP" });

        // Fail-closed: never persist a config that binds a non-loopback address without an access token
        // — the server would refuse to start (unauthenticated control of the data folder + claude CLI).
        // Exception: the explicit LAN opt-in accepts an unauthenticated non-loopback bind.
        var loopback = newBind is "127.0.0.1" or "::1";
        var willHaveToken = body.ClearAccessToken == true ? false
            : !string.IsNullOrEmpty(body.AccessToken) || !string.IsNullOrEmpty(c.Security.AccessToken);
        var willAllowLan = body.AllowLanWithoutToken ?? c.Security.AllowLanWithoutToken;
        if (!loopback && !willHaveToken && !willAllowLan)
            return BadRequest(new { error = "对外网开放(非 127.0.0.1)必须设置访问令牌,或开启「局域网免令牌」,否则服务会拒绝启动。" });

        _config.Update(cfg =>
        {
            if (body.ServerName is { Length: > 0 }) cfg.ServerName = body.ServerName.Trim();
            if (body.Port is { } port) cfg.Port = port;
            if (body.LogLevel is { Length: > 0 } lvl && Enum.TryParse<Microsoft.Extensions.Logging.LogLevel>(lvl, true, out _))
                cfg.LogLevel = lvl;
            if (body.HostCloseAction is { Length: > 0 } hca && hca is "ask" or "tray" or "exit")
                cfg.HostCloseAction = hca;
            if (!string.IsNullOrWhiteSpace(body.BindAddress)) cfg.Security.BindAddress = body.BindAddress.Trim();
            if (body.TrustLoopback is { } tl) cfg.Security.TrustLoopback = tl;
            if (body.AllowLanWithoutToken is { } lan) cfg.Security.AllowLanWithoutToken = lan;
            if (body.ClearAccessToken == true) cfg.Security.AccessToken = null;
            else if (!string.IsNullOrEmpty(body.AccessToken)) cfg.Security.AccessToken = body.AccessToken;
            if (body.Tls is { } tls)
            {
                if (tls.Enabled is { } en) cfg.Security.Tls.Enabled = en;
                if (tls.CertPath is not null) cfg.Security.Tls.CertPath = string.IsNullOrWhiteSpace(tls.CertPath) ? null : tls.CertPath.Trim();
                if (tls.ClearCertPassword == true) cfg.Security.Tls.CertPassword = null;
                else if (!string.IsNullOrEmpty(tls.CertPassword)) cfg.Security.Tls.CertPassword = tls.CertPassword;
            }
            if (body.SelfUpdate is { } su)
            {
                if (su.GithubRepo is not null) cfg.SelfUpdate.GithubRepo = string.IsNullOrWhiteSpace(su.GithubRepo) ? null : su.GithubRepo.Trim();
                if (su.ApiUrl is not null) cfg.SelfUpdate.ApiUrl = string.IsNullOrWhiteSpace(su.ApiUrl) ? null : su.ApiUrl.Trim();
            }
        });
        return Ok(new { ok = true, restartRequired = true });
    }
}
