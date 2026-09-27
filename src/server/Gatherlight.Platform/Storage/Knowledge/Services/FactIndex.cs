using Lyntai.Memory;
using Microsoft.Extensions.Logging;

namespace Gatherlight.Server.Platform.Storage.Knowledge.Services;

/// <summary>One ranked hit from the derived index: where the fact lives, and how well remembered it is.</summary>
/// <param name="GraphRef">Opaque address, resolved back to a <c>knowledge</c> row by the store.</param>
/// <param name="Retrievability">0..1, how far the entry has decayed. Reported to the agent so a faint
/// fact is visibly faint rather than silently equal to a fresh one.</param>
/// <param name="Degree">How many other facts this one is linked to.</param>
/// <remarks>A fact found through a SUBJECT HANDLE is an ordinary hit here, carrying a real retrievability and
/// degree: since Lyntai 3.1 the engine seeds recall from the handles itself and ranks those candidates with
/// every other. It used to be appended app-side and flagged, because that route measured neither number.</remarks>
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

/// <summary>The fact index's LAYOUT MARKER — one <c>app_config</c> key saying where the graph's entries and vectors are.
/// THREE writers: <c>FactIndexStep</c> at startup; <see cref="IFactIndex.ReindexSemanticAsync"/>, around its own pass; and
/// the 语义 bind (<c>MemoryRecallController</c>), which records a newly bound or changed embedder's vectors as owed
/// (<see cref="VectorsOwed"/>) for the restart to pay. The startup step overlaps neither, because the console is reachable
/// only once the startup steps have run; the bind and the pass CAN overlap — a bind landing mid-pass — which is why the
/// pass hands the marker back by compare-and-set (<see cref="PassPrefix"/>).</summary>
public static class FactIndexLayout
{
    public const string Key = "facts.index.layout";

    /// <summary>Entries and vectors at the current address (Lyntai 3.2's vector collection address, one scope).</summary>
    public const string Current = "3";

    /// <summary>Entries at the current address, VECTORS NOT — or not all of them from the model that is wired. The
    /// pre-3.2 layout; what <c>FactIndexStep</c> records while a bound embedder is not wired; what a revisit of facts the
    /// embedder's old batch refused records; and what a console re-embed records for the length of its pass, so a pass cut
    /// short (a restart, an update) is finished by the next start. With an embedder wired, the start that finds it
    /// re-embeds every entry IN PLACE (<see cref="IFactIndex.ReembedInPlaceAsync"/>); with none, it keeps the graph.</summary>
    public const string VectorsOwed = "2";

    /// <summary>The marker a CONSOLE re-embed writes for the length of its pass: <see cref="VectorsOwed"/> with a token of
    /// its own after it ("2:…"). Owed, like "2", to every reader (<see cref="IsVectorsOwed"/>) — so a pass a restart cuts
    /// short is finished by the next start — and the token is what lets the pass hand the marker back to
    /// <see cref="Current"/> by COMPARE-AND-SET: a 语义 bind that lands mid-pass writes a plain "2" (the new model's
    /// vectors are owed), the pass's swap from its own token then finds something else and leaves it, and the restart
    /// re-embeds with the new model. With one value for both, the pass would clear the bind's debt and the vectors would
    /// stay on the old model after the restart — the wrong width, semantic recall silently empty. An older build reads a
    /// token as an unknown layout and rebuilds, which is safe.</summary>
    public const string PassPrefix = VectorsOwed + ":";

    /// <summary>Is a stored marker "the vectors are owed" — plain <see cref="VectorsOwed"/>, or a console pass's token?</summary>
    public static bool IsVectorsOwed(string? stored) =>
        stored == VectorsOwed || (stored?.StartsWith(PassPrefix, StringComparison.Ordinal) ?? false);

    /// <summary>A fresh console-pass marker (<see cref="PassPrefix"/> and a token).</summary>
    public static string NewPassMarker() => PassPrefix + Guid.NewGuid().ToString("N")[..12];
}

/// <summary>What a re-embed in place did: how many graph entries got a vector from the wired embedder, how many it could
/// not embed (each keeps whatever vector it had, or none), and whether the pass COMPLETED — false when it threw, or when
/// entries failed and the embedder then did not answer a probe either (an outage, retried by the next start), true when
/// the embedder answers and the failures were its refusals of those inputs (past its window, above all: kept as they are
/// and never retried, as a write's classifier keeps a refused input).</summary>
public sealed record ReembedResult(int Reembedded, int Failed, bool Completed)
{
    public static readonly ReembedResult NotRun = new(0, 0, true);
}

/// <summary>Which part of a semantic reindex is running: re-embedding the graph in place (an embedder arm), back-filling
/// facts that had no index entry (after that), or storing phrasings (the Claude CLI arm).</summary>
public enum SemanticReindexStage { Reembed, BackFill, Rephrase }

/// <summary>Progress of a semantic reindex. <c>Reembed</c> reports once, before the pass, with the number of indexed facts
/// as its total and 0 done: the engine re-embeds in one call and reports nothing on the way.</summary>
public sealed record SemanticReindexProgress(SemanticReindexStage Stage, int Done, int Total);

