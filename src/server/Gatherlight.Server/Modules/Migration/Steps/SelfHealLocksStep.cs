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
