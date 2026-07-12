using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.PlanIndex.Services;

/// <summary>
/// Debounced FileSystemWatcher over the data folder's content trees (plans/, household/,
/// .claude/) so out-of-band edits — the user editing markdown directly, or an interactive
/// claude session run from the data folder — reflect in the index without a server restart.
/// Server-driven writes (chat execute, fs ops, seeder) also land here; the debounce coalesces.
/// </summary>
public sealed class PlanIndexWatcher : IHostedService, IDisposable
{
    private static readonly string[] WatchedPrefixes = { "plans", "household", ".claude" };
    private static readonly TimeSpan Debounce = TimeSpan.FromSeconds(1.5);

    private readonly IDataContext _data;
    private readonly IPlanIndexService _index;
    private readonly ILogger<PlanIndexWatcher> _log;
    private FileSystemWatcher? _watcher;
    private Timer? _timer;

    public PlanIndexWatcher(IDataContext data, IPlanIndexService index, ILogger<PlanIndexWatcher> log)
    {
        _data = data;
        _index = index;
        _log = log;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _watcher = new FileSystemWatcher(_data.RootPath)
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite,
        };
        _watcher.Changed += OnFsEvent;
        _watcher.Created += OnFsEvent;
        _watcher.Deleted += OnFsEvent;
        _watcher.Renamed += OnFsEvent;
        _watcher.EnableRaisingEvents = true;
        return Task.CompletedTask;
    }

    private void OnFsEvent(object sender, FileSystemEventArgs e)
    {
        var rel = _data.ToRelativePath(e.FullPath);
        if (rel is null) return;
        // Only content trees — state/ (SQLite WAL churn), uploads/, cache/, .git/ must not
        // trigger rescans.
        if (!WatchedPrefixes.Any(p => rel == p || rel.StartsWith(p + "/"))) return;
        if (rel.Contains("/.git/") || rel.StartsWith(".git/")) return;

        _timer ??= new Timer(_ => Rescan(), null, Timeout.Infinite, Timeout.Infinite);
        _timer.Change(Debounce, Timeout.InfiniteTimeSpan);
    }

    private void Rescan()
    {
        try { _index.RescanAsync().GetAwaiter().GetResult(); }
        catch (Exception ex) { _log.LogWarning(ex, "Plan index rescan failed (will retry on next change)"); }
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        if (_watcher is not null) _watcher.EnableRaisingEvents = false;
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        _watcher?.Dispose();
        _timer?.Dispose();
    }
}
