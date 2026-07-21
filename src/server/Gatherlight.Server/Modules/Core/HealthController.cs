using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Migration.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Core;

[ApiController]
[Route("api/health")]
public sealed class HealthController : ControllerBase
{
    private readonly IDataContext _data;
    private readonly ServerConfigService _config;
    private readonly MigrationState _migration;

    public HealthController(IDataContext data, ServerConfigService config, MigrationState migration)
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
