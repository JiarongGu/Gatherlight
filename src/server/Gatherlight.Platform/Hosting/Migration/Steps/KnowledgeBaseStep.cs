using Gatherlight.Server.Platform.Agent.Chat.Services;
using Gatherlight.Server.Platform.Storage.DataRepo.Services;
using Gatherlight.Server.Platform.Hosting.Migration.Services;
using Gatherlight.Server.Platform.Site.Seed.Services;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

public sealed class KnowledgeBaseStep : IMigrationStep
{
    private readonly IZhikuSeeder _seeder;
    private readonly ChatEnvironmentService _chatEnv;
    private readonly IZhikuMigrator _migrator;
    private readonly IGitCliService _git;
    private readonly IDataCommitRepository _commits;
    private readonly ILogger<KnowledgeBaseStep> _log;
    public KnowledgeBaseStep(IZhikuSeeder seeder, ChatEnvironmentService chatEnv, IZhikuMigrator migrator,
        IGitCliService git, IDataCommitRepository commits, ILogger<KnowledgeBaseStep> log)
    { _seeder = seeder; _chatEnv = chatEnv; _migrator = migrator; _git = git; _commits = commits; _log = log; }

    public string Id => "knowledge-base";
    public string Title => "知识库与安全护栏";
    public bool Essential => true;
    public async Task RunAsync(CancellationToken ct)
    {
        await _seeder.SeedAsync();
        // Re-issue the app-managed agent files (the scope guard — a security boundary — and the UI
        // block contract) and commit whatever was newly written, so the agent's own diffs stay clean.
        if (_chatEnv.EnsureFiles() is { Count: > 0 } seeded)
        {
            var sha = await _git.CommitPathsAsync(seeded, "seed: app-managed agent files", ct);
            _commits.Record(sha, "seed: app-managed agent files", "seed");
        }
        // Best-effort: notify (no token spend) that customized .claude files have shipped improvements.
        try { await _migrator.NotifyIfUpgradesAsync(); }
        catch (Exception ex) { _log.LogWarning(ex, "KB upgrade-notify failed (non-fatal)"); }
    }
}
