using System.Text.Json;
using Gatherlight.Server.Platform.Agent.Chat.Services;
using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Storage.DataRepo.Services;
using Gatherlight.Server.Platform.Storage.Files.Services;
using Gatherlight.Server.Platform.Hosting.Fluent.Services;
using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Product.Planner.PlanIndex.Services;
using Gatherlight.Server.Platform.Site.Seed.Services;
using Gatherlight.Server.Platform.Capabilities.Tools.Models;
using Gatherlight.Server.Platform.Capabilities.Tools.Services;
using Gatherlight.Server.Platform.Capabilities.Tools.Services.Tools;
using Lyntai; // the shared LLM library (AddClaudeCliProvider / UseDefaultCandidates on the builder)

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

        var cert = Platform.Hosting.Security.Services.TlsCertificate.Resolve(options);
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
        var dbPath = Path.Combine(Path.GetFullPath(options.DataPath), "state", "gatherlight.db"); // = IPlatformContext.DatabasePath (for Lyntai's store)
        var logLevel = ResolveLogLevel(config.Current.LogLevel);
        var fwLevel = logLevel > LogLevel.Warning ? logLevel : LogLevel.Warning;
        builder.Logging.AddProvider(new Platform.Kernel.Logging.FileLoggerProvider(logsDir, logLevel));
        builder.Logging.AddFilter<Platform.Kernel.Logging.FileLoggerProvider>((string?)null, logLevel);
        builder.Logging.AddFilter<Platform.Kernel.Logging.FileLoggerProvider>("Microsoft", fwLevel);
        builder.Logging.AddFilter<Platform.Kernel.Logging.FileLoggerProvider>("System", fwLevel);

        builder.Services
            .AddSingleton(options)
            // The config resolved above (one instance, one settings.json reader).
            .AddSingleton(config)
            .AddSingleton<Platform.Site.Services.ISiteManifestStore, Platform.Site.Services.SiteManifestStore>()
            .AddSingleton<Platform.Kernel.Services.ISiteContext, Platform.Kernel.Services.SiteContext>()
            .AddSingleton<Platform.Kernel.Services.IPlatformContext, Platform.Kernel.Services.PlatformContext>()
            .AddSingleton<IDbConnectionFactory, SqliteConnectionFactory>()
            .AddSingleton<IAppConfigService, AppConfigService>()
            // Data repo (the private git repo inside the data folder)
            .AddSingleton<IGitCliService, GitCliService>()
            .AddSingleton<DataWriteLock>()
            .AddSingleton<IDataCommitRepository, DataCommitRepository>()
            // Plan index — zero-LLM browse/search over the markdown tree. Registered by concrete type so
            // IPlanIndexService and IRecordIndex both forward to the SAME singleton instance — anchoring
            // on the concrete type (not a cast between the two unrelated interfaces) makes it a compile
            // error, not a runtime surprise, if PlanIndexService ever stops implementing IRecordIndex.
            .AddSingleton<PlanIndexService>()
            .AddSingleton<IPlanIndexService>(sp => sp.GetRequiredService<PlanIndexService>())
            .AddSingleton<IRecordIndex>(sp => sp.GetRequiredService<PlanIndexService>())
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
                .Configure(o =>
                {
                    o.MaxProviderTimeout = TimeSpan.FromHours(2);
                    // Cortex lives in the app's OWN keys — point Lyntai's IPromptRegistry / IModelRoutingStore
                    // straight at cortex.prompt.* / llm.model.* (no shim, no lyntai_kv duplicate).
                    o.PromptKeyPrefix = "cortex.prompt.";
                    o.ModelKeyPrefix = "llm.model.";
                    o.DefaultModelByConsumer["scorer"] = "haiku"; // cheap-judge default; llm.model.scorer overrides live
                })
                // Live per-consumer model routing (the scorers' judge model) read from app_config each call.
                .AddLiveModelRouting()
                .UseDefaultCandidates("claude-cli")
                // Lyntai owns scoring + conversation persistence: its SQLite storage lands lyntai_score_result,
                // lyntai_thread/lyntai_message (+ other lyntai_* tables) in the same gatherlight.db. Kept EAGER
                // (default SchemaMigration.OnStartup → migrates synchronously here, during DI) so the lyntai_*
                // tables exist before first use. The old 0.x→Lyntai data bridges that once REQUIRED this
                // ordering are gone (squashed out at the 202607280001 baseline — a fresh DB has nothing to
                // migrate), but there's no reason to defer, so leave it eager. Lyntai 1.0's own migrations are
                // a fresh baseline reset (202607280001..) — a pre-1.0 DB must be reset, not upgraded in place.
                .UseSqliteStorage(dbPath)
                // The 6 scorers now implement Lyntai.Cortex.IScorer — registered into Lyntai's scoring
                // collection so its IScoringService iterates + persists them (LLM judges route through
                // llm.model.scorer, skip via Applies()).
                .AddScorer<Platform.Ops.Scoring.Services.ScopeAdherenceScorer>()
                .AddScorer<Platform.Ops.Scoring.Services.PlanStructureScorer>()
                .AddScorer<Platform.Ops.Scoring.Services.OutcomeScorer>()
                .AddScorer<Platform.Ops.Scoring.Services.CitationScorer>()
                .AddScorer<Platform.Ops.Scoring.Services.AnswerRelevancyScorer>()
                .AddScorer<Platform.Ops.Scoring.Services.FaithfulnessScorer>()
                // Tool-calling for the LLM judges. AddMcpToolHost registers an ICliToolProvisioner, which
                // ONLY ClaudeCliProvider reads — i.e. the one-shot ILlmClient path, whose only consumers
                // here are the two judges above. (The agent path, ClaudeAgentSession, takes no provisioner;
                // its MCP stays --mcp-config → this server's own /mcp.) Per call it starts a loopback
                // Kestrel on an OS-assigned port, bearer-gated, and tears it down after — so the judges get
                // mediated, read-only access to the artifacts they're grading without the data folder's
                // CLAUDE.md/knowledge base being loaded, which is exactly why they run neutral-cwd.
                // Registering ZERO ITools would make the host a no-op (the provisioner short-circuits).
                .AddMcpToolHost(new Lyntai.Providers.ClaudeCli.ClaudeCliMcpDialect())
                .AddTool(sp => new Platform.Ops.Scoring.Services.JudgeReadFileTool(
                    sp.GetRequiredService<Platform.Kernel.Services.ISiteContext>()))
                .AddTool(sp => new Platform.Ops.Scoring.Services.JudgeListFilesTool(
                    sp.GetRequiredService<Platform.Kernel.Services.ISiteContext>())))
            // Lyntai's cortex (IPromptRegistry / IModelRoutingStore) reads/writes the app's OWN app_config
            // table — single source of truth for cortex.prompt.* / llm.model.*, no lyntai_kv duplicate. Plain
            // AddSingleton after AddLyntai wins over its TryAdd SqliteKeyValueStore.
            .AddSingleton<Lyntai.Storage.IKeyValueStore, Platform.Ops.Cortex.Services.AppConfigKeyValueStore>()
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
            .AddSingleton<Platform.Hosting.Resources.Services.IResourceProvisioner, Platform.Hosting.Resources.Services.ResourceProvisioner>()
            .AddSingleton<IPlaywrightHost, PlaywrightHost>()
            .AddSingleton<Product.Planner.Scrapers.Services.IPlaywrightScraper, Product.Planner.Scrapers.Services.PlaywrightScraper>()
            .AddSingleton<IGatherlightTool, ExtractTool>()
            .AddSingleton<IGatherlightTool, WebFetchTool>()   // registers as "scrape" (Playwright-native)
            .AddSingleton<IGatherlightTool, WikiInfoTool>()
            // Native C#/Playwright scraper ports (the Node puppeteer leaves are all gone)
            .AddSingleton<IGatherlightTool, Product.Planner.Scrapers.Tools.FlightScheduleScraperTool>()
            .AddSingleton<IGatherlightTool, Product.Planner.Scrapers.Tools.PolicyCheckScraperTool>()
            .AddSingleton<IGatherlightTool, Product.Planner.Scrapers.Tools.FlightPricesScraperTool>()
            .AddSingleton<IGatherlightTool, Product.Planner.Scrapers.Tools.HotelPricesScraperTool>()
            .AddSingleton<IGatherlightTool, Product.Planner.Scrapers.Tools.HotelInfoScraperTool>()
            .AddSingleton<IGatherlightTool, Product.Planner.Scrapers.Tools.RestaurantInfoScraperTool>()
            .AddSingleton<IGatherlightTool, Product.Planner.Scrapers.Tools.XhsSearchScraperTool>()
            .AddSingleton<IGatherlightTool, Product.Planner.PlanIndex.Tools.BudgetScanTool>()
            // Document / media processing (PdfPig extract + pdf-lib leaves for AcroForm + ImageSharp)
            .AddSingleton<Platform.Capabilities.Documents.Services.IPdfProcessor, Platform.Capabilities.Documents.Services.PdfProcessor>()
            .AddSingleton<Platform.Capabilities.Documents.Services.IImageProcessor, Platform.Capabilities.Documents.Services.ImageProcessor>()
            .AddSingleton<IGatherlightTool, Platform.Capabilities.Documents.Tools.PdfInspectTool>()
            .AddSingleton<IGatherlightTool, Platform.Capabilities.Documents.Tools.PdfExtractTextTool>()
            .AddSingleton<IGatherlightTool, Platform.Capabilities.Documents.Tools.PdfFillTool>()
            .AddSingleton<IGatherlightTool, Platform.Capabilities.Documents.Tools.PdfMergeTool>()
            .AddSingleton<IGatherlightTool, Platform.Capabilities.Documents.Tools.FillItineraryTool>()
            .AddSingleton<IGatherlightTool, Platform.Capabilities.Documents.Tools.ImageInfoTool>()
            .AddSingleton<IGatherlightTool, Platform.Capabilities.Documents.Tools.ImageResizeTool>()
            .AddSingleton<IGatherlightTool, Platform.Capabilities.Documents.Tools.ImageConvertTool>()
            // Generalized stores + agent-writable cross-session memory
            .AddSingleton<Platform.Storage.Knowledge.Services.IEntityStore, Platform.Storage.Knowledge.Services.EntityStore>()
            .AddSingleton<Platform.Storage.Knowledge.Services.IKnowledgeStore, Platform.Storage.Knowledge.Services.KnowledgeStore>()
            .AddSingleton<Platform.Storage.Knowledge.Services.IProcessLog, Platform.Storage.Knowledge.Services.ProcessLog>()
            .AddSingleton<IGatherlightTool, Platform.Storage.Knowledge.Tools.RememberFactTool>()
            .AddSingleton<IGatherlightTool, Platform.Storage.Knowledge.Tools.RecallFactsTool>()
            // Knowledge library — DB-backed reference entities (browse read side + agent write tools)
            .AddSingleton<Platform.Storage.Library.Services.ILibraryRepository, Platform.Storage.Library.Services.LibraryRepository>()
            .AddSingleton<Platform.Storage.Library.Services.IImageCache, Platform.Storage.Library.Services.ImageCache>()
            .AddSingleton<IGatherlightTool, Platform.Storage.Library.Tools.LibraryUpsertTool>()
            .AddSingleton<IGatherlightTool, Platform.Storage.Library.Tools.LibrarySearchTool>()
            .AddSingleton<IGatherlightTool, Platform.Storage.Library.Tools.LibraryImportTool>()
            .AddSingleton<IGatherlightTool, Platform.Storage.Library.Tools.LibraryDeleteTool>()
            // Plan-index navigation (md-driven plans/INDEX.md + these programmatic twins)
            .AddSingleton<IGatherlightTool, Product.Planner.PlanIndex.Tools.IndexListTool>()
            .AddSingleton<IGatherlightTool, Product.Planner.PlanIndex.Tools.IndexSearchTool>()
            .AddSingleton<IGatherlightTool, Product.Planner.PlanIndex.Tools.IndexReindexTool>()
            // Portable memory transfer (export/import the DB knowledge between installs)
            .AddSingleton<Platform.Storage.Memory.Services.IMemoryService, Platform.Storage.Memory.Services.MemoryService>()
            // Whole-install backup/restore (records + DB memory in one .zip)
            .AddSingleton<Platform.Storage.Backup.Services.IBackupService, Platform.Storage.Backup.Services.BackupService>()
            // Eval / LLM-ops: per-conversation ranking + observability (tuning dataset)
            .AddSingleton<Platform.Ops.Eval.Services.IFeedbackStore, Platform.Ops.Eval.Services.FeedbackStore>()
            // Cortex tuning: runtime prompt-template + model-routing overrides (write side of LLM-ops)
            .AddSingleton<Platform.Ops.Cortex.Services.ICortexConfigService, Platform.Ops.Cortex.Services.CortexConfigService>()
            // Automated scorers (Mastra-style): grade each committed conversation on 智库-rule dimensions
            .AddSingleton<Platform.Ops.Scoring.Services.IScoringService, Platform.Ops.Scoring.Services.ScoringService>()
            // Run traces (Mastra observability): structure the conversation event stream into a run timeline
            .AddSingleton<Platform.Ops.Trace.Services.ITraceService, Platform.Ops.Trace.Services.TraceService>()
            // Prompt/agent playground (Mastra runEvals): score dry plans over a scenario set (CLI)
            .AddSingleton<Platform.Ops.Playground.Services.IPlaygroundService, Platform.Ops.Playground.Services.PlaygroundService>()
            // Remote-access gate: loopback trusted, remote needs the shared token
            .AddSingleton<Platform.Hosting.Security.Services.ISecurityGuard, Platform.Hosting.Security.Services.SecurityGuard>()
            .AddSingleton<Platform.Hosting.Security.Services.ILoginThrottle, Platform.Hosting.Security.Services.LoginThrottle>()
            // Self-update: check GitHub releases + download/stage (launcher applies on restart)
            .AddSingleton<Platform.Hosting.Update.Services.IUpdateService, Platform.Hosting.Update.Services.UpdateService>()
            // Background jobs: generic scheduled/one-off work (agent tasks, tool calls, notifications,
            // reports) + a browser/in-app notification feed. See docs/background-jobs-design.md.
            .AddSingleton<Platform.Ops.Jobs.Services.IJobRepository, Platform.Ops.Jobs.Services.JobRepository>()
            .AddSingleton<Platform.Ops.Jobs.Services.INotificationService, Platform.Ops.Jobs.Services.NotificationService>()
            .AddSingleton<Platform.Ops.Jobs.Services.IUnattendedRunService, Platform.Ops.Jobs.Services.UnattendedRunService>()
            // Job kinds = IJobHandler DI collection (add a kind = add a handler, never an if/else)
            .AddSingleton<Platform.Ops.Jobs.Services.IJobHandler, Platform.Ops.Jobs.Services.ToolJobHandler>()
            .AddSingleton<Platform.Ops.Jobs.Services.IJobHandler, Platform.Ops.Jobs.Services.NotifyJobHandler>()
            .AddSingleton<Platform.Ops.Jobs.Services.IJobHandler, Platform.Ops.Jobs.Services.ReportJobHandler>()
            .AddSingleton<Platform.Ops.Jobs.Services.IJobHandler, Platform.Ops.Jobs.Services.AgentJobHandler>()
            // Orchestration (CRUD + execution engine + staged approve/reject) shared by the scheduler + run-now
            .AddSingleton<Platform.Ops.Jobs.Services.IJobService, Platform.Ops.Jobs.Services.JobService>()
            // The scheduler loop (polls due jobs, dispatches, catch-up, guardrails)
            .AddHostedService<Platform.Ops.Jobs.Services.JobSchedulerService>()
            // AI-facing job management tools (both surfaces)
            .AddSingleton<IGatherlightTool, Platform.Ops.Jobs.Tools.JobScheduleTool>()
            .AddSingleton<IGatherlightTool, Platform.Ops.Jobs.Tools.JobListTool>()
            .AddSingleton<IGatherlightTool, Platform.Ops.Jobs.Tools.JobCancelTool>()
            .AddSingleton<IGatherlightTool, Platform.Ops.Jobs.Tools.JobRunNowTool>()
            .AddSingleton<IGatherlightTool, Platform.Ops.Jobs.Tools.NotifyUserTool>()
            // Hot-loadable script tools ({data}/tools/<name>/tool.json — no rebuild needed)
            .AddSingleton<ScriptToolProvider>()
            .AddSingleton<IScriptToolProvider>(sp => sp.GetRequiredService<ScriptToolProvider>())
            .AddHostedService(sp => sp.GetRequiredService<ScriptToolProvider>())
            // External MCP servers (Gatherlight-as-MCP-client): connect out to stdio/http MCP servers,
            // proxy their tools into the registry (namespaced {serverId}__{tool}). Config +secrets in
            // the mcp_server table; add is access-gated / chat-gated, never agent-reachable.
            // See docs/mcp-client-design.md.
            .AddSingleton<Platform.Capabilities.McpClient.Services.IMcpServerStore, Platform.Capabilities.McpClient.Services.McpServerStore>()
            .AddSingleton<Platform.Capabilities.McpClient.Services.McpConnectionManager>()
            .AddSingleton<Platform.Capabilities.McpClient.Services.IMcpConnectionManager>(sp => sp.GetRequiredService<Platform.Capabilities.McpClient.Services.McpConnectionManager>())
            .AddHostedService(sp => sp.GetRequiredService<Platform.Capabilities.McpClient.Services.McpConnectionManager>())
            .AddSingleton<Platform.Capabilities.McpClient.Services.IExternalToolProvider, Platform.Capabilities.McpClient.Services.McpProxyToolProvider>()
            .AddSingleton<Platform.Capabilities.McpClient.Services.IMcpProvisionService, Platform.Capabilities.McpClient.Services.McpProvisionService>()
            .AddSingleton<Platform.Capabilities.McpClient.Services.IMcpLoginService, Platform.Capabilities.McpClient.Services.McpLoginService>()
            .AddSingleton<IToolRegistry, ToolRegistry>()
            // Knowledge-base seeder (template → data folder, hash-guarded upgrades)
            .AddSingleton<IZhikuSeeder, ZhikuSeeder>()
            // Knowledge-base upgrade migration (LLM-reconcile customized .claude/ files with new templates)
            .AddSingleton<Platform.Site.Seed.Services.IZhikuMigrator, Platform.Site.Seed.Services.ZhikuMigrator>()
            // Startup migration runner: the versioned, ordered, idempotent upgrade phase (was inline,
            // pre-listen). IMigrationStep is a DI collection — registration order = run order.
            .AddSingleton<Platform.Hosting.Migration.Services.MigrationState>()
            .AddSingleton<Platform.Hosting.Migration.Services.StartupMigrationRunner>()
            .AddSingleton<Platform.Hosting.Migration.Services.IMigrationStep, Platform.Hosting.Migration.Steps.SiteManifestStep>()
            .AddSingleton<Platform.Hosting.Migration.Services.IMigrationStep, Platform.Hosting.Migration.Steps.DbMigrateStep>()
            .AddSingleton<Platform.Hosting.Migration.Services.IMigrationStep, Platform.Hosting.Migration.Steps.SelfHealLocksStep>()
            .AddSingleton<Platform.Hosting.Migration.Services.IMigrationStep, Platform.Hosting.Migration.Steps.DataRepoInitStep>()
            .AddSingleton<Platform.Hosting.Migration.Services.IMigrationStep, Platform.Hosting.Migration.Steps.KnowledgeBaseStep>()
            .AddSingleton<Platform.Hosting.Migration.Services.IMigrationStep, Platform.Hosting.Migration.Steps.RecordIndexStep>()
            .AddSingleton<Platform.Hosting.Migration.Services.IMigrationStep, Platform.Hosting.Migration.Steps.SelfHealStateStep>()
            .AddSingleton<Platform.Hosting.Migration.Services.IMigrationStep, Platform.Hosting.Migration.Steps.MemorySeedStep>()
            // After the DB is migrated: connect the enabled external MCP servers (best-effort).
            .AddSingleton<Platform.Hosting.Migration.Services.IMigrationStep, Platform.Hosting.Migration.Steps.McpConnectStep>();

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
            Platform.Kernel.Services.AppVersion.Semver,
            logLevel, options.DataPath, options.BindAddress, options.Port, logsDir);

        // Loud, once-at-startup warning when the LAN opt-in is exposing the app unauthenticated.
        if (openBind && options.AllowLanWithoutToken)
            app.Logger.LogWarning(
                "Gatherlight is bound to {Bind}:{Port} WITHOUT an access token (allowLanWithoutToken). " +
                "Anyone who can reach that address has full, unauthenticated access to your data and the " +
                "claude CLI — only use this on a trusted private network.", options.BindAddress, options.Port);

        // Run the versioned startup migration in the background once we're listening, so /manage can
        // render the progress overlay instead of the app appearing to hang. The gate keeps /api closed
        // until it lifts. MigrationState defaults to migrating=true, so requests before this fires are
        // already gated. (DB migrate, data-repo init, KB seed/notify, record-index rebuild, memory seed,
        // chat scope-guard, and interrupted-work reconcile now all live as ordered IMigrationSteps.)
        var life = app.Services.GetRequiredService<IHostApplicationLifetime>();
        life.ApplicationStarted.Register(() =>
        {
            var runner = app.Services.GetRequiredService<Platform.Hosting.Migration.Services.StartupMigrationRunner>();
            var state = app.Services.GetRequiredService<Platform.Hosting.Migration.Services.MigrationState>();
            _ = Task.Run(async () =>
            {
                try { await runner.RunAsync(life.ApplicationStopping); }
                catch (Exception ex) { app.Logger.LogError(ex, "Startup migration crashed"); state.Fail(ex.Message); }
            });
        });

        // Block /api + /mcp (except health + /api/migration) while the startup migration runs.
        app.UseMiddleware<Platform.Hosting.Migration.MigrationGateMiddleware>();
        // Defense-in-depth response headers (CSP + framing/sniffing) on everything.
        app.UseMiddleware<Platform.Hosting.Security.SecurityHeadersMiddleware>();
        // Gate /api + /mcp before the endpoints run (no-op unless an access token is configured).
        app.UseMiddleware<Platform.Hosting.Security.AccessGateMiddleware>();

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
