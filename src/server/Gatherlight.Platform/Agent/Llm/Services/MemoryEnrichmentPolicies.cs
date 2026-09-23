using Gatherlight.Server.Platform.Kernel.Services;
using Lyntai.Memory.Annotation;
using Lyntai.Memory.Verification;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>
/// The live on/off for the claude-CLI memory enrichment.
///
/// <para><b>Why a switch here rather than a registration.</b> Whether the enrichment runs is a
/// dynamic, tunable value, and this codebase already says where those belong: <c>ServerConfig</c>'s own
/// doc reserves <c>settings.json</c> for "what must exist before the DB opens", with everything tunable in
/// <c>app_config</c> — which is what the cortex panel edits. The enrichment's MODEL already lives there
/// (<c>llm.model.memory</c>); having its on/off somewhere else, behind a restart, split one feature's
/// controls across two stores.</para>
///
/// <para><b>Why decorating works at all.</b> Both seams already define a "no opinion" result that the
/// engine treats as identical to having no policy registered — <see cref="MemoryAnnotation.None"/> and
/// <see cref="MemoryVerification.NoOpinion"/>. So "off" is not a new code path to be got right; it is a
/// state the library already handles, and one a model outage produces anyway. That is what makes the
/// switch safe to flip at runtime rather than at startup.</para>
///
/// <para>Default ON when unset: the enrichment shipped on with the Lyntai 3.0 adoption, and defaulting it
/// off would silently degrade recall for every existing household on upgrade.</para>
/// </summary>
public static class MemoryEnrichment
{
    /// <summary>app_config key. Absent = on; "0" = off.</summary>
    public const string Key = "memory.enrichment.enabled";

    public static bool IsOn(IAppConfigService config) => config.Get(Key) != "0";

    public static void Set(IAppConfigService config, bool on)
    {
        if (on) config.Delete(Key);      // absent = the default, so "on" leaves no row behind
        else config.Set(Key, "0");
    }
}

/// <summary>What the judge was actually WIRED with when the container was built — as opposed to what
/// settings.json says now.
///
/// <para>The transport is a startup registration (a provider plus a named <c>ITextClient</c>), so between
/// saving a change and restarting, the saved value and the running one disagree. The console reports both,
/// exactly as the semantic layer reports <c>enabled</c> separately from <c>active</c>. This exists because
/// the panel now NAMES the backend on the layer's header: a badge reading the saved setting would announce
/// a model that is not doing the work, which is the class of defect — a label asserting something the code
/// is not doing — that the surrounding rename is fixing.</para></summary>
/// <param name="Transport">The bound source's id — <c>claude-cli</c> or <c>ollama</c>. Deliberately the
/// same vocabulary the SAVED setting is reported in: two vocabularies for one comparison can never come
/// out equal, which reads on screen as a restart that is permanently owed.</param>
/// <param name="Model">The model in effect on it.</param>
public sealed record MemoryJudgeWiring(string Transport, string? Model);

/// <summary>Runs the real annotator only while the switch is on. Registered BEFORE
/// <c>AddMemoryAnnotation()</c>, whose <c>TryAddSingleton</c> then stands down — the BYO seam that
/// registration documents.</summary>
public sealed class SwitchableAnnotationPolicy : IMemoryAnnotationPolicy
{
    private readonly IMemoryAnnotationPolicy _inner;
    private readonly IAppConfigService _config;

    public SwitchableAnnotationPolicy(IMemoryAnnotationPolicy inner, IAppConfigService config)
    {
        _inner = inner;
        _config = config;
    }

    public Task<MemoryAnnotation> AnnotateAsync(MemoryAnnotationRequest request, CancellationToken ct = default)
        // Read per call, not cached: the point of moving this out of settings.json was that it takes
        // effect without a restart.
        => MemoryEnrichment.IsOn(_config)
            ? _inner.AnnotateAsync(request, ct)
            : Task.FromResult(MemoryAnnotation.None);
}

