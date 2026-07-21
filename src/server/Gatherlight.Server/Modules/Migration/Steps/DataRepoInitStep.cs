using Gatherlight.Server.Modules.DataRepo.Services;
using Gatherlight.Server.Modules.Migration.Services;

namespace Gatherlight.Server.Modules.Migration.Steps;

public sealed class DataRepoInitStep : IMigrationStep
{
    private readonly IGitCliService _git;
    private readonly IDataCommitRepository _commits;
    public DataRepoInitStep(IGitCliService git, IDataCommitRepository commits) { _git = git; _commits = commits; }
    public string Id => "data-repo";
    public string Title => "初始化数据仓库";
    public bool Essential => true;
    public async Task RunAsync(CancellationToken ct)
    {
        if (await _git.EnsureRepoAsync(ct))
        {
            var sha = await _git.CommitAllAsync("data: initial import", ct);
            if (sha is not null) _commits.Record(sha, "data: initial import", "import");
        }
    }
}
