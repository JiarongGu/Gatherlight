# Startup Migration Runner + Progress UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the silent, pre-listen inline startup work with a versioned, ordered, idempotent migration runner that self-heals broken state and shows live per-step progress in `/manage`.

**Architecture:** A new `Modules/Migration` module: `MigrationState` (singleton) + `IMigrationStep` collection (DI-ordered) + `StartupMigrationRunner`, kicked off on `ApplicationStarted` so Kestrel listens immediately. A `MigrationGateMiddleware` 503s `/api`+`/mcp` (except `/api/health` + `/api/migration/*`) while it runs; `/api/health` gains a `migrating` bool. A React `MigrationOverlay` polls `/api/migration/status` and renders progress in the Host window + browser.

**Tech Stack:** ASP.NET Core (net10), DI-collection pattern (like `IScorer`), React + antd, e2e via `devtools/scripts/e2e/pN.mjs` against the claude stub.

**Testing note:** this repo has no C# unit-test project — the test mechanism is the integration e2e suites. So each task ends with a compile/build verify, and acceptance is the new `p29` suite plus the full 28-suite sweep (kept green by the `waitHealthy` change in Task 6). Follow the existing pattern; do not add a unit-test framework.

---

## File structure

**New (server) — `Modules/Migration/`:**
- `Models/MigrationModels.cs` — phase/step status consts + `MigrationStepState` (mutable) + `MigrationSnapshot`/`MigrationStepView` (DTO).
- `Services/IMigrationStep.cs` — step contract.
- `Services/MigrationState.cs` — thread-safe singleton (phase, steps, warnings, `IsMigrating` hot path).
- `Services/StartupMigrationRunner.cs` — orchestration + version gate + essential/best-effort policy + test seams.
- `Steps/DbMigrateStep.cs`, `SelfHealLocksStep.cs`, `DataRepoInitStep.cs`, `KnowledgeBaseStep.cs`, `PlanIndexStep.cs`, `SelfHealStateStep.cs`, `MemorySeedStep.cs` — the ordered steps (thin wrappers over existing services).
- `MigrationGateMiddleware.cs` — 503 gate.
- `MigrationController.cs` — `GET status` + `POST retry`.

**Modified (server):**
- `GatherlightApp.cs` — register migration services/steps + gate middleware + `ApplicationStarted` kickoff; **remove** the inline startup block (DB migrate, repo init, seeder, migrator-notify, index rescan, memory seed, `chatEnv.EnsureFiles`, `FailInterrupted*`).
- `Modules/Core/HealthController.cs` — add `migrating`.

**Modified (client):**
- `src/client/src/lib/apiClient.ts` — add a `get` helper.
- `src/client/src/lib/migrationApi.ts` — **new**.
- `src/client/src/ui/organisms/MigrationOverlay.tsx` — **new**.
- `src/client/src/screens/Manage.tsx` — mount `<MigrationOverlay />`.

**Modified (devtools):**
- `devtools/scripts/e2e/_e2e-common.mjs` — `waitHealthy` waits for `migrating:false`.
- `devtools/scripts/e2e/p29.mjs` — **new** acceptance suite.

---

## Task 1: Migration models, step contract, state

**Files:**
- Create: `src/server/Gatherlight.Server/Modules/Migration/Models/MigrationModels.cs`
- Create: `src/server/Gatherlight.Server/Modules/Migration/Services/IMigrationStep.cs`
- Create: `src/server/Gatherlight.Server/Modules/Migration/Services/MigrationState.cs`

- [ ] **Step 1: Create the models**

```csharp
// MigrationModels.cs
namespace Gatherlight.Server.Modules.Migration.Models;

public static class MigrationPhase
{
    public const string Running = "running";
    public const string Completed = "completed";
    public const string Failed = "failed";
}

public static class StepStatus
{
    public const string Pending = "pending";
    public const string Running = "running";
    public const string Ok = "ok";
    public const string Failed = "failed";
    public const string Skipped = "skipped";
}

/// <summary>Live, mutable status of one step (the runner updates it as it progresses).</summary>
public sealed class MigrationStepState
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public required bool Essential { get; init; }
    public string Status { get; set; } = StepStatus.Pending;
    public string? Error { get; set; }
    public long Ms { get; set; }
}

/// <summary>Immutable snapshot returned by GET /api/migration/status (serialized camelCase).</summary>
public sealed record MigrationSnapshot(
    string Phase, bool IsUpgrade, string FromVersion, string ToVersion,
    IReadOnlyList<MigrationStepView> Steps, IReadOnlyList<string> Warnings, string? Error);

public sealed record MigrationStepView(string Id, string Title, bool Essential, string Status, string? Error, long Ms);
```

- [ ] **Step 2: Create the step contract**

```csharp
// IMigrationStep.cs
namespace Gatherlight.Server.Modules.Migration.Services;

/// <summary>One ordered, idempotent startup-migration step. Registered as a DI collection
/// (AddSingleton&lt;IMigrationStep,…&gt;) in registration order = run order. An Essential step that
/// throws keeps the gate closed (never serve half-migrated); a best-effort step that throws is
/// recorded and skipped past.</summary>
public interface IMigrationStep
{
    string Id { get; }
    string Title { get; }        // shown in the /manage overlay — Simplified Chinese
    bool Essential { get; }
    Task RunAsync(CancellationToken ct);
}
```

- [ ] **Step 3: Create the state singleton**

