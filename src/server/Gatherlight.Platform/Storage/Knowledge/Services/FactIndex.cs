using Lyntai.Memory;
using Microsoft.Extensions.Logging;

namespace Gatherlight.Server.Platform.Storage.Knowledge.Services;

/// <summary>One ranked hit from the derived index: where the fact lives, and how well remembered it is.</summary>
/// <param name="GraphRef">Opaque address, resolved back to a <c>knowledge</c> row by the store.</param>
/// <param name="Retrievability">0..1, how far the entry has decayed. Reported to the agent so a faint
/// fact is visibly faint rather than silently equal to a fresh one.</param>
/// <param name="Degree">How many other facts this one is linked to.</param>
public sealed record FactHit(string GraphRef, double Retrievability, int Degree);

/// <summary>A fact opened up: its own text plus the headlines it is connected to.</summary>
public sealed record FactExpansion(string GraphRef, string Headline, string? Content,
    IReadOnlyList<string> Neighbours);

/// <summary>A ranking plus 3.0's abstention signal: <c>Answered</c> is true when a judge found an
/// answer, false when a judge looked and found none, null when nothing was judged (no judge
/// registered, or it failed — fail-open).</summary>
public sealed record FactRanking(IReadOnlyList<FactHit> Hits, bool? Answered)
{
    public static readonly FactRanking Empty = new([], null);
}

/// <summary>
/// The graph recall index over <c>knowledge</c> — Lyntai's <see cref="IMemoryEngine"/> in the shape this
/// app needs. DERIVED, always: <c>knowledge</c> is the record of truth, this ranks it.
///
/// <para>What it adds over the FTS recall it sits in front of: entries <b>decay</b> by what has happened
/// in the index rather than by the clock, so a scraped price nobody has used since sinks beneath fresher
/// material; recall <b>refreshes</b> what it returned, so a fact that keeps proving useful never looks
/// stale; and facts recalled together get <b>linked</b>, so a later query can reach material it never
/// literally matched. Decay only ever ranks — nothing is deleted here.</para>
///
/// <para><b>Every method degrades to nothing rather than throwing.</b> A fact store that fails closed is
/// worse than one that ranks by relevance alone: the caller falls back to FTS and the household still
/// finds what they know. That is why <see cref="Available"/> exists and why the operations swallow into
/// a log — the index is an optimisation over a store that already worked.</para>
/// </summary>
public interface IFactIndex
{
    /// <summary>False when no memory engine is registered — callers then use FTS alone.</summary>
    bool Available { get; }

    /// <summary>Index one fact; returns its address, or null if the index is unavailable or refused it.</summary>
    Task<string?> IndexAsync(string kind, string topic, string content, CancellationToken ct = default);

    /// <summary>Rank facts for a query, best first. Empty means "use FTS", never "you have nothing".</summary>
    Task<FactRanking> RankAsync(string query, string? kind, int limit, CancellationToken ct = default);

    /// <summary>Open one fact: full text plus what it is linked to.</summary>
    Task<FactExpansion?> ExpandAsync(string graphRef, CancellationToken ct = default);

    /// <summary>Index facts that have no entry yet, leaving indexed ones untouched. Cheap, idempotent,
    /// and safe to run at every startup — which is the point: it back-fills what the household already
    /// knew when this index first shipped, and picks up anything written while it was unavailable.</summary>
    Task<int> SyncAsync(CancellationToken ct = default);

    /// <summary>Discard the index and rebuild it from the record of truth. Returns facts indexed.
    /// <para><b>Destructive of everything the index has learned</b> — decay positions, reinforcement and
    /// links all go. Reserved for when the facts themselves were replaced underneath it (a backup
    /// import); at startup use <see cref="SyncAsync"/>, or every restart would erase the accumulated
    /// ranking this exists to build.</para></summary>
    Task<int> RebuildAsync(CancellationToken ct = default);

