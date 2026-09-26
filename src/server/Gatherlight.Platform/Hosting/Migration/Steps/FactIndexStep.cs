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

    /// <summary>The layout whose ENTRIES are at the current address and whose VECTORS are not: the pre-3.2 layout,
    /// and also what is recorded while a bound embedder is not wired (<see cref="EmbedderOwed"/>) — either way, the
    /// next start with an embedder wired rebuilds, re-embedding every indexed fact.</summary>
    private const string VectorsOnlyMoved = "2";

    private readonly IFactIndex _index;
    private readonly IKnowledgeStore _store;
    private readonly IAppConfigService _config;
    private readonly ServerConfigService _settings;
    private readonly MigrationState? _state;
    private readonly ILogger<FactIndexStep>? _log;

    public FactIndexStep(IFactIndex index, IKnowledgeStore store, IAppConfigService config,
        ServerConfigService settings, MigrationState? state = null, ILogger<FactIndexStep>? log = null)
    {
        _index = index;
        _store = store;
        _config = config;
        _settings = settings;
        _state = state;
        _log = log;
    }

    public string Id => "fact-index";
    public string Title => "补全事实索引";
    public bool Essential => false;

    public async Task RunAsync(CancellationToken ct)
    {
        // NOTHING is written while an embedder is wired but not answering — no back-fill, no rebuild, no
        // marker. That is our COST POLICY, not what keeps a vector from being lost: a write whose embed fails is
        // not an error to the engine (it stores the fact without its vector), and since the Lyntai 3.4 bump
        // IndexAsync reads each write's Ran and leaves such a fact unindexed, so the back-fill comes back to it.
        // What the gate saves is the cost of coming back for nothing: every pending fact re-remembered on every
        // start of an outage, each an annotation call against the household's quota when 判断 is on the CLI
        // (IFactIndex.EmbedderReadyAsync says what would end it). History: a real install came up after the 3.2
        // upgrade with every fact indexed and no vector at all — the rebuild ran before llama.cpp had started
        // (docs/self-managed-llm-runtime.md); the step order now starts the router first. A marker is written
        // only after work that actually happened, so skipping here just means the next start tries again.
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
        var facts = await _store.AllAsync();
        var alreadyIndexed = facts.Any(f => !string.IsNullOrEmpty(f.GraphRef));
        if (!alreadyIndexed) await _index.SyncAsync(ct);
        else if (stored == VectorsOnlyMoved && !_index.Embeds)
        {
            // Nothing reads a vector on this install, so nothing was stranded. A rebuild here would throw
            // away the decay positions and links the household has accumulated in exchange for nothing. If an
            // embedder is bound LATER, binding it already asks for a re-index, which drops every collection
            // under the graph's prefix — the orphaned old-address ones included. One bound but NOT wired (its
            // model file gone) asks for nothing, which is why the marker below then stays at this layout.
            // No target layout named here: which one is recorded is decided below (EmbedderOwed), and naming "3"
            // beside a later line recording "2" contradicted it.
            _log?.LogInformation("fact index: layout {Stored} is behind only in its vector addresses, and no " +
                "embedder is wired; keeping the graph as it is", stored);
            await _index.SyncAsync(ct);
        }
        else
        {
            _log?.LogInformation(
                "fact index: layout {Stored} -> {Layout}; rebuilding so recall can reach the entries again",
                stored ?? "(pre-marker)", Layout);
            // A count against the TOTAL, not a bare await and not against zero. RebuildAsync degrades rather
            // than throwing (the whole index does — an unindexed fact is still found by FTS), so a failed
            // migration returns a short count here and would otherwise be recorded as done. It compared with
            // zero until the Lyntai 3.4 bump, which was complete only while every write got a reference: now a
            // write that kept no vector gets none (IndexAsync reads its Ran), so an embedder that answered the
            // probe and then failed part-way returns a count above zero and below the total — and the marker
            // would have claimed a rebuild whose vectors are partly missing. The facts it did not reach are
            // unindexed rows, found by FTS, and the next start rebuilds AGAIN — a whole rebuild, every fact
            // re-remembered, so a fact the embedder can never embed (one past llama.cpp's physical batch) repeats
            // it at every start; the warning below says so each time rather than letting it loop unseen. Proof:
            // e2e-p52 case 9, where a fake embedder refuses one fact's content; confirmed to FAIL with this
            // compared against zero.
            var indexed = await _index.RebuildAsync(ct);
            if (indexed < facts.Count)
            {
                _log?.LogWarning("fact index: the layout rebuild indexed {Indexed} of {Total} facts; leaving the " +
                    "marker unset so the next start retries rather than recording a migration that did not happen",
                    indexed, facts.Count);
                _state?.AddWarning($"事实索引的重建没有完成(只建立了 {indexed}/{facts.Count} 条) —— "
                    + "其余的事实仍能按关键词找到,下次启动会重试。");
                return;
            }
        }

        // WHAT HAPPENED, and no more. With an embedder OWED — bound in settings, not wired this start — the entries
        // are at the current address and the vectors are not, which is exactly what VectorsOnlyMoved says. Recording
        // the current layout instead told the start that has the embedder back that nothing was owed: it only
        // Synced, the vectors Lyntai 3.2's address change orphaned were never re-embedded, and semantic recall
        // stayed empty with nothing anywhere saying so. A bound model whose file is gone reaches this (the resolver
        // turns 语义 off), and so do a deleted runtime and the built-in embedder's missing files. Proof: e2e-p52
        // case 10.
        //
        // The SyncAsync branches above reach this whatever they indexed: a fact a back-fill left unindexed (a write
        // that kept no vector) is a row with an empty ref, which the next start's back-fill finishes at any layout.
        // The rebuild is held to every fact (above) by DECISION (the 3.4 bump), not because its unreached facts
        // differ — they are rows of the same kind. What the rule buys is that the marker never records a rebuild
        // that did not reach every fact; what it costs is a whole rebuild, not a back-fill, on the retry.
        var layout = EmbedderOwed() ? VectorsOnlyMoved : Layout;
        if (layout != Layout)
            _log?.LogWarning("fact index: 语义 is bound to an embedder that is not wired this start; recording " +
                "layout {Recorded}, not {Layout}, so the start that has it back re-embeds every fact", layout, Layout);
        // Last, deliberately: a crash mid-rebuild leaves the marker unset too, so the next start retries
        // rather than settling into the silent FTS fallback this exists to prevent.
        _config.Set(LayoutKey, layout);
    }

    /// <summary>Is 语义 bound to an EMBEDDER arm that is not wired this start?
    /// <para>"Embedder arm" is asked of the source, never of its id: <see cref="Agent.Llm.Sources.IMemorySource.TakesEffectOnRestart"/>
    /// is true for exactly the 语义 arms whose Register wires an embedder and its vector store (llama.cpp, built-in)
    /// and false for the CLI arm, which registers nothing and stores phrasings instead. A 语义 arm has nothing else
    /// to register, so for this layer "wired at startup" IS "embeds" — should one ever register something else,
    /// this is the line to revisit.</para></summary>
    private bool EmbedderOwed()
    {
        if (_index.Embeds) return false;
        var m = _settings.Current.Memory;
        return !string.IsNullOrWhiteSpace(m.SemanticSource) && !string.IsNullOrWhiteSpace(m.EmbeddingModel)
            && Agent.Llm.Sources.MemorySources.FindSemantic(m.SemanticSource) is { TakesEffectOnRestart: true };
    }
}
