using Gatherlight.Server.Modules.Resources.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Resources;

/// <summary>
/// The 资源 · Resources surface of the management console. Large resources (Chromium, Git, later the
/// embedding model) ship download-at-setup rather than bundled; this reports what's present and kicks
/// off a download. Provisioning runs in the background — the UI polls <c>GET</c> for live progress.
/// </summary>
[ApiController]
public sealed class ResourcesController : ControllerBase
{
    private readonly IResourceProvisioner _provisioner;
    public ResourcesController(IResourceProvisioner provisioner) => _provisioner = provisioner;

    [HttpGet("api/manage/resources")]
    public IActionResult Get() => Ok(new { resources = _provisioner.Status() });

    [HttpPost("api/manage/resources/{id}/provision")]
    public IActionResult Provision(string id) =>
        _provisioner.Start(id) ? Accepted(new { ok = true }) : NotFound(new { error = "unknown resource" });
}