```csharp
// MigrationState.cs
using Gatherlight.Server.Modules.Migration.Models;

namespace Gatherlight.Server.Modules.Migration.Services;

/// <summary>Thread-safe holder for the startup-migration phase + per-step status. Singleton: the gate
/// middleware reads <see cref="IsMigrating"/> on every request (volatile bool, no lock), the controller
/// reads snapshots, the runner mutates it. Defaults to migrating=true so the gate is closed from the very
/// first request until the runner lifts it.</summary>
public sealed class MigrationState
{
    private readonly object _lock = new();
    private readonly List<MigrationStepState> _steps = new();
    private readonly List<string> _warnings = new();
    private volatile bool _migrating = true;
    private string _phase = MigrationPhase.Running;
    private string? _error;

    public bool IsUpgrade { get; set; }
    public string FromVersion { get; set; } = "";
    public string ToVersion { get; set; } = "";

    /// <summary>Gate hot path: block /api while the essential phase hasn't cleared.</summary>
    public bool IsMigrating => _migrating;

    public void Init(IEnumerable<IMigrationStep> steps)
    {
        lock (_lock)
        {
            _steps.Clear();
            foreach (var s in steps)
                _steps.Add(new MigrationStepState { Id = s.Id, Title = s.Title, Essential = s.Essential });
        }
    }

    public void SetStep(string id, string status, string? error = null, long ms = 0)
    {
        lock (_lock)
        {
            var st = _steps.Find(s => s.Id == id);
            if (st is null) return;
            st.Status = status;
            if (error is not null) st.Error = error;
            if (ms > 0) st.Ms = ms;
        }
    }

    public void AddWarning(string message)
    {
        lock (_lock) _warnings.Add(message);
    }

    /// <summary>All essential steps passed → serve normally.</summary>
    public void CompleteOk()
    {
        lock (_lock) _phase = MigrationPhase.Completed;
        _migrating = false;
    }

    /// <summary>An essential step failed → phase failed, gate stays CLOSED (migrating stays true).</summary>
    public void Fail(string error)
    {
        lock (_lock) { _phase = MigrationPhase.Failed; _error = error; }
    }

    /// <summary>Retry: back to a fresh running phase.</summary>
    public void Reset()
    {
        lock (_lock)
        {
            foreach (var s in _steps) { s.Status = StepStatus.Pending; s.Error = null; s.Ms = 0; }
            _warnings.Clear();
            _phase = MigrationPhase.Running;
            _error = null;
        }
        _migrating = true;
    }

    public MigrationSnapshot Snapshot()
    {
        lock (_lock)
        {
            var views = _steps.ConvertAll(s => new MigrationStepView(s.Id, s.Title, s.Essential, s.Status, s.Error, s.Ms));
            return new MigrationSnapshot(_phase, IsUpgrade, FromVersion, ToVersion, views, _warnings.ToArray(), _error);
        }
    }
}
```

- [ ] **Step 4: Build**

Run: `dotnet build src/server/Gatherlight.Server -v q -clp:ErrorsOnly`
Expected: `Build succeeded. 0 Error(s)`

- [ ] **Step 5: Commit**

```bash
git add src/server/Gatherlight.Server/Modules/Migration/
git commit -m "feat(migration): migration state + step contract scaffolding"
```

---

## Task 2: The migration steps

**Files:**
- Create: `src/server/Gatherlight.Server/Modules/Migration/Steps/DbMigrateStep.cs`
- Create: `src/server/Gatherlight.Server/Modules/Migration/Steps/SelfHealLocksStep.cs`
- Create: `src/server/Gatherlight.Server/Modules/Migration/Steps/DataRepoInitStep.cs`
- Create: `src/server/Gatherlight.Server/Modules/Migration/Steps/KnowledgeBaseStep.cs`
- Create: `src/server/Gatherlight.Server/Modules/Migration/Steps/PlanIndexStep.cs`
- Create: `src/server/Gatherlight.Server/Modules/Migration/Steps/SelfHealStateStep.cs`
- Create: `src/server/Gatherlight.Server/Modules/Migration/Steps/MemorySeedStep.cs`

Ordered: `db-migrate → self-heal-locks → data-repo → knowledge-base → plan-index → self-heal-state → memory-seed`. Each file has `namespace Gatherlight.Server.Modules.Migration.Steps;` and the usings shown.

- [ ] **Step 1: DbMigrateStep (essential)**

```csharp
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
```

- [ ] **Step 2: SelfHealLocksStep (best-effort) — remove a stale git lock BEFORE any repo op**

```csharp
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Migration.Services;

namespace Gatherlight.Server.Modules.Migration.Steps;

public sealed class SelfHealLocksStep : IMigrationStep
{
    private readonly IDataContext _data;
    private readonly MigrationState _state;
    private readonly ILogger<SelfHealLocksStep> _log;
    public SelfHealLocksStep(IDataContext data, MigrationState state, ILogger<SelfHealLocksStep> log)
    { _data = data; _state = state; _log = log; }

    public string Id => "self-heal-locks";
    public string Title => "清理残留锁文件";
    public bool Essential => false;

    public Task RunAsync(CancellationToken ct)
    {
        // A crashed git leaves .git/index.lock, which blocks every later git op. Remove it (the process
        // that held it is long gone by the time the server is booting). Runs BEFORE data-repo init.
        var lockPath = Path.Combine(_data.RootPath, ".git", "index.lock");
        if (File.Exists(lockPath))
        {
            try
            {
                File.Delete(lockPath);
                _log.LogWarning("self-heal: removed stale .git/index.lock");
                _state.AddWarning("已清理残留的 .git/index.lock(上次异常退出遗留)。");
            }
            catch (Exception ex) { _log.LogWarning(ex, "self-heal: could not remove .git/index.lock"); }
        }
        return Task.CompletedTask;
    }
}
```

