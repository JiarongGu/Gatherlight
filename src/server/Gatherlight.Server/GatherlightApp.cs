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
using Lyntai; // the shared LLM library (AddClaudeCliProvider / DefaultCandidates on the builder)

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

        // Bridge the CLI stub override to Lyntai's ClaudeCli provider: the native runner reads
        // GATHERLIGHT_CLAUDE_CMD, Lyntai's provider reads CLAUDE_CMD — point both at the same stubbed CLI
        // (tests/e2e) so the migrated one-shot scorers hit the stub, not a real claude. No-op in production.
        var stubCmd = Environment.GetEnvironmentVariable("GATHERLIGHT_CLAUDE_CMD");
        if (!string.IsNullOrEmpty(stubCmd) && string.IsNullOrEmpty(Environment.GetEnvironmentVariable("CLAUDE_CMD")))
            Environment.SetEnvironmentVariable("CLAUDE_CMD", stubCmd);

        var builder = WebApplication.CreateBuilder(args ?? Array.Empty<string>());
        // Fail closed: exposing beyond loopback without a token = unauthenticated control of the
        // claude CLI + the family's private data. Refuse rather than silently open the door — UNLESS
        // the user explicitly opts in (allowLanWithoutToken) for a trusted private LAN.
        var openBind = !GatherlightServerOptions.IsLoopbackAddress(options.BindAddress)
            && string.IsNullOrEmpty(options.AccessToken);
        if (openBind && !options.AllowLanWithoutToken)
            throw new InvalidOperationException(
                $"Refusing to bind {options.BindAddress} without an access token. Set security.accessToken " +
                "in settings.json (or GATHERLIGHT_ACCESS_TOKEN) before exposing Gatherlight on the network — " +
                "or set security.allowLanWithoutToken=true (GATHERLIGHT_ALLOW_LAN=1) to expose it unauthenticated " +
                "on a trusted private LAN.");

        var cert = Modules.Security.Services.TlsCertificate.Resolve(options);
        if (cert is null)
            builder.WebHost.UseUrls($"http://{options.BindAddress}:{options.Port}");
        else
            builder.WebHost.ConfigureKestrel(k =>
                k.Listen(ParseBindAddress(options.BindAddress), options.Port, lo => lo.UseHttps(cert)));
        builder.Logging.AddSimpleConsole(o => o.SingleLine = true);
        // Persist logs to {data}/state/logs/{yyyy-MM-dd}.log so errors are trackable after the fact.
        // Level from settings (GATHERLIGHT_LOG_LEVEL wins); framework (Microsoft/System) noise is capped
        // at Warning (or the app level if quieter). One ServerConfigService for both this + the DI below.
        config ??= new ServerConfigService(options);
        var logsDir = Path.Combine(Path.GetFullPath(options.DataPath), "state", "logs");
        var dbPath = Path.Combine(Path.GetFullPath(options.DataPath), "state", "gatherlight.db"); // = IDataContext.DatabasePath (for Lyntai's store)
        var logLevel = ResolveLogLevel(config.Current.LogLevel);
        var fwLevel = logLevel > LogLevel.Warning ? logLevel : LogLevel.Warning;
        builder.Logging.AddProvider(new Modules.Core.Logging.FileLoggerProvider(logsDir, logLevel));
        builder.Logging.AddFilter<Modules.Core.Logging.FileLoggerProvider>((string?)null, logLevel);
        builder.Logging.AddFilter<Modules.Core.Logging.FileLoggerProvider>("Microsoft", fwLevel);
        builder.Logging.AddFilter<Modules.Core.Logging.FileLoggerProvider>("System", fwLevel);

        builder.Services
            .AddSingleton(options)
            // The config resolved above (one instance, one settings.json reader).
            .AddSingleton(config)
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
            // Lyntai (灵台) — the shared LLM library from NuGet. LLM-judge scorers consume its ILlmClient
            // front door + ClaudeCli provider (neutral cwd, verdict/router); the interactive two-gate, jobs,
            // and playground drive the CLI's own agent loop through its IAgentSession (via AgentRunner below).
            // AddLyntai returns IServiceCollection, so it chains; SQLite storage backs scoring persistence.
            .AddLyntai(b => b
                .AddClaudeCliProvider()
                // The interactive two-gate + jobs + playground drive the CLI's own agent loop through
                // Lyntai's IAgentSession (registered here). Long agentic runs need a budget bigger than the
                // 2-min provider default: lift the ceiling so a per-call TimeoutSeconds up to 2h is honored
                // (short one-shot/scorer calls keep the 2-min ProviderTimeout default).
                .AddClaudeCliAgentSession()
                .Configure(o => o.MaxProviderTimeout = TimeSpan.FromHours(2))
                .DefaultCandidates("claude-cli")
                // Lyntai owns scoring persistence: its SQLite storage lands lyntai_score_result (+ the other
                // lyntai_* tables) in the same gatherlight.db, migrated eagerly here.
                .UseSqliteStorage(dbPath)
                // The 6 scorers now implement Lyntai.Cortex.IScorer — registered into Lyntai's scoring
                // collection so its IScoringService iterates + persists them (LLM judges route through
                // llm.model.scorer, skip via Applies()).
                .AddScorer<Modules.Scoring.Services.ScopeAdherenceScorer>()
                .AddScorer<Modules.Scoring.Services.PlanStructureScorer>()
                .AddScorer<Modules.Scoring.Services.OutcomeScorer>()
                .AddScorer<Modules.Scoring.Services.CitationScorer>()
                .AddScorer<Modules.Scoring.Services.AnswerRelevancyScorer>()
                .AddScorer<Modules.Scoring.Services.FaithfulnessScorer>())
            // App-side adapter over Lyntai's IAgentSession — the two-gate / jobs / playground run through this.
            .AddSingleton<IAgentRunner, AgentRunner>()
            // One live agent run at a time across chat AND background jobs (single-writer data tree)
            .AddSingleton<IAgentGate, AgentGate>()
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
            .AddSingleton<Modules.Resources.Services.IResourceProvisioner, Modules.Resources.Services.ResourceProvisioner>()
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
            .AddSingleton<IGatherlightTool, Modules.Scrapers.Tools.XhsSearchScraperTool>()
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
            // Plan-index navigation (md-driven plans/INDEX.md + these programmatic twins)
            .AddSingleton<IGatherlightTool, Modules.PlanIndex.Tools.IndexListTool>()
            .AddSingleton<IGatherlightTool, Modules.PlanIndex.Tools.IndexSearchTool>()
            .AddSingleton<IGatherlightTool, Modules.PlanIndex.Tools.IndexReindexTool>()
            // Portable memory transfer (export/import the DB knowledge between installs)
            .AddSingleton<Modules.Memory.Services.IMemoryService, Modules.Memory.Services.MemoryService>()
            // Whole-install backup/restore (records + DB memory in one .zip)
            .AddSingleton<Modules.Backup.Services.IBackupService, Modules.Backup.Services.BackupService>()
            // Eval / LLM-ops: per-conversation ranking + observability (tuning dataset)
            .AddSingleton<Modules.Eval.Services.IFeedbackStore, Modules.Eval.Services.FeedbackStore>()
            // Cortex tuning: runtime prompt-template + model-routing overrides (write side of LLM-ops)
            .AddSingleton<Modules.Cortex.Services.ICortexConfigService, Modules.Cortex.Services.CortexConfigService>()
            // Automated scorers (Mastra-style): grade each committed conversation on 智库-rule dimensions
            .AddSingleton<Modules.Scoring.Services.IScoringService, Modules.Scoring.Services.ScoringService>()
            // Run traces (Mastra observability): structure the conversation event stream into a run timeline
            .AddSingleton<Modules.Trace.Services.ITraceService, Modules.Trace.Services.TraceService>()
            // Prompt/agent playground (Mastra runEvals): score dry plans over a scenario set (CLI)
            .AddSingleton<Modules.Playground.Services.IPlaygroundService, Modules.Playground.Services.PlaygroundService>()
            // Remote-access gate: loopback trusted, remote needs the shared token
            .AddSingleton<Modules.Security.Services.ISecurityGuard, Modules.Security.Services.SecurityGuard>()
            .AddSingleton<Modules.Security.Services.ILoginThrottle, Modules.Security.Services.LoginThrottle>()
            // Self-update: check GitHub releases + download/stage (launcher applies on restart)
            .AddSingleton<Modules.Update.Services.IUpdateService, Modules.Update.Services.UpdateService>()
            // Background jobs: generic scheduled/one-off work (agent tasks, tool calls, notifications,
            // reports) + a browser/in-app notification feed. See docs/background-jobs-design.md.
            .AddSingleton<Modules.Jobs.Services.IJobRepository, Modules.Jobs.Services.JobRepository>()
            .AddSingleton<Modules.Jobs.Services.INotificationService, Modules.Jobs.Services.NotificationService>()
            .AddSingleton<Modules.Jobs.Services.IUnattendedRunService, Modules.Jobs.Services.UnattendedRunService>()
            // Job kinds = IJobHandler DI collection (add a kind = add a handler, never an if/else)
            .AddSingleton<Modules.Jobs.Services.IJobHandler, Modules.Jobs.Services.ToolJobHandler>()
            .AddSingleton<Modules.Jobs.Services.IJobHandler, Modules.Jobs.Services.NotifyJobHandler>()
            .AddSingleton<Modules.Jobs.Services.IJobHandler, Modules.Jobs.Services.ReportJobHandler>()
            .AddSingleton<Modules.Jobs.Services.IJobHandler, Modules.Jobs.Services.AgentJobHandler>()
            // Orchestration (CRUD + execution engine + staged approve/reject) shared by the scheduler + run-now
            .AddSingleton<Modules.Jobs.Services.IJobService, Modules.Jobs.Services.JobService>()
            // The scheduler loop (polls due jobs, dispatches, catch-up, guardrails)
            .AddHostedService<Modules.Jobs.Services.JobSchedulerService>()
            // AI-facing job management tools (both surfaces)
            .AddSingleton<IGatherlightTool, Modules.Jobs.Tools.JobScheduleTool>()
            .AddSingleton<IGatherlightTool, Modules.Jobs.Tools.JobListTool>()
            .AddSingleton<IGatherlightTool, Modules.Jobs.Tools.JobCancelTool>()
            .AddSingleton<IGatherlightTool, Modules.Jobs.Tools.JobRunNowTool>()
            .AddSingleton<IGatherlightTool, Modules.Jobs.Tools.NotifyUserTool>()
            // Hot-loadable script tools ({data}/tools/<name>/tool.json — no rebuild needed)
            .AddSingleton<ScriptToolProvider>()
            .AddSingleton<IScriptToolProvider>(sp => sp.GetRequiredService<ScriptToolProvider>())
            .AddHostedService(sp => sp.GetRequiredService<ScriptToolProvider>())
            .AddSingleton<IToolRegistry, ToolRegistry>()
            // Knowledge-base seeder (template → data folder, hash-guarded upgrades)
            .AddSingleton<IZhikuSeeder, ZhikuSeeder>()
            // Knowledge-base upgrade migration (LLM-reconcile customized .claude/ files with new templates)
            .AddSingleton<Modules.Seed.Services.IZhikuMigrator, Modules.Seed.Services.ZhikuMigrator>();

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

        // Startup banner — the first lines of every log file (version · level · data root · bind · logs).
        app.Logger.LogInformation("=== Gatherlight starting === v{Ver} · level={Lvl} · data={Data} · bind={Bind}:{Port} · logs={Logs}",
            Modules.Core.Services.AppVersion.Semver,
            logLevel, options.DataPath, options.BindAddress, options.Port, logsDir);

        // Loud, once-at-startup warning when the LAN opt-in is exposing the app unauthenticated.
        if (openBind && options.AllowLanWithoutToken)
            app.Logger.LogWarning(
                "Gatherlight is bound to {Bind}:{Port} WITHOUT an access token (allowLanWithoutToken). " +
                "Anyone who can reach that address has full, unauthenticated access to your data and the " +
                "claude CLI — only use this on a trusted private network.", options.BindAddress, options.Port);

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
        // Detect customized .claude/ files that have shipped improvements (which the seeder skips) and
        // notify — the LLM 3-way merge is opt-in from the console (no startup token spend).
        app.Services.GetRequiredService<Modules.Seed.Services.IZhikuMigrator>().NotifyIfUpgradesAsync().GetAwaiter().GetResult();

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
                    app.Logger.LogInformation("Seeded memory from {Path}: {Lib} library, {Kn} knowledge, {Ent} entities, {Cx} cortex",
                        seedPath, r.Library, r.Knowledge, r.Entities, r.Cortex);
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
        // Same for job runs left 'running' by a crash → reconcile to failed so history is honest.
        var reconciled = app.Services.GetRequiredService<Modules.Jobs.Services.IJobRepository>()
            .FailInterruptedRunsAsync().GetAwaiter().GetResult();
        if (reconciled > 0) app.Logger.LogInformation("Reconciled {N} interrupted job run(s) → failed", reconciled);

        // Defense-in-depth response headers (CSP + framing/sniffing) on everything.
        app.UseMiddleware<Modules.Security.SecurityHeadersMiddleware>();
        // Gate /api + /mcp before the endpoints run (no-op unless an access token is configured).
        app.UseMiddleware<Modules.Security.AccessGateMiddleware>();

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

    /// <summary>Parse the configured file-log level (env <c>GATHERLIGHT_LOG_LEVEL</c> wins);
    /// unrecognized falls back to Information.</summary>
    private static LogLevel ResolveLogLevel(string setting)
    {
        var s = Environment.GetEnvironmentVariable("GATHERLIGHT_LOG_LEVEL") is { Length: > 0 } e ? e : setting;
        return Enum.TryParse<LogLevel>(s, ignoreCase: true, out var l) ? l : LogLevel.Information;
    }

    /// <summary>Maps a bind-address string to the IP Kestrel should listen on for the HTTPS path.</summary>
    private static System.Net.IPAddress ParseBindAddress(string address) => address switch
    {
        "0.0.0.0" => System.Net.IPAddress.Any,
        "::" or "[::]" => System.Net.IPAddress.IPv6Any,
        "localhost" => System.Net.IPAddress.Loopback,
        _ => System.Net.IPAddress.TryParse(address, out var ip) ? ip : System.Net.IPAddress.Loopback,
    };
}