    /// <summary>Re-embed every fact for SEMANTIC recall. Two occasions need it and neither is served by
    /// <see cref="SyncAsync"/>, which back-fills only rows with an empty ref and so would embed nothing:
    /// turning semantic recall on over an already-populated graph, and CHANGING the embedding model.
    /// <para>The model change is the sharp one: vectors keep the width of the model that wrote them, and
    /// Lyntai's semantic search is fail-open on a dimension mismatch — it returns NOTHING rather than
    /// throwing. So a switched model without this leaves recall silently, permanently empty, looking
    /// exactly like a household that has no facts.</para>
    /// <para><b>This REBUILDS</b> — an entry is embedded as it is written and there is no re-embed door,
    /// so decay positions and links reset with it. Returns how many facts were indexed; 0 when semantic
    /// recall is not configured.</para>
    /// <para><paramref name="progress"/> reports (done, total) as each fact lands. It exists because this
    /// is MINUTES of work on a real corpus — annotation is a model call per fact — and an operation that
    /// long with no signal is indistinguishable from one that hung.</para></summary>
    Task<int> ReindexSemanticAsync(CancellationToken ct = default,
        IProgress<(int Done, int Total)>? progress = null);
}

public sealed class FactIndex : IFactIndex
{
    /// <summary>The engine registered in <c>GatherlightApp</c>; its graph member is <c>facts/graph</c>.</summary>
    public const string EngineName = "facts";
    private const string GraphMember = EngineName + "/graph";

    /// <summary>Lyntai scopes memory by (task, scope). The task is this consumer — the household's
    /// granular facts.</summary>
    private const string TaskKey = "facts";

    /// <summary>ONE scope for every fact, rather than the fact's own <c>kind</c>.
    ///
    /// <para>Scope looks like the natural home for <c>kind</c> and costs the feature its main path. A
    /// vector collection is keyed <c>{member}|{task}|{scope}</c>, so kind-as-scope splits the embeddings
    /// into one collection per kind — and a recall that names no kind searches <c>…|facts|</c>, which is
    /// empty. That is the DEFAULT <c>recall_facts</c> call: the agent rarely knows the kind, so semantic
    /// recall was answering only the rare scoped ask. Measured 2026-08-21: scoped 3/3 queries improved,
    /// unscoped 0/3.</para>
    ///
    /// <para>Nothing is lost, because kind was never doing the filtering — <c>ByGraphRefsAsync</c> takes
    /// the kind and applies it in SQL when resolving refs back to rows. So a kind-filtered recall ranks
    /// over every fact and then narrows, which is why <see cref="RankAsync"/> over-asks harder when a kind
    /// is given. (Cross-kind LINKING is not among the gains — it already worked, because the graph's
    /// lexical recall spans scopes when the query names none, which is how <c>e2e-p48</c> has always
    /// linked its three differently-kinded facts.)</para>
    ///
    /// <para><b>Lyntai 3.0.2 makes kind-as-scope workable again and this deliberately stays.</b> That
    /// release teaches the graph's SEMANTIC half to span scopes on a null-scope recall, as its lexical
    /// half already did — so the split-collection problem above would be fixed at the source. Two reasons
    /// to keep one scope anyway. Spanning is built on <c>IListableVectorStore</c>, an OPTIONAL capability:
    /// a store that lacks it yields nothing there, silently, on the DEFAULT recall — the exact failure
    /// class this whole area kept producing. And spanning searches one collection per kind where this
    /// searches one, for the same vectors. The upside it would buy is a narrower search on the kind-filtered
    /// path, which is the rare one.</para></summary>
    private const string AllFacts = "all";

    private readonly IMemoryEngine? _engine;
    private readonly IMemoryGraphStore? _graph;
    private readonly IKnowledgeStore _store;
    private readonly ILogger<FactIndex>? _log;