- [ ] **Step 3: DataRepoInitStep (essential)**

```csharp
using Gatherlight.Server.Modules.DataRepo.Services;
using Gatherlight.Server.Modules.Migration.Services;

namespace Gatherlight.Server.Modules.Migration.Steps;

public sealed class DataRepoInitStep : IMigrationStep
{
    private readonly IGitCliService _git;
    private readonly IDataCommitRepository _commits;
    public DataRepoInitStep(IGitCliService git, IDataCommitRepository commits) { _git = git; _commits = commits; }
    public string Id => "data-repo";
    public string Title => "初始化数据仓库";
    public bool Essential => true;
    public async Task RunAsync(CancellationToken ct)
    {
        if (await _git.EnsureRepoAsync(ct))
        {
            var sha = await _git.CommitAllAsync("data: initial import", ct);
            if (sha is not null) _commits.Record(sha, "data: initial import", "import");
        }
    }
}
```

- [ ] **Step 4: KnowledgeBaseStep (essential; the notify sub-step is best-effort inline)**

```csharp
using Gatherlight.Server.Modules.Chat.Services;
using Gatherlight.Server.Modules.DataRepo.Services;
using Gatherlight.Server.Modules.Migration.Services;
using Gatherlight.Server.Modules.Seed.Services;

namespace Gatherlight.Server.Modules.Migration.Steps;

public sealed class KnowledgeBaseStep : IMigrationStep
{
    private readonly IZhikuSeeder _seeder;
    private readonly ChatEnvironmentService _chatEnv;
    private readonly IZhikuMigrator _migrator;
    private readonly IGitCliService _git;
    private readonly IDataCommitRepository _commits;
    private readonly ILogger<KnowledgeBaseStep> _log;
    public KnowledgeBaseStep(IZhikuSeeder seeder, ChatEnvironmentService chatEnv, IZhikuMigrator migrator,
        IGitCliService git, IDataCommitRepository commits, ILogger<KnowledgeBaseStep> log)
    { _seeder = seeder; _chatEnv = chatEnv; _migrator = migrator; _git = git; _commits = commits; _log = log; }

    public string Id => "knowledge-base";
    public string Title => "知识库与安全护栏";
    public bool Essential => true;
    public async Task RunAsync(CancellationToken ct)
    {
        await _seeder.SeedAsync();
        // Guard re-issue (a security boundary) + commit a newly-seeded hook so the agent's diffs stay clean.
        if (_chatEnv.EnsureFiles() is { } seededHook)
        {
            var sha = await _git.CommitPathsAsync(new[] { seededHook }, "seed: chat scope-guard hook", ct);
            _commits.Record(sha, "seed: chat scope-guard hook", "seed");
        }
        // Best-effort: notify (no token spend) that customized .claude files have shipped improvements.
        try { await _migrator.NotifyIfUpgradesAsync(); }
        catch (Exception ex) { _log.LogWarning(ex, "KB upgrade-notify failed (non-fatal)"); }
    }
}
```

- [ ] **Step 5: PlanIndexStep (best-effort)**

```csharp
using Gatherlight.Server.Modules.Migration.Services;
using Gatherlight.Server.Modules.PlanIndex.Services;

namespace Gatherlight.Server.Modules.Migration.Steps;

public sealed class PlanIndexStep : IMigrationStep
{
    private readonly IPlanIndexService _index;
    public PlanIndexStep(IPlanIndexService index) => _index = index;
    public string Id => "plan-index";
    public string Title => "重建计划索引";
    public bool Essential => false;
    public Task RunAsync(CancellationToken ct) => _index.RescanAsync();
}
```

- [ ] **Step 6: SelfHealStateStep (best-effort) — reconcile interrupted work + surface a dirty tree**

```csharp
using Gatherlight.Server.Modules.Chat.Services;
using Gatherlight.Server.Modules.DataRepo.Services;
using Gatherlight.Server.Modules.Jobs.Services;
using Gatherlight.Server.Modules.Migration.Services;

namespace Gatherlight.Server.Modules.Migration.Steps;

public sealed class SelfHealStateStep : IMigrationStep
{
    private readonly IChatRepository _chat;
    private readonly IJobRepository _jobs;
    private readonly IGitCliService _git;
    private readonly MigrationState _state;
    private readonly ILogger<SelfHealStateStep> _log;
    public SelfHealStateStep(IChatRepository chat, IJobRepository jobs, IGitCliService git,
        MigrationState state, ILogger<SelfHealStateStep> log)
    { _chat = chat; _jobs = jobs; _git = git; _state = state; _log = log; }

    public string Id => "self-heal-state";
    public string Title => "检查中断的任务与改动";
    public bool Essential => false;
    public async Task RunAsync(CancellationToken ct)
    {
        // Sessions/job runs left non-terminal by a previous death → error/failed (inspectable, not resumed).
        await _chat.FailInterruptedSessionsAsync();
        var reconciled = await _jobs.FailInterruptedRunsAsync();
        if (reconciled > 0) _log.LogInformation("self-heal: reconciled {N} interrupted job run(s) → failed", reconciled);

        // Surface — never auto-mutate — an unexpected dirty data-repo tree (e.g. an aborted commit's
        // leftovers). state/ uploads/ cache/ are gitignored, so only real planner/KB changes show.
        var status = await _git.RunAsync(new[] { "status", "--porcelain" }, ct);
        var dirty = status.Stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (dirty.Length > 0)
        {
            _log.LogWarning("self-heal: data repo has {N} uncommitted change(s) from an interrupted task: {Files}",
                dirty.Length, string.Join(", ", dirty[..Math.Min(dirty.Length, 10)]));
            _state.AddWarning($"数据仓库有 {dirty.Length} 处未提交改动(可能来自中断的任务)— 请在管理台检查处理。");
        }
    }
}
```

