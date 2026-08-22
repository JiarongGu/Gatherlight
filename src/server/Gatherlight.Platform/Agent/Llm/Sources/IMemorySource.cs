using Lyntai;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>
/// What every recall backend can answer, regardless of which layer it serves.
///
/// <para><b>Why the layers get their own interfaces rather than one list with capability flags.</b> Claude
/// ships no embeddings endpoint, and Ollama refuses a chat model an embedding call and an embedding model a
/// chat call (verified 2026-08-21, both directions). So the two layers genuinely have disjoint backend sets
/// today. Expressing that as a capability STRING plus a predicate would put the rule somewhere a person can
/// get it wrong — and the previous version got it wrong in both directions at once, admitting an
/// uncatalogued embedder as a judge while disabling the switch on a machine that had chat models. Expressing
/// it as "no class implements <see cref="IMemorySemanticSource"/> for the CLI" makes it a fact about which
/// types exist. Nothing filters; the set IS the answer.</para>
///
/// <para>And it is not a hard binding: the day a backend can do both, it implements both interfaces, joins
/// both catalog lists, and appears in both toggles — with no other edit anywhere.</para>
/// </summary>
public interface IMemorySource
{
    /// <summary>Stable id, stored in settings.json and sent by the console: <c>claude-cli</c> · <c>ollama</c>.</summary>
    string Id { get; }

    /// <summary>What the toggle button says.</summary>
    string Name { get; }

    /// <summary>One line under the toggle: what choosing this costs, and what it buys.</summary>
    string Description { get; }

    /// <summary>Can it serve its layer here and now — and when it cannot, why, in a sentence with a fix in
    /// it. Three causes with three different fixes get three different sentences.</summary>
    Task<SourceStatus> StatusAsync(MemorySourceContext ctx, CancellationToken ct = default);

    /// <summary>The models this source offers for its layer. Empty is a legitimate answer and must be paired
    /// with a <see cref="StatusAsync"/> reason — an empty picker with no sentence beside it is precisely the
    /// dead control this design replaces.</summary>
    Task<IReadOnlyList<ModelOption>> ModelsAsync(MemorySourceContext ctx, CancellationToken ct = default);

    /// <summary>The endpoint this backend talks to, resolved from config and guarded by whatever rule owns
    /// that address. Null when it has none (the CLI is a process, not a URL) or when the configured one was
    /// refused.
    ///
    /// <para>On the SOURCE rather than on the caller because only the source knows which config field is
    /// its own — and putting it here means there is exactly one place that answers "where does this backend
    /// talk", which is what stops an install embedding against one host while reporting another.</para></summary>
    string? Endpoint(MemorySourceSettings s);

    /// <summary>Does choosing this backend require the household to supply an address? True only for a
    /// service we do not manage. Declared rather than inferred from a null <see cref="Endpoint"/>, because
    /// the CLI also has no endpoint and asking it for one would be nonsense.</summary>
    bool NeedsEndpoint { get; }

    /// <summary>Is this backend completely enough configured to be WIRED? False means a half-configured
    /// binding, and the caller falls back rather than registering a provider against a missing address —
    /// the same "half-configured stays off" rule 语义 has always had for a model.</summary>
    bool IsConfigured(MemorySourceSettings s);

    /// <summary>Register whatever this source needs at startup — a provider, a named client, an embedder, a
    /// vector store. A no-op for a backend that is already registered by default.</summary>
    void Register(LyntaiBuilder b, MemoryWiringContext ctx);

    /// <summary>Does binding this source need a RESTART before it does anything?
    ///
    /// <para>True for every arm whose <see cref="Register"/> wires something into the container — the
    /// container is built once, so a new embedder or provider only exists after a restart, and the panel
    /// says so. False for an arm whose effect is at WRITE time and reads the saved binding per call.</para>
    ///
    /// <para><b>Why the source answers and not the controller.</b> The panel decides "a restart is owed" by
    /// comparing the SAVED backend against the RUNNING one, and it infers the running one from whether the
    /// container holds an <c>ISemanticMemory</c>. An arm that registers nothing never produces one — so it
    /// read as permanently un-applied, and the banner asked forever for a restart that would change
    /// nothing. That exact failure is recorded in <c>MemoryRecallPanel</c>'s own comment about a remembered
    /// model compared against a null running one; this is the same bug one case over, and a per-id check in
    /// the controller would be the if/else chain the source catalog exists to avoid.</para></summary>
    bool TakesEffectOnRestart { get; }

