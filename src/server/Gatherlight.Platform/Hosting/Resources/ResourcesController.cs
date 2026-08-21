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

    private static string ClaudeDetail(ClaudeCliState s) =>
        !s.Runnable ? "未安装或无法运行"
        : !s.LoggedIn ? "已安装,但尚未登录 —— 在本机运行 `claude auth login` 后即可使用"
        : s.Account is { Length: > 0 } ? $"已登录:{s.Account}"
        : "已登录";

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