- [ ] **Step 7: MemorySeedStep (best-effort)**

```csharp
using System.Text.Json;
using Gatherlight.Server.Modules.Memory.Services;
using Gatherlight.Server.Modules.Migration.Services;

namespace Gatherlight.Server.Modules.Migration.Steps;

public sealed class MemorySeedStep : IMigrationStep
{
    private readonly IMemoryService _memory;
    private readonly ILogger<MemorySeedStep> _log;
    public MemorySeedStep(IMemoryService memory, ILogger<MemorySeedStep> log) { _memory = memory; _log = log; }
    public string Id => "memory-seed";
    public string Title => "导入初始记忆(可选)";
    public bool Essential => false;
    public async Task RunAsync(CancellationToken ct)
    {
        var seedPath = Environment.GetEnvironmentVariable("GATHERLIGHT_SEED_MEMORY");
        if (string.IsNullOrEmpty(seedPath) || !File.Exists(seedPath)) return;
        var bundle = JsonSerializer.Deserialize<MemoryBundle>(
            await File.ReadAllTextAsync(seedPath, ct), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        if (bundle is { GatherlightMemory: >= 1 })
        {
            var r = await _memory.ImportAsync(bundle);
            _log.LogInformation("Seeded memory from {Path}: {Lib} library, {Kn} knowledge, {Ent} entities, {Cx} cortex",
                seedPath, r.Library, r.Knowledge, r.Entities, r.Cortex);
        }
    }
}
```

- [ ] **Step 8: Build**

Run: `dotnet build src/server/Gatherlight.Server -v q -clp:ErrorsOnly`
Expected: `Build succeeded. 0 Error(s)`. If a `using`/type name mismatches (e.g. `IJobRepository` namespace), open the referenced service and correct the namespace — do not stub.

- [ ] **Step 9: Commit**

```bash
git add src/server/Gatherlight.Server/Modules/Migration/Steps/
git commit -m "feat(migration): ordered upgrade + self-heal steps"
```

---

## Task 3: The runner

**Files:**
- Create: `src/server/Gatherlight.Server/Modules/Migration/Services/StartupMigrationRunner.cs`

- [ ] **Step 1: Write the runner**

```csharp
using System.Diagnostics;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Migration.Models;

namespace Gatherlight.Server.Modules.Migration.Services;

/// <summary>Runs the ordered <see cref="IMigrationStep"/> collection once at startup. Compares the app
/// version against the persisted last-ran version (drives the "upgrade" wording), runs each step, and
/// resolves the phase: an Essential step failing keeps the gate CLOSED (phase failed, retryable); a
/// best-effort step failing is logged and skipped past (degraded but serving). Writes lastRanVersion
/// only on a clean essential run.</summary>
public sealed class StartupMigrationRunner
{
    private const string LastRanVersionKey = "app.lastRanVersion";

    private readonly IReadOnlyList<IMigrationStep> _steps;
    private readonly MigrationState _state;
    private readonly IAppConfigService _config;
    private readonly ILogger<StartupMigrationRunner> _log;

    public StartupMigrationRunner(IEnumerable<IMigrationStep> steps, MigrationState state,
        IAppConfigService config, ILogger<StartupMigrationRunner> log)
    {
        _steps = steps.ToList();
        _state = state;
        _config = config;
        _log = log;
    }

    public async Task RunAsync(CancellationToken ct = default)
    {
        var current = AppVersion.Semver;
        var last = _config.Get(LastRanVersionKey);
        _state.FromVersion = last ?? "";
        _state.ToVersion = current;
        _state.IsUpgrade = last is not null && last != current;
        _state.Init(_steps);

        // Test seam: hold the running/gated window open so e2e can observe the 503 + status.
        if (int.TryParse(Environment.GetEnvironmentVariable("GATHERLIGHT_MIGRATION_TEST_DELAY"), out var delay) && delay > 0)
            await Task.Delay(delay, ct);
        // Test seam: force a named step to throw (exercise the essential-fail / retry path).
        var failStep = Environment.GetEnvironmentVariable("GATHERLIGHT_MIGRATION_TEST_FAIL");

        _log.LogInformation("Startup migration: {From} → {To} (upgrade={Up}, {N} steps)",
            last ?? "(none)", current, _state.IsUpgrade, _steps.Count);

        foreach (var step in _steps)
        {
            if (ct.IsCancellationRequested) return;
            _state.SetStep(step.Id, StepStatus.Running);
            var sw = Stopwatch.StartNew();
            try
            {
                if (failStep == step.Id) throw new InvalidOperationException($"forced test failure at {step.Id}");
                await step.RunAsync(ct);
                sw.Stop();
                _state.SetStep(step.Id, StepStatus.Ok, ms: sw.ElapsedMilliseconds);
                _log.LogInformation("  ✓ {Id} ({Ms}ms)", step.Id, sw.ElapsedMilliseconds);
            }
            catch (Exception ex)
            {
                sw.Stop();
                _state.SetStep(step.Id, StepStatus.Failed, ex.Message, sw.ElapsedMilliseconds);
                if (step.Essential)
                {
                    _log.LogError(ex, "  ✗ ESSENTIAL step {Id} failed — app stays gated", step.Id);
                    _state.Fail($"{step.Title}: {ex.Message}");
                    return; // gate stays closed; overlay offers retry
                }
                _log.LogWarning(ex, "  ✗ best-effort step {Id} failed — continuing (degraded)", step.Id);
            }
        }

        _config.Set(LastRanVersionKey, current);
        _state.CompleteOk();
        _log.LogInformation("Startup migration complete → serving.");
    }
}
```

