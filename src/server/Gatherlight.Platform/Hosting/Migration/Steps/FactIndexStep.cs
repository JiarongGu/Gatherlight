using Gatherlight.Server.Platform.Hosting.Migration.Services;
using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Storage.Knowledge.Services;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

/// <summary>
/// Back-fills the derived fact index at startup — the facts the household already knew before the
/// index existed, plus anything written while it was unavailable.
///
/// <para>Deliberately <see cref="IFactIndex.SyncAsync"/> and NOT <see cref="IRecordIndex"/>. That
/// collection's step runs on every boot and means "rebuild from scratch", which for this index would
/// discard the decay positions, reinforcement and links it has accumulated — erasing at each restart
/// the very ranking it exists to build. Only a backup import, which replaces the facts themselves,
/// warrants the destructive rebuild.</para>
///
/// <para>Not essential: an unindexed fact is still found by FTS, so a failure here costs ranking, not
/// recall.</para>
/// </summary>
public sealed class FactIndexStep : IMigrationStep
{
    private readonly IFactIndex _index;
    public FactIndexStep(IFactIndex index) => _index = index;

    public string Id => "fact-index";
    public string Title => "补全事实索引";
    public bool Essential => false;

    public Task RunAsync(CancellationToken ct) => _index.SyncAsync(ct);
}
