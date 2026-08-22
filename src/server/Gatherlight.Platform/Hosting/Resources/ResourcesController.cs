using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Hosting.Resources.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Platform.Hosting.Resources;

/// <summary>
/// The 资源 · Resources surface of the management console. Large resources (Chromium, Git, the claude CLI,
/// later the embedding model) ship download-at-setup rather than bundled; this reports what's present and
/// kicks off a download. Provisioning runs in the background — the UI polls <c>GET</c> for live progress.
/// </summary>
[ApiController]
public sealed class ResourcesController : ControllerBase
{
    private readonly IResourceProvisioner _provisioner;
    private readonly IClaudeCliRuntime _claude;

    public ResourcesController(IResourceProvisioner provisioner, IClaudeCliRuntime claude)
    {
        _provisioner = provisioner;
        _claude = claude;
    }

    [HttpGet("api/manage/resources")]
    public IActionResult Get()
    {
        var rows = _provisioner.Status();

        // The CLI is the one resource where "installed" does not mean "usable": a downloaded binary is not
        // a signed-in one. So the row carries the login state as its own line, rather than letting the
        // household find out when a chat turn dies.
        //
        // READ FROM THE CACHE, never awaited. The probe spawns `auth status` and costs 0.6–0.9 s; awaiting
        // it meant one row's extra question held up a whole panel of file checks, and 资源 took ~0.7 s to
        // show anything. A cold cache now returns Detail = null — "not known yet", which the client renders
        // as 检查中… and re-asks once — while the refresh runs in the background. Null is deliberately
        // distinct from "not installed": the panel must not report a signed-out CLI just because nobody has
        // looked yet.
        // ADOPT SYNCHRONOUSLY, PROBE IN THE BACKGROUND. These are two different costs and only one of them
        // is slow: Apply() is two env reads, a File.Exists and a SetEnvironmentVariable — microseconds —
        // while the probe spawns a process. Taking the probe off the request path without this left a CLI
        // installed from this very panel un-adopted until something else happened to probe, because
        // CLAUDE_CMD is set inside Apply(). That is the resolve-once trap this file already documents,
        // re-created one layer out: p50's "installed mid-life is adopted with no restart" caught it.
        _claude.Apply();

        var state = _claude.Cached;
        if (state is null) _ = _claude.ProbeAsync(ct: CancellationToken.None);
        rows = rows.Select(r => r.Id == "claude"
            ? r with { Detail = state is null ? null : ClaudeDetail(state) }
            : r).ToList();

        // Opening the panel is the natural moment to learn whether a newer CLI exists. Detached: a slow or
        // absent network must not hold the panel, and the answer only decorates a row.
        _ = _provisioner.CheckUpdatesAsync(CancellationToken.None);
        return Ok(new
        {
            resources = rows,
            // WHICH login the app uses, and where the app's own credentials live. Sent even when the
            // machine's session is in use, so the panel can offer the switch without a second request.
            claudeSession = new
            {
                mode = _claude.SessionMode == ClaudeSessionMode.App ? "app" : "machine",
                home = _claude.AppSessionHome,
            },
        });
    }

    /// <summary>The CLI's own line. When it is not signed in this NAMES THE BUTTON rather than a command:
    /// the command was unactionable for a CLI we installed, because its directory is never on PATH.</summary>
    private static string ClaudeDetail(ClaudeCliState s) =>
        !s.Runnable ? "未安装或无法运行"
        : !s.LoggedIn ? "已安装,但尚未登录 —— 点「登录」会打开浏览器完成一次登录"
        : s.Account is { Length: > 0 } ? $"已登录:{s.Account}"
        : "已登录";

