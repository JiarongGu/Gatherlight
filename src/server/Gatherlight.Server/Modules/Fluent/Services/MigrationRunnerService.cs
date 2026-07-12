using FluentMigrator.Runner;

namespace Gatherlight.Server.Modules.Fluent.Services;

/// <summary>
/// Runs FluentMigrator migrations at startup (before any module touches the DB). Builds its own
/// minimal service provider so the migration plumbing never leaks into the app container.
/// Numbering: YYYYMMDDNNNN — never reuse a number (an unapplied same-numbered migration is
/// skipped silently).
/// </summary>
public static class MigrationRunnerService
{
    public static void MigrateToLatest(string databasePath)
    {
        var connectionString = $"Data Source={databasePath}";
        using var provider = new ServiceCollection()
            .AddFluentMigratorCore()
            .ConfigureRunner(rb => rb
                .AddSQLite()
                .WithGlobalConnectionString(connectionString)
                .ScanIn(typeof(MigrationRunnerService).Assembly).For.Migrations())
            .AddLogging(lb => lb.AddFluentMigratorConsole())
            .BuildServiceProvider(validateScopes: false);

        using var scope = provider.CreateScope();
        scope.ServiceProvider.GetRequiredService<IMigrationRunner>().MigrateUp();
    }
}
