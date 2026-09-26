namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>A reindex as the console sees it: whether one is running, how far it has got, and how the last
/// one ended.</summary>
/// <param name="Running">True between start and finish.</param>
/// <param name="Done">Facts visited so far.</param>
/// <param name="Total">Facts to visit; 0 while the run cannot count its progress (it has not counted its facts yet,
/// or the stage it is in reports none — a re-embed in place is one engine call).</param>
/// <param name="Embedded">Result of the last FINISHED run.</param>
/// <param name="Error">Why the last run failed, or null.</param>
/// <param name="Phase">What the running run is doing, in the household's words — written by the controller from the
/// stage the fact index reports, so the sentence has one writer. Null when there is nothing to say.</param>
/// <param name="Summary">How the last FINISHED run went, in the household's words, when it did not fail.</param>
public sealed record ReindexSnapshot(bool Running, int Done, int Total, int? Embedded, string? Error,
    string? Phase = null, string? Summary = null);

/// <summary>
/// Tracks the one reindex this install may be running.
///
/// <para><b>Why it exists.</b> Reindexing can take minutes on a real corpus — the rephrasing arm is a model call per
/// fact, a re-embed an embed per entry on whatever device the machine has. It used to run INSIDE the POST, so the
/// household got a greyed-out button and nothing else: no count, no bar, no way to tell work from a hang. Worse, a
/// request that long is one the browser may give up on while the server is still working, so the panel would report
/// a failure for an operation that went on to succeed.</para>
///
/// <para><b>One at a time.</b> <see cref="TryStart"/> refuses a second run rather than queueing it: two passes over the
/// same graph would re-embed or re-derive everything twice for nothing.</para>
/// </summary>
public interface IReindexStatus
{
    ReindexSnapshot Current { get; }

    /// <summary>Claim the slot. False when one is already running.</summary>
    bool TryStart();

    void Report(int done, int total, string? phase = null);
    void Finish(int embedded, string? error, string? summary = null);
}

public sealed class ReindexStatus : IReindexStatus
{
    private readonly object _gate = new();
    private bool _running;
    private int _done;
    private int _total;
    private int? _embedded;
    private string? _error;
    private string? _phase;
    private string? _summary;

    public ReindexSnapshot Current
    {
        get { lock (_gate) return new ReindexSnapshot(_running, _done, _total, _embedded, _error, _phase, _summary); }
    }

    public bool TryStart()
    {
        lock (_gate)
        {
            if (_running) return false;
            _running = true;
            _done = 0;
            _total = 0;
            _phase = null;
            // Cleared on START, not on finish: the previous run's outcome stays readable right up until a
            // new one replaces it, so a household that navigated away still finds out how the last one went.
            _embedded = null;
            _error = null;
            _summary = null;
            return true;
        }
    }

    public void Report(int done, int total, string? phase = null)
    {
        lock (_gate) { _done = done; _total = total; _phase = phase; }
    }

    public void Finish(int embedded, string? error, string? summary = null)
    {
        lock (_gate) { _running = false; _embedded = embedded; _error = error; _summary = summary; _phase = null; }
    }
}