/// <summary>Runs the real verifier only while the switch is on. Off returns
/// <see cref="MemoryVerification.NoOpinion"/> — "could not decide", which the engine reinforces normally
/// for. Deliberately NOT <see cref="MemoryVerification.NothingRelevant"/>: that would assert every recall
/// found nothing useful and teach the engine exactly the wrong thing.</summary>
public sealed class SwitchableVerificationPolicy : IMemoryVerificationPolicy
{
    private readonly IMemoryVerificationPolicy _inner;
    private readonly IAppConfigService _config;

    public SwitchableVerificationPolicy(IMemoryVerificationPolicy inner, IAppConfigService config)
    {
        _inner = inner;
        _config = config;
    }

    public Task<MemoryVerification> VerifyAsync(MemoryVerificationRequest request, CancellationToken ct = default)
        => MemoryEnrichment.IsOn(_config)
            ? _inner.VerifyAsync(request, ct)
            : Task.FromResult(MemoryVerification.NoOpinion);
}

/// <summary>Shows an LLM judge each candidate's CONTENT, not only its headline.
///
/// <para><b>Why.</b> Lyntai's <see cref="LlmMemoryVerificationPolicy"/> renders each candidate as
/// <c>"{n}. {Headline}"</c>, and the fact index writes a fact's TOPIC as its headline — so the judge decided
/// "did this answer the question?" from topics alone. Verified against the real claude CLI 2.1.280: a fact whose
/// topic was "weekend market" and whose content said when the market opens came back <c>answered=false</c>,
/// which is the correct verdict on what the judge was shown. Lyntai's D108 gave every verifier
/// <see cref="MemoryVerificationCandidate.Content"/> and left the choice of text to the POLICY; its reranker
/// policy reads content, its LLM policy has no option to.</para>
///
/// <para><b>A WORKAROUND FOR A LYNTAI GAP — delete it when the gap closes.</b> Filed as Lyntai TASKS.md
/// <b>Part 274</b> (a policy-level opt-in on <c>LlmVerificationOptions</c> to read <c>Content ?? Headline</c>).
/// When that ships, set the option where the LLM verifier is built and delete this class: the option would
/// render the same text, so keeping both would only double the content.</para>
///
/// <para>Topics stay the STORED headline, so <c>expand_fact</c>'s neighbour list is unchanged; only what the judge
/// reads changes. <c>GATHERLIGHT_JUDGE_INPUT=headline</c> turns it off — a measurement knob for
/// <c>dev.mjs judge-bench</c>, not a setting.</para></summary>
public sealed class JudgeSeesContentPolicy : IMemoryVerificationPolicy
{
    /// <summary>The most one candidate may contribute. Facts are short; the cap exists so one pathological
    /// fact cannot multiply the cost of every recall that surfaces it.</summary>
    public const int MaxChars = 400;

    private readonly IMemoryVerificationPolicy _inner;

    public JudgeSeesContentPolicy(IMemoryVerificationPolicy inner) => _inner = inner;

    /// <summary>False only under the measurement knob.</summary>
    public static bool Enabled => !string.Equals(
        Environment.GetEnvironmentVariable("GATHERLIGHT_JUDGE_INPUT"), "headline", StringComparison.OrdinalIgnoreCase);

    public Task<MemoryVerification> VerifyAsync(MemoryVerificationRequest request, CancellationToken ct = default)
        => _inner.VerifyAsync(request with
        {
            Candidates = [.. request.Candidates.Select(c => c.Content is { Length: > 0 } content
                ? c with { Headline = Line($"{c.Headline} — {content}") }
                : c)],
        }, ct);

    /// <summary>ONE line, bounded. The judge's prompt is a numbered list, so a newline inside an entry would
    /// start a line the judge reads as another note — the same shape Lyntai's D166 fixed for recalled memory.</summary>
    internal static string Line(string text)
    {
        var flat = string.Join(' ', text.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)).Trim();
        return flat.Length <= MaxChars ? flat : flat[..MaxChars] + "…";
    }
}
