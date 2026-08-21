namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>A reindex as the console sees it: whether one is running, how far it has got, and how the last
/// one ended.</summary>
/// <param name="Running">True between start and finish.</param>
/// <param name="Done">Facts visited so far.</param>
/// <param name="Total">Facts to visit; 0 until the run has counted them.</param>
/// <param name="Embedded">Result of the last FINISHED run.</param>
/// <param name="Error">Why the last run failed, or null.</param>
public sealed record ReindexSnapshot(bool Running, int Done, int Total, int? Embedded, string? Error);

/// <summary>
/// Tracks the one reindex this install may be running.
///
/// <para><b>Why it exists.</b> Reindexing re-remembers every fact, and with the enrichment on that is a
/// model call each — minutes on a real corpus. It used to run INSIDE the POST, so the household got a
/// greyed-out button and nothing else: no count, no bar, no way to tell work from a hang. Worse, a request
/// that long is one the browser may give up on while the server is still working, so the panel would report
/// a failure for an operation that went on to succeed.</para>
///
/// <para><b>One at a time.</b> <see cref="TryStart"/> refuses a second run rather than queueing it: two
/// rebuilds over the same graph would interleave discards and writes, and the second would be re-indexing
/// against a store the first is still emptying.</para>
/// </summary>
public interface IReindexStatus
{
    ReindexSnapshot Current { get; }

    /// <summary>Claim the slot. False when one is already running.</summary>
    bool TryStart();

    void Report(int done, int total);
    void Finish(int embedded, string? error);
}

public sealed class ReindexStatus : IReindexStatus
{
    private readonly object _gate = new();
    private bool _running;
    private int _done;
    private int _total;
    private int? _embedded;
    private string? _error;

    public ReindexSnapshot Current
    {
        get { lock (_gate) return new ReindexSnapshot(_running, _done, _total, _embedded, _error); }
    }

    public bool TryStart()
    {
        lock (_gate)
        {
            if (_running) return false;
            _running = true;
            _done = 0;
            _total = 0;
            // Cleared on START, not on finish: the previous run's outcome stays readable right up until a
            // new one replaces it, so a household that navigated away still finds out how the last one went.
            _embedded = null;
            _error = null;
            return true;
        }
    }

    public void Report(int done, int total)
    {
        lock (_gate) { _done = done; _total = total; }
    }

    public void Finish(int embedded, string? error)
    {
        lock (_gate) { _running = false; _embedded = embedded; _error = error; }
    }
}
