namespace Gatherlight.Server.Modules.DataRepo.Services;

/// <summary>
/// One writer to the data tree + data repo at a time — chat execution, direct fs ops, and the
/// knowledge-base seeder all serialize here, or concurrent git operations collide on index.lock
/// (and interleaved edits would corrupt a review diff).
/// </summary>
public sealed class DataWriteLock
{
    private readonly SemaphoreSlim _sem = new(1, 1);

    /// <summary>Blocks until the writer slot is free. Dispose the token to release.</summary>
    public async Task<IDisposable> AcquireAsync(CancellationToken ct = default)
    {
        await _sem.WaitAsync(ct);
        return new Releaser(_sem);
    }

    /// <summary>Non-blocking attempt — null when another writer holds the lock (callers surface
    /// 409 BUSY instead of queueing, matching the one-active-task chat contract).</summary>
    public IDisposable? TryAcquire()
    {
        return _sem.Wait(0) ? new Releaser(_sem) : null;
    }

    public bool IsBusy => _sem.CurrentCount == 0;

    private sealed class Releaser(SemaphoreSlim sem) : IDisposable
    {
        private int _released;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0) sem.Release();
        }
    }
}
