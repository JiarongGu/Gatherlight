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
    /// startup, <c>DetachedFactBackfill</c>'s after a memory import or the seed, and the console's semantic reindex,
    /// which refuses with a sentence rather than discard the index for nothing — and with an embedder wired and not
    /// answering, they re-remember NOTHING. What keeps a lost vector RETRYABLE is no longer this probe but <see
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
    /// knew when this index first shipped, and picks up anything written while it was unavailable.</summary>
    Task<int> SyncAsync(CancellationToken ct = default);

    /// <summary>Discard the index and rebuild it from the record of truth. Returns facts indexed — fewer than the
    /// facts there are when the embedder went down during the pass (<see cref="IndexAsync"/> leaves those rows
    /// unindexed), which <c>FactIndexStep</c> reports without holding its layout marker back: the empty refs are the
    /// retry queue the next back-fill finishes at the current address.
    /// <para><b>Destructive of everything the index has learned</b> — decay positions, reinforcement and
    /// links all go. Reserved for when the facts themselves were replaced underneath it (a backup
    /// import); at startup use <see cref="SyncAsync"/>, or every restart would erase the accumulated
    /// ranking this exists to build.</para></summary>
    Task<int> RebuildAsync(CancellationToken ct = default);

    /// <summary>Re-derive every fact's SEMANTIC material. "Embed" for an embedder arm, "rephrase" for the
    /// Claude CLI one — both re-remember the fact, which is why one method serves both. Guarding this on
    /// "is an embedder registered" made it a silent no-op for the CLI arm, whose whole effect is at write
    /// time: binding it then reached future writes only, and an existing knowledge base could never gain
    /// phrasings from the one control offered for exactly that.
    /// <para>Two occasions need it and neither is served by
    /// <see cref="SyncAsync"/>, which back-fills only rows with an empty ref and so would embed nothing:
    /// turning semantic recall on over an already-populated graph, and CHANGING the embedding model.
    /// <para>The model change is the sharp one: vectors keep the width of the model that wrote them, and
    /// Lyntai's semantic search is fail-open on a dimension mismatch — it returns NOTHING rather than
    /// throwing. So a switched model without this leaves recall silently, permanently empty, looking
    /// exactly like a household that has no facts.</para>
    /// <para><b>This REBUILDS</b> — an entry is embedded as it is written and there is no re-embed door,
    /// so decay positions and links reset with it. Returns how many facts were indexed; 0 when NEITHER a
    /// semantic backend nor the rephrasing arm is bound — there is nothing to re-derive.</para>
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

    public FactIndex(IMemoryEngineFactory? engines, IKnowledgeStore store,
        IMemoryGraphStore? graph = null, ILogger<FactIndex>? log = null,
        ISemanticMemory? semantic = null, IVectorStore? vectors = null,
        Lyntai.Inference.ITextClient? llm = null, Kernel.Services.ServerConfigService? config = null,
        IEnumerable<Lyntai.Inference.IModelProvider>? providers = null,
        Lyntai.Inference.IProviderRouterFactory? routing = null)
    {
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

    public async Task<string?> IndexAsync(string kind, string topic, string content, long? factId = null,
        CancellationToken ct = default)
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
            if (!written.Ran.HasFlag(Lyntai.Memory.MemorySources.Annotation))
                _log?.LogWarning("fact index: {Kind}/{Topic} was stored without its subject handles — its annotation got " +
                    "no answer (a signed-out or failing CLI, a reply that is not the JSON asked for) or its subjects could " +
                    "not be recorded; nothing re-tags it until it is written again or the index is rebuilt (it stays " +
                    "findable by its words)", kind, topic);
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
    /// round that trade goes is not a close call.</para></summary>
    private async Task ExpandAkaAsync(string kind, string topic, string content, CancellationToken ct)
    {
        if (_llm is null || _config is null) return;
        var mem = _config.Current.Memory;
        // The SAVED binding, read per write rather than captured at startup: this arm registers nothing,
        // so there is no DI-time snapshot to go stale, and binding it must take effect on the next fact
        // rather than after a restart.
        if (!string.Equals(mem.SemanticSource, Agent.Llm.Sources.MemoryBackends.ClaudeCli,
                StringComparison.OrdinalIgnoreCase))
            return;
        try
        {
            var phrasings = await Agent.Llm.Sources.ClaudeCliSemanticSource.RephraseAsync(
                _llm, mem.EmbeddingModel, content, ct);
            if (phrasings.Count == 0) return;
            // Addressed by KEY. Searching for the fact we had just written could attach its phrasings to a
            // different one — see IKnowledgeStore.SetAkaAsync for how.
            await _store.SetAkaAsync(kind, topic, string.Join('\n', phrasings));
            _log?.LogInformation("fact index: stored {Count} phrasings for {Kind}/{Topic}",
                phrasings.Count, kind, topic);
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex,
                "fact index: could not expand {Kind}/{Topic}; it stays as findable as before", kind, topic);
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
        // Both arms re-derive the same way (re-remember every fact), so the question is not "is there an
        // embedder" but "is anything bound that a rewrite would re-derive".
        var rephrasing = _llm is not null
            && string.Equals(_config?.Current.Memory.SemanticSource,
                Agent.Llm.Sources.MemoryBackends.ClaudeCli, StringComparison.OrdinalIgnoreCase);
        if (_semantic is null && !rephrasing) return 0;

        // …AND THE TWO ARMS DO NOT COST THE SAME THING, which the first version of this got wrong by
        // routing both through the destructive path. The rephrasing arm's output is a knowledge COLUMN
        // (`aka`, picked up by the FTS trigger on UPDATE). Nothing of it lives in the graph, so rebuilding
        // the graph to produce it discards every decay position and link the household has accumulated in
        // exchange for absolutely nothing. An embedder is the opposite: its vectors belong to the graph's
        // entries and are written as each one is remembered, so re-embedding really is re-remembering.
        //
        // Being over-broad here is not a small matter — it made "bind the arm, then rebuild" advice that
        // silently cost weeks of accumulated ranking, and made measuring the arm's benefit an operation
        // nobody should agree to.
        if (_semantic is null) return await ExpandEachAsync(ct, progress);

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
    /// rephrased is simply as findable as it was.</para></summary>
    private async Task<int> ExpandEachAsync(CancellationToken ct, IProgress<(int Done, int Total)>? progress)
    {
        var facts = await _store.AllAsync();
        var done = 0;
        foreach (var (row, _) in facts)
        {
            ct.ThrowIfCancellationRequested();
            await ExpandAkaAsync(row.Kind, row.Topic, row.Content, ct);
            progress?.Report((++done, facts.Count));
        }
        _log?.LogInformation(
            "fact index: re-derived phrasings for {Done} fact(s) — graph, decay and links untouched", done);
        return done;
    }

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
                var reference = await IndexAsync(fact.Kind, fact.Topic, fact.Content, fact.Id, ct);
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
