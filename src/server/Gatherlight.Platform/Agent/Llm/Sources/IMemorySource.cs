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

    /// <summary>How this source's judge is wired for <c>ctx.Model</c>. Called at composition, alongside
    /// <see cref="IMemorySource.Register"/> — see <see cref="JudgeWiring"/> for why the source decides.</summary>
    JudgeWiring Wiring(MemoryWiringContext ctx);

    /// <summary>The model ANNOTATION runs on when this source is bound to <paramref name="model"/> — what the
    /// binding endpoint writes to <c>llm.model.memory</c>. Must agree with <see cref="Wiring"/>, which is why
    /// every implementation builds its wiring FROM this rather than restating the rule.</summary>
    string AnnotationModel(string model);

    /// <summary>Does <paramref name="model"/>, bound here, do only the CHECKING at recall, while annotation runs
    /// on another model entirely (<see cref="AnnotationModel"/>) — a reranker, which scores and never
    /// generates, so tagging goes to the default client (the Claude CLI)? The binding toast and the startup
    /// warnings are built on it; they used to say "annotation and checking" for every binding, which a
    /// reranker binding made false.
    ///
    /// <para><b>STATED, never inferred.</b> It was once derived as <c>AnnotationModel(model) != model</c>,
    /// which reads a source whose AnnotationModel merely NORMALISES a name — an alias, a case fold — as
    /// checks-only, and the toast would then tell that household its tagging moved to Claude. Default false;
    /// a source that overrides it does so BESIDE its <see cref="AnnotationModel"/>, because the two answer one
    /// question and must agree.</para></summary>
    bool ChecksOnly(string model) => false;

    /// <summary>The layer's cost line for this source bound to <paramref name="model"/>. It describes the BOUND
    /// arm (dev-conventions: a layer's cost line describes the bound arm), which is why the source owns it: an arm
    /// whose two halves cost different things has to say both.</summary>
    string Cost(string? model);
}

/// <summary>
/// A backend that makes a DIFFERENTLY-WORDED question find the fact.
///
/// <para><b>The job, not the mechanism</b> — and this summary said the mechanism for a long time, which is
/// how it came to exclude a whole group of households. It read "a backend that turns a fact into a VECTOR",
/// with a paragraph explaining that there is no <c>ClaudeCliSemanticSource</c> because Anthropic ships no
/// embeddings endpoint. The first clause was true; the conclusion was circular, because the layer was
/// defined as embeddings BY US. Defining the interface by its PURPOSE is what let the missing arm be
/// written, and it is the shape to keep.</para>
///
/// <para>Two routes serve it now, and implementations differ accordingly: an EMBEDDER arm registers a
/// vector store and <see cref="ProveAsync"/> returns a width; the CLI arm registers NOTHING and instead
/// stores other wordings of each fact at write time (<c>knowledge.aka</c>, in the trigram index), so
/// <see cref="ProveAsync"/> reports a phrasing COUNT with <c>EmbedProbe.What</c> saying so. Do not
/// reintroduce "every implementation registers an embedder" — it stopped being true the day this layer
/// gained a second kind of answer.</para>
///
/// <para>Note the shipped design is not the one this comment used to predict. It guessed a QUERY-rewrite
/// (rewrite the question into several phrasings, retrieve over each), which costs a model call on every
/// recall, on top of the judge's ~9 s. Rephrasing at WRITE time costs the same call once per fact and
/// nothing on the path the household waits on. The prediction was a reasonable design and the cheaper one
/// won; recorded because a comment that describes an unbuilt plan reads as a description of what exists.</para>
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
    /// <summary>A refusal BEFORE the proof, in the source's own words — null when there is none, which is the
    /// default. It exists because <see cref="ProveAsync"/> answers only "a vector or not": llama.cpp refusing to
    /// serve a model it does not list (a router we adopted, which the household must end; one we may not restart
    /// right now) came back as the generic "no vector" sentence, which names neither cause nor fix. Asked
    /// first; the proof runs only when this has nothing to say.</summary>
    Task<string?> WhyNotAsync(MemorySourceContext ctx, string model, CancellationToken ct = default) =>
        Task.FromResult<string?>(null);

    /// <summary>PROVE the model embeds before a setting is saved, and report the vector width it returned.
    /// <para>Being installed is not being usable, and the width decides whether a switch invalidates every
    /// stored vector. Null = it produced no vector, so nothing is saved — otherwise the failure would
    /// surface only as recall that finds nothing, which is indistinguishable from a household that knows
    /// nothing.</para></summary>
    Task<Services.EmbedProbe?> ProveAsync(MemorySourceContext ctx, string model, CancellationToken ct = default);

    /// <summary>The sentence a household reads when <see cref="ProveAsync"/> returned null for
    /// <paramref name="model"/> — what THIS arm's failure means and what to do about it.
    ///
    /// <para><b>The source answers, because the arms fail differently.</b> A CLI that produced no phrasings is a
    /// login-or-model problem; llama.cpp returning no vector is a wrong-model-or-runtime-down one; the built-in
    /// embedder returning none is its model FILES (it was seen on disk, so what is left is a load that failed).
    /// The bind endpoint used to hold one sentence for all of them — which named Ollama, a backend retired on
    /// 2026-08-22 — and then an if/else over source ids, the chain the source catalog exists to replace. No
    /// default, so a new arm cannot compile without saying how it fails.</para></summary>
    string ProveFailed(string model);
}