- [ ] **Step 2: Build**

Run: `dotnet build src/server/Gatherlight.Server -v q -clp:ErrorsOnly`
Expected: `Build succeeded. 0 Error(s)`

- [ ] **Step 3: Commit**

```bash
git add src/server/Gatherlight.Server/Modules/Migration/Services/StartupMigrationRunner.cs
git commit -m "feat(migration): versioned startup runner with essential/best-effort policy"
```

---

## Task 4: Gate middleware, status controller, health field

**Files:**
- Create: `src/server/Gatherlight.Server/Modules/Migration/MigrationGateMiddleware.cs`
- Create: `src/server/Gatherlight.Server/Modules/Migration/MigrationController.cs`
- Modify: `src/server/Gatherlight.Server/Modules/Core/HealthController.cs`

- [ ] **Step 1: Gate middleware**

```csharp
using Gatherlight.Server.Modules.Migration.Services;

namespace Gatherlight.Server.Modules.Migration;

/// <summary>While migration runs, return 503 {migrating:true} for /api + /mcp — EXCEPT /api/health (so
/// the Host keeps its heartbeat) and /api/migration/* (so /manage can render + drive the overlay). Static
/// /manage + /assets are not /api and pass straight through. Once migration lifts, this is a bool no-op.</summary>
public sealed class MigrationGateMiddleware
{
    private readonly RequestDelegate _next;
    private readonly MigrationState _state;
    public MigrationGateMiddleware(RequestDelegate next, MigrationState state) { _next = next; _state = state; }

    public async Task Invoke(HttpContext ctx)
    {
        if (_state.IsMigrating)
        {
            var path = ctx.Request.Path;
            var isApi = path.StartsWithSegments("/api") || path.StartsWithSegments("/mcp");
            var allowed = path.StartsWithSegments("/api/health") || path.StartsWithSegments("/api/migration");
            if (isApi && !allowed)
            {
                ctx.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
                await ctx.Response.WriteAsJsonAsync(new { migrating = true, error = "正在完成升级 / 启动,请稍候…" });
                return;
            }
        }
        await _next(ctx);
    }
}
```

- [ ] **Step 2: Status + retry controller**

```csharp
using Gatherlight.Server.Modules.Migration.Models;
using Gatherlight.Server.Modules.Migration.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Migration;

[ApiController]
[Route("api/migration")]
public sealed class MigrationController : ControllerBase
{
    private readonly MigrationState _state;
    private readonly StartupMigrationRunner _runner;
    private readonly IHostApplicationLifetime _life;
    public MigrationController(MigrationState state, StartupMigrationRunner runner, IHostApplicationLifetime life)
    { _state = state; _runner = runner; _life = life; }

    [HttpGet("status")]
    public IActionResult Status() => Ok(_state.Snapshot());

    [HttpPost("retry")]
    public IActionResult Retry()
    {
        if (_state.Snapshot().Phase != MigrationPhase.Failed)
            return Conflict(new { error = "没有失败的迁移可重试。" });
        _state.Reset();
        _ = Task.Run(() => _runner.RunAsync(_life.ApplicationStopping));
        return Ok(new { ok = true });
    }
}
```

- [ ] **Step 3: Add `migrating` to health**

Modify `HealthController.cs` — inject `MigrationState` and add the field:

```csharp
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
```

- [ ] **Step 4: Build**