    /// <summary>Registered only when the household turned semantic recall on AND an embedder resolved, so
    /// its presence is exactly "meaning-based recall is available" — which is all this field is read for.
    /// <para>NOT written to. The vectors that answer a recall are the GRAPH member's own: it embeds every
    /// write already, and <c>GraphMemoryOptions.SemanticSeedK</c> is what lets a recall consider those
    /// neighbours. Writing here as well would embed each fact a second time into a collection whose hits
    /// carry a <c>facts/semantic#…</c> reference that no <c>knowledge</c> row stores — dropped on the way
    /// out by the ref match in <c>ByGraphRefsAsync</c>.</para></summary>
    private readonly ISemanticMemory? _semantic;

    /// <summary>The store the graph member embeds into. Read only to CLEAR it — see
    /// <see cref="DropGraphVectorsAsync"/>; the writing and searching are the engine's own.</summary>
    private readonly IVectorStore? _vectors;

    public FactIndex(IMemoryEngineFactory? engines, IKnowledgeStore store,
        IMemoryGraphStore? graph = null, ILogger<FactIndex>? log = null,
        ISemanticMemory? semantic = null, IVectorStore? vectors = null)
    {
        _store = store;
        _graph = graph;
        _log = log;
        _semantic = semantic;
        _vectors = vectors;
        if (engines is not null && engines.TryGet(EngineName, out var engine)) _engine = engine;
    }

    public bool Available => _engine is not null;

