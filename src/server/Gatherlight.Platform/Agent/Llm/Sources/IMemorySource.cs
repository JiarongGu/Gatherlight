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

    /// <summary>Register whatever this source needs at startup — a provider, a named client, an embedder, a
    /// vector store. A no-op for a backend that is already registered by default.</summary>
    void Register(LyntaiBuilder b, MemoryWiringContext ctx);
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
/// <para>There is deliberately no <c>ClaudeCliSemanticSource</c>: Anthropic ships no embeddings endpoint,
/// so one cannot exist. That absence IS the rule — see <see cref="IMemorySource"/>. It is a narrow technical
/// fact and NOT a reason to tell a household Claude cannot help meaning-based recall: through the judge it
/// is the strongest measured arm Lyntai has (miss 0.54 → 0.19).</para>
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
