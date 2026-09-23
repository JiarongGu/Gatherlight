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
/// the topic earns its tokens is the MEASURED decision this class exists to let happen —
/// <c>dev.mjs judge-bench</c> compares this class's <c>both</c> and <c>content</c> modes: if <c>content</c>
/// scores as well, set <c>ContentChars = MaxChars</c>
/// where the LLM verifier is built and delete this class; if the topic earns its tokens, keep this class and
/// leave <c>ContentChars</c> at 0 — with it &gt; 0, upstream reads <c>Content</c> itself and ignores this
/// class's rewritten <c>Headline</c>, which would make this class dead code running for nothing.</para>
///
/// <para><b>MEASURED, and the first branch won.</b> <c>docs/judge-bench.md</c> Run 1 (2026-09-23): content
/// alone is EQUIVALENT to <c>both</c> on top-1 and on found@8 (2/0 pairs, p = 0.500, 95% [−2.2, +0.6] pp,
/// inside ±3 pp), with ~24% less candidate text. The topic does not earn its tokens. So when the app takes the
/// Lyntai release carrying Part 276: set <c>ContentChars = MaxChars</c> in <c>JudgeWiring.Llm</c>, and delete
/// this class, the <c>GATHERLIGHT_JUDGE_INPUT</c> knob and the judge-bench arms that set it (<c>topic</c>,
/// <c>contentonly</c>). Lyntai's side of the note is Part 276's own outcome, which names this decorator as the
/// thing to remove (dev-conventions: a workaround is recorded on both sides). Content alone has been the
/// default since 2026-09-24; <c>both</c> stays selectable for the bench until the bump deletes this
/// class.</para>
///
/// <para><b>Cost.</b> <c>FactIndex.RankAsync</c> asks the engine for <c>min(3×limit, 100)</c> candidates when
/// no kind is given, but a flat 100 whenever a kind IS given (a kind narrows AFTER the ranking, so a thin
/// kind needs a far wider one to fill its own page). Lyntai's <c>VerificationDepth</c> then shows the judge up
/// to 4× THAT many — so at the default limit of 8, the judge sees up to 96 candidates on a kind-less recall
/// and up to 400 on one naming a kind. The prompt grows with that depth × line length; the bench's latency
/// and estimated judge-input columns are where the trade-off is priced, not this class.</para>
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
    /// <c>GATHERLIGHT_JUDGE_INPUT</c>: <c>content</c> (default since 2026-09-24 — content alone, measured
    /// equivalent to <c>both</c> with ~24% less text, docs/judge-bench.md Run 1; identical to how Lyntai's
    /// <c>ContentChars</c> renders it below <see cref="MaxChars"/>), <c>both</c> (<c>"topic — content"</c>, the
    /// 1.3.0 default) or <c>headline</c> (topics only, the old behaviour). Anything else means
    /// <c>content</c>.</summary>
    public static readonly string Mode = (Environment.GetEnvironmentVariable("GATHERLIGHT_JUDGE_INPUT") ?? "").Trim().ToLowerInvariant() switch
    {
        "headline" => "headline",
        "both" => "both",
        _ => "content",
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

/// <summary>Caps what a SCORING verifier (a reranker) is sent per candidate — the reranker's counterpart of
/// <see cref="JudgeSeesContentPolicy.MaxChars"/>, which only ever bounded the LLM judge.
///
/// <para><b>Why a cap is not optional here — measured 2026-09-23 on the real llama-server</b>, both catalogued
/// rerankers, preset <c>ctx-size</c>/<c>batch-size</c>/<c>ubatch-size = 4096</c>
/// (<c>docs/self-managed-llm-runtime.md</c>): one (query, document) pair past 4096 tokens fails the WHOLE
/// <c>/v1/rerank</c> call — <c>500 input (4965 tokens) is too large to process</c>, the short document beside
/// it unscored too. The scoring policy is fail-open, so a single long fact turned every recall that surfaced it
/// into <c>NoOpinion</c>, and nothing said so. ~6,000 characters of English is ~1,600 tokens and passes;
/// ~6,000 of Chinese is ~4,960 and fails. The limit is per PAIR only: 96 documents of ~1,660 tokens each in
/// one call succeeded (in ~9.7 s).</para>
///
/// <para><b>Why <see cref="MaxChars"/> is 1000.</b> The worst rate measured was 0.83 tokens per UTF-16 unit
/// (common CJK; emoji ~0.48, rare CJK collapses to a handful of tokens), so 1000 characters is ~830 tokens —
/// under a fifth of the limit, room for the query and for a household-dropped reranker whose tokenizer is
/// several times greedier. And it bounds cost: the same 96-candidate page at the cap is about half the ~9.7 s
/// above. Household facts are granular, so a real fact is whole at this length; only a pathological one is
/// cut, and cut is better than every recall that surfaces it going unverified.</para></summary>
public sealed class RerankInputCap : IMemoryVerificationPolicy
{
    /// <summary>The most one candidate's text may run, in UTF-16 units. See the class comment.</summary>
    public const int MaxChars = 1000;

    private readonly IMemoryVerificationPolicy _inner;

    public RerankInputCap(IMemoryVerificationPolicy inner) => _inner = inner;

    /// <summary>Both the content and the headline, because the scoring policy reads the content and falls back
    /// to the headline when none was supplied.</summary>
    public Task<MemoryVerification> VerifyAsync(MemoryVerificationRequest request, CancellationToken ct = default)
        => _inner.VerifyAsync(request with
        {
            Candidates = [.. request.Candidates.Select(c => c with
            {
                Headline = Cap(c.Headline),
                Content = c.Content is null ? null : Cap(c.Content),
            })],
        }, ct);

    /// <summary>At most <see cref="MaxChars"/>, never splitting a surrogate pair. No ellipsis: a reranker scores
    /// the text, and a mark it was never trained on is noise in the one thing it reads.</summary>
    public static string Cap(string text)
    {
        if (text.Length <= MaxChars) return text;
        var cut = MaxChars;
        if (char.IsHighSurrogate(text[cut - 1])) cut--;
        return text[..cut];
    }
}
