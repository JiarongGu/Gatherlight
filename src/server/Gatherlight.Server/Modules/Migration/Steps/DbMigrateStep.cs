using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Fluent.Services;
using Gatherlight.Server.Modules.Migration.Services;

namespace Gatherlight.Server.Modules.Migration.Steps;

public sealed class DbMigrateStep : IMigrationStep
{
    private readonly IDataContext _data;
    public DbMigrateStep(IDataContext data) => _data = data;
    public string Id => "db-migrate";
    public string Title => "数据库结构迁移";
    public bool Essential => true;
    public Task RunAsync(CancellationToken ct)
    {
        MigrationRunnerService.MigrateToLatest(_data.DatabasePath);
        return Task.CompletedTask;
    }
}
