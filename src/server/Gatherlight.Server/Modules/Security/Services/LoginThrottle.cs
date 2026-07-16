using System.Collections.Concurrent;

namespace Gatherlight.Server.Modules.Security.Services;

/// <summary>
/// Per-IP brute-force guard for the login endpoint. The shared token is the only barrier for a
/// remote client, so an unthrottled login lets an attacker try tokens as fast as the network
/// allows. After <see cref="Threshold"/> failures inside <see cref="Window"/> the source IP is
/// locked out for <see cref="Lockout"/> — and the lockout blocks even a correct token, so a lucky
/// guess on the next attempt still can't get in. A success clears the counter.
/// </summary>
public interface ILoginThrottle
{
    /// <summary>True if <paramref name="key"/> is currently locked out; <paramref name="retryAfter"/>
    /// is how long until it clears.</summary>
    bool IsLocked(string key, out TimeSpan retryAfter);
    void RecordFailure(string key);
    void RecordSuccess(string key);
}

public sealed class LoginThrottle : ILoginThrottle
{
    public const int Threshold = 5;
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan Lockout = TimeSpan.FromMinutes(5);
    // Once the map grows past this, sweep out entries that are neither locked nor within their failure
    // window, so an attacker rotating source IPs can't grow it without bound (memory-exhaustion DoS).
    private const int SweepThreshold = 2048;

    private sealed class Entry
    {
        public int Failures;
        public DateTime LastFailure;
        public DateTime? LockedUntil;
    }

    private readonly ConcurrentDictionary<string, Entry> _map = new();

    public bool IsLocked(string key, out TimeSpan retryAfter)
    {
        retryAfter = TimeSpan.Zero;
        if (!_map.TryGetValue(key, out var e)) return false;
        // Read LockedUntil under the same per-entry lock RecordFailure writes it with — a lock-free read
        // of the nullable DateTime can tear.
        lock (e)
        {
            if (e.LockedUntil is { } until)
            {
                var remaining = until - DateTime.UtcNow;
                if (remaining > TimeSpan.Zero) { retryAfter = remaining; return true; }
            }
        }
        return false;
    }

    public void RecordFailure(string key)
    {
        var now = DateTime.UtcNow;
        var e = _map.GetOrAdd(key, _ => new Entry());
        lock (e)
        {
            if (now - e.LastFailure > Window) e.Failures = 0;   // stale streak → start fresh
            e.LastFailure = now;
            if (++e.Failures >= Threshold)
            {
                e.LockedUntil = now + Lockout;
                e.Failures = 0;
            }
        }
        if (_map.Count > SweepThreshold) Prune(now);
    }

    public void RecordSuccess(string key) => _map.TryRemove(key, out _);

    // Drop entries that are neither locked nor within their failure window — they carry no state worth
    // keeping and would otherwise accumulate one-per-IP forever.
    private void Prune(DateTime now)
    {
        foreach (var (k, v) in _map)
        {
            var locked = v.LockedUntil is { } until && until > now;
            var active = now - v.LastFailure <= Window;
            if (!locked && !active) _map.TryRemove(k, out _);
        }
    }
}
