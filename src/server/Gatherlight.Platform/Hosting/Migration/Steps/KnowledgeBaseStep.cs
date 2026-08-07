using Gatherlight.Server.Platform.Agent.Chat.Services;
using Gatherlight.Server.Platform.Storage.DataRepo.Services;
using Gatherlight.Server.Platform.Hosting.Migration.Services;
using Gatherlight.Server.Platform.Site.Seed.Services;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

public sealed class KnowledgeBaseStep : IMigrationStep
{
    private readonly IAppManagedFiles _appManaged;
    private readonly IZhikuMigrator _migrator;
    private readonly IGitCliService _git;
    private readonly IDataCommitRepository _commits;
    private readonly ILogger<KnowledgeBaseStep> _log;
    public KnowledgeBaseStep(IAppManagedFiles appManaged, IZhikuMigrator migrator,
        IGitCliService git, IDataCommitRepository commits, ILogger<KnowledgeBaseStep> log)
    { _appManaged = appManaged; _migrator = migrator; _git = git; _commits = commits; _log = log; }

    public string Id => "knowledge-base";
    public string Title => "知识库与安全护栏";
    public bool Essential => true;
    public async Task RunAsync(CancellationToken ct)
    {
        // Seed the template + re-issue the app-managed agent files (the scope guard — a security
        // boundary — the UI block contract, the form maps), then commit whatever was newly written so
        // the agent's own diffs stay clean. Backup import runs the SAME re-issue, because restoring
        // .claude/ from an older archive rolls these back.
        if (await _appManaged.ReissueAsync(ct) is { Count: > 0 } seeded)
        {
            var sha = await _git.CommitPathsAsync(seeded, "seed: app-managed agent files", ct);
            _commits.Record(sha, "seed: app-managed agent files", "seed");
        }
        // Best-effort: notify (no token spend) that customized .claude files have shipped improvements.
        try { await _migrator.NotifyIfUpgradesAsync(); }
        catch (Exception ex) { _log.LogWarning(ex, "KB upgrade-notify failed (non-fatal)"); }
    }
}
