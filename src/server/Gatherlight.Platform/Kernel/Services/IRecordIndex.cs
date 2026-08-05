namespace Gatherlight.Server.Platform.Kernel.Services;

/// <summary>
/// Something that derives state from the site's record files and must be rebuilt when those files
/// change underneath it — a backup restore, a startup migration, an out-of-band edit. The PLATFORM
/// owns the trigger; the PRODUCT owns what rebuilding means, so platform code never needs to know
/// that the planner keeps a plan index. Resolved as a DI collection: zero implementations is a
/// valid site with nothing to rebuild, and a second one joins without touching any caller.
/// </summary>
public interface IRecordIndex
{
    Task RebuildAsync(CancellationToken ct);
}
