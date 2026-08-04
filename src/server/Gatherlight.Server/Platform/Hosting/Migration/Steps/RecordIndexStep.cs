using Gatherlight.Server.Platform.Hosting.Migration.Services;
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

public sealed class RecordIndexStep : IMigrationStep
{
    private readonly IEnumerable<IRecordIndex> _indexes;
    public RecordIndexStep(IEnumerable<IRecordIndex> indexes) => _indexes = indexes;
    public string Id => "record-index";
    public string Title => "重建记录索引";
    public bool Essential => false;
    public async Task RunAsync(CancellationToken ct)
    {
        foreach (var ix in _indexes) await ix.RebuildAsync(ct);
    }
}
