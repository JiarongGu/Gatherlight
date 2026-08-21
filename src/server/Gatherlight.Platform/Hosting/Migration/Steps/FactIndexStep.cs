using Gatherlight.Server.Platform.Hosting.Migration.Services;
using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Storage.Knowledge.Services;
using Microsoft.Extensions.Logging;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

/// <summary>
/// Back-fills the derived fact index at startup — the facts the household already knew before the
/// index existed, plus anything written while it was unavailable.
///
/// <para>Deliberately <see cref="IFactIndex.SyncAsync"/> and NOT <see cref="IRecordIndex"/>. That
/// collection's step runs on every boot and means "rebuild from scratch", which for this index would
/// discard the decay positions, reinforcement and links it has accumulated — erasing at each restart
/// the very ranking it exists to build.</para>
///
/// <para>The destructive rebuild is reserved for the two events that leave the existing entries WRONG or
/// unreachable rather than merely stale: a backup import (handled elsewhere — the facts themselves were
/// replaced), and a LAYOUT change here, which happens once per affected install and is gated by the
/// marker below.</para>
///
/// <para>Not essential: an unindexed fact is still found by FTS, so a failure here costs ranking, not
/// recall.</para>
/// </summary>
public sealed class FactIndexStep : IMigrationStep
{
    /// <summary>Which (task, scope) layout the entries in the graph were written under. Bumped when a
    /// change moves them, because the graph is addressed BY scope: entries left at the old address are
    /// not corrupt, they are unreachable, and recall answers from the FTS floor instead — a quiet loss
    /// of ranking that nothing else in the app would report.
    /// <para>v2 (2026-08-21) put every fact in one scope so that a recall naming no kind still searches
    /// a populated vector collection. See <c>FactIndex.AllFacts</c>.</para></summary>
    private const string LayoutKey = "facts.index.layout";
    private const string Layout = "2";

    private readonly IFactIndex _index;
    private readonly IKnowledgeStore _store;
    private readonly IAppConfigService _config;
    private readonly ILogger<FactIndexStep>? _log;

    public FactIndexStep(IFactIndex index, IKnowledgeStore store, IAppConfigService config,
        ILogger<FactIndexStep>? log = null)
    {
        _index = index;
        _store = store;
        _config = config;
        _log = log;
    }

    public string Id => "fact-index";
    public string Title => "补全事实索引";
    public bool Essential => false;

    public async Task RunAsync(CancellationToken ct)
    {
        var stored = _config.Get(LayoutKey);
        if (stored == Layout)
        {
            await _index.SyncAsync(ct);
            return;
        }

        // A missing marker is NOT the same as a fresh install, and reading it that way would have skipped
        // the rebuild for precisely the households that need it: the marker did not exist before the
        // layout it describes, so every existing install arrives here with `stored == null` AND with facts
        // already indexed at the old address. Ask the store instead of the marker — an INDEXED fact (a
        // non-empty graph_ref) is the evidence that entries were written under some earlier layout.
        var alreadyIndexed = (await _store.AllAsync()).Any(f => !string.IsNullOrEmpty(f.GraphRef));
        if (!alreadyIndexed) await _index.SyncAsync(ct);
        else
        {
            _log?.LogInformation(
                "fact index: layout {Stored} -> {Layout}; rebuilding so recall can reach the entries again",
                stored ?? "(pre-marker)", Layout);
            // A count, not a bare await: RebuildAsync degrades to nothing rather than throwing (the whole
            // index does — an unindexed fact is still found by FTS), so a failed migration returns 0 here
            // and would otherwise be recorded as done. There WERE indexed facts to move, so zero moved is
            // a failure by construction, and the entries are still stranded at the old address.
            if (await _index.RebuildAsync(ct) == 0)
            {
                _log?.LogWarning("fact index: the layout rebuild moved nothing; leaving the marker unset " +
                    "so the next start retries rather than recording a migration that did not happen");
                return;
            }
        }

        // Last, deliberately: a crash mid-rebuild leaves the marker unset too, so the next start retries
        // rather than settling into the silent FTS fallback this exists to prevent.
        _config.Set(LayoutKey, Layout);
    }
}
