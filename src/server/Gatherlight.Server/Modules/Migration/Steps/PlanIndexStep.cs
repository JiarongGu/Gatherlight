using Gatherlight.Server.Modules.Migration.Services;
using Gatherlight.Server.Modules.PlanIndex.Services;

namespace Gatherlight.Server.Modules.Migration.Steps;

public sealed class PlanIndexStep : IMigrationStep
{
    private readonly IPlanIndexService _index;
    public PlanIndexStep(IPlanIndexService index) => _index = index;
    public string Id => "plan-index";
    public string Title => "重建计划索引";
    public bool Essential => false;
    public Task RunAsync(CancellationToken ct) => _index.RescanAsync();
}