/// <summary>What a semantic reindex did. <paramref name="Arm"/> is null when nothing is bound that it could re-derive.
/// <paramref name="Rederived"/> counts vectors re-embedded (graph entries, which may exceed facts: an edit leaves the old
/// content's entry behind) for an embedder arm, facts visited for the rephrasing arm. <paramref name="BackFilled"/> is
/// facts that had no index entry and were indexed after the pass.</summary>
public sealed record SemanticReindexResult(SemanticReindexStage? Arm, int Rederived, int Failed, bool Completed,
    int BackFilled)
{
    public static readonly SemanticReindexResult Nothing = new(null, 0, 0, true, 0);
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

    /// <summary>True when an EMBEDDER is wired, so the graph's entries carry vectors a recall reads. Asked
    /// by a layout migration that moved only the vectors: without an embedder there is nothing to move.</summary>
    bool Embeds { get; }

    /// <summary>Can a write be embedded RIGHT NOW? True when no embedder is wired — there is nothing to reach —
    /// or when one answered a probe embed.
    /// <para><b>A GATE, BY OUR COST POLICY — not a Lyntai gap</b> (owner decision, 2026-09-26, at the Lyntai 3.4 bump).
    /// Every path that re-remembers facts in bulk asks it first — <c>FactIndexStep</c>'s back-fill and layout rebuild at
    /// startup, <c>DetachedFactBackfill</c>'s after a memory import or the seed — and with an embedder wired and not
    /// answering, they re-remember NOTHING. So does every re-embed IN PLACE (<see cref="ReembedInPlaceAsync"/>: the
    /// startup one and the console's semantic reindex, which refuses with a sentence), though a failed re-embed loses
    /// nothing — each entry keeps the vector it had — because the pass would compute no vector, and the back-fill after it
    /// would re-remember, and annotate, facts whose writes lose their vector again. What keeps a lost vector RETRYABLE is no longer this probe but <see
    /// cref="IndexAsync"/>, which reads each write's <c>Ran</c> (Lyntai D175, shipped in 3.3.0). So without this gate
    /// nothing would be lost — every pending fact would simply be re-remembered on every pass of an outage, and each of
    /// those writes still pays its annotation: since Lyntai 3.5.0 a graph write EMBEDS BEFORE IT ANNOTATES (3.4 annotated
    /// first), but a write whose embed failed goes on to annotate unless <c>SkipAnnotationWithoutVector</c> is set, which
    /// we leave off (below). With 判断 on the Claude CLI, each is an annotation call against the household's quota, for a
    /// fact that has lost its vector and is walked again by the next back-fill. The probe is one embed; skipping costs
    /// nothing a later back-fill does not recover. ONE bulk path does
    /// NOT ask: a backup import's rebuild — its facts were replaced, so the old refs must go whatever the embedder says,
    /// and the rows it leaves unindexed are the startup back-fill's.</para>
    /// <para><b>AND A CLASSIFIER.</b> <see cref="IndexAsync"/> re-embeds a vector-less write's own content and, when that
    /// is refused too, sends this probe: answered, the write was refused for its own input (past the embedder's window)
    /// and keeps its reference; unanswered, the embedder is down and the row is left for the back-fill. A gate, not the
    /// detection: a probe can pass a moment before a write fails (Lyntai's D175 says so of the probe it deferred, as
    /// amended after 3.4.0), which is why a vector lost AFTER it passed is caught per write.</para>
    /// <para><b>It restates the engine's embedding route</b> — Lyntai's own filter (a backend producing vectors from
    /// text) is internal, so the implementation below repeats it. Should the library's filter change, this probe could
    /// answer differently from a write: a probe that passes wrongly costs one pass's annotations — and reads an outage as
    /// an input refusal, keeping that write's reference without a vector; one that fails wrongly defers the indexing with
    /// <c>FactIndexStep</c>'s warning — and reads an input refusal as an outage, so that fact is retried. <b>What would
    /// end the GATE</b>: Lyntai <c>docs/task-archive.md</c> Part 310's item "Let a graph write skip its annotation when
    /// its vector fails" — closed there as Part 304, <c>GraphMemoryOptions.SkipAnnotationWithoutVector</c>, RELEASED in
    /// 3.5.0 and left OFF by the 3.5 bump (2026-09-26). Set on the facts engine, it would make a retried write during an
    /// outage cost no annotation, so the quota reason would go and the back-fills could stop asking. <b>But the option
    /// cannot simply be switched on</b>: it skips the annotation of EVERY write owed a vector that got none — including
    /// one this classifier then KEEPS as an input refusal and never retries, which would stay without subjects for good
    /// (and there is no per-write override). So it stays off and this gate stays, until it can be enabled together with
    /// either a pass that re-annotates the kept vector-less facts (not built) or an embedder that cannot refuse a fact
    /// for its length (Lyntai's input segmentation on the embedding registration — unmeasured). The CLASSIFIER keeps
    /// the probe either way — it answers a different question. The household warning <c>FactIndexStep</c> attaches to a
    /// failed probe would then need another source — a start with nothing pending makes no write, so there is nothing to
    /// observe; <c>LlamaWarmStep</c> warns for a llama.cpp model that fails to warm, and nothing warns for the built-in
    /// embedder.</para></summary>
    Task<bool> EmbedderReadyAsync(CancellationToken ct = default);

    /// <summary>Index one fact; returns its address, or null if the index is unavailable or refused it, or — with an
    /// embedder wired — stored it WITHOUT its vector for a reason that may pass (the embedder down, or its content
    /// embedding fine on a second try): a null leaves the row's <c>graph_ref</c> empty, the retry queue the gated
    /// back-fill (<see cref="SyncAsync"/>) works through. A vector-less write whose own content is refused again while the
    /// embedder answers a probe was refused for its input, and keeps its address — see the
    /// implementation. <paramref name="factId"/> is the <c>knowledge</c> row, named in that case's log line. A write
    /// that keeps its address WITHOUT its subject handles — 判断 on, and its annotation unanswered — is logged too.</summary>
    Task<string?> IndexAsync(string kind, string topic, string content, long? factId = null,
        CancellationToken ct = default);

    /// <summary>Rank facts for a query, best first. Empty means "use FTS", never "you have nothing".</summary>
    Task<FactRanking> RankAsync(string query, string? kind, int limit, CancellationToken ct = default);

    /// <summary>Open one fact: full text plus what it is linked to.</summary>
    Task<FactExpansion?> ExpandAsync(string graphRef, CancellationToken ct = default);

    /// <summary>Index facts that have no entry yet, leaving indexed ones untouched. Cheap, idempotent,
    /// and safe to run at every startup — which is the point: it back-fills what the household already
    /// knew when this index first shipped, and picks up anything written while it was unavailable. WAITS for a running
    /// <see cref="RebuildAsync"/> or <see cref="ReembedInPlaceAsync"/> first: beside a rebuild, which clears every ref,
    /// it would read every fact as pending and annotate each a second time (<c>e2e-p48</c> case 10).</summary>
    Task<int> SyncAsync(CancellationToken ct = default);

    /// <summary>Discard the index and rebuild it from the record of truth. Returns facts indexed — fewer than the
    /// facts there are when the embedder went down during the pass (<see cref="IndexAsync"/> leaves those rows
    /// unindexed), which <c>FactIndexStep</c> reports without holding its layout marker back: the empty refs are the
    /// retry queue the next back-fill finishes at the current address.
    /// <para><b>Destructive of everything the index has learned</b> — decay positions, reinforcement and
    /// links all go, and each fact pays its annotation again. Reserved for when the ENTRIES are wrong rather than
    /// their vectors: the facts themselves were replaced underneath it (a backup import), or the entries sit at an
    /// address recall no longer reads (a pre-marker layout, at startup). Where only the vectors need redoing — a
    /// model turned on or changed, a vector address moved — use <see cref="ReembedInPlaceAsync"/>; at an ordinary
    /// startup use <see cref="SyncAsync"/>, or every restart would erase the accumulated ranking this exists to
    /// build. Forgets THROUGH THE ENGINE (<c>IForgettableMemory</c>), whose removal lock every write's vector index and
    /// every re-embed batch wait on, so no vector outlives it (Lyntai 3.5.1); serialised with
    /// <see cref="ReembedInPlaceAsync"/> and <see cref="SyncAsync"/> besides.</para>
    /// <para><b>NOT serialised with a single write</b> (<c>remember_fact</c>; the memory import's rows) — and the two races
    /// that left on <c>graph_ref</c>, which no Lyntai lock sees, are closed by CONDITIONAL ref writes rather than a lock
    /// (owner decision, 2026-09-27): a write that read a ref and writes or restores it after this pass re-indexed the row
    /// writes only while the ref is still the one it read (<c>IKnowledgeStore.SetGraphRefIfAsync</c>), so it cannot put back
    /// a ref to a node this pass forgot; and this pass writes only while the row still holds the content it indexed
    /// (<c>SetGraphRefIfContentAsync</c>), so an EDIT landing after its snapshot is not overwritten by the ref of the content
    /// it replaced. A lost race leaves the ref current, or empty for the back-fill. Proof: e2e-p48 case 11.</para></summary>
    Task<int> RebuildAsync(CancellationToken ct = default);

    /// <summary>Re-embed every graph entry IN PLACE with the embedder that is wired now — Lyntai's
    /// <c>IReindexableMemory.ReindexAsync</c> (D194, 3.5.0), which writes ONLY vectors: no entry is forgotten or
    /// re-remembered, so node ids, links, decay positions, reinforcement and subject handles all stay, and no fact is
    /// annotated. One embed per entry (<see cref="FactIndex.ReindexBatchSize"/>) and nothing else.
    /// <para>An entry the embedder cannot embed keeps the vector it had — none, when it never had one — and is counted
    /// <see cref="ReembedResult.Failed"/>; nothing retries it within the pass and nothing loops. When some failed, one
    /// probe decides what the pass was: answered, the embedder refused those inputs (past its window) and the pass
    /// COMPLETED; unanswered, it went down and the pass did not — the caller leaves the layout marker owed, so the next
    /// start re-embeds again. <b>Not gated here</b>: the callers ask <see cref="EmbedderReadyAsync"/> before they call
    /// it. A no-op (<see cref="ReembedResult.NotRun"/>) when no embedder is wired.</para></summary>
    Task<ReembedResult> ReembedInPlaceAsync(CancellationToken ct = default,
        IProgress<SemanticReindexProgress>? progress = null);

    /// <summary>Re-derive every fact's SEMANTIC material: vectors for an embedder arm, phrasings for the
    /// Claude CLI one. Guarding this on "is an embedder registered" made it a silent no-op for the CLI arm,
    /// whose whole effect is at write time: binding it then reached future writes only, and an existing
    /// knowledge base could never gain phrasings from the one control offered for exactly that.
    /// <para>Two occasions need it and neither is served by
    /// <see cref="SyncAsync"/>, which back-fills only rows with an empty ref and so would embed nothing:
    /// turning semantic recall on over an already-populated graph, and CHANGING the embedding model.</para>
    /// <para>The model change is the sharp one: vectors keep the width of the model that wrote them, and a vector of
    /// another width scores 0 against every query (Lyntai's <c>VectorMath.Cosine</c>) — unfindable rather than wrong,
    /// so a switched model without this leaves semantic recall silently empty, looking exactly like a household that
    /// has no facts.</para>
    /// <para><b>An embedder arm re-embeds IN PLACE</b> (<see cref="ReembedInPlaceAsync"/>) — nothing the graph has
    /// learned is lost and nothing is annotated — with the layout marker recording the vectors as owed for the length
    /// of the pass, and then back-fills any fact that had no index entry (those DO pay an annotation each, as every
    /// back-fill does). The rephrasing arm writes a knowledge column and touches no graph at all — and it is the SAVED
    /// arm that decides, so a rebind to it before the restart rephrases, though the embedder it replaced is still wired.
    /// <see cref="SemanticReindexResult.Nothing"/> when NEITHER a semantic backend nor the rephrasing arm is
    /// bound — there is nothing to re-derive.</para>
    /// <para><paramref name="progress"/> reports each stage (<see cref="SemanticReindexStage"/>). It exists because
    /// this can be minutes on a real corpus — the rephrasing arm is a model call per fact, the re-embed an embed per
    /// entry on whatever device the machine has — and an operation that long with no signal is indistinguishable
    /// from one that hung.</para></summary>
    Task<SemanticReindexResult> ReindexSemanticAsync(CancellationToken ct = default,
        IProgress<SemanticReindexProgress>? progress = null);
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
    /// vector collection is keyed by member, task AND scope, so kind-as-scope splits the embeddings
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
    /// write already, and the semantic seed source (<c>VectorRecallWiring</c>) is what lets a recall consider
    /// those neighbours. Writing here as well would embed each fact a second time into a collection whose hits
    /// carry a <c>facts/semantic#…</c> reference that no <c>knowledge</c> row stores — dropped on the way
    /// out by the ref match in <c>ByGraphRefsAsync</c>.</para></summary>
    private readonly ISemanticMemory? _semantic;

    /// <summary>The store the graph member embeds into. Read only to CLEAR it — see
    /// <see cref="DropGraphVectorsAsync"/>; the writing and searching are the engine's own.</summary>
    private readonly IVectorStore? _vectors;

    // The CLI 语义 arm: a one-shot model call per write that stores rephrasings, for installs with no
    // local model. Both nullable — the arm is off unless a household bound it, and everything here works
    // exactly as before when they have not.
    private readonly Lyntai.Inference.ITextClient? _llm;
    private readonly Kernel.Services.ServerConfigService? _config;

    /// <summary>Where the layout marker lives (<see cref="FactIndexLayout"/>) — read and written only by the console's
    /// re-embed, which records the vectors as owed for the length of its pass. Null leaves the marker alone.</summary>
    private readonly Kernel.Services.IAppConfigService? _layout;

    /// <summary>How many entries a re-embed in place sends the embedder per call — <c>GraphMemoryOptions.ReindexBatchSize</c>,
    /// set from this in <c>GatherlightApp</c>. <b>One, and why</b>: Lyntai's pass embeds a batch in ONE call and counts
    /// the whole batch <c>Failed</c> when that call fails (<c>GraphMemoryEngine.ReindexAsync</c>, D194), and llama.cpp
    /// refuses a request whole when ONE of its inputs is past the embedder's window
    /// (<c>docs/self-managed-llm-runtime.md</c>, 2026-09-26) — so at Lyntai's default of 32 a single over-long fact would
    /// cost 31 others their new vector, silently, on every pass. At one, only that fact keeps its old vector. The price is
    /// a request per entry, which at household scale is what the write path already pays (measured on the real binary —
    /// the runtime doc, 2026-09-27).</summary>
    public const int ReindexBatchSize = 1;

    /// <summary>Serialises the passes that walk every fact or graph entry: <see cref="RebuildAsync"/>,
    /// <see cref="ReembedInPlaceAsync"/> and the back-fill (<see cref="SyncAsync"/>). The engine's removal lock already
    /// keeps a VECTOR from outliving a forget — both the re-embed (D194) and, since Lyntai 3.5.1, every write's index step
    /// take it and re-read their entry — now that the rebuild forgets through the engine. What that lock cannot see is the
    /// app's own half: the rebuild clears every <c>graph_ref</c> and re-indexes from a snapshot, so a back-fill beside it
    /// would read every fact as pending and index each a second time. <b>Single writes do not take this</b> —
    /// <c>remember_fact</c> runs beside a rebuild, and its ref writes are conditional instead (see <see cref="RebuildAsync"/>). None of
    /// the three takes <c>DataWriteLock</c>, so holding this inside it (the import's rebuild runs outside it anyway)
    /// cannot deadlock, and none calls another while holding it. The rebuild waits for it with NO token — see
    /// <see cref="RebuildAsync"/> — because by the time it is called the facts underneath have already changed.</summary>
    private readonly SemaphoreSlim _bulk = new(1, 1);

    public FactIndex(IMemoryEngineFactory? engines, IKnowledgeStore store,
        IMemoryGraphStore? graph = null, ILogger<FactIndex>? log = null,
        ISemanticMemory? semantic = null, IVectorStore? vectors = null,
        Lyntai.Inference.ITextClient? llm = null, Kernel.Services.ServerConfigService? config = null,
        IEnumerable<Lyntai.Inference.IModelProvider>? providers = null,
        Lyntai.Inference.IProviderRouterFactory? routing = null,
        Kernel.Services.IAppConfigService? layout = null)
    {
        _layout = layout;
        _providers = providers;
        _routing = routing;
        _llm = llm;
        _config = config;
        _store = store;
        _graph = graph;
        _log = log;
        _semantic = semantic;
        _vectors = vectors;
        if (engines is not null && engines.TryGet(EngineName, out var engine)) _engine = engine;
    }

    public bool Available => _engine is not null;

    public bool Embeds => _engine is not null && _semantic is not null;

    // The backends the graph embeds through — read only to PROBE them; see EmbedderReadyAsync.
    private readonly IEnumerable<Lyntai.Inference.IModelProvider>? _providers;
    private readonly Lyntai.Inference.IProviderRouterFactory? _routing;

    public async Task<bool> EmbedderReadyAsync(CancellationToken ct = default) =>
        !Embeds || await EmbedsNowAsync(ProbeText, "a probe embed", ct);

    /// <summary>The probe's text — tiny, so an embedder that answers at all answers it.</summary>
    private const string ProbeText = "索引前的探测 · index probe";

    /// <summary>Does the embedder embed <paramref name="text"/> right now? One call through the same route a write
    /// embeds by — the probe (<see cref="EmbedderReadyAsync"/>) and the classifier's re-embed of a fact's own content
    /// (<see cref="IndexAsync"/>) alike. Never throws but for the caller's cancellation.</summary>
    private async Task<bool> EmbedsNowAsync(string text, string what, CancellationToken ct)
    {
        try
        {
            // The same routing the engine embeds a write through. Lyntai's EmbeddingRouting and its filter
            // (ProviderShapes.Embeds) are internal, so this RESTATES that one filter — a backend producing vectors
            // from text — and a pass here means a write would embed too. It serves our quota gate and IndexAsync's
            // classifier of a vector-less write, not the detection (that is IndexAsync's Ran check); the interface doc
            // on EmbedderReadyAsync says more.
            Func<Lyntai.Inference.ProviderCapabilities, bool> embeds = c => c.Supports(
                Lyntai.Inference.ProviderKinds.Vector, Lyntai.Inference.ProviderOperation.Complete,
                accepts: Lyntai.Inference.ProviderKinds.Text);
            var providers = _providers ?? [];
            var router = _routing?.For<Lyntai.Inference.VectorRequest, Lyntai.Inference.VectorResponse>(
                    providers, Lyntai.Inference.VectorResponse.Failure, embeds, logger: _log)
                ?? new Lyntai.Inference.ProviderRouter<Lyntai.Inference.VectorRequest, Lyntai.Inference.VectorResponse>(
                    providers, Lyntai.Inference.VectorResponse.Failure, embeds, logger: _log);
            if (!router.CanServe()) return false;
            var answer = await router.CallAsync(new Lyntai.Inference.VectorRequest(
                [text], Lyntai.Inference.EmbeddingRole.Document, Lyntai.Inference.ProviderConsumers.Memory), ct);
            if (!answer.IsOk)
                _log?.LogWarning("fact index: the embedder did not answer {What} ({Verdict}): {Detail}",
                    what, answer.Verdict, answer.Detail);
            return answer.IsOk && answer.Vectors.Count > 0 && answer.Vectors[0].Length > 0;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            _log?.LogWarning("fact index: the embedder did not answer {What}: {Msg}", what, ex.Message);
            return false;
        }
    }

    public Task<string?> IndexAsync(string kind, string topic, string content, long? factId = null,
        CancellationToken ct = default) => IndexCoreAsync(kind, topic, content, factId, null, ct);

    /// <summary><see cref="IndexAsync"/>, with a bulk pass's <paramref name="tally"/> — null for a single write, whose
    /// lost subjects get a line of their own.</summary>
    private async Task<string?> IndexCoreAsync(string kind, string topic, string content, long? factId,
        UnansweredTally? tally, CancellationToken ct)
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
            var written = await _engine.RememberAsync(
                new MemoryWrite(TaskKey, AllFacts, content, Headline: topic), ct);
            await ExpandAkaAsync(kind, topic, content, ct);

            // A WRITE THAT KEPT NO VECTOR IS CLASSIFIED, never assumed to be an outage. A failed write-time embed is not
            // an error to the engine: it stores the fact anyway and hands back a reference, and a row holding that
            // reference is never revisited — SyncAsync back-fills only EMPTY refs — so until the Lyntai 3.4 bump such a
            // fact stayed out of semantic recall for good while coverage read 100%. Since Lyntai 3.3 (D175) a write
            // reports what it did: `Ran` carries Lyntai.Memory.MemorySources.Similarity exactly when THIS write's vector
            // was indexed (Lyntai's flags enum — not this app's own MemorySources catalog in Agent/Llm/Sources). Asked
            // only when an embedder is wired: without one no write carries a vector, and none is owed. The graph's
            // SimilarityK stays at Lyntai's default: at 0 no write indexes a vector, so this would fire on every fact.
            //
            // Then the loss is CLASSIFIED, the fact's own content first — at most two calls, and only on a write that
            // kept no vector:
            //   1. Re-embed the fact's CONTENT (the Document role and Memory consumer the write used, the same route).
            //      It embeds now: whatever cost the write its vector has passed — a blip that cleared (a child crash the
            //      retry's own request reloads, the tail of a router restart) or a vector store that refused after a good
            //      embed (Lyntai sets no Similarity for either, and its router retries nothing by default). The row is
            //      left UNINDEXED for the gated back-fill, which remembers it again onto the same node (the graph dedups
            //      by content) with its vector.
            //   2. The content is refused again: send the tiny probe. It fails too — the embedder is DOWN: unindexed, as
            //      in 1. It answers — the embedder refused THIS input, twice, while it takes others: past its window, above
            //      all (llama.cpp refuses an input longer than its physical batch, or its context, whole:
            //      docs/self-managed-llm-runtime.md; since Lyntai 3.5.0 the physical-batch 500 classifies
            //      ContextWindowExceeded, its Part 307, so such a refusal no longer counts toward benching the embedder).
            //      Retrying would fail the same way at every start and pay the fact's annotation each time, while the
            //      fact stayed keyword-only; so it keeps its reference — graph-indexed without a vector, as every
            //      vector-less write was before the bump — and is never retried.
            // THE RESIDUAL: an input refused only INTERMITTENTLY — refused at the write and again at the re-check, while
            // the probe is answered — is read as refused for good and kept without a vector until a semantic reindex. And
            // a vector store that refuses after a good embed EVERY time reads as passing, so its fact is retried by every
            // back-fill, an annotation each; Lyntai itself calls that case "not foreseen" (docs/task-archive.md Part 304).
            if (Embeds && !written.Ran.HasFlag(Lyntai.Memory.MemorySources.Similarity))
            {
                if (await EmbedsNowAsync(content, "a re-embed of the fact's content", ct))
                {
                    _log?.LogWarning("fact index: {Kind}/{Topic} was stored without its vector, and its content embeds " +
                        "now — a passing failure; leaving it unindexed so the next back-fill retries it (it stays " +
                        "findable by FTS)", kind, topic);
                    return null;
                }
                if (!await EmbedderReadyAsync(ct))
                {
                    _log?.LogWarning("fact index: {Kind}/{Topic} was stored without its vector and the embedder does " +
                        "not answer a probe either; leaving it unindexed so the next back-fill retries it (it stays " +
                        "findable by FTS)", kind, topic);
                    return null;
                }
                _log?.LogWarning("fact index: the embedder refused the content of fact {Id} ({Kind}/{Topic}) twice while " +
                    "it answers a probe — most likely past its window; indexed without a vector and never retried",
                    factId?.ToString() ?? "(no row id)", kind, topic);
            }

            // A WRITE KEPT WITHOUT ITS SUBJECTS IS SAID (Lyntai 3.5.0, Part 303). `Ran` carries
            // Lyntai.Memory.MemorySources.Annotation only when the annotator ANSWERED and its subjects were recorded. Until
            // 3.5 the shipped LLM annotator caught its own failures and returned MemoryAnnotation.None — an answer, "about
            // nothing" — so the flag was set for a signed-out CLI too; it now returns MemoryAnnotation.Unanswered for a
            // refused or non-Ok call, an empty or unparseable reply and its own timeout, and logs the likeliest of them —
            // a non-Ok verdict, a reply with no JSON — at Debug only, below this file log's level. So without this line a
            // fact that lost its subjects left no trace, while the same outcome from an annotator that THROWS is a Warning
            // in Lyntai's own engine — hence Warning here too, and because the loss is not retried: this write keeps its
            // reference, and the back-fill revisits only empty ones.
            // Absent exactly when a real call went unanswered (or the subject store failed, which Lyntai also warns of):
            // an annotator is always registered (GatherlightApp's SwitchableAnnotationPolicy), and with 判断 switched OFF
            // it returns None without asking anything — answered, about nothing — so an "off" write sets the flag and says
            // nothing here. Asked only on the path that KEEPS the reference: a write returned unindexed above is
            // re-remembered by the next back-fill, which annotates it again.
            // ONE LINE PER WRITE for a single write, ONE PER PASS for a bulk one (UnansweredTally): while the annotator
            // fails, every write of a back-fill or rebuild loses its subjects the same way.
            if (!written.Ran.HasFlag(Lyntai.Memory.MemorySources.Annotation))
            {
                if (tally is not null) tally.Add(kind, topic);
                else
                    _log?.LogWarning("fact index: {Kind}/{Topic} was stored without its subject handles — its annotation " +
                        "got no answer (the annotator, the Claude CLI or a local chat model, failed, refused or replied " +
                        "with something other than the JSON asked for) or its subjects could not be recorded; nothing " +
                        "re-tags it until it is written again or the index is rebuilt (it stays findable by its words)",
                        kind, topic);
            }
            return Encode(written.Reference);
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "fact index: could not index {Kind}/{Topic}; it stays findable by FTS", kind, topic);
            return null;
        }
    }

    /// <summary>Store other ways to say this fact, when 语义 is bound to the CLI arm.
    ///
    /// <para>This is the write-time half of <see cref="Agent.Llm.Sources.ClaudeCliSemanticSource"/>: the
    /// layer's job is that a paraphrase finds the fact, and on a machine with no local model the only way
    /// to buy that is to write the paraphrases down. Costs one model call per fact — the same class of cost
    /// 判断 already pays per write — and nothing at recall time, which is the path the household waits on.
    ///
    /// <para>NEVER throws and never blocks the write. A fact that failed to gain phrasings is a fact that
    /// is merely as findable as it was before; a fact that failed to be written is data loss. Which way
    /// round that trade goes is not a close call.</para>
    /// <para>Returns whether phrasings were STORED — false for a fact the arm is not bound for, and for one whose call
    /// failed or came back empty, which is what a signed-out CLI does to every fact. A pass counts this, not the facts
    /// it visited, so it can say how many it really rephrased.</para></summary>
    private async Task<bool> ExpandAkaAsync(string kind, string topic, string content, CancellationToken ct)
    {
        if (_llm is null || _config is null) return false;
        var mem = _config.Current.Memory;
        // The SAVED binding, read per write rather than captured at startup: this arm registers nothing,
        // so there is no DI-time snapshot to go stale, and binding it must take effect on the next fact
        // rather than after a restart.
        if (!string.Equals(mem.SemanticSource, Agent.Llm.Sources.MemoryBackends.ClaudeCli,
                StringComparison.OrdinalIgnoreCase))
            return false;
        try
        {
            var phrasings = await Agent.Llm.Sources.ClaudeCliSemanticSource.RephraseAsync(
                _llm, mem.EmbeddingModel, content, ct);
            if (phrasings.Count == 0)
            {
                // Information, not Warning: a pass over a signed-out CLI would otherwise log one per fact, and it reports
                // the count itself (ExpandEachAsync) — the same volume rule as the annotation tally.
                _log?.LogInformation("fact index: no phrasings came back for {Kind}/{Topic} (the Claude CLI failed, refused " +
                    "or answered nothing); it stays as findable as before", kind, topic);
                return false;
            }
            // Addressed by KEY. Searching for the fact we had just written could attach its phrasings to a
            // different one — see IKnowledgeStore.SetAkaAsync for how.
            await _store.SetAkaAsync(kind, topic, string.Join('\n', phrasings));
            _log?.LogInformation("fact index: stored {Count} phrasings for {Kind}/{Topic}",
                phrasings.Count, kind, topic);
            return true;
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex,
                "fact index: could not expand {Kind}/{Topic}; it stays as findable as before", kind, topic);
            return false;
        }
    }

    /// <summary>How many candidates <see cref="RankAsync"/> asks the engine for — the over-ask its comment explains:
    /// min(3 × limit, 100) with no kind, 100 with one. Public because the reranker device verdict follows the recall path
    /// through it to the candidate count a verifier sees (<c>RerankDeviceVerdict.ReferenceCandidates</c>) — one writer.</summary>
    public static int RankLimit(string? kind, int limit) => kind is null ? Math.Min(limit * 3, 100) : 100;

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
            var want = RankLimit(kind, limit);
            var recall = await _engine.RecallAsync(
                new MemoryQuery(TaskKey, Scope: AllFacts, Query: query, Limit: want), ct);
            var hits = new List<FactHit>(recall.Items.Count);
            foreach (var i in recall.Items)
                hits.Add(new FactHit(Encode(i.Reference), i.Retrievability, i.Degree));
            return new FactRanking(hits, recall.Answered);
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

    public Task<int> SyncAsync(CancellationToken ct = default) => SyncAsync(ct, null);

    private async Task<int> SyncAsync(CancellationToken ct, IProgress<SemanticReindexProgress>? progress)
    {
        if (_engine is null) return 0;
        // Serialised with the two bulk passes — see _bulk. Beside a REBUILD, which clears every ref before it
        // re-indexes, a back-fill reads EVERY fact as pending and re-remembers all of them alongside it: each fact
        // annotated twice (a CLI call each with 判断 on), and its ref writes racing the rebuild's own. A detached
        // back-fill after a memory import could do exactly that while a backup import ran. Waiting, it starts after
        // the rebuild and finds only what is still unindexed. Beside a re-embed in place, Lyntai asks for writes to
        // pause (IReindexableMemory: a write mid-pass links against the old vectors). Never called with _bulk held.
        await _bulk.WaitAsync(ct);
        try
        {
            var pending = (await _store.AllAsync()).Where(f => string.IsNullOrEmpty(f.GraphRef)).ToList();
            if (pending.Count == 0) return 0;
            progress?.Report(new(SemanticReindexStage.BackFill, 0, pending.Count));
            var indexed = await IndexEachAsync(pending.Select(p => p.Row), ct, pending.Count,
                progress is null ? null : new Relay<(int Done, int Total)>(p =>
                    progress.Report(new(SemanticReindexStage.BackFill, p.Done, p.Total))));
            _log?.LogInformation("fact index: back-filled {Indexed}/{Pending} previously unindexed facts",
                indexed, pending.Count);
            return indexed;
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "fact index: back-fill failed; those facts stay findable by FTS");
            return 0;
        }
        finally
        {
            _bulk.Release();
        }
    }

    public async Task<int> RebuildAsync(CancellationToken ct = default)
    {
        if (_engine is null) return 0;
        // Serialised with the other bulk passes — see _bulk — and WAITED FOR WITH NO TOKEN, like the discard below. A
        // rebuild is asked for once the facts underneath have already been replaced (a backup import, a pre-marker
        // layout), so what must happen whatever the caller does next is the discard and the clearing of every ref; only
        // the re-indexing after it may be cut short, because an empty ref is exactly what the next back-fill finishes.
        // The wait sat outside the try with the caller's token: a backup import whose client gave up while it queued
        // behind a long console pass threw out of a method whose contract is to degrade rather than throw, and the
        // rebuild the import asked for never ran. Clearing the refs BEFORE the wait instead would re-open what _bulk
        // closes — a back-fill getting the semaphore first would read every fact as pending and annotate each, and the
        // rebuild would then annotate each again (e2e-p48 case 10). The cost: a caller that gave up keeps this pass
        // waiting until the one ahead of it ends.
        await _bulk.WaitAsync(CancellationToken.None);
        try
        {
            // Discard first. Anything that replaces the facts underneath the index — a backup import
            // above all — leaves it describing material the household no longer has, and a stale index
            // is worse than none: it ranks confidently for facts that are gone. This is also why this
            // is NOT wired to IRecordIndex, whose step runs at every startup: the discard would erase
            // the decay positions, reinforcement and links that are the whole point.
            //
            // THROUGH THE ENGINE, not its store (Lyntai 3.5.1). A write stores its entry and only then indexes the
            // vector, with the entry's full content as its payload; since 3.5.1 that index step waits on the engine's
            // removal lock and re-reads that its entry survived, so a forget cannot land between the two — but only a
            // forget that takes the same lock, on the same engine instance. The store's own ForgetAsync takes none, so
            // a remember_fact running beside a backup import could re-read its entry just before this deleted it and
            // then index its vector for a node that no longer exists. The engine's verb holds the lock, clears the
            // similarity index first, then the nodes. `_engine` is the one instance every write goes through (the
            // factory builds each engine once), and the composite fans the verb out to its one graph member.
            //
            // The discard runs to the end with NO token — the forget, the vector sweep and the ref clear are one unit,
            // short work, and a token honoured half-way through would leave refs naming what was just forgotten.
            if (_engine is IForgettableMemory forgettable)
                await forgettable.ForgetAsync(TaskKey, scope: null, CancellationToken.None);
            else if (_graph is not null)
            {
                _log?.LogWarning("fact index: the memory engine {Engine} cannot forget (no IForgettableMemory); " +
                    "forgetting through the graph store, which a concurrent write's vector index does not wait on",
                    _engine.GetType().Name);
                await _graph.ForgetAsync(GraphMember, TaskKey, scope: null, CancellationToken.None);
            }
            // The vectors go with them. The engine's forget clears the collections at the CURRENT address; this
            // prefix sweep also reaches the ones a pre-3.2 build named, which no forget of today's address touches
            // (and it is the whole cleanup when the forget went through the store above). Both callers want them
            // gone: an import replaced the facts, and a pre-marker layout left them at an address recall no longer
            // reads. A MODEL change no longer comes here — it re-embeds in place (ReembedInPlaceAsync), overwriting
            // each entry's vector at its address.
            await DropGraphVectorsAsync(CancellationToken.None);
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
            var indexed = await IndexEachAsync(facts.Select(f => f.Row), ct);
            _log?.LogInformation("fact index: rebuilt — {Indexed}/{Total} facts indexed", indexed, facts.Count);
            return indexed;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Only the re-indexing honours the token, so this is always AFTER the discard: every ref is empty or names a
            // node this pass wrote, and the next back-fill finishes the rest.
            _log?.LogInformation("fact index: rebuild cut short by its caller after the discard; the facts it did not " +
                "re-index have empty refs, which the next back-fill finishes (they stay findable by FTS)");
            return 0;
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "fact index: rebuild failed; recall stays on FTS");
            return 0;
        }
        finally
        {
            _bulk.Release();
        }
    }

    public async Task<ReembedResult> ReembedInPlaceAsync(CancellationToken ct = default,
        IProgress<SemanticReindexProgress>? progress = null)
    {
        // Nothing to re-embed INTO without an embedder: Lyntai's pass throws for a graph with no vector index or no
        // embedding backend, and a no-op is the honest answer here (the callers ask Embeds first anyway).
        if (!Embeds) return ReembedResult.NotRun;
        // Lyntai's graph engine and its composite both implement it (3.5.0); an engine that does not is a wiring change
        // this would otherwise pass over in silence, reporting a pass that re-embedded nothing as done. Not completed, so
        // the marker stays owed and every start says so in the log until the wiring is fixed.
        if (_engine is not IReindexableMemory reindexable)
        {
            _log?.LogWarning("fact index: the memory engine {Engine} cannot re-embed in place (no IReindexableMemory); " +
                "no vector was recomputed", _engine?.GetType().Name);
            return new ReembedResult(0, 0, Completed: false);
        }
        await _bulk.WaitAsync(ct);
        try
        {
            // The count is the FACTS a household knows (rows with an entry); the pass visits every ENTRY, which is more
            // when an edit left its previous content's node behind (the graph dedups by content hash). Reported up front
            // because the engine re-embeds in one call and says nothing until it returns.
            var facts = (await _store.AllAsync()).Count(f => !string.IsNullOrEmpty(f.GraphRef));
            progress?.Report(new(SemanticReindexStage.Reembed, 0, facts));
            var clock = System.Diagnostics.Stopwatch.StartNew();
            // ONE scope — every entry lives in AllFacts (FactIndexStep's layout), and it is the only one recall reads.
            var result = await reindexable.ReindexAsync(TaskKey, AllFacts, ct);
            // LYNTAI'S OWN RECIPE for a pass with failures (docs/memory.md, "Re-embed after changing the embedding
            // model"): run it once more. A failure that PASSED — a child crash the next request reloads, the tail of a
            // router restart — is then gone, and only what fails TWICE is classified. A rerun re-embeds the whole task,
            // not only the failed entries (no API narrows it): one more embed per entry, no annotation. Without it a
            // single blip read as a refused input, and that entry kept its old vector until the next reindex.
            var firstFailed = result.Failed;
            if (result.Failed > 0) result = await reindexable.ReindexAsync(TaskKey, AllFacts, ct);
            clock.Stop();
            // What failed twice is CLASSIFIED once, for the whole pass, as a write's loss is: a probe answered means the
            // embedder refused those inputs and the pass is done; unanswered, it is down and the pass must be run again.
            // A failed entry keeps the vector it had — Lyntai writes nothing for a batch whose embed failed — so nothing is
            // lost either way, and nothing retries it past the rerun: an input refused for its length would be refused
            // again. THE RESIDUAL: an input refused on both passes while the probe is answered is read as refused for good
            // — an outage that lifts between the second pass and the probe is read that way too.
            var completed = result.Failed == 0 || await EmbedderReadyAsync(ct);
            _log?.LogInformation("fact index: re-embedded {Indexed} graph entries IN PLACE in {Ms} ms ({Facts} indexed " +
                "facts; nodes, links, decay and subjects untouched; no annotation){Rerun}{Failed}", result.Indexed,
                clock.ElapsedMilliseconds, facts,
                firstFailed == 0 ? "" : $"; {firstFailed} failed on the first pass, so it ran once more",
                result.Failed == 0 ? "" : completed
                    ? $" — {result.Failed} could not be embedded twice while the embedder answers a probe (most likely " +
                      "past its window); they keep the vector they had, or none, and are not retried"
                    : $" — {result.Failed} failed twice and the embedder no longer answers a probe; the pass is owed again");
            if (completed) await DropPre32VectorsAsync(ct);
            return new ReembedResult(result.Indexed, result.Failed, completed);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            // A write that FAILS throws in Lyntai's pass (the vector index itself is broken) — possibly after earlier
            // batches were written: those entries are re-embedded and stay so. Nothing was forgotten, so the graph is as it
            // was; the pass is simply not done, and the result cannot say how far it got.
            _log?.LogWarning(ex, "fact index: re-embedding in place failed part-way; the graph is unchanged, some vectors " +
                "may already be recomputed, and the pass is owed");
            return new ReembedResult(0, 0, Completed: false);
        }
        finally
        {
            _bulk.Release();
        }
    }

    public async Task<SemanticReindexResult> ReindexSemanticAsync(CancellationToken ct = default,
        IProgress<SemanticReindexProgress>? progress = null)
    {
        // TWO ARMS NEED THIS, and guarding on `_semantic` alone silently served only one of them.
        //
        // `_semantic` is non-null exactly when an EMBEDDER was registered at startup. The Claude CLI arm
        // registers nothing by design — its work is at write time — so for a household bound to it this
        // method returned 0 and did nothing at all. The effect was that binding that arm applied only to
        // facts written AFTERWARDS: an existing knowledge base could never gain phrasings, the one control
        // offered for that reported success having done nothing, and the layer looked like it had no
        // effect. Same shape as everything else in this area — a capability that appears available and
        // quietly is not.
        //
        // So the question is not "is there an embedder" but "is anything bound that a pass would re-derive".
        //
        // AND THE SAVED ARM DECIDES, not what happens to be wired. `_semantic` is the embedder this process was STARTED
        // with; the rephrasing arm registers nothing and is read per write, so it is live from its bind on. Between a
        // rebind from an embedder to the CLI arm and the restart, both are true at once — and choosing by "an embedder is
        // wired" re-embedded every entry with the arm the household had just left, then reported 「N 条向量…」 for a layer
        // that now stores phrasings. The opposite rebind (CLI arm → an embedder) is the controller's to refuse before this
        // runs: that embedder is not wired until the restart, which re-embeds on its own (e2e-p52 case 11d).
        var rephrasing = _llm is not null
            && string.Equals(_config?.Current.Memory.SemanticSource,
                Agent.Llm.Sources.MemoryBackends.ClaudeCli, StringComparison.OrdinalIgnoreCase);
        if (_semantic is null && !rephrasing) return SemanticReindexResult.Nothing;

        // …AND THE TWO ARMS DO NOT COST THE SAME THING, which the first version of this got wrong by
        // routing both through the destructive path. The rephrasing arm's output is a knowledge COLUMN
        // (`aka`, picked up by the FTS trigger on UPDATE). Nothing of it lives in the graph, so rebuilding
        // the graph to produce it discards every decay position and link the household has accumulated in
        // exchange for absolutely nothing.
        //
        // Being over-broad here is not a small matter — it made "bind the arm, then rebuild" advice that
        // silently cost weeks of accumulated ranking, and made measuring the arm's benefit an operation
        // nobody should agree to.
        if (rephrasing)
        {
            // STORED, not visited: a fact whose rephrasing failed (a signed-out CLI, a refused call, an empty reply) is
            // counted as failed, so the panel cannot report phrasings nobody wrote.
            var (rephrased, visited) = await ExpandEachAsync(ct, progress);
            return new SemanticReindexResult(SemanticReindexStage.Rephrase, rephrased, visited - rephrased, true, 0);
        }

        // AN EMBEDDER'S VECTORS ARE RE-EMBEDDED IN PLACE (Lyntai D194, 3.5.0). They belong to the graph's entries, and
        // until 3.5 the engine offered no way to recompute one except re-remembering it — so this was RebuildAsync, which
        // forgot the graph, discarded every decay position, reinforcement and link, and paid an annotation per fact
        // (with 判断 on the Claude CLI, against the household's quota) for a pass whose only job was the vectors.
        // ReindexAsync writes vectors and nothing else. Both occasions that need it are served: turning the model ON (the
        // entries have no vector, so each gains one) and CHANGING it (each vector is overwritten at its address; one the
        // new model cannot embed keeps the old one, whose other width scores 0 — unfindable, not wrong).
        //
        // THE MARKER SAYS THE VECTORS ARE OWED for the length of the pass. The old rebuild healed an interrupted run by
        // clearing every ref up front, so the startup back-fill finished it; a re-embed clears nothing, so a pass cut short
        // by a restart or an update would leave the rest on the OLD model with refs intact — and no back-fill ever returns
        // to a row that has a ref. Recording the vectors as owed first makes the next start finish it (FactIndexStep
        // re-embeds in place at that marker). Moved only from the current layout or an owed one: any other value is a move
        // of the ENTRIES the next start still owes (a rebuild), and "vectors owed" would understate it.
        //
        // BACK TO CURRENT BY COMPARE-AND-SET, and only by a pass that COMPLETED — one the embedder went down during stays
        // owed. The pass writes a token of its own (FactIndexLayout.NewPassMarker) and swaps THAT for Current: a 语义 bind
        // landing mid-pass writes a plain "2", because the new model's vectors are owed, and a plain Set here would erase
        // that debt — the restart would then only sync, and the vectors stay on the model this pass used.
        var stored = _layout?.Get(FactIndexLayout.Key);
        string? passMarker = null;
        if (stored == FactIndexLayout.Current || FactIndexLayout.IsVectorsOwed(stored))
        {
            passMarker = FactIndexLayout.NewPassMarker();
            if (!_layout!.CompareAndSet(FactIndexLayout.Key, stored!, passMarker)) passMarker = null;   // someone got there first
        }
        var reembed = await ReembedInPlaceAsync(ct, progress);
        if (passMarker is not null && reembed.Completed
            && !_layout!.CompareAndSet(FactIndexLayout.Key, passMarker, FactIndexLayout.Current))
            _log?.LogInformation("fact index: the layout marker changed during the re-embed (a 语义 bind, most likely); " +
                "leaving it owed for the next start");

        // Then the facts that have NO entry — what the panel's coverage line counts as missing and offers this button for.
        // These are ordinary back-fill writes: each is remembered (an annotation with 判断 on) and its write embeds. Only
        // after a pass that completed — the embedder answered — which is the back-fills' own gate.
        var backFilled = reembed.Completed ? await SyncAsync(ct, progress) : 0;
        return new SemanticReindexResult(SemanticReindexStage.Reembed, reembed.Reembedded, reembed.Failed,
            reembed.Completed, backFilled);
    }

    /// <summary>Drop the graph member's vector collections before a REBUILD, which gives every entry a new id.
    /// <para>Forgetting the graph's NODES does not reach the vectors: they are the vector store's rows, keyed by
    /// node id, and a rebuilt node takes a fresh id — so the old rows would simply stay, unreferenced, still
    /// matched against, and holding the old content as their payload. (A vector of another WIDTH is not the danger
    /// this once said it was: Lyntai's <c>VectorMath.Cosine</c> scores it 0, so it ranks last rather than breaking
    /// the search. A re-embed in place, which keeps the ids, overwrites each entry's vector and needs none of
    /// this.)</para>
    /// <para>Located by PREFIX rather than by rebuilding the collection name: the name is Lyntai's to
    /// compose (member, task and scope — the separator changed in Lyntai 3.2, which is exactly why this
    /// does not restate it), and the one part of it this app can rely on is that it starts with the
    /// engine's own name — which also sweeps collections a pre-3.2 build left at the old address. Best-effort — a failure here costs recall quality on the next
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
            _log?.LogWarning(ex, "fact index: could not drop the old vectors; the rebuild leaves them behind, " +
                "addressed by ids no entry has any more");
        }
    }

    /// <summary>After a re-embed in place that COMPLETED, drop the vector collections a pre-3.2 build left at the OLD
    /// address — <c>{member}|{task}|{scope}</c>, which Lyntai 3.2 replaced with a U+001F separator.
    /// <para><b>Why.</b> A 2 → 3 move that used to rebuild now re-embeds every entry at the CURRENT address, so the old
    /// collection is never read again — and it holds a copy of each fact's content, as it was when last embedded, as its
    /// payload: stale text in the database for as long as nothing rebuilds.</para>
    /// <para><b>Why this prefix is safe.</b> It names the OLD format, which is history and cannot change; the pass never
    /// writes there (it writes at the address Lyntai composes today, which has no <c>|</c> after the member), so nothing
    /// this sweep can reach is live. It restates nothing about the current address. After a COMPLETED pass only: one that
    /// did not complete is run again, and the sweep has nothing to add to it. Best-effort, like the rebuild's sweep.</para></summary>
    private async Task DropPre32VectorsAsync(CancellationToken ct)
    {
        if (_vectors is not IListableVectorStore listable) return;
        try
        {
            var stale = await listable.ListCollectionsAsync(GraphMember + "|", ct);
            foreach (var collection in stale) await listable.RemoveCollectionAsync(collection, ct);
            if (stale.Count > 0)
                _log?.LogInformation("fact index: dropped {Count} vector collection(s) left at the pre-3.2 address, " +
                    "which no recall reads", stale.Count);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "fact index: could not drop the pre-3.2 vector collections; they stay, unread");
        }
    }

    /// <summary>How many facts index concurrently in a backfill/rebuild. Each index write can carry a
    /// model call (annotation), so serial cost is seconds PER FACT and a restore of a real corpus paid
    /// it N times over. Bounded, not unbounded: every slot is a spawned claude CLI process, and
    /// concurrent annotations cannot reuse each other's just-coined subject labels — a wider bound
    /// buys little and coins more near-duplicate subjects (they steer linking only, never recall).</summary>
    private const int IndexConcurrency = 4;

    /// <summary>Re-derive PHRASINGS for every fact, touching nothing else.
    ///
    /// <para>The non-destructive half of <see cref="ReindexSemanticAsync"/>, and the one that serves the
    /// Claude CLI arm. It writes `knowledge.aka` per fact — a column, picked up by the FTS trigger — so the
    /// graph, its decay positions and its links are all untouched. A household turning this arm on over an
    /// existing knowledge base pays a model call per fact and loses nothing.</para>
    ///
    /// <para>Serialised rather than fanned out like <see cref="IndexEachAsync"/>: every call here is a CLI
    /// spawn against the household's own account, and the point of the concurrency limit there is to bound
    /// exactly that. Progress is reported per fact because this is minutes of work on a real corpus.</para>
    ///
    /// <para>Never throws — <c>ExpandAkaAsync</c> swallows its own failures, so a fact that could not be
    /// rephrased is simply as findable as it was. Returns the facts it STORED phrasings for and the facts it VISITED:
    /// counting only the visits reported every fact rephrased on a signed-out CLI, where none was.</para></summary>
    private async Task<(int Stored, int Visited)> ExpandEachAsync(CancellationToken ct,
        IProgress<SemanticReindexProgress>? progress)
    {
        var facts = await _store.AllAsync();
        var (done, stored) = (0, 0);
        progress?.Report(new(SemanticReindexStage.Rephrase, 0, facts.Count));
        foreach (var (row, _) in facts)
        {
            ct.ThrowIfCancellationRequested();
            if (await ExpandAkaAsync(row.Kind, row.Topic, row.Content, ct)) stored++;
            progress?.Report(new(SemanticReindexStage.Rephrase, ++done, facts.Count));
        }
        _log?.LogInformation("fact index: re-derived phrasings for {Stored} of {Done} fact(s) — graph, decay and links " +
            "untouched", stored, done);
        if (stored < done)
            _log?.LogWarning("fact index: {Failed} of {Done} fact(s) got no phrasings in this pass — the Claude CLI failed, " +
                "refused or answered nothing for them (a signed-out CLI fails every one); they stay as findable as before",
                done - stored, done);
        return (stored, done);
    }

    private async Task<int> IndexEachAsync(IEnumerable<KnowledgeRow> facts, CancellationToken ct,
        int total = 0, IProgress<(int Done, int Total)>? progress = null)
    {
        var indexed = 0;
        var seen = 0;
        var tally = new UnansweredTally();
        using var slots = new SemaphoreSlim(IndexConcurrency, IndexConcurrency);
        var tasks = facts.Select(async fact =>
        {
            await slots.WaitAsync(ct);
            try
            {
                ct.ThrowIfCancellationRequested();
                var reference = await IndexCoreAsync(fact.Kind, fact.Topic, fact.Content, fact.Id, tally, ct);
                // Written even when null: it clears a ref left over from a discarded index, so a row is
                // never pointing at a node that no longer exists.
                //
                // …and ONLY WHILE THE ROW STILL HOLDS THE CONTENT THIS INDEXED. The pass works from a snapshot, and a
                // single write (remember_fact, the memory import) takes no lock beside it: an EDIT landing after the
                // snapshot was overwritten by the ref of the node holding the content it replaced — a non-empty ref, so no
                // back-fill ever returned to it, and the new text stayed out of the graph until the next rebuild. The edit
                // writes its own ref; losing this race leaves the row with that one, or empty for the back-fill.
                // Proof: e2e-p48 case 11.
                if (await _store.SetGraphRefIfContentAsync(fact.Id, reference, fact.Content))
                {
                    if (reference is not null) Interlocked.Increment(ref indexed);
                }
                else
                    _log?.LogInformation("fact index: {Kind}/{Topic} changed while it was being indexed; its ref is left " +
                        "to the write that changed it", fact.Kind, fact.Topic);
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
        tally.Report(_log);
        return indexed;
    }

    /// <summary>A bulk pass's writes kept WITHOUT their subject handles, counted for ONE line at the end of the pass rather
    /// than one per write: while the annotator fails — a signed-out CLI, a local chat model that is down — every write of a
    /// back-fill or rebuild loses its subjects the same way, and a Warning per fact buried the log under N copies of one
    /// cause. A single write (<c>remember_fact</c>) still gets its own line.</summary>
    private sealed class UnansweredTally
    {
        private readonly object _gate = new();
        private readonly List<string> _examples = new(3);
        private int _count;

        public void Add(string kind, string topic)
        {
            lock (_gate)
            {
                _count++;
                if (_examples.Count < 3) _examples.Add($"{kind}/{topic}");
            }
        }

        public void Report(ILogger? log)
        {
            if (_count > 0)
                log?.LogWarning("fact index: {Count} fact(s) in this pass were stored without their subject handles — " +
                    "their annotation got no answer (the annotator, the Claude CLI or a local chat model, failed, refused or " +
                    "replied with something other than the JSON asked for) or their subjects could not be recorded; nothing " +
                    "re-tags them until they are written again or the index is rebuilt (they stay findable by their words). " +
                    "For example: {Examples}", _count, string.Join(", ", _examples));
        }
    }

    /// <summary>An <see cref="IProgress{T}"/> that reports on the caller's thread, in order — unlike
    /// <see cref="Progress{T}"/>, which posts each report to the thread pool and may deliver them out of order.</summary>
    private sealed class Relay<T>(Action<T> report) : IProgress<T>
    {
        public void Report(T value) => report(value);
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
