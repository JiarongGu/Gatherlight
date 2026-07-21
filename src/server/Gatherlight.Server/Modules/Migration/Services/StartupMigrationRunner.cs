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
        // Defer the config read until after db-migrate has ensured the table exists; on a first-run
        // (or a fresh e2e data folder) the app_config table doesn't exist yet and the read would throw.
        string? last = null;
        try { last = _config.Get(LastRanVersionKey); } catch { /* pre-migration DB — treat as first run */ }
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
