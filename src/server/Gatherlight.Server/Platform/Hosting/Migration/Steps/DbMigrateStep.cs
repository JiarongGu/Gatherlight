using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Hosting.Fluent.Services;
using Gatherlight.Server.Platform.Hosting.Migration.Services;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

public sealed class DbMigrateStep : IMigrationStep
{
    private readonly IPlatformContext _data;
    public DbMigrateStep(IPlatformContext data) => _data = data;
    public string Id => "db-migrate";
    public string Title => "数据库结构迁移";
    public bool Essential => true;
    public Task RunAsync(CancellationToken ct)
    {
        MigrationRunnerService.MigrateToLatest(_data.DatabasePath);
        return Task.CompletedTask;
    }
}