    public async Task<string?> IndexAsync(string kind, string topic, string content, CancellationToken ct = default)
    {
        if (_engine is null) return null;
        try
        {
            // Headline = the topic the household chose. Left null, the engine would derive one by
            // truncating the content, and a fact's own topic is a better one-line form than its first
            // eighty characters. Grade stays associative (Inherit → the graph's role): the curated
            // markdown is this product's authoritative tier, and marking facts authoritative would
            // exempt them from the decay that is the whole reason for indexing them.
            // One write, one embedding: the graph member embeds its own entry when an embedder is wired.
            // The fact's kind rides on the knowledge row, which is what the recall filters on.
            var reference = await _engine.RememberAsync(
                new MemoryWrite(TaskKey, AllFacts, content, Headline: topic), ct);
            return Encode(reference);
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "fact index: could not index {Kind}/{Topic}; it stays findable by FTS", kind, topic);
            return null;
        }
    }

    public async Task<FactRanking> RankAsync(string query, string? kind, int limit,
        CancellationToken ct = default)
    {
        if (_engine is null) return FactRanking.Empty;
        try
        {
            // Over-ask, for two reasons that compound. The graph dedups by CONTENT HASH, so editing a
            // fact leaves its previous node behind with no row pointing at it; those resolve to nothing
            // and would otherwise shrink the page the agent asked for (orphans are cleared by
            // RebuildAsync, not by recall). And a KIND narrows the ranked list afterwards rather than
            // before it — see AllFacts — so a kind holding a tenth of the corpus needs a far wider
            // ranking to return a full page of its own.
            var want = kind is null ? Math.Min(limit * 3, 100) : 100;
            var recall = await _engine.RecallAsync(
                new MemoryQuery(TaskKey, Scope: AllFacts, Query: query, Limit: want), ct);
            return new FactRanking(
                [.. recall.Items.Select(i => new FactHit(Encode(i.Reference), i.Retrievability, i.Degree))],
                recall.Answered);
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "fact index: recall failed; falling back to FTS");
            return FactRanking.Empty;
        }
    }

    public async Task<FactExpansion?> ExpandAsync(string graphRef, CancellationToken ct = default)
    {
        if (_engine is null || Decode(graphRef) is not { } reference) return null;
        try
        {
            if (_engine is not IExpandableMemory expandable) return null;
            var recall = await expandable.ExpandAsync(reference, ct: ct);
            if (recall.Items.Count == 0) return null;
            // The expanded entry comes back first; anything after it is what it is linked to.
            var self = recall.Items[0];
            return new FactExpansion(Encode(self.Reference), self.Headline, self.Content,
                [.. recall.Items.Skip(1).Select(i => i.Headline)]);
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "fact index: expand failed for {Ref}", graphRef);
            return null;
        }
    }

    public async Task<int> SyncAsync(CancellationToken ct = default)
    {
        if (_engine is null) return 0;
        try
        {
            var pending = (await _store.AllAsync()).Where(f => string.IsNullOrEmpty(f.GraphRef)).ToList();
            if (pending.Count == 0) return 0;
            var indexed = await IndexEachAsync(pending.Select(p => p.Row), ct);
            _log?.LogInformation("fact index: back-filled {Indexed}/{Pending} previously unindexed facts",
                indexed, pending.Count);
            return indexed;
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "fact index: back-fill failed; those facts stay findable by FTS");
            return 0;
        }
    }

    public Task<int> RebuildAsync(CancellationToken ct = default) => RebuildAsync(ct, null);

    private async Task<int> RebuildAsync(CancellationToken ct, IProgress<(int Done, int Total)>? progress)
    {
        if (_engine is null) return 0;
        try
        {
            // Discard first. Anything that replaces the facts underneath the index — a backup import
            // above all — leaves it describing material the household no longer has, and a stale index
            // is worse than none: it ranks confidently for facts that are gone. This is also why this
            // is NOT wired to IRecordIndex, whose step runs at every startup: the discard would erase
            // the decay positions, reinforcement and links that are the whole point.
            if (_graph is not null) await _graph.ForgetAsync(GraphMember, TaskKey, scope: null, ct);
            // The vectors go with them. Forgetting a NODE does not reach its embedding — that lives in the
            // vector store keyed by node id, and a rebuilt node takes a fresh id — so every caller of this
            // method would otherwise leave the old ones behind. All three want them gone: an import
            // replaced the facts, a layout change moved them to a new collection, and a MODEL change made
            // the stored widths unusable. That last one is the dangerous case, since mixed widths in one
            // collection break every search against it, fail-open and therefore silently.
            await DropGraphVectorsAsync(ct);
            // Detach every row NOW, not one-by-one as each re-index lands: annotation makes this
            // loop minutes long on a real corpus, and an abort mid-way (client gone, an update
            // restart) would otherwise strand refs pointing at the discarded graph — which
            // SyncAsync cannot heal, because it back-fills only EMPTY refs. Cleared up front, an
            // aborted rebuild degrades to exactly the state the startup back-fill already repairs.
            await _store.ClearGraphRefsAsync();

            var facts = await _store.AllAsync();
            _log?.LogInformation(
                "fact index: rebuilding {Count} facts ({Concurrency} at a time; annotation may add a model call each)",
                facts.Count, IndexConcurrency);
            progress?.Report((0, facts.Count));
            var indexed = await IndexEachAsync(facts.Select(f => f.Row), ct, facts.Count, progress);
            _log?.LogInformation("fact index: rebuilt — {Indexed}/{Total} facts indexed", indexed, facts.Count);
            return indexed;
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "fact index: rebuild failed; recall stays on FTS");
            return 0;
        }
    }

    public async Task<int> ReindexSemanticAsync(CancellationToken ct = default,
        IProgress<(int Done, int Total)>? progress = null)
    {
        if (_semantic is null) return 0;
        // The vectors a recall reads belong to the GRAPH's entries, written as each one was remembered —
        // so re-embedding means re-remembering, which is exactly RebuildAsync. There is no cheaper door:
        // the engine embeds on write and offers no "re-embed what you already hold".
        //
        // That makes this destructive of decay positions and links, which SyncAsync never is. Both
        // occasions that need it have already lost the vectors anyway — turning the model ON (the graph
        // was built without an embedder, so its entries have none) and CHANGING it. Clearing the old
        // vectors is RebuildAsync's job, not this method's: every caller of it needs the same thing.
        _log?.LogInformation("fact index: re-embedding by rebuilding the index — decay positions and links reset");
        return await RebuildAsync(ct, progress);
    }

    /// <summary>Drop the graph member's vector collections, so a rebuild does not write NEW vectors into a
    /// collection still holding the OLD model's.
    /// <para>This is the model-change case, and it is the sharp one: a vector keeps the width of the model
    /// that wrote it, so mixing widths in one collection corrupts every search against it — and Lyntai's
    /// search is fail-open, returning nothing rather than throwing, which reads exactly like a household
    /// that has no facts. Forgetting the graph's NODES does not reach the vectors: they are the vector
    /// store's rows, keyed by node id, and a rebuilt node takes a fresh id — so the old rows would simply
    /// stay, unreferenced and still matched against.</para>
    /// <para>Located by PREFIX rather than by rebuilding the collection name: the name is Lyntai's to
    /// compose (<c>{engine}|{task}|{scope}</c> today), and the one part of it this app can rely on is that
    /// it starts with the engine's own name. Best-effort — a failure here costs recall quality on the next
    /// search, never the rebuild.</para></summary>
    private async Task DropGraphVectorsAsync(CancellationToken ct)
    {
        if (_vectors is not IListableVectorStore listable) return;
        try
        {
            var collections = await listable.ListCollectionsAsync(GraphMember, ct);
            foreach (var collection in collections) await listable.RemoveCollectionAsync(collection, ct);
            if (collections.Count > 0)
                _log?.LogInformation("fact index: dropped {Count} stale vector collection(s) before re-embedding",
                    collections.Count);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "fact index: could not drop the old vectors; a model CHANGE may leave " +
                "mixed-width vectors that match nothing");
        }
    }

    /// <summary>How many facts index concurrently in a backfill/rebuild. Each index write can carry a
    /// model call (annotation), so serial cost is seconds PER FACT and a restore of a real corpus paid
    /// it N times over. Bounded, not unbounded: every slot is a spawned claude CLI process, and
    /// concurrent annotations cannot reuse each other's just-coined subject labels — a wider bound
    /// buys little and coins more near-duplicate subjects (they steer linking only, never recall).</summary>
    private const int IndexConcurrency = 4;

    private async Task<int> IndexEachAsync(IEnumerable<KnowledgeRow> facts, CancellationToken ct,
        int total = 0, IProgress<(int Done, int Total)>? progress = null)
    {
        var indexed = 0;
        var seen = 0;
        using var slots = new SemaphoreSlim(IndexConcurrency, IndexConcurrency);
        var tasks = facts.Select(async fact =>
        {
            await slots.WaitAsync(ct);
            try
            {
                ct.ThrowIfCancellationRequested();
                var reference = await IndexAsync(fact.Kind, fact.Topic, fact.Content, ct);
                // Written even when null: it clears a ref left over from a discarded index, so a row is
                // never pointing at a node that no longer exists.
                await _store.SetGraphRefAsync(fact.Id, reference);
                if (reference is not null) Interlocked.Increment(ref indexed);
                // Counts every fact VISITED, not every one indexed: a fact the engine refused still moved
                // the work forward, and a bar that stalls on it would report a hang that is not happening.
                if (progress is not null) progress.Report((Interlocked.Increment(ref seen), total));
            }
            finally
            {
                slots.Release();
            }
        }).ToList();
        await Task.WhenAll(tasks);
        return indexed;
    }

    // A MemoryRef is (engine, id) and has to survive a round trip through a TEXT column. '#' cannot
    // appear in an engine name (they are hierarchical on '/'), so the split is unambiguous.
    private static string Encode(MemoryRef reference) => $"{reference.Engine}#{reference.Id}";

    private static MemoryRef? Decode(string graphRef)
    {
        var cut = graphRef.LastIndexOf('#');
        return cut > 0 ? new MemoryRef(graphRef[..cut], graphRef[(cut + 1)..]) : null;
    }
}
