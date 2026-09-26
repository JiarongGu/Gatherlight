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
/// <para>The destructive rebuild is reserved for the two events that leave the existing ENTRIES wrong or
/// unreachable rather than merely stale: a backup import (handled elsewhere — the facts themselves were
/// replaced), and a pre-marker LAYOUT here, which happens once per affected install and is gated by the
/// marker below. Where only the VECTORS are owed — the marker at <see cref="FactIndexLayout.VectorsOwed"/> — the
/// entries are re-embedded IN PLACE (<see cref="IFactIndex.ReembedInPlaceAsync"/>, Lyntai D194): nothing the graph
/// has learned is lost and nothing is annotated.</para>
///
/// <para>Not essential: an unindexed fact is still found by FTS, so a failure here costs ranking, not
/// recall.</para>
/// </summary>
public sealed class FactIndexStep : IMigrationStep
{
    /// <summary>Which (task, scope) layout the entries in the graph were written under — <see cref="FactIndexLayout"/>,
    /// shared with the console's re-embed. Bumped when a change moves them, because the graph is addressed BY scope:
    /// entries left at the old address are not corrupt, they are unreachable, and recall answers from the FTS floor
    /// instead — a quiet loss of ranking that nothing else in the app would report.
    /// <para>v2 (2026-08-21) put every fact in one scope so that a recall naming no kind still searches
    /// a populated vector collection. See <c>FactIndex.AllFacts</c>.</para>
    /// <para>v3 (Lyntai 3.2) is a move WE did not make: the library changed the vector collection address
    /// from <c>{engine}|{task}|{scope}</c> to a U+001F separator, so two task/scope pairs could no longer
    /// compose to one collection. Vectors under the old address are orphaned, not migrated — Lyntai's
    /// changelog says "a deployment re-indexes". Only the vectors moved, though: a graph read by no embedder is
    /// still exactly where it was, which is why v2 → v3 touches the graph only when one is wired — and since
    /// Lyntai 3.5 (D194) it re-embeds the entries IN PLACE rather than rebuilding them. The old-address collection
    /// is then never read again and is left where it is: only a rebuild (a backup import) sweeps it.</para></summary>
    private const string LayoutKey = FactIndexLayout.Key;
    private const string Layout = FactIndexLayout.Current;

    /// <summary>The layout whose ENTRIES are at the current address and whose VECTORS are not
    /// (<see cref="FactIndexLayout.VectorsOwed"/>): the pre-3.2 layout, and also what is recorded while a bound
    /// embedder is not wired (<see cref="EmbedderOwed"/>), when the long facts an old batch refused are due a vector
    /// (<see cref="RevisitLongFactsOnceAsync"/>), and by a console re-embed for the length of its pass — each way, the
    /// next start with an embedder wired re-embeds every entry in place.</summary>
    private const string VectorsOnlyMoved = FactIndexLayout.VectorsOwed;

    /// <summary>Set once the facts a llama.cpp embedder refused at its OLD 512-token physical batch have been given their
    /// vector (<see cref="RevisitLongFactsOnceAsync"/>). A one-off, like the layout marker, and for the same reason: running
    /// it again would re-embed every entry for facts that already have their vectors.</summary>
    private const string EmbedWindowKey = "facts.index.embed-window";
    private const string EmbedWindowRevisited = "1";

    /// <summary>How long a fact must be, in <see cref="Agent.Llm.Services.RerankPace.Tokens"/>, to count as possibly
    /// refused at the old 512-token batch. That estimate's rates (0.83 per CJK character, 0.25 per other) were measured
    /// on the rerankers' tokenizer, and they OVERESTIMATE EmbeddingGemma's (0.68 and 0.19, measured on b10549 —
    /// docs/self-managed-llm-runtime.md): a fact that really was refused estimates at ~625 tokens or more. 400 leaves
    /// room beside that for scripts neither rate was measured on. It decides only WHETHER the one-off pass runs — the pass
    /// itself re-embeds every entry — so an overestimate costs one pass an install did not need, once.</summary>
    private const double LongAtOldBatchTokens = 400;

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
        // NOTHING is written while an embedder is wired but not answering — no back-fill, no rebuild or re-embed, no
        // marker. That is our COST POLICY, not what keeps a vector from being lost: a write whose embed fails is
        // not an error to the engine (it stores the fact without its vector), and since the Lyntai 3.4 bump
        // IndexAsync reads each write's Ran and, when the embedder is down, leaves such a fact unindexed, so the
        // back-fill comes back to it.
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

