using Gatherlight.Server.Modules.Chat.Services;
using Gatherlight.Server.Modules.DataRepo.Services;
using Gatherlight.Server.Modules.Migration.Services;
using Gatherlight.Server.Modules.Seed.Services;

namespace Gatherlight.Server.Modules.Migration.Steps;

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
        // Guard re-issue (a security boundary) + commit a newly-seeded hook so the agent's diffs stay clean.
        if (_chatEnv.EnsureFiles() is { } seededHook)
        {
            var sha = await _git.CommitPathsAsync(new[] { seededHook }, "seed: chat scope-guard hook", ct);
            _commits.Record(sha, "seed: chat scope-guard hook", "seed");
        }
        // Best-effort: notify (no token spend) that customized .claude files have shipped improvements.
        try { await _migrator.NotifyIfUpgradesAsync(); }
        catch (Exception ex) { _log.LogWarning(ex, "KB upgrade-notify failed (non-fatal)"); }
    }
}