    /// <summary>WHOSE runtime this is on THIS install — see <see cref="RuntimeOrigin"/> for why the panel
    /// has to say.
    ///
    /// <para>Takes the context because for two backends the answer is not a property of the backend: the
    /// app provisions both Ollama and the claude CLI into the data folder, and a household may equally have
    /// their own. Only <c>Locate()</c> knows which copy won, so only a per-call question can answer
    /// truthfully. A constant here would have to pick one and be wrong for the other half of installs —
    /// which is the shape of the mistake that made this member necessary.</para></summary>
    RuntimeOrigin Origin(MemorySourceContext ctx);

    /// <summary>Which of the three headings this source appears under — see <see cref="MemoryGroups"/> for
    /// why the picker groups at all. A constant per source: unlike <see cref="Origin"/>, nothing about the
    /// install changes who manages a given implementation.</summary>
    string Group { get; }
}

/// <summary>
/// A backend that can answer a memory JUDGEMENT — a subject label on every write, a verdict on which
/// candidates actually answered on every recall.
/// </summary>
public interface IMemoryJudgeSource : IMemorySource
{
    /// <summary>Refuse a model that is installed, well-formed and unable to do this job. Both memory
    /// policies are FAIL-OPEN, so an accepted-but-incapable model surfaces as recall that quietly never
    /// improves — never as an error. Null when the model is fine; otherwise the sentence explaining the
    /// refusal, naming the model.</summary>
    Task<string?> RejectAsync(MemorySourceContext ctx, string model, CancellationToken ct = default);

    /// <summary>The Lyntai client name the judge runs on, or null for the default client. A name selects
    /// BACKENDS, never permissions.</summary>
    string? ClientName { get; }

    /// <summary>Provider ids to append to the GLOBAL candidate list, after <c>claude-cli</c>.
    /// <para>Required because <c>LlmRouterFactory.For()</c> narrows a named client's provider POOL but
    /// reuses the same candidates: a client pooled over a provider absent from the global list matches
    /// nothing, and every call fails — silently, since the policies are fail-open. Empty for a source that
    /// registers no provider of its own.</para></summary>
    IReadOnlyList<string> CandidateProviderIds { get; }
}

/// <summary>
/// A backend that can turn a fact into a VECTOR, so a paraphrase finds it.
///
/// <para>There is no <c>ClaudeCliSemanticSource</c> because THIS INTERFACE asks for a vector: <see
/// cref="ProveAsync"/> returns a width, and every implementation registers an embedder plus a vector store.
/// Anthropic ships no embeddings endpoint, so Claude cannot satisfy that shape.
///
/// <para><b>Do not upgrade that into "Claude cannot do meaning-based recall", which is what the earlier
/// wording here did.</b> "An absent class, not an exclusion" is true and says nothing on its own: the class
/// is absent because WE defined this layer as embeddings. The layer's purpose — a paraphrase finds the fact
/// — has a non-vector route Claude can serve, namely rewriting the query into several phrasings and running
/// the existing FTS-trigram + graph retrieval over each. That would change what is RETRIEVABLE, which is
/// the property separating this layer from the judge, so it belongs here rather than there. It is UNBUILT,
/// not impossible: Lyntai exposes no query-rewrite seam (its <c>ExpandAsync</c> is graph-neighbour
/// expansion), and it would cost a model call on every recall, on top of the judge's. A real design
/// decision — which is exactly why it must not hide behind a sentence about a missing file.</para>
///
/// <para>It is a narrow technical
/// fact and NOT a reason to tell a household Claude cannot help meaning-based recall: through the judge it
/// is the strongest measured arm Lyntai has (miss 0.5357 → 0.1857). Strongest, not cheapest — Lyntai priced
/// that arm at $66 per 1,000 recalls through the CLI and concluded the cost-effective judge is a free local
/// `gemma3:4b` at 0.2571, which already beats its ground-truth reference. So this figure belongs in a
/// sentence about what a judge CAN do, never in one about what to turn on first; that sentence has to cite
/// the local number, or it recommends the arm the measurement argues against.</para>
/// </summary>
public interface IMemorySemanticSource : IMemorySource
{
    /// <summary>PROVE the model embeds before a setting is saved, and report the vector width it returned.
    /// <para>Being installed is not being usable, and the width decides whether a switch invalidates every
    /// stored vector. Null = it produced no vector, so nothing is saved — otherwise the failure would
    /// surface only as recall that finds nothing, which is indistinguishable from a household that knows
    /// nothing.</para></summary>
    Task<Services.EmbedProbe?> ProveAsync(MemorySourceContext ctx, string model, CancellationToken ct = default);
}
