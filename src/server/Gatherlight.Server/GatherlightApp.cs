using System.Text.Json;
using Gatherlight.Server.Modules.Chat.Services;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.DataRepo.Services;
using Gatherlight.Server.Modules.Files.Services;
using Gatherlight.Server.Modules.Fluent.Services;
using Gatherlight.Server.Modules.Llm.Services;
using Gatherlight.Server.Modules.PlanIndex.Services;
using Gatherlight.Server.Modules.Seed.Services;
using Gatherlight.Server.Modules.Tools.Models;
using Gatherlight.Server.Modules.Tools.Services;
using Gatherlight.Server.Modules.Tools.Services.Tools;

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
            .AddSingleton<IIcsExportService, IcsExportService>()
            .AddSingleton<IBudgetService, BudgetService>()
            .AddHostedService<PlanIndexWatcher>()
            // LLM — spawn the authenticated claude CLI, never an API key
            .AddSingleton<IClaudeCliRunner, ClaudeCliRunner>()
            .AddSingleton<IPromptHarness, PromptHarness>()
            .AddSingleton<IZhikuRouter, ZhikuRouter>()
            .AddSingleton<IClaudeValidateService, ClaudeValidateService>()
            // Chat — the two-gate flow (+ 系统模式: the agent edits the code repo's src/client)
            .AddSingleton<IChatRepository, ChatRepository>()
            .AddSingleton<ChatEnvironmentService>()
            .AddSingleton<CodeRepoGit>()
            .AddSingleton<BuildVerifyService>()
            .AddSingleton<ChatSessionService>()
            // Uploads (chat attachments)
            .AddSingleton<IUploadService, UploadService>()
            // Tools — one registry, two surfaces (HTTP + MCP for the spawned agent)
            .AddSingleton<IPlaywrightHost, PlaywrightHost>()
            .AddSingleton<Modules.Scrapers.Services.IPlaywrightScraper, Modules.Scrapers.Services.PlaywrightScraper>()
            .AddSingleton<IGatherlightTool, ExtractTool>()
            .AddSingleton<IGatherlightTool, WebFetchTool>()   // registers as "scrape" (Playwright-native)
            .AddSingleton<IGatherlightTool, WikiInfoTool>()
            // Native C#/Playwright scraper ports (the Node puppeteer leaves are all gone)
            .AddSingleton<IGatherlightTool, Modules.Scrapers.Tools.FlightScheduleScraperTool>()
            .AddSingleton<IGatherlightTool, Modules.Scrapers.Tools.PolicyCheckScraperTool>()
            .AddSingleton<IGatherlightTool, Modules.Scrapers.Tools.FlightPricesScraperTool>()
            .AddSingleton<IGatherlightTool, Modules.Scrapers.Tools.HotelPricesScraperTool>()
            .AddSingleton<IGatherlightTool, Modules.Scrapers.Tools.HotelInfoScraperTool>()
            .AddSingleton<IGatherlightTool, Modules.Scrapers.Tools.RestaurantInfoScraperTool>()
            .AddSingleton<IGatherlightTool, Modules.PlanIndex.Tools.BudgetScanTool>()
            // Document / media processing (PdfPig extract + pdf-lib leaves for AcroForm + ImageSharp)
            .AddSingleton<Modules.Documents.Services.IPdfProcessor, Modules.Documents.Services.PdfProcessor>()
            .AddSingleton<Modules.Documents.Services.IImageProcessor, Modules.Documents.Services.ImageProcessor>()
            .AddSingleton<IGatherlightTool, Modules.Documents.Tools.PdfInspectTool>()
            .AddSingleton<IGatherlightTool, Modules.Documents.Tools.PdfExtractTextTool>()
            .AddSingleton<IGatherlightTool, Modules.Documents.Tools.PdfFillTool>()
            .AddSingleton<IGatherlightTool, Modules.Documents.Tools.PdfMergeTool>()
            .AddSingleton<IGatherlightTool, Modules.Documents.Tools.FillItineraryTool>()
            .AddSingleton<IGatherlightTool, Modules.Documents.Tools.ImageInfoTool>()
            .AddSingleton<IGatherlightTool, Modules.Documents.Tools.ImageResizeTool>()
            .AddSingleton<IGatherlightTool, Modules.Documents.Tools.ImageConvertTool>()
            // Generalized stores + agent-writable cross-session memory
            .AddSingleton<Modules.Knowledge.Services.IEntityStore, Modules.Knowledge.Services.EntityStore>()
            .AddSingleton<Modules.Knowledge.Services.IKnowledgeStore, Modules.Knowledge.Services.KnowledgeStore>()
            .AddSingleton<Modules.Knowledge.Services.IProcessLog, Modules.Knowledge.Services.ProcessLog>()
            .AddSingleton<IGatherlightTool, Modules.Knowledge.Tools.RememberFactTool>()
            .AddSingleton<IGatherlightTool, Modules.Knowledge.Tools.RecallFactsTool>()
            // Knowledge library — DB-backed reference entities (browse read side + agent write tools)
            .AddSingleton<Modules.Library.Services.ILibraryRepository, Modules.Library.Services.LibraryRepository>()
            .AddSingleton<Modules.Library.Services.IImageCache, Modules.Library.Services.ImageCache>()
            .AddSingleton<IGatherlightTool, Modules.Library.Tools.LibraryUpsertTool>()
            .AddSingleton<IGatherlightTool, Modules.Library.Tools.LibrarySearchTool>()
            .AddSingleton<IGatherlightTool, Modules.Library.Tools.LibraryImportTool>()
            .AddSingleton<IGatherlightTool, Modules.Library.Tools.LibraryDeleteTool>()
            // Portable memory transfer (export/import the DB knowledge between installs)
            .AddSingleton<Modules.Memory.Services.IMemoryService, Modules.Memory.Services.MemoryService>()
            // Hot-loadable script tools ({data}/tools/<name>/tool.json — no rebuild needed)
            .AddSingleton<ScriptToolProvider>()
            .AddSingleton<IScriptToolProvider>(sp => sp.GetRequiredService<ScriptToolProvider>())
            .AddHostedService(sp => sp.GetRequiredService<ScriptToolProvider>())
            .AddSingleton<IToolRegistry, ToolRegistry>()
            // Knowledge-base seeder (template → data folder, hash-guarded upgrades)
            .AddSingleton<IZhikuSeeder, ZhikuSeeder>();

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
        // Seed/upgrade the knowledge base BEFORE indexing so a fresh data folder scaffolds fully.
        app.Services.GetRequiredService<IZhikuSeeder>().SeedAsync().GetAwaiter().GetResult();

        app.Services.GetRequiredService<IPlanIndexService>().RescanAsync().GetAwaiter().GetResult();

        // Optional startup memory seed (testing / new installs): point GATHERLIGHT_SEED_MEMORY at a
        // bundle exported from another install and it's merged in on boot (idempotent upsert).
        if (Environment.GetEnvironmentVariable("GATHERLIGHT_SEED_MEMORY") is { Length: > 0 } seedPath
            && File.Exists(seedPath))
        {
            try
            {
                var bundle = JsonSerializer.Deserialize<Modules.Memory.Services.MemoryBundle>(
                    File.ReadAllText(seedPath), new JsonSerializerOptions(JsonSerializerDefaults.Web));
                if (bundle is { GatherlightMemory: >= 1 })
                {
                    var r = app.Services.GetRequiredService<Modules.Memory.Services.IMemoryService>()
                        .ImportAsync(bundle).GetAwaiter().GetResult();
                    app.Logger.LogInformation("Seeded memory from {Path}: {Lib} library, {Kn} knowledge, {Ent} entities",
                        seedPath, r.Library, r.Knowledge, r.Entities);
                }
            }
            catch (Exception ex)
            {
                app.Logger.LogWarning("Memory seed from {Path} failed: {Msg}", seedPath, ex.Message);
            }
        }

        // Chat runtime files (settings.chat.json + scope-guard hook); a newly-seeded scope guard
        // is committed so the agent's own diffs stay clean.
        var chatEnv = app.Services.GetRequiredService<ChatEnvironmentService>();
        if (chatEnv.EnsureFiles() is { } seededHook)
        {
            var hookSha = git.CommitPathsAsync(new[] { seededHook }, "seed: chat scope-guard hook")
                .GetAwaiter().GetResult();
            app.Services.GetRequiredService<IDataCommitRepository>().Record(hookSha, "seed: chat scope-guard hook", "seed");
        }

        // Sessions left non-terminal by a previous server death → error (inspectable, not resumed).
        app.Services.GetRequiredService<IChatRepository>().FailInterruptedSessionsAsync().GetAwaiter().GetResult();

        app.MapControllers();
        McpEndpoint.Map(app);

        // The built web client (src/client `npm run build` → wwwroot). Resolved across the flat
        // output layout and the structured bundle (res/wwwroot) by ResourcePaths. Absent = dev via Vite.
        var wwwroot = ResourcePaths.Wwwroot;
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
