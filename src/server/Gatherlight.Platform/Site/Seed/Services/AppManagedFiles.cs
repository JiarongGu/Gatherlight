using Gatherlight.Server.Platform.Agent.Chat.Services;

namespace Gatherlight.Server.Platform.Site.Seed.Services;

/// <summary>
/// Everything inside the site that the APP owns rather than the household: the knowledge-base
/// template (hash-guarded, so a customized file is never overwritten) and the version-gated agent
/// files — the scope guard, the UI contract, the shipped form maps.
///
/// It exists because those files are DERIVED FROM THE APP VERSION, not user content, and so any
/// operation that replaces a record subtree wholesale invalidates them — exactly like the plan index,
/// which such operations already rebuild. Backup import is that operation: it restores <c>.claude/</c>
/// from the archive, so a backup taken by an older build silently rolled the scope guard BACK (a
/// security boundary, three versions in the case that found this) and removed app files the archive
/// predated. Startup was the only caller of the re-issue, so the downgrade lasted the whole session.
///
/// One seam so the answer to "what does the app install into the site?" lives in one place: a file
/// added to the re-issue is covered on every path that needs it, without anyone remembering to.
/// </summary>
public interface IAppManagedFiles
{
    /// <summary>Install/upgrade the app-owned files. Returns the data-root-relative paths newly
    /// written, for the caller to commit.</summary>
    Task<IReadOnlyList<string>> ReissueAsync(CancellationToken ct = default);
}

public sealed class AppManagedFiles : IAppManagedFiles
{
    private readonly IZhikuSeeder _seeder;
    private readonly ChatEnvironmentService _chatEnv;

    public AppManagedFiles(IZhikuSeeder seeder, ChatEnvironmentService chatEnv)
    {
        _seeder = seeder;
        _chatEnv = chatEnv;
    }

    public async Task<IReadOnlyList<string>> ReissueAsync(CancellationToken ct = default)
    {
        await _seeder.SeedAsync();
        return _chatEnv.EnsureFiles();
    }
}