        await RevisitLongFactsOnceAsync();

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
        // "Owed" is read through FactIndexLayout.IsVectorsOwed: a plain "2", or the token a console re-embed writes for
        // its pass — which a restart that cut that pass short leaves here, to be finished below.
        else if (FactIndexLayout.IsVectorsOwed(stored) && !_index.Embeds)
        {
            // Nothing reads a vector on this install, so nothing was stranded, and the graph is kept as it is. If an
            // embedder is bound LATER, binding it asks for a semantic reindex, which re-embeds every entry in place. One
            // bound but NOT wired (its model file gone) asks for nothing, which is why the marker below then stays at
            // this layout. No target layout named here: which one is recorded is decided below (EmbedderOwed), and
            // naming "3" beside a later line recording "2" contradicted it.
            _log?.LogInformation("fact index: layout {Stored} is behind only in its vector addresses, and no " +
                "embedder is wired; keeping the graph as it is", stored);
            await _index.SyncAsync(ct);
        }
        else if (FactIndexLayout.IsVectorsOwed(stored))
        {
            // ONLY THE VECTORS ARE OWED, AND AN EMBEDDER IS WIRED: re-embed every entry IN PLACE (Lyntai D194). This used
            // to be a destructive rebuild — every entry forgotten and re-remembered, every decay position and link
            // discarded, an annotation paid per fact — because until Lyntai 3.5 re-remembering was the only way to give an
            // entry a vector. The pass writes vectors and nothing else, onto the entries' existing ids.
            //
            // A pass that did not COMPLETE — it threw, or entries failed and the embedder then stopped answering — writes
            // no marker, so the next start re-embeds again (one embed per entry, no annotation: cheap to repeat, and gated
            // like everything here on the probe above). One that completed with failures the embedder refused while
            // answering a probe (inputs past its window) writes it: those entries keep the vector they had, or none, as the
            // write classifier keeps a refused input, and running the pass again would only be refused again — so nothing
            // loops. Proof: e2e-p52 case 11 (11b: a pass a restart cut short is finished here; 11c: one the embedder goes
            // down during keeps the marker owed and warns, and the next start finishes it) and 9e.
            _log?.LogInformation("fact index: layout {Stored} -> {Layout}; re-embedding every entry in place", stored, Layout);
            // The migration overlay shows this step while it runs, and this can be a minute on a CPU with a large corpus —
            // so it says what it is doing rather than sitting on the step's title (a 语义 bind now owes this on purpose).
            _state?.SetStepDetail(Id, $"正在原地重新计算 {facts.Count(f => !string.IsNullOrEmpty(f.GraphRef))} 条事实的向量……");
            var reembed = await _index.ReembedInPlaceAsync(ct);
            if (!reembed.Completed)
            {
                _log?.LogWarning("fact index: the re-embed did not complete ({Failed} entries failed, or it threw); " +
                    "leaving the marker owed so the next start re-embeds again", reembed.Failed);
                _state?.AddWarning("「语义」的向量这次启动没有全部重新计算 —— 嵌入模型途中停止了响应,或写入时出了错"
                    + "(详见「日志」)。已有的事实仍能找到,下次启动会再算一次(只算向量,不动已学到的排序和关联)。");
                return;
            }
            // Then the rows with no entry, as every start does.
            await _index.SyncAsync(ct);
        }
        else
        {
            _log?.LogInformation(
                "fact index: layout {Stored} -> {Layout}; rebuilding so recall can reach the entries again",
                stored ?? "(pre-marker)", Layout);
            // A PARTIAL REBUILD STILL WRITES THE MARKER; its empty refs are the retry queue. RebuildAsync forgets the
            // old graph and clears every ref BEFORE it re-indexes, so every entry it writes is at the current address,
            // and a fact it did not index — IndexAsync leaves a write unindexed when the embedder went down during the
            // pass — is a row with an EMPTY ref, which the next start's gated back-fill finishes right here, at the
            // current address. So the marker ("the entries are at the current address") is true after the pass. For a
            // round of the 3.4 bump it was held back until the count reached the fact TOTAL, and that made every retry
            // a whole DESTRUCTIVE rebuild — re-spending an annotation on every fact and discarding the decay and links
            // accumulated since — for the few facts a back-fill would have finished.
            //
            // ZERO is still no marker, because a zero is ambiguous: RebuildAsync degrades rather than throwing, so it
            // returns 0 both when every write stayed unindexed AND when it failed before it cleared the old refs,
            // which would then still address the old layout. Holding the marker costs nothing in the first case — with
            // every ref empty the next start takes the back-fill path above, not a rebuild — and is required in the
            // second. Proof: e2e-p52 case 9b, where the fake embedder goes down for one fact mid-pass: the marker is
            // written and the next start back-fills that fact and keeps every other node; confirmed to FAIL against
            // the total rule. (A pre-marker install since the 3.5 bump: 9b and 9d stage one by deleting the marker.)
            //
            // Its sentence says only that the rebuild did not complete and will be tried again — never a count, never
            // "补上": a zero also covers a rebuild that THREW after indexing some facts (RebuildAsync's catch returns
            // 0), where "none were built" would be false, and the next start then REBUILDS again (it finds refs) — and
            // only if the embedder answers its gate. Proof: e2e-p52 case 9d, whose zero pass keeps the marker and whose
            // next start back-fills onto the zero pass's own nodes.
            var indexed = await _index.RebuildAsync(ct);
            if (indexed == 0)
            {
                _log?.LogWarning("fact index: the layout rebuild indexed nothing; leaving the marker unset so the " +
                    "next start retries rather than recording a migration that may not have happened");
                _state?.AddWarning("事实索引的重建没有完成 —— 已有的事实仍能按关键词找到,下次启动会再试。");
                return;
            }
            if (indexed < facts.Count)
            {
                _log?.LogWarning("fact index: the layout rebuild indexed {Indexed} of {Total} facts; the rest stay " +
                    "unindexed (found by keyword) until the next start's back-fill", indexed, facts.Count);
                _state?.AddWarning($"事实索引的重建没有全部完成(建立了 {indexed}/{facts.Count} 条) —— "
                    + "其余的事实仍能按关键词找到,下次启动会补上。");
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
        // The SyncAsync branches above reach this whatever they indexed, for the reason the rebuild does: a fact a
        // back-fill left unindexed (the embedder down) is a row with an empty ref, which the next back-fill finishes.
        // The re-embed reaches it only when it COMPLETED (above).
        var layout = EmbedderOwed() ? VectorsOnlyMoved : Layout;
        if (layout != Layout)
            _log?.LogWarning("fact index: 语义 is bound to an embedder that is not wired this start; recording " +
                "layout {Recorded}, not {Layout}, so the start that has it back re-embeds every fact", layout, Layout);
        // Last, deliberately: a crash mid-rebuild leaves the marker unset too, so the next start retries
        // rather than settling into the silent FTS fallback this exists to prevent.
        _config.Set(LayoutKey, layout);
    }

    /// <summary>ONCE, with a llama.cpp embedder wired: when any indexed fact is long enough to have been refused at the
    /// OLD 512-token physical batch, record the vectors as owed, so this very start re-embeds every entry in place.
    /// <para><b>Why.</b> Until the Lyntai 3.4 bump the embedder section set no batch, so llama.cpp refused every fact past
    /// ~510 tokens whole, and the engine stored such a fact WITHOUT its vector while handing back its reference. Those
    /// rows kept their refs, and the back-fill revisits only EMPTY ones — so the window the preset launches with now
    /// (<see cref="Agent.Llm.Services.LlamaServerRuntime.EmbedBatch"/>, the row's declared one) would never reach them
    /// short of a reindex.</para>
    /// <para><b>In place since the Lyntai 3.5 bump</b> (D194). It used to clear the ref of each long fact and let the
    /// back-fill re-remember it onto the same node — which kept the node, but advanced its position, reset its age and
    /// paid one annotation per fact revisited (with 判断 on the CLI, the household's quota). The in-place pass writes
    /// only vectors: no fact is re-remembered or annotated, and decay, links and subjects stay exactly as they were. It
    /// re-embeds EVERY entry rather than the long ones, because no API narrows the pass — one embed each, once, where
    /// the old way paid a remember and an annotation per long fact.</para>
    /// <para><b>Which installs.</b> Length decides only whether the pass is owed (<see cref="LongAtOldBatchTokens"/>,
    /// estimated generously): with no long fact nothing is owed and nothing runs. Only a llama.cpp embedder, the one that
    /// refused at 512. Moved only from the CURRENT layout — at any other the start re-embeds or rebuilds anyway. A fact
    /// that is still past the NEW window is refused again, counted, and keeps no vector. Run after the gate, so a start
    /// whose embedder is down leaves this for the next; the key is set here, and the owed marker makes a pass that does
    /// not complete run again at the next start. Proof: e2e-p52 case 9e, confirmed to FAIL with this step removed.</para></summary>
    private async Task RevisitLongFactsOnceAsync()
    {
        if (!_index.Embeds || _config.Get(EmbedWindowKey) == EmbedWindowRevisited
            || !string.Equals(_settings.Current.Memory.SemanticSource, Agent.Llm.Sources.MemoryBackends.LlamaCpp,
                StringComparison.OrdinalIgnoreCase))
            return;
        var longFacts = (await _store.AllAsync()).Count(f => !string.IsNullOrEmpty(f.GraphRef)
            && Agent.Llm.Services.RerankPace.Tokens(f.Row.Content) > LongAtOldBatchTokens);
        if (longFacts > 0 && _config.Get(LayoutKey) == Layout)
        {
            _config.Set(LayoutKey, VectorsOnlyMoved);
            _log?.LogInformation("fact index: {Count} long fact(s) may have been refused their vectors by the embedder's " +
                "old 512-token batch, and its window is wider now; re-embedding every entry in place, once", longFacts);
        }
        _config.Set(EmbedWindowKey, EmbedWindowRevisited);
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
