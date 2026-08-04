using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Hosting.Migration.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Platform.Kernel;

[ApiController]
[Route("api/health")]
public sealed class HealthController : ControllerBase
{
    private readonly ISiteContext _data;
    private readonly ServerConfigService _config;
    private readonly MigrationState _migration;

    public HealthController(ISiteContext data, ServerConfigService config, MigrationState migration)
    {
        _data = data;
        _config = config;
        _migration = migration;
    }

    [HttpGet]
    public IActionResult Get() => Ok(new
    {
        ok = true,
        serverName = _config.Current.ServerName,
        dataRoot = _data.RootPath,
        migrating = _migration.IsMigrating,
    });
}
