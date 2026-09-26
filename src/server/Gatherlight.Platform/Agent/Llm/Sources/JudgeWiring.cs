using Gatherlight.Server.Platform.Agent.Llm.Services;
using Lyntai.Inference;
using Lyntai.Memory.Verification;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>What 判断 is made of once a source is bound: who ANNOTATES each write (a text client and its model)
/// and what VERIFIES each recall.
///
/// <para>Not to be confused with <see cref="MemoryJudgeWiring"/>: this is what the layer is BUILT from, whose
/// annotation model may differ from the bound one; that is what the panel reports as the BOUND backend and
/// model.</para>
///
/// <para><b>Why the source answers this, not the composition root.</b> The two halves stopped moving together
/// the day a reranker could verify: it scores pairs and never generates, so annotation has to stay on a
/// chat model. Branching on that in <c>GatherlightApp</c> would be the if/else chain the source catalog
/// exists to replace; each source states its own wiring instead.</para></summary>
/// <param name="AnnotationClient">The named Lyntai text client that annotates, or null for the default client
/// (the Claude CLI). A name selects BACKENDS, never permissions.
/// <para>The name is the WHOLE mechanism since Lyntai 3.1 (its D87): a named client narrows the candidate list
/// along with the provider pool. Before that it narrowed only the pool, so each source also had to append its
/// provider to the GLOBAL candidate list — which let the default client reach a backend it was never meant
/// to. That workaround (Lyntai Part 93) is gone.</para></param>
/// <param name="AnnotationModel">The model annotation runs on — the ONE value <c>DefaultModelByConsumer["memory"]</c>
/// holds and the model half of the <c>llm.route.memory</c> route a bind writes (its provider is the source's
/// <c>AnnotationProvider</c>). Never a reranker's id: the CLI would be asked for it.</param>
/// <param name="Verifier">Builds the recall verifier from the container.</param>
public sealed record JudgeWiring(
    string? AnnotationClient,
    string AnnotationModel,
    Func<IServiceProvider, IMemoryVerificationPolicy> Verifier)
{
    /// <summary>How many characters of each candidate's CONTENT an LLM judge is shown — Lyntai's
    /// <c>LlmVerificationOptions.ContentChars</c>, set by <see cref="Llm"/>. A longer note is cut and ends in "…", so a
    /// line is at most this many characters plus the ellipsis.
    ///
    /// <para><b>Why content, and not the headline.</b> Lyntai's LLM verifier shows the HEADLINE by default, and the fact
    /// index writes a fact's TOPIC as its headline (<c>FactIndex.IndexAsync</c>, <c>Headline: topic</c>) — an authored
    /// label, which says what a fact is about and not what it says. So the judge decided "did this answer?" from topics:
    /// against the real claude CLI 2.1.280, a fact whose topic was "weekend market" and whose content said when the market
    /// opens came back <c>answered=false</c>, the right verdict on what it was shown. Content ALONE, not
    /// <c>"topic — content"</c>, was MEASURED rather than argued: <c>docs/judge-bench.md</c> Run 1 (2026-09-23) found it
    /// EQUIVALENT to "topic — content" on top-1 and found@8 (2/0 pairs, p = 0.500, 95% [−2.2, +0.6] pp, inside ±3 pp),
    /// with ~24% less candidate text. For the llama.cpp chat judge, Run 3 (Gemma 3 1B) found no significant difference
    /// but not equivalence, leaning against content alone (top-1 −4.6 pp, p = 0.090; found@8 −4.2 pp, p = 0.076) —
    /// quote the lean with its figures.</para>
    ///
    /// <para><b>Why 400.</b> Facts are granular, so a real fact is whole at this length — every judge-bench fixture fact
    /// is ≤ 101 characters — and the cap exists so one pathological fact cannot multiply the cost of every recall that
    /// surfaces it: the judge is shown up to 400 candidates on a deep recall (<c>LlamaServerRuntime.ChatContextTokens</c>
    /// prices that prompt against this cap).</para>
    ///
    /// <para><b>How Lyntai cuts past it</b> (3.5.0, its Part 302): at the last space in the budget's LATTER half, else at
    /// the last text-element boundary, never inside a surrogate pair; flattened to one line first
    /// (<c>MemoryLine.Flatten</c>). Until 2026-09-27 the app showed content through its own decorator, which hard-cut at
    /// exactly 400; the owner accepted the difference (2026-09-26) — a note with a space in its characters 200–400 is cut
    /// there, at a word, so it may be shown as little as half the cap. Measured on the committed fixtures, every fact
    /// ≤ 400 characters renders identically, and 20 of the 90 long notes are cut 1–12 characters shorter. Through 3.4.0
    /// the same option cut at the last space however early, so a long Chinese note whose one space follows a leading date
    /// reached the judge as the date; that is why the decorator outlived <c>ContentChars</c>' release (3.3.0) through the
    /// 3.4 and 3.5 bumps.</para></summary>
    public const int ContentChars = 400;

    /// <summary>An LLM judge on <paramref name="client"/>: both halves on the same model. The verifier is shown each
    /// candidate's content, at most <see cref="ContentChars"/> characters of it, through Lyntai's own
    /// <c>LlmVerificationOptions.ContentChars</c>. It serves BOTH LLM judges — the Claude CLI and a llama.cpp chat GGUF —
    /// so whatever it shows one it shows the other. <see cref="ContentChars"/> quotes what each input measured.</summary>
    public static JudgeWiring Llm(string? client, string model) => new(client, model, sp =>
        new LlmMemoryVerificationPolicy(
            sp.GetRequiredService<ITextClientFactory>(),
            new LlmVerificationOptions { ClientName = client, ContentChars = ContentChars },
            sp.GetService<ILogger<LlmMemoryVerificationPolicy>>()));
}