    /// <summary>Start the browser login for whichever CLI this install resolves to.
    ///
    /// <para><b>Loopback only, and that is not a permission check.</b> This opens a console window on the
    /// machine running the server. To someone reaching the console from another device that window is
    /// invisible and unreachable, so "started" would be a lie — the honest answer is to refuse and say
    /// where the login has to happen. The access gate has already decided WHO may call this; the question
    /// here is whether the answer can possibly be useful to them.</para>
    ///
    /// <para>Returns at once. The flow needs a human in a browser, so the panel polls
    /// <c>GET /api/manage/resources</c> and the row's own line flips when it lands — the same mechanism the
    /// download rows already use, rather than a second kind of progress.</para></summary>
    [HttpPost("api/manage/resources/claude/login")]
    public IActionResult ClaudeLogin()
    {
        var ip = HttpContext.Connection.RemoteIpAddress;
        if (ip is null || !System.Net.IPAddress.IsLoopback(ip))
            return StatusCode(409, new
            {
                error = "登录要在运行本服务的那台机器上完成 —— 它会打开一个浏览器窗口,"
                    + "远程看不到也点不到。请到那台机器的管理控制台里点「登录」。",
            });

        if (!_claude.StartLogin())
            return StatusCode(409, new
            {
                error = _claude.Locate() is null
                    ? "还没有可运行的 Claude CLI —— 先在这一行点「下载」。"
                    : "登录窗口可能已经打开了 —— 请在那个窗口里完成,然后回到这里。",
            });

        return Accepted(new { ok = true, note = "已打开登录窗口 —— 在浏览器里完成后回到这里,状态会自动刷新。" });
    }

    /// <summary>Which login the app's own spawns use — the machine's, or one of its own.
    ///
    /// <para>The CLI keeps credentials in a config directory, so every process started as the same OS user
    /// shares a session: the app was signed in as whoever the household is signed in as in their own
    /// terminal. That is fine when they are the same account and wrong when they are not — a personal
    /// account for their own work and a family account for the planner is a reasonable thing to want, and
    /// there was no way to say it.</para>
    ///
    /// <para>Live, not a restart: the variable is re-applied on every probe, so the next spawn uses it.</para></summary>
    [HttpPost("api/manage/resources/claude/session")]
    public IActionResult ClaudeSession([FromBody] SessionRequest body)
    {
        var mode = string.Equals(body?.Mode, "app", StringComparison.OrdinalIgnoreCase)
            ? ClaudeSessionMode.App
            : string.Equals(body?.Mode, "machine", StringComparison.OrdinalIgnoreCase)
                ? ClaudeSessionMode.Machine
                : (ClaudeSessionMode?)null;
        if (mode is null) return BadRequest(new { error = "mode must be \"machine\" or \"app\"" });

        _claude.SetSessionMode(mode.Value);
        return Ok(new
        {
            ok = true, mode = mode == ClaudeSessionMode.App ? "app" : "machine",
            note = mode == ClaudeSessionMode.App
                ? "应用改用自己的登录 —— 还没登录过的话,点「登录」。"
                : "应用改用这台机器上的登录。",
        });
    }

    /// <summary>Sign out of the APP's own session.
    ///
    /// <para>Refused while the app shares the machine's login, and that refusal is the point: that
    /// credential belongs to the household's own terminal. Signing them out of it from our panel is the
    /// same overreach as deleting models out of a daemon we did not install — a lesson this codebase has
    /// already paid for once.</para></summary>
    [HttpPost("api/manage/resources/claude/logout")]
    public async Task<IActionResult> ClaudeLogout()
    {
        if (_claude.SessionMode != ClaudeSessionMode.App)
            return StatusCode(409, new
            {
                error = "现在用的是这台机器上的登录 —— 那是你自己终端里的账号,应用不会替你退出。"
                    + "要单独一个账号,先切到「应用自己的登录」。",
            });

        return await _claude.LogoutAsync()
            ? Ok(new { ok = true, note = "已退出应用自己的登录。" })
            : StatusCode(502, new { error = "退出登录没有成功 —— 详情见「日志」。" });
    }

    public sealed record SessionRequest(string Mode);

    [HttpPost("api/manage/resources/{id}/provision")]
    public IActionResult Provision(string id)
    {
        if (!_provisioner.Start(id)) return NotFound(new { error = "unknown resource" });
        // Whatever we knew about the CLI is about to stop being true; drop it so the panel does not keep
        // reporting a pre-install answer after the download lands.
        if (id == "claude") _claude.Invalidate();
        return Accepted(new { ok = true });
    }
}