Run: `dotnet build src/server/Gatherlight.Server -v q -clp:ErrorsOnly`
Expected: `Build succeeded. 0 Error(s)` (will fail until `MigrationState` is registered — that's Task 5; a compile of these files alone still succeeds since DI is runtime).

- [ ] **Step 5: Commit**

```bash
git add src/server/Gatherlight.Server/Modules/Migration/MigrationGateMiddleware.cs src/server/Gatherlight.Server/Modules/Migration/MigrationController.cs src/server/Gatherlight.Server/Modules/Core/HealthController.cs
git commit -m "feat(migration): 503 gate + status/retry endpoints + health migrating flag"
```

---

## Task 5: Wire into GatherlightApp (register + kickoff + remove inline block)

**Files:**
- Modify: `src/server/Gatherlight.Server/GatherlightApp.cs`

- [ ] **Step 1: Register migration services + steps (in the ConfigureServices/AddSingleton chain)**

Add near the other `AddSingleton` registrations (e.g. next to the seeder registrations around the `IZhikuSeeder`/`IZhikuMigrator` lines). Order of the `IMigrationStep` registrations IS the run order:

```csharp
            .AddSingleton<Modules.Migration.Services.MigrationState>()
            .AddSingleton<Modules.Migration.Services.StartupMigrationRunner>()
            .AddSingleton<Modules.Migration.Services.IMigrationStep, Modules.Migration.Steps.DbMigrateStep>()
            .AddSingleton<Modules.Migration.Services.IMigrationStep, Modules.Migration.Steps.SelfHealLocksStep>()
            .AddSingleton<Modules.Migration.Services.IMigrationStep, Modules.Migration.Steps.DataRepoInitStep>()
            .AddSingleton<Modules.Migration.Services.IMigrationStep, Modules.Migration.Steps.KnowledgeBaseStep>()
            .AddSingleton<Modules.Migration.Services.IMigrationStep, Modules.Migration.Steps.PlanIndexStep>()
            .AddSingleton<Modules.Migration.Services.IMigrationStep, Modules.Migration.Steps.SelfHealStateStep>()
            .AddSingleton<Modules.Migration.Services.IMigrationStep, Modules.Migration.Steps.MemorySeedStep>()
```

- [ ] **Step 2: Remove the inline startup block**

Delete the whole inline sequence in `Build()` — the DB migrate, data-repo init/import, KB seed, migrator notify, plan-index rescan, memory-seed block, `chatEnv.EnsureFiles()` commit, and the two `FailInterrupted*` calls (currently ~lines 262–323, from the `// Migrations before anything touches the DB.` comment through the reconcile-interrupted-runs log line). These are now steps. Keep the startup banner + the LAN warning above them.

- [ ] **Step 3: Register the gate middleware + the ApplicationStarted kickoff**

Add the gate middleware BEFORE `SecurityHeadersMiddleware`/`AccessGateMiddleware`:

```csharp
        // Block /api + /mcp (except health + /api/migration) while the startup migration runs.
        app.UseMiddleware<Modules.Migration.MigrationGateMiddleware>();
```

And, after `builder.Build()` + banner (where the inline block used to be), kick the runner off once the app is listening so Kestrel binds immediately (no more pre-listen hang):

```csharp
        // Run the versioned startup migration in the background once we're listening, so /manage can
        // render the progress overlay instead of the app appearing to hang. The gate keeps /api closed
        // until it lifts. MigrationState defaults to migrating=true, so requests before this fires are
        // already gated.
        var life = app.Services.GetRequiredService<IHostApplicationLifetime>();
        life.ApplicationStarted.Register(() =>
        {
            var runner = app.Services.GetRequiredService<Modules.Migration.Services.StartupMigrationRunner>();
            var state = app.Services.GetRequiredService<Modules.Migration.Services.MigrationState>();
            _ = Task.Run(async () =>
            {
                try { await runner.RunAsync(life.ApplicationStopping); }
                catch (Exception ex) { app.Logger.LogError(ex, "Startup migration crashed"); state.Fail(ex.Message); }
            });
        });
```

- [ ] **Step 4: Build**

Run: `dotnet build src/server/Gatherlight.Server -v q -clp:ErrorsOnly`
Expected: `Build succeeded. 0 Error(s)`. Fix any now-unused `using` warnings only if the build treats warnings as errors (it doesn't here) — otherwise leave.

- [ ] **Step 5: Smoke-run against the dev data folder**

Run: `GATHERLIGHT_DATA="$PWD/local" node devtools/dev.mjs server` (Ctrl-C after it logs `Startup migration complete → serving.`)
Expected: the log shows `Startup migration: … → …` then each `✓ <step>` then `complete → serving`; `GET http://127.0.0.1:5317/api/health` returns `"migrating":false` after completion.

- [ ] **Step 6: Commit**

```bash
git add src/server/Gatherlight.Server/GatherlightApp.cs
git commit -m "feat(migration): run upgrade steps as a gated startup phase (was inline pre-listen)"
```

---

## Task 6: e2e harness compatibility

**Files:**
- Modify: `devtools/scripts/e2e/_e2e-common.mjs`

- [ ] **Step 1: Make `waitHealthy` wait for readiness (migrating:false)**

Replace the existing `waitHealthy` export with:

```js
// Wait until the server is up AND the startup migration has lifted the gate (health.migrating === false).
// Older behavior (just r.ok) implicitly waited because the port wasn't open until migration finished; the
// migration now runs while listening, so readiness must be checked explicitly.
export const waitHealthy = (base, ms = 30000) => until(async () => {
  const r = await fetch(`${base}/api/health`);
  if (!r.ok) return false;
  const j = await r.json().catch(() => ({}));
  return j.migrating === true ? false : true;
}, ms);
```

- [ ] **Step 2: Verify the existing suites still pass**

Run: `node devtools/dev.mjs e2e p2 && node devtools/dev.mjs e2e p1`
Expected: `e2e-p2 PASS` and `e2e-p1 PASS`.

- [ ] **Step 3: Commit**

```bash
git add devtools/scripts/e2e/_e2e-common.mjs
git commit -m "test(e2e): waitHealthy waits for migrating:false (startup-migration compat)"
```

---

## Task 7: Client — API helper, migration API, overlay, mount

**Files:**
- Modify: `src/client/src/lib/apiClient.ts`
- Create: `src/client/src/lib/migrationApi.ts`
- Create: `src/client/src/ui/organisms/MigrationOverlay.tsx`
- Modify: `src/client/src/screens/Manage.tsx`

- [ ] **Step 1: Add a `get` helper to apiClient**

Append to `apiClient.ts`:

```ts
export async function get<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `请求失败 (${res.status})`);
  }
  return data as T;
}
```

- [ ] **Step 2: Create the migration API client**

```ts
// migrationApi.ts
import { get, post } from './apiClient';

export interface MigrationStep {
  id: string;
  title: string;
  essential: boolean;
  status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
  error?: string | null;
  ms: number;
}

export interface MigrationSnapshot {
  phase: 'running' | 'completed' | 'failed';
  isUpgrade: boolean;
  fromVersion: string;
  toVersion: string;
  steps: MigrationStep[];
  warnings: string[];
  error?: string | null;
}

export const getMigrationStatus = () => get<MigrationSnapshot>('/api/migration/status');
export const retryMigration = () => post('/api/migration/retry');
```

- [ ] **Step 3: Create the overlay**

```tsx
// MigrationOverlay.tsx
import { useEffect, useRef, useState } from 'react';
import { Button, Spin, Alert } from '@/ui/atoms';
import { getMigrationStatus, retryMigration, type MigrationSnapshot } from '@/lib/migrationApi';

const STEP_ICON: Record<string, string> = { pending: '○', running: '…', ok: '✓', failed: '✗', skipped: '–' };

/** Full-screen progress layer shown while the server's startup migration runs. Polls the status feed;
 *  on completion (after having been migrating) it reloads so the console loads fresh. Renders nothing
 *  when the server is already serving. */
export function MigrationOverlay() {
  const [snap, setSnap] = useState<MigrationSnapshot | null>(null);
  const [retrying, setRetrying] = useState(false);
  const wasMigrating = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer: number;
    const poll = async () => {
      try {
        const s = await getMigrationStatus();
        if (!alive) return;
        setSnap(s);
        if (s.phase === 'completed') {
          if (wasMigrating.current) window.location.reload();
          return; // stop polling — serving normally
        }
        wasMigrating.current = true;
        timer = window.setTimeout(poll, 500);
      } catch {
        if (alive) timer = window.setTimeout(poll, 800);
      }
    };
    void poll();
    return () => { alive = false; window.clearTimeout(timer); };
  }, []);

  if (!snap || snap.phase === 'completed') return null;

  const failed = snap.phase === 'failed';
  const title = snap.isUpgrade ? `正在升级到 v${snap.toVersion}…` : '正在启动…';

  const onRetry = async () => {
    setRetrying(true);
    try { await retryMigration(); } catch { /* poll will reflect state */ }
    finally { setRetrying(false); wasMigrating.current = true; }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999, background: 'var(--bg)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 18, fontWeight: 600, color: 'var(--text)' }}>
        {!failed && <Spin size="small" />}{title}
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, minWidth: 280, maxWidth: 480 }}>
        {snap.steps.map((s) => (
          <li key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', opacity: s.status === 'pending' ? 0.5 : 1 }}>
            <span style={{ width: 16, textAlign: 'center', color: s.status === 'failed' ? 'var(--danger, #d33)' : 'var(--accent)' }}>
              {s.status === 'running' ? <Spin size="small" /> : STEP_ICON[s.status]}
            </span>
            <span style={{ color: 'var(--text)' }}>{s.title}</span>
            {s.status === 'failed' && s.error && <span style={{ color: 'var(--danger, #d33)', fontSize: 12 }}>— {s.error}</span>}
          </li>
        ))}
      </ul>
      {snap.warnings.map((w, i) => (
        <Alert key={i} type="warning" showIcon message={w} style={{ maxWidth: 480 }} />
      ))}
      {failed && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <Alert type="error" showIcon message={snap.error ?? '升级失败'} style={{ maxWidth: 480 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button type="primary" loading={retrying} onClick={() => void onRetry()}>重试</Button>
            <Button onClick={() => { try { (window as any).chrome?.webview?.postMessage('openLogs'); } catch { /* browser */ } }}>打开日志</Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Mount the overlay in the Manage screen**

In `Manage.tsx`, import and render `<MigrationOverlay />` as the first child of the screen's root element:

```tsx
import { MigrationOverlay } from '@/ui/organisms/MigrationOverlay';
// …inside the returned JSX, as the first child of the outermost wrapper:
//   <MigrationOverlay />
```

(If `MigrationOverlay` isn't re-exported from `@/ui/organisms`, import it by full path `@/ui/organisms/MigrationOverlay`. Add it to `ui/organisms/index.ts` if that barrel exists and other organisms are exported there.)

- [ ] **Step 5: Build the client**

Run: `cd src/client && npm run build`
Expected: `✓ built` with no TypeScript errors. Fix any `--danger` token / import path issues surfaced by tsc.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/lib/apiClient.ts src/client/src/lib/migrationApi.ts src/client/src/ui/organisms/MigrationOverlay.tsx src/client/src/ui/organisms/index.ts src/client/src/screens/Manage.tsx
git commit -m "feat(migration): /manage progress overlay (polls status, retry on failure)"
```

---

## Task 8: Acceptance e2e — p29

**Files:**
- Create: `devtools/scripts/e2e/p29.mjs`

- [ ] **Step 1: Write the suite**

```js
#!/usr/bin/env node
// e2e P29 — startup migration runner: gated serving phase, status feed, self-heal, essential-fail + retry.
import fs from 'node:fs';
import path from 'node:path';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until } from './_e2e-common.mjs';

const dataDir = dataDirFor('p29');
const { ok, fail, done } = makeReporter('p29');
makeTestData(dataDir);
const baseEnv = { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd };
const PORT = 5429;
const base = `http://127.0.0.1:${PORT}`;
const health = async () => { try { const r = await fetch(`${base}/api/health`); return { ok: r.ok, j: await r.json().catch(() => ({})) }; } catch { return { ok: false, j: {} }; } };
const status = async () => { const r = await fetch(`${base}/api/migration/status`); return r.json(); };

try {
  // --- Boot A: fresh, with a delay so the gated window is observable ----------------------
  let srv = startServer({ dataDir, port: PORT, env: { ...baseEnv, GATHERLIGHT_MIGRATION_TEST_DELAY: '1500' } });
  try {
    // health answers early (during migration) with migrating:true
    const up = await until(async () => { const h = await health(); return h.ok ? h : null; }, 20000);
    ok('A: health up during migration', up.ok === true);
    ok('A: health reports migrating:true', up.j.migrating === true, JSON.stringify(up.j));
    // a normal /api is gated 503 while migrating
    const gated = await fetch(`${base}/api/plans`);
    ok('A: normal /api gated 503 while migrating', gated.status === 503);
    // status feed shows the phase + steps
    const st = await status();
    ok('A: status running with steps', st.phase === 'running' && Array.isArray(st.steps) && st.steps.length >= 5, JSON.stringify({ p: st.phase, n: st.steps?.length }));
    // waitHealthy now waits for migrating:false → then normal /api works
    await waitHealthy(base);
    const done1 = await status();
    ok('A: completed with all essential steps ok', done1.phase === 'completed' && done1.steps.every((s) => s.status === 'ok' || (!s.essential)), JSON.stringify(done1.steps?.map((s) => [s.id, s.status])));
    const plans = await fetch(`${base}/api/plans`);
    ok('A: /api serves after migration', plans.ok);
  } finally { srv.stop(); await new Promise((r) => setTimeout(r, 800)); }

  // --- Boot B: restart with a tampered repo (stale lock + a dirty file) → self-heal --------
  fs.writeFileSync(path.join(dataDir, '.git', 'index.lock'), '', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'plans', 'daily', '_leftover.md'), '# leftover from an interrupted task\n', 'utf8');
  srv = startServer({ dataDir, port: PORT, env: baseEnv });
  try {
    await waitHealthy(base);
    const st = await status();
    ok('B: stale index.lock removed', !fs.existsSync(path.join(dataDir, '.git', 'index.lock')));
    const warns = (st.warnings ?? []).join(' | ');
    ok('B: lock cleanup surfaced', warns.includes('index.lock'), warns);
    ok('B: dirty tree surfaced', warns.includes('未提交'), warns);
  } finally { srv.stop(); await new Promise((r) => setTimeout(r, 800)); }
  // tidy the leftover so a re-run of the suite is clean
  try { fs.rmSync(path.join(dataDir, 'plans', 'daily', '_leftover.md')); } catch {}

  // --- Boot C: force an essential step to fail → gate stays closed, retry re-runs ----------
  srv = startServer({ dataDir, port: PORT, env: { ...baseEnv, GATHERLIGHT_MIGRATION_TEST_FAIL: 'data-repo' } });
  try {
    // health is up but migrating stays true (gate never lifts)
    const failed = await until(async () => { const s = await status().catch(() => null); return s && s.phase === 'failed' ? s : null; }, 20000);
    ok('C: essential failure → phase failed', failed.phase === 'failed');
    ok('C: failed step recorded', failed.steps.some((s) => s.id === 'data-repo' && s.status === 'failed'));
    const h = await health();
    ok('C: still migrating (gate closed)', h.j.migrating === true);
    const gated = await fetch(`${base}/api/plans`);
    ok('C: /api still gated 503', gated.status === 503);
    const retry = await fetch(`${base}/api/migration/retry`, { method: 'POST' });
    ok('C: retry accepted (200)', retry.status === 200);
  } finally { srv.stop(); }
} catch (err) {
  fail('e2e-p29 fatal: ' + err.message);
  console.error(srv?.log?.().slice(-3000) ?? '');
} finally {
  try { srv?.stop(); } catch {}
}
done();
```

- [ ] **Step 2: Run p29**

Run: `node devtools/dev.mjs e2e p29`
Expected: `e2e-p29 PASS`. If Boot C's `srv` reference is out of scope in the catch, hoist `let srv;` to the top (already done). If Boot A's delay is too short to catch the 503, raise `GATHERLIGHT_MIGRATION_TEST_DELAY` to `2500`.

- [ ] **Step 3: Commit**

```bash
git add devtools/scripts/e2e/p29.mjs
git commit -m "test(e2e): p29 — startup migration gate, status, self-heal, essential-fail + retry"
```

---

## Task 9: Full sweep + final build

- [ ] **Step 1: Full client+server build**

Run: `node devtools/dev.mjs build`
Expected: client `✓ built`, server `Build succeeded`.

- [ ] **Step 2: Full e2e sweep**

Run: `node devtools/dev.mjs e2e all`
Expected: `e2e: 29/29 suites passed`. Any failure in a suite other than p29 almost certainly traces to the `waitHealthy` change or the gate excluding a path a suite needs — fix by widening the gate's allow-list or the readiness wait, not by weakening the gate.

- [ ] **Step 3: Commit any final fixups**

```bash
git add -A
git commit -m "chore(migration): finalize startup migration runner + progress UI"
```

---

## Self-review notes (author)

- **Spec coverage:** A (startup restructure + health `migrating` + gate) → Tasks 4,5,6. B (runner + versioning + failure policy) → Tasks 2,3. C (state + status feed) → Tasks 1,4. D (overlay) → Task 7. E (self-heal locks/state/dirty-tree surface) → Task 2 steps 2,6. F (testing) → Tasks 6,8,9. All covered.
- **Type consistency:** `MigrationState.IsMigrating` (gate + health + middleware), `CompleteOk()`/`Fail()`/`Reset()` (runner + controller), snapshot fields `phase/isUpgrade/fromVersion/toVersion/steps/warnings/error` (C# record → client interface) all match.
- **Ordering invariant:** `db-migrate` before any DB-touching step; `self-heal-locks` before `data-repo`; `self-heal-state` after both. Encoded by DI registration order in Task 5 Step 1.
- **Known follow-ups (out of scope):** SSE instead of polling; a `/manage` action to review/discard the surfaced dirty tree; wiring the failed-overlay "打开日志" button to the Host bridge for the browser case.
