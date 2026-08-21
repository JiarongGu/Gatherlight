namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>One model download as the console sees it.</summary>
/// <param name="Model">The id the household asked for, VERBATIM — the panel matches its own row on this,
/// so normalising it here would leave a download nothing on screen could claim.</param>
/// <param name="Running">True between start and finish.</param>
/// <param name="Percent">0–100 over the whole pull, or null while Ollama is still resolving manifests and
/// has no total to divide by. Null renders as indeterminate: a bar pinned at 0% reads as stuck.</param>
/// <param name="Status">Ollama's own line ("pulling manifest", "verifying sha256 digest"), passed through
/// rather than paraphrased — on a long download it is the only thing separating slow from wedged.</param>
/// <param name="Error">Why the last attempt failed, or null.</param>
public sealed record ModelPullSnapshot(string Model, bool Running, int? Percent, string? Status, string? Error);

/// <summary>
/// Tracks the model downloads this install has in flight.
///
/// <para><b>Why it exists.</b> A pull is hundreds of megabytes to gigabytes and the budget in
/// <see cref="OllamaRuntime.PullModelAsync"/> is two hours. It used to run INSIDE the POST, so the household
/// got a button reading 下载中… with no bar, no bytes and no way to tell work from a hang — over a request the
/// browser may abandon while Ollama carries on downloading. This is the same fix
/// <see cref="IReindexStatus"/> already applied to the rebuild, for the same reason; the pull simply never
/// got it, even though <see cref="OllamaRuntime.PullModelAsync"/> had been parsing the percentages and
/// throwing them away.</para>
///
/// <para><b>Keyed by model, not one slot.</b> Unlike a reindex — where a second run would interleave
/// discards and writes over the same graph — two different models download independently, and the panel
/// puts a button on every row. So this follows <c>ResourceProvisioner</c>'s shape (one entry per id, ride
/// along on a repeat) rather than the reindex's single slot.</para>
/// </summary>
public interface IModelPullStatus
{
    IReadOnlyList<ModelPullSnapshot> Current { get; }

    /// <summary>Claim the slot for one model. False when that model is ALREADY downloading — in which case
    /// the caller should report success rather than a conflict: the household asked for a download and one
    /// is running, and an error toast over a working progress bar describes nothing that went wrong.</summary>
    bool TryStart(string model);

    void Report(string model, int? percent, string? status);
    void Finish(string model, string? error);
}

public sealed class ModelPullStatus : IModelPullStatus
{
    /// <summary>How long a FINISHED entry stays readable. Long enough that a panel polling every second and
    /// a half cannot miss the outcome; short enough that a household returning to a tab left open overnight
    /// is not shown last night's downloads as if they were news.</summary>
    private static readonly TimeSpan KeepFinished = TimeSpan.FromMinutes(3);

    private readonly object _gate = new();
    private readonly Dictionary<string, Entry> _entries = new(StringComparer.OrdinalIgnoreCase);

    private sealed class Entry
    {
        public bool Running;
        public int? Percent;
        public string? Status;
        public string? Error;
        public DateTimeOffset FinishedAt;
    }

    public IReadOnlyList<ModelPullSnapshot> Current
    {
        get
        {
            lock (_gate)
            {
                Prune();
                return _entries
                    .Select(kv => new ModelPullSnapshot(
                        kv.Key, kv.Value.Running, kv.Value.Percent, kv.Value.Status, kv.Value.Error))
                    .ToList();
            }
        }
    }

    public bool TryStart(string model)
    {
        lock (_gate)
        {
            Prune();
            if (_entries.TryGetValue(model, out var existing) && existing.Running) return false;
            _entries[model] = new Entry { Running = true, Status = "准备中…" };
            return true;
        }
    }

    public void Report(string model, int? percent, string? status)
    {
        lock (_gate)
        {
            if (!_entries.TryGetValue(model, out var e) || !e.Running) return;
            // Only ADVANCE on a line that carried a denominator. A manifest or verify line has none, and
            // letting it null the percent would send the bar back to indeterminate mid-download.
            if (percent is not null) e.Percent = percent;
            if (!string.IsNullOrWhiteSpace(status)) e.Status = status;
        }
    }

    public void Finish(string model, string? error)
    {
        lock (_gate)
        {
            if (!_entries.TryGetValue(model, out var e)) return;
            e.Running = false;
            e.Error = error;
            e.FinishedAt = DateTimeOffset.UtcNow;
            // A success that stopped at 97% because the last layer was small reads as an unfinished
            // download. A FAILURE keeps its position, because where it stopped is information.
            if (error is null) e.Percent = 100;
        }
    }

    private void Prune()
    {
        var cutoff = DateTimeOffset.UtcNow - KeepFinished;
        foreach (var key in _entries
                     .Where(kv => !kv.Value.Running && kv.Value.FinishedAt < cutoff)
                     .Select(kv => kv.Key)
                     .ToList())
            _entries.Remove(key);
    }
}
