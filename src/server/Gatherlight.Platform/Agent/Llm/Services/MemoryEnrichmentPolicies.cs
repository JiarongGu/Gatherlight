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
/// <param name="Transport">The bound source's id — <c>claude-cli</c> or <c>llama-cpp</c>. Deliberately the
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
/// <para><b>UPSTREAM SHIPPED PART OF THIS, AND IT DOES NOT REPLACE THE CLASS OUTRIGHT.</b> Lyntai
/// <c>docs/task-archive.md</c> Part 276 (decision D170) added <c>LlmVerificationOptions.ContentChars</c>
/// (default 0), shipping in the release AFTER 3.2.0 — the one this app currently consumes. It renders the
/// candidate's content ALONE, not <c>"topic — content"</c>: D170 rejected the combined shape because, for an
/// engine-DERIVED headline (the first <c>HeadlineChars</c> of the content), it repeats the content's opening
/// and so doubles the tokens. Ours is AUTHORED — <c>FactIndex.IndexAsync</c> passes <c>Headline: topic</c> —
/// which is the very case D170 cites as the reason for adding <c>ContentChars</c> at all ("an application
/// that authors headlines hands the judge a label"). So <c>both</c> adds a label rather than a copy — though
/// household facts often restate their own topic in the content, so it may still pay for it twice. Whether
/// the topic earns its tokens is what judge-bench measures (<c>both</c> vs <c>content</c>), and that is the
/// MEASURED decision this class exists to let happen — <c>dev.mjs judge-bench</c> compares this class's
/// <c>both</c> and <c>content</c> modes: if <c>content</c> scores as well, set <c>ContentChars = MaxChars</c>
/// where the LLM verifier is built and delete this class; if the topic earns its tokens, keep this class and
/// leave <c>ContentChars</c> at 0 — with it &gt; 0, upstream reads <c>Content</c> itself and ignores this
/// class's rewritten <c>Headline</c>, which would make this class dead code running for nothing.</para>
///
/// <para><b>Cost.</b> <c>FactIndex.RankAsync</c> asks the engine for <c>min(3×limit, 100)</c> candidates when
/// no kind is given, but a flat 100 whenever a kind IS given (a kind narrows AFTER the ranking, so a thin
/// kind needs a far wider one to fill its own page). Lyntai's <c>VerificationDepth</c> then shows the judge up
/// to 4× THAT many — so at the default limit of 8, the judge sees up to 96 candidates on a kind-less recall
/// and up to 400 on one naming a kind. The prompt grows with that depth × line length; the bench's latency
/// column is where the trade-off is priced, not this class.</para>
///
/// <para>Topics stay the STORED headline, so <c>expand_fact</c>'s neighbour list is unchanged; only what the judge
/// reads changes.</para></summary>
public sealed class JudgeSeesContentPolicy : IMemoryVerificationPolicy
{
    /// <summary>The most one candidate's rendered line may run, before the truncation mark. Facts are
    /// short; the cap exists so one pathological fact cannot multiply the cost of every recall that surfaces
    /// it. The line actually sent is at most <see cref="MaxChars"/> characters plus the ellipsis.</summary>
    public const int MaxChars = 400;

    private readonly IMemoryVerificationPolicy _inner;

    public JudgeSeesContentPolicy(IMemoryVerificationPolicy inner) => _inner = inner;

    /// <summary>What the judge is shown, read ONCE at startup from the measurement knob
    /// <c>GATHERLIGHT_JUDGE_INPUT</c>: <c>both</c> (default, <c>"topic — content"</c>), <c>content</c> (content
    /// alone — identical to how Lyntai's upcoming <c>ContentChars</c> renders it below <see cref="MaxChars"/>;
    /// above it upstream cuts at a word boundary where this class cuts hard) or <c>headline</c> (topics only,
    /// the old behaviour). Anything else means <c>both</c>.</summary>
    public static readonly string Mode = (Environment.GetEnvironmentVariable("GATHERLIGHT_JUDGE_INPUT") ?? "").Trim().ToLowerInvariant() switch
    {
        "headline" => "headline",
        "content" => "content",
        _ => "both",
    };

    /// <summary>False only when the knob asks for topics only.</summary>
    public static bool Enabled => Mode != "headline";

    public Task<MemoryVerification> VerifyAsync(MemoryVerificationRequest request, CancellationToken ct = default)
        => _inner.VerifyAsync(request with
        {
            Candidates = [.. request.Candidates.Select(c => !string.IsNullOrWhiteSpace(c.Content)
                ? c with { Headline = Line(Mode == "content" ? c.Content! : $"{c.Headline} — {c.Content}") }
                : c)],
        }, ct);

    /// <summary>ONE line, bounded. The judge's prompt is a numbered list, so a newline inside an entry would
    /// start a line the judge reads as another note — the same shape Lyntai's D166 fixed for recalled memory.
    /// <see cref="string.ReplaceLineEndings(string)"/> replaces every line terminator (CR, LF, CRLF, NEL
    /// U+0085, LS U+2028, PS U+2029, FF) with a space in one pass, covering wording no plain <c>\r</c>/<c>\n</c>
    /// split would catch. Truncation never splits a surrogate pair.</summary>
    private static string Line(string text)
    {
        var flat = text.ReplaceLineEndings(" ").Trim();
        if (flat.Length <= MaxChars) return flat;
        var cut = MaxChars;
        if (char.IsHighSurrogate(flat[cut - 1])) cut--;
        return flat[..cut] + "…";
    }
}
