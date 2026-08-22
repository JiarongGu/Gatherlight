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
    public async Task<IActionResult> Get()
    {
        var rows = _provisioner.Status();

        // The CLI is the one resource where "installed" does not mean "usable": a downloaded binary is not
        // a signed-in one, and the app can detect that precisely but cannot fix it (`claude auth login` is
        // a browser flow with no headless variant). So the row carries the login state as its own line,
        // rather than letting the household find out when a chat turn dies.
        var state = await _claude.ProbeAsync();
        rows = rows.Select(r => r.Id == "claude" ? r with { Detail = ClaudeDetail(state) } : r).ToList();

        // Opening the panel is the natural moment to learn whether a newer CLI exists. Detached: a slow or
        // absent network must not hold the panel, and the answer only decorates a row.
        _ = _provisioner.CheckUpdatesAsync(CancellationToken.None);
        return Ok(new { resources = rows });
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
