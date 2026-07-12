using System.Text.Json;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.DataRepo.Services;
using Gatherlight.Server.Modules.Fluent.Services;
using Gatherlight.Server.Modules.PlanIndex.Services;

namespace Gatherlight.Server;

/// <summary>
/// Builds the Gatherlight server as a ready-to-run WebApplication. Consumed by the standalone
/// <c>Program.cs</c> (headless dev + the shipped product for now); the composition-root seam
/// keeps a future desktop tray host trivial (Kestrel in-process, same Build()).
/// </summary>
public static class GatherlightApp
{
    public static WebApplication Build(
        GatherlightServerOptions? options = null, string[]? args = null, ServerConfigService? config = null)
    {
        options ??= new GatherlightServerOptions();

        var builder = WebApplication.CreateBuilder(args ?? Array.Empty<string>());
        // Loopback only until there is an auth story — the data folder is a family's private life.
        builder.WebHost.UseUrls($"http://127.0.0.1:{options.Port}");
        builder.Logging.AddSimpleConsole(o => o.SingleLine = true);

        builder.Services
            .AddSingleton(options)
            // Reuse the config the entry point already loaded to resolve the port (one instance,
            // one settings.json reader), or construct it here for callers that don't pre-load it.
            .AddSingleton(config ?? new ServerConfigService(options))
            .AddSingleton<IDataContext, DataContext>()
            .AddSingleton<IDbConnectionFactory, SqliteConnectionFactory>()
            .AddSingleton<IAppConfigService, AppConfigService>()
            // Data repo (the private git repo inside the data folder)
            .AddSingleton<IGitCliService, GitCliService>()
            .AddSingleton<DataWriteLock>()
            .AddSingleton<IDataCommitRepository, DataCommitRepository>()
            // Plan index — zero-LLM browse/search over the markdown tree
            .AddSingleton<IPlanIndexService, PlanIndexService>()
            .AddSingleton<IFsOpsService, FsOpsService>()
            .AddHostedService<PlanIndexWatcher>();

        builder.Services.AddHttpClient();

        builder.Services.AddControllers()
            .AddJsonOptions(o =>
            {
                o.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
            })
            // Controller discovery scans the ENTRY assembly — under a future host exe that's not
            // this library, and every /api route would silently fall through to the SPA fallback.
            // Register this assembly explicitly.
            .AddApplicationPart(typeof(GatherlightApp).Assembly);

        var app = builder.Build();

        // Migrations before anything touches the DB.
        var data = app.Services.GetRequiredService<IDataContext>();
        MigrationRunnerService.MigrateToLatest(data.DatabasePath);

        // Data repo must exist before any fs op / chat commit; index fills before first request.
        var git = app.Services.GetRequiredService<IGitCliService>();
        if (git.EnsureRepoAsync().GetAwaiter().GetResult())
        {
            // Freshly initialized over existing content (import case): baseline commit so
            // diffs/restores have a HEAD to work against. Never auto-commits on later boots —
            // interrupted chat edits must stay reviewable, not get swallowed.
            var sha = git.CommitAllAsync("data: initial import").GetAwaiter().GetResult();
            if (sha is not null)
                app.Services.GetRequiredService<IDataCommitRepository>().Record(sha, "data: initial import", "import");
        }
        app.Services.GetRequiredService<IPlanIndexService>().RescanAsync().GetAwaiter().GetResult();

        app.MapControllers();

        // The built web client (src/client `npm run build` → wwwroot, copied next to the exe).
        // Explicit file provider: the exe's base dir is the one place it always exists,
        // regardless of content root. Absent = dev via Vite.
        var wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        if (File.Exists(Path.Combine(wwwroot, "index.html")))
        {
            var files = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(wwwroot);
            app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
            app.UseStaticFiles(new StaticFileOptions { FileProvider = files });
            app.MapFallbackToFile("index.html", new StaticFileOptions { FileProvider = files });
        }

        return app;
    }
}
