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
