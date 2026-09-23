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
    /// a populated vector collection. See <c>FactIndex.AllFacts</c>.</para>
    /// <para>v3 (Lyntai 3.2) is a move WE did not make: the library changed the vector collection address
    /// from <c>{engine}|{task}|{scope}</c> to a U+001F separator, so two task/scope pairs could no longer
    /// compose to one collection. Vectors under the old address are orphaned, not migrated — Lyntai's
    /// changelog says "a deployment re-indexes" — and the vector store offers no way to read a vector back
    /// out to move it. So a household with an embedder wired would get a semantic channel searching an EMPTY
    /// collection, fail-open and therefore silently. Only the vectors moved, though: a graph read by no
    /// embedder is still exactly where it was, which is why v2 → v3 rebuilds only when one is wired.</para></summary>
    private const string LayoutKey = "facts.index.layout";
    private const string Layout = "3";

    /// <summary>The layout whose ENTRIES are still at the current address — only its vectors moved.</summary>
    private const string VectorsOnlyMoved = "2";

    private readonly IFactIndex _index;
    private readonly IKnowledgeStore _store;
    private readonly IAppConfigService _config;
    private readonly MigrationState? _state;
    private readonly ILogger<FactIndexStep>? _log;

    public FactIndexStep(IFactIndex index, IKnowledgeStore store, IAppConfigService config,
        MigrationState? state = null, ILogger<FactIndexStep>? log = null)
    {
        _index = index;
        _store = store;
        _config = config;
        _state = state;
        _log = log;
    }

    public string Id => "fact-index";
    public string Title => "补全事实索引";
    public bool Essential => false;

    public async Task RunAsync(CancellationToken ct)
    {
        // NOTHING is written while an embedder is wired but not answering — no back-fill, no rebuild, no
        // marker. A write whose embed fails is not an error to the engine: it stores the fact WITHOUT its
        // vector and the fact gets its graph reference, so neither a later back-fill nor this step would ever
        // return to it. That is how a real install came up after the 3.2 upgrade with every fact indexed and
        // no vector at all — the rebuild ran before llama.cpp had started (docs/self-managed-llm-runtime.md).
        // The step order now starts the router first; this guards everything else that leaves it down (a
        // failed start, a router that will not load the model). A marker is written only after work that
        // actually happened, so skipping here just means the next start tries again.
        if (!await _index.EmbedderReadyAsync(ct))
        {
            _log?.LogWarning("fact index: an embedder is wired but did not answer a probe; indexing nothing and " +
                "leaving the layout marker as it is, so the next start retries");
            _state?.AddWarning("「语义」的嵌入模型这次启动没有响应,事实索引没有更新 —— 已有的事实仍能按关键词找到,"
                + "下次启动会自动重试。");
            return;
        }

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
        else if (stored == VectorsOnlyMoved && !_index.Embeds)
        {
            // Nothing reads a vector on this install, so nothing was stranded. A rebuild here would throw
            // away the decay positions and links the household has accumulated in exchange for nothing. If an
            // embedder is bound LATER, binding it already asks for a re-index, which drops every collection
            // under the graph's prefix — the orphaned old-address ones included.
            _log?.LogInformation("fact index: layout {Stored} -> {Layout} moved only vector addresses, and no " +
                "embedder is wired; keeping the graph as it is", stored, Layout);
            await _index.SyncAsync(ct);
        }
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
