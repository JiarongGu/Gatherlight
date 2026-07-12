using Gatherlight.Server.Modules.Core.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Core;

[ApiController]
[Route("api/health")]
public sealed class HealthController : ControllerBase
{
    private readonly IDataContext _data;
    private readonly ServerConfigService _config;

    public HealthController(IDataContext data, ServerConfigService config)
    {
        _data = data;
        _config = config;
    }

    [HttpGet]
    public IActionResult Get() => Ok(new
    {
        ok = true,
        serverName = _config.Current.ServerName,
        dataRoot = _data.RootPath,
    });
}
