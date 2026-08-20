using Gatherlight.Server.Platform.Hosting.Migration.Services;
using Gatherlight.Server.Platform.Hosting.Resources.Services;
using Gatherlight.Server.Platform.Storage.DataRepo.Services;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

/// <summary>
/// Make sure a git CLI exists before anything needs one — it runs immediately before
/// <see cref="DataRepoInitStep"/>, whose repo IS the audit trail the diff gate rests on.
///
/// Why this step exists: the lean release ships no git on purpose (it is download-at-setup, like
/// chromium), so on a fresh household PC the data-repo step spawned the PATH "git" that was not there
/// and died with a raw Win32 "系统找不到指定的文件". Being ESSENTIAL, that kept the startup gate closed —
/// and the only remedy the product documented, the 资源 · Resources panel, is served by /api, which the
/// same gate 503s. The failure sealed the door to its own fix, and 重试 could never succeed. So git is
/// not a prerequisite to be reported any more: when it is missing the app DOWNLOADS it (≈37 MB, once,
/// into the data folder so it survives updates) and carries on booting.
///
/// Still essential, because a household with no network cannot be served a planner whose every approved
/// change would fail to commit — but now the failure is one sentence about the network, and 重试 retries
/// the download, which is a remedy that can actually work.
/// </summary>
public sealed class GitRuntimeStep : IMigrationStep
{
    private readonly IGitCliService _git;
    private readonly IResourceProvisioner _resources;
    private readonly MigrationState _state;
    private readonly ILogger<GitRuntimeStep> _log;

    public GitRuntimeStep(IGitCliService git, IResourceProvisioner resources, MigrationState state,
        ILogger<GitRuntimeStep> log)
    { _git = git; _resources = resources; _state = state; _log = log; }

    public string Id => "git-runtime";
    public string Title => "准备 Git(数据仓库引擎)";
    public bool Essential => true;

    public async Task RunAsync(CancellationToken ct)
    {
        // The common case by far, and it must cost nothing: a machine with git (or an install that has
        // already downloaded it) neither downloads nor is asked to.
        var found = await _git.ProbeAsync(ct);
        if (found is not null) { _log.LogInformation("git present: {Git}", found); return; }

        if (!OperatingSystem.IsWindows())
            throw new InvalidOperationException(
                "未找到 git,且自动下载的便携版仅支持 Windows —— 请先安装 git,然后重启应用。");

        _log.LogWarning("No git on this machine — provisioning the portable git runtime automatically.");
        _state.SetStepDetail(Id, "首次启动:正在下载 Git(约 37MB)…");
        try
        {
            await _resources.EnsureAsync("git",
                (pct, msg) => _state.SetStepDetail(Id, $"{msg ?? "下载 Git"} {pct}%"), ct);
        }
        catch (Exception ex)
        {
            // The household reads this sentence with nothing else to go on, so it says what failed, what
            // it was for, and what to do — never the download library's own words alone.
            throw new InvalidOperationException(
                $"无法自动下载 Git(数据仓库需要它):{ex.Message}。请检查网络后点击「重试」," +
                "或自行安装 git 后重启应用。", ex);
        }

        // Installed ≠ usable: a wrong archive layout, a blocked exe or a broken extraction all look like
        // success on disk. Probe the thing we actually intend to run, and say so plainly when it fails.
        var provisioned = await _git.ProbeAsync(ct);
        if (provisioned is null)
            throw new InvalidOperationException(
                "Git 已下载但无法运行 —— 请检查杀毒软件是否拦截,或自行安装 git 后重启应用。");
        _log.LogInformation("Portable git provisioned and working: {Git}", provisioned);
        _state.AddWarning("首次启动已自动安装便携版 Git(数据仓库引擎),之后不会再下载。");
    }
}
