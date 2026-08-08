using Gatherlight.Server.Platform.Hosting.Migration.Services;
using Gatherlight.Server.Platform.Storage.DataRepo.Services;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

/// <summary>
/// Packs the data repo's loose objects at startup when enough have piled up.
///
/// <para>Threshold-gated, so an ordinary boot does nothing and pays one git command for the privilege.
/// It earns its place after the events that create objects in bulk — a backup restore, a seeding pass,
/// a long planning session — because those objects ride into the NEXT backup uncompacted, and that is
/// how an archive grows by a megabyte without the household adding anything.</para>
///
/// <para>Not essential: an uncompacted repo is a working repo. A failure here costs disk, not data.</para>
/// </summary>
public sealed class DataRepoMaintenanceStep : IMigrationStep
{
    private readonly IDataRepoMaintenance _maintenance;
    public DataRepoMaintenanceStep(IDataRepoMaintenance maintenance) => _maintenance = maintenance;

    public string Id => "data-repo-maintenance";
    public string Title => "整理数据仓库";
    public bool Essential => false;

    public Task RunAsync(CancellationToken ct) => _maintenance.RunAsync(force: false, ct);
}
