namespace Gatherlight.Server.Modules.Llm.Services;

/// <summary>
/// One live agent run at a time across the WHOLE app — interactive chat AND background jobs. The
/// data tree is shared and single-writer (concurrent agent writes / git ops corrupt it), and an
/// interactive session parked at the diff-approval gate leaves uncommitted edits in the tree, so
/// the gate is held for a chat session's ENTIRE lifetime (start → terminal), not just the CLI run.
///
/// Non-blocking by design: chat fails fast with BUSY, background jobs defer to their next tick — a
/// running agent is never preempted mid-write.
/// </summary>
public interface IAgentGate
{
    bool IsBusy { get; }
    /// <summary>Try to take the single agent slot. Returns a lease to Dispose when done, or null if
    /// another owner holds it.</summary>
    IDisposable? TryBegin(string owner);
    /// <summary>Who currently holds the slot (for diagnostics), or null if free.</summary>
    string? CurrentOwner { get; }
}

public sealed class AgentGate : IAgentGate
{
    private readonly SemaphoreSlim _sem = new(1, 1);
    private volatile string? _owner;

    public bool IsBusy => _sem.CurrentCount == 0;
    public string? CurrentOwner => _owner;

    public IDisposable? TryBegin(string owner)
    {
        if (!_sem.Wait(0)) return null;
        _owner = owner;
        return new Lease(this);
    }

    private void Release()
    {
        _owner = null;
        _sem.Release();
    }

    private sealed class Lease(AgentGate gate) : IDisposable
    {
        private int _disposed;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0) gate.Release();
        }
    }
}
