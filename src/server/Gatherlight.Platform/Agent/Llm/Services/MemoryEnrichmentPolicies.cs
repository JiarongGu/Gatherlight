using System.Globalization;
using System.Text;
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
/// (the live route <c>llm.route.memory</c>); having its on/off somewhere else, behind a restart, split one
/// feature's controls across two stores.</para>
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

/// <summary>Gives a recall's verification a deadline of its OWN, inside the tool call's — so a judge that hangs costs
/// its verdict, never the page.
///
/// <para><b>What happened without it</b> (docs/judge-bench.md Run 5, found in the arm logs): a local chat judge's
/// verification hung, and 120 s later <c>FactIndex</c> logged "recall failed; falling back to FTS" with a
/// <c>TaskCanceledException</c> raised through <c>LlmMemoryVerificationPolicy.VerifyAsync</c> →
/// <c>GraphMemoryEngine.VerifyAsync</c> → <c>RecallAsync</c>. The designed outcome of a judge failure is NoOpinion —
/// the engine's own page stands — and Lyntai 3.2.0 implements it: every layer of that chain fails open on its own
/// timeout and rethrows ONLY when the CALLER's token is cancelled (<c>HttpChatEngine</c>, <c>TextRouter</c>,
/// <c>LlmMemoryVerificationPolicy</c> and <c>GraphMemoryEngine.VerifyAsync</c>, each
/// <c>catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }</c>). The caller's token WAS
/// cancelled: <c>ToolRegistry</c> links every tool call to a 120 s deadline (<c>ToolRegistry.ToolTimeout</c>), and
/// Lyntai's provider timeout is also 120 s (<c>LyntaiOptions.ProviderTimeout</c>, the 2-minute default) but starts
/// LATER — at the HTTP send, after the gather — so on a hung judge the tool's deadline always fires first. The logged
/// message is the token's ("The operation was canceled."), not <c>HttpClient.Timeout</c>'s, and only a cancelled
/// caller token could have passed those four rethrow filters. To the engine that is a caller cancellation, correctly
/// propagated; <c>FactIndex.RankAsync</c> then catches everything and falls back to FTS. So the cause is APP-side —
/// two equal clocks, the outer one started first — and this is its fix; nothing in Lyntai is wrong here.</para>
///
/// <para><b>The fix is a shorter clock on the inside.</b> This policy links the caller's token to a deadline of
/// <see cref="Default"/> — HALF the tool's, so the gather, the reinforcement and the FTS top-up keep the other half —
/// and when that deadline ends the verification while the caller's token is still live, the answer is
/// <see cref="MemoryVerification.NoOpinion"/>: the engine's page stands, exactly as for any other judge failure. A
/// real caller cancellation (the request abandoned, the tool's own deadline) still propagates, because only an
/// exception with the caller's token un-cancelled is caught. It wraps EVERY verifier — the Claude CLI judge, a chat
/// GGUF, a reranker — because the clock problem is the tool's, not any one judge's. 60 s is ~3.5× the slowest
/// measured Claude CLI judge (9–17 s per recall on the household's own facts; serial medians 8.7–11.7 s in Run 1), and
/// far beyond a local chat judge with thinking off (0.1–0.3 s per verdict on the real binary), whose runaway the
/// generation cap bounds to seconds (<c>LlamaServerRuntime.ChatMaxTokens</c>). <b>That basis is recalls of at most 60
/// candidates</b> — the bench fixture's, and the household's 16 facts: a CLI verification shown up to 400 (a recall
/// naming a kind, or asking for 34 or more) is UNMEASURED, and a verdict that would have arrived between 60 and 120 s is
/// now dropped as NoOpinion, where before this policy it was delivered.</para>
///
/// <para><b>Annotation is deliberately NOT given one.</b> On the write path the same tool deadline fails the graph
/// index (<c>FactIndex.IndexAsync</c> returns null) and the row's <c>graph_ref</c> is left EMPTY — for a new fact
/// because nothing was ever written, and for an EDITED one because <c>RememberFactTool</c> writes the null (and
/// <c>KnowledgeStore.LearnAsync</c> detached the changed row already). Until 2026-09-24 an edit kept its previous
/// content's ref there, so the back-fill never returned to it. The startup back-fill then indexes the fact again —
/// annotation included. A deadline here would instead index it WITHOUT subjects, permanently, since an indexed row is
/// never revisited. <c>e2e-p48</c> case 9 hangs the annotation of an edit and sees the new content indexed, with its
/// subject, at the next start.</para>
///
/// <para><b>A test knob, and only a shortening one</b>: <c>GATHERLIGHT_JUDGE_DEADLINE_SECONDS</c>, read once at
/// startup and clamped to [1 s, <see cref="Default"/>], so <c>e2e-p52</c> can hang a judge and see the page stand in
/// seconds rather than a minute. It can never lengthen the deadline past the point where the tool's would win
/// again.</para></summary>
public sealed class VerificationDeadlinePolicy : IMemoryVerificationPolicy
{
    /// <summary>Half the tool call's deadline — see the class comment.</summary>
    public static readonly TimeSpan Default = Capabilities.Tools.Services.ToolRegistry.ToolTimeout / 2;

    /// <summary>The deadline in effect: <see cref="Default"/>, or the test knob's shorter value.</summary>
    public static readonly TimeSpan Configured = FromKnob(Environment.GetEnvironmentVariable(KnobName));

    /// <summary>The test knob's name — announced at startup when set, like the measurement knobs.</summary>
    public const string KnobName = "GATHERLIGHT_JUDGE_DEADLINE_SECONDS";

    private readonly IMemoryVerificationPolicy _inner;
    private readonly TimeSpan _deadline;
    private readonly ILogger? _log;

    public VerificationDeadlinePolicy(IMemoryVerificationPolicy inner, TimeSpan deadline, ILogger? log = null)
    {
        _inner = inner;
        _deadline = deadline;
        _log = log;
    }

    private static TimeSpan FromKnob(string? raw) =>
        double.TryParse(raw, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture,
            out var seconds) && seconds > 0
            ? TimeSpan.FromSeconds(Math.Clamp(seconds, 1, Default.TotalSeconds))
            : Default;

    public async Task<MemoryVerification> VerifyAsync(MemoryVerificationRequest request, CancellationToken ct = default)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(_deadline);
        try
        {
            return await _inner.VerifyAsync(request, deadline.Token).ConfigureAwait(false);
        }
        // OUR deadline, the caller's token still live: a judge that did not answer in time. Anything else propagates —
        // the caller's own cancellation, as Lyntai's seams require, and an OperationCanceledException from some OTHER
        // clock while ours has not fired (an inner timeout a policy failed to swallow), which the engine's own
        // VerifyAsync turns into NoOpinion under its own log line. Catching that here too logged "no verdict within
        // 60 s" for a failure that took a fraction of it.
        catch (OperationCanceledException) when (!ct.IsCancellationRequested && deadline.IsCancellationRequested)
        {
            _log?.LogWarning(
                "memory verification gave no verdict within {Seconds:0.#} s; leaving the engine's own page in place",
                _deadline.TotalSeconds);
            return MemoryVerification.NoOpinion;
        }
    }
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
/// scores as well, the bump replaces this class with <c>ContentChars</c> (below); if the topic earns its tokens,
/// keep this class and leave <c>ContentChars</c> at 0 — with it &gt; 0, upstream reads <c>Content</c> itself and
/// ignores this class's rewritten <c>Headline</c>, which would make this class dead code running for
/// nothing.</para>
///
/// <para><b>MEASURED, and the first branch won.</b> <c>docs/judge-bench.md</c> Run 1 (2026-09-23): content
/// alone is EQUIVALENT to <c>both</c> on top-1 and on found@8 (2/0 pairs, p = 0.500, 95% [−2.2, +0.6] pp,
/// inside ±3 pp), with ~24% less candidate text. The topic does not earn its tokens. Content alone has been the
/// default since 2026-09-24; <c>both</c> stays selectable, for the bench, until the bump deletes this class.</para>
///
/// <para><b>ON THE BUMP</b> — the Lyntai release carrying Part 276. Lyntai's side of this note is Part 276's own
/// outcome, which names this decorator as the thing to remove (dev-conventions: a workaround is recorded on both
/// sides). It is more than one line, because the bench and <c>e2e-p52</c> pin this class's knob to <c>both</c>:
/// <list type="number">
/// <item>Set <c>ContentChars = MaxChars</c> where <c>JudgeWiring.Llm</c> builds the verifier; delete this class
/// and the <c>GATHERLIGHT_JUDGE_INPUT</c> knob (its two announcements in <c>GatherlightApp</c>, console and
/// logger).</item>
/// <item><c>judge-bench.mjs</c>: <c>topic</c> and <c>contentonly</c> go. <c>content</c> and <c>content2</c> stay —
/// the paired reference arm and the judge's A/A twin — but COLLAPSE into the content-only default: no env, no
/// <c>knob</c>, relabelled. <c>fuse</c> drops its <c>GATHERLIGHT_JUDGE_INPUT</c> pin and its second knob regex,
/// keeping only the verdict-combination one; <c>PINNED</c> and the default <c>--arms</c> list lose the knob and
/// the two arms. Left pinned, the three arms that stay would each throw "its knob did not announce
/// itself".</item>
/// <item><c>e2e-p52</c> case 7b asserts <c>judge input = both</c> reaches state/logs. It moves to the other knob:
/// start the signed-in server with <c>GATHERLIGHT_VERDICT_COMBINATION=fuse</c> (non-default, so the logged value
/// can only have come from the knob; case 7 makes no recall on that server, so Fuse changes nothing it asserts)
/// and match <c>Measurement knob set: verdict combination = Fuse</c>.</item>
/// </list>
/// After that, <c>both</c> cannot be reproduced at all: the bench measures content alone, and Run 1's <c>content</c>
/// rows stay the only record of "topic — content". That is acceptable because Run 1 measured the two
/// equivalent; but a <c>--baseline=…:content</c> against a pre-bump results file then pairs content-only against
/// <c>both</c> under one arm name, so say so when quoting such a comparison.</para>
///
/// <para><b>THE LOCAL CHAT JUDGE WAS FLIPPED TOO, AND RUN 3 MEASURED IT.</b> <c>JudgeWiring.Llm</c> builds the
/// verifier for BOTH LLM judges — <c>ClaudeCliJudgeSource</c> and <c>LlamaCppSource</c> bound to a chat GGUF — so
/// the 2026-09-24 default moved the llama.cpp chat judge to content alone as well. The owner approved the flip on
/// the Claude judge's measurement. <c>docs/judge-bench.md</c> Run 3 (2026-09-24, <c>gemma-3-1b-it-Q4_K_M</c>, the
/// pre-registered rule being "stop only if content alone is significantly worse") found NO SIGNIFICANT DIFFERENCE
/// but not equivalence either. Content alone trails "topic — content" by 4.6 pp top-1 (23/12, p = 0.090,
/// 95% [−9.4, +0.3]) and by 4.2 pp found@8 (18/8, p = 0.076, [−8.3, +0.04]); part of that is the longer input
/// failing to yield a verdict more often (75% against 86% coverage), which leaves the engine's page. So the default
/// stays unscoped. It only brings forward what Lyntai's <c>ContentChars</c> gives every LLM verifier on the bump
/// anyway. The same run found something larger: in EITHER mode, this 1B judge is significantly WORSE than no judge
/// (top-1 −19.2 / −14.6 pp), because partition promotes whatever it endorses. That is a statement about the model,
/// not about this class.</para>
///
/// <para><b>Cost.</b> <c>FactIndex.RankAsync</c> asks the engine for <c>min(3×limit, 100)</c> candidates when
/// no kind is given, but a flat 100 whenever a kind IS given (a kind narrows AFTER the ranking, so a thin
/// kind needs a far wider one to fill its own page). Lyntai's <c>VerificationDepth</c> then shows the judge up
/// to 4× THAT many — so at the default limit of 8, the judge sees up to 96 candidates on a kind-less recall
/// and up to 400 on one naming a kind (a kind-less recall reaches 400 too, from a limit of 34: 4 × min(3 × 34, 100)).
/// The prompt grows with that depth × line length; the bench's latency
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

/// <summary>Bounds what a SCORING verifier (a reranker) is sent per (query, document) PAIR — the reranker's counterpart
/// of <see cref="JudgeSeesContentPolicy.MaxChars"/>, which only ever bounded the LLM judge — and, since 2026-09-24,
/// hands a candidate longer than that bound to <see cref="ChunkedScoreProvider"/> WHOLE, to be scored in windows of it,
/// instead of cutting it to its first window (see the last paragraph).
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
/// above. Household facts are granular, so a real fact is whole at this length; a longer one is read in windows of
/// it (the last paragraph), never sent past it.</para>
///
/// <para><b>A model whose row DECLARES a window is fitted to it, PER PAIR — the query included</b>
/// (<see cref="GgufModel.ContextTokens"/>, read through <see cref="GgufCatalog.DeclaredWindow"/>, the same read the
/// preset makes). mMiniLMv2 serves 512-token slots, and <c>docs/judge-bench.md</c> Run 4 measured what the
/// 1,000-character cap does to it: dense Chinese at the cap is 781 tokens and the whole call comes back
/// <c>400 input (781 tokens) is larger than the max context size (512 tokens)</c>. Lyntai 3.2.0 reads that refusal as a
/// HOST fault (<c>Failed</c>, counted toward benching the reranker for every caller) and logs it at Debug; its next release
/// reads it as <c>ContextWindowExceeded</c>, which advances without blame, and logs a failure that will repeat at Warning
/// (Lyntai <c>docs/FIXES.md</c>, 2026-09-24, committed and unreleased) — the call is refused either way, so the bound
/// stays. A pair is formatted as query +
/// document + 4 special tokens (read back from the server's own figure in that refusal), and on this tokenizer
/// family — XLM-RoBERTa SentencePiece, no byte fallback — an NFKC-normalised text costs at most its UTF-16 length + 1
/// in tokens (see the next paragraph for why NFKC). So <c>query + document ≤ window − <see cref="PairOverheadTokens"/></c>
/// CHARACTERS OF THE NORMALISED TEXT is a hard bound, not an estimate, and it needs no <c>/tokenize</c> round trip per
/// candidate. The query gets at most half that budget, so a long question cannot starve the documents; each candidate
/// gets the rest, never more than <see cref="MaxChars"/>. At 512: the query ≤ 253 characters, each candidate ≤ 506 − the
/// query's length. <b>The bound does NOT transfer to a byte-level tokenizer</b>, where one character can be several
/// tokens — a row declaring a window for such a model needs its own measurement first. Verified on the real binary
/// (2026-09-24) under the preset the row now produces (<c>ctx-size</c>/<c>batch-size</c>/<c>ubatch-size = 512</c>): a
/// pair of 512 tokens is served and 513 refused with a 500, <c>too large to process … batch size 512</c> — the same
/// whole-call refusal in another shape — and the app bound to the catalogued id got a verdict on a recall of a
/// 1,236-character Chinese fact with a 347-character query.</para>
///
/// <para><b>WHY THE COUNT IS TAKEN AFTER NFKC — and the text SENT is the normalised one.</b> XLM-R's SentencePiece
/// normalises with <c>nmt_nfkc</c> before it tokenizes, so a compatibility character EXPANDS: ℃ → °C, ㎡ → m2,
/// ㍿ → 株式会社, ﷺ → an 18-character phrase. The bound above was measured on text with none of them, and one
/// character past the window refuses the whole call — fail-open, silently. Measured on the real mMiniLMv2 GGUF with
/// <c>/tokenize</c> (llama.cpp b10549, 2026-09-24): RAW, a lone ℃ or ㎡ is 2 tokens, ﷺ 4, ㌚ 6 — up to 6 tokens per
/// UTF-16 unit — and 200 ℃ in a row cost 400 tokens, so a raw character count undercounts by up to 6×. NORMALISED,
/// every assigned BMP scalar and every astral one FormKC changes (64,012 scalars; 4,928 changed) costs at most its
/// normalised UTF-16 length + 1 — no exception — and dense strings of ℃, ㎡, ㍿ or ﷺ, alone or mixed into Chinese, ran
/// 0.22–1.00 tokens per normalised unit. .NET 10's FormKC matched Node's NFKC on all 64,012. So the count is exact
/// again once it is taken on the normalised text, with no slack margin needed. SENDING the normalised text loses
/// nothing the model would have read: the tokenizer normalises anyway, and the token ids came out identical for all
/// but 95 of the 4,928 changed scalars — characters newer than the model's normalisation table (㋿ U+32FF, Unicode
/// 12.1) plus fullwidth ～, where the model now reads the NFKC form (令和, ~) instead of an unmapped original.
/// Reproducible: <c>dev.mjs rerank-window</c> re-runs the sweep and the pair at the limit on the pinned GGUF; the method
/// and the recorded run are in <c>docs/self-managed-llm-runtime.md</c>.</para>
///
/// <para><b>A declared window too small to hold a pair's overhead is NO window</b> (<see cref="UsableWindow"/>): at
/// ≤ <see cref="PairOverheadTokens"/> the budget is zero and every query and candidate would be cut to nothing, so the
/// verifier would score empty strings on every recall. <see cref="GgufCatalog.DeclaredWindow"/> applies the same rule,
/// so the preset and the fitting still agree. No row declares one; this is a guard, not a case.</para>
///
/// <para><b>No declared window keeps the 1,000-character cap per candidate and leaves the text un-normalised</b> — the
/// catalogued rerankers served at 4096 (BGE, LAMAR), and every GGUF a household dropped in (no row, so no window — a
/// stated limit, see <see cref="GgufCatalog.DeclaredWindow"/>). <b>The query is capped there too</b>, at
/// <see cref="UndeclaredQueryMaxChars"/>: the rule a declared window applies — half the pair's budget — applied to the
/// 4,096-token batch the preset launches such a reranker with (<see cref="LlamaServerRuntime.RerankBatch"/>). It used to
/// stay uncut, argued from recall queries being short; but the agent writes them, one pair past the batch refuses the
/// WHOLE call, and the verifier is fail-open, so a long enough question would silently leave every recall it made
/// unjudged. <b>The question is COUNTED after NFKC and SENT as written</b> (<see cref="CapCountedNfkc"/>) — counted as
/// the declared path counts it, because the tokenizer normalises before it counts, and left un-normalised because
/// nothing else on this path is. So on the tokenizer family these rerankers use (a text costs at most one token per
/// NFKC character plus one — the NFKC paragraph's measurement; BGE and LAMAR tokenized Run 6c's windows alike, 857 and
/// 858 tokens for the largest task) the question costs at most 2,046 tokens whatever it contains, and a pair of an
/// ordinary 1,000-character candidate beside it ~3,050 of the 4,096: a hard bound. The CANDIDATE stays counted raw, so
/// compatibility characters there are the stated limit: each ㌚ costs 6 tokens where an ordinary character costs one, so
/// ~210 of them in one window overflow the pair beside a question at the cap, ~610 beside a short one — possible in
/// principle, not guarded; so is a household-dropped model with a greedier tokenizer. The cap changes no question any
/// bench run has asked: the fixtures' longest is 164 characters.</para>
///
/// <para><b>A CUT WAS NOT BETTER FOR THE CUT FACT ITSELF — measured, so a long candidate is scored in windows</b>
/// (<c>docs/judge-bench.md</c> Runs 6 and 6c, 2026-09-24). This class used to cut every candidate to the budget and
/// argued that a cut beats a refused call. For the recall's OTHER candidates it does — they still get scored — but not
/// for the note that was cut: under partition the reranker endorses the eight candidates it scores highest and
/// promotes them ahead of the rest, so a note whose answer lies past the cut scores like filler and is pushed OFF a
/// page the engine would have given it — worse than no judge, which fails open and leaves the engine's page standing.
/// On 60 notes of 883–1,241 characters (240 questions, no tags, no embedder, a page of 8 chosen by the reranker):
/// mMiniLMv2 put the answer on the page 4 times in 60 when it sat at the note's END, against 29 with no judge; BGE and
/// LAMAR, past their 1,000-character cap, 3 of 60 against 30. So with <see cref="RerankChunking"/> on — the default —
/// this class prepares candidates (NFKC under a window) and fits the query exactly as before but does NOT cut the
/// candidates: <see cref="ChunkedScoreProvider"/> scores each in windows of this same budget (<see cref="Windows"/>:
/// at most <see cref="MaxWindows"/>, overlapping by a quarter, the last at the tail; at most
/// <see cref="MaxWindowsPerCall"/> per call, and fewer on a machine <see cref="RerankPace"/> measures too slow to score them
/// in half the verification deadline) and keeps its best window's score. Run 6c's pre-registered rule held:
/// in the same run, the end-position answers went 4 → 44 of 60 on mMiniLMv2 (0/40, p &lt; 0.001), beyond-1,000 answers
/// 3 → 51 on BGE and 3 → 52 on LAMAR, no reranker was significantly worse where the cut already read the answer
/// (start: 49 → 47, 55 → 54, 52 → 50), and on the ≤ 101-character fixture every row of every reranker was
/// byte-identical, because a candidate that fits one window is sent exactly as before. The cost is time, where notes
/// are long: serial medians on those notes 2.0 → 3.2 s (BGE), 2.2 → 3.2 s (LAMAR), 0.5 → 1.2 s (mMiniLMv2); unchanged
/// on short facts. Long and short notes MIXED in one recall were measured in Run 9 (30 short facts beside 30 long notes,
/// the same 240 questions): short-target found@8 not significantly lower in windows than cut (94 → 91, 101 → 99, 98 → 97
/// of 120; a loss of up to 4–6 points not ruled out), long targets +30 / +50 / +69. On a CPU-only machine the windows and
/// the pace were measured in Run 8 (one laptop's CPU, 60 long notes, 240 questions): mMiniLMv2 judged every recall in
/// windows, a median 17.5 s, found@8 180/240 against no judge's 104; BGE waited out the minute on 230 of 240 recalls and
/// ended where no judge is (104) — which is why <see cref="RerankPace"/> now SKIPS a recall that one window per candidate
/// cannot fit, a rule derived from that run and not run on its CPU. Unmeasured: notes past five window-lengths (the
/// stretches between windows go unread), real household notes, and how soon the pace settles on a CPU where calls are
/// SIZED — Run 8's mMiniLMv2 never needed sizing.</para></summary>
public sealed class RerankInputCap : IMemoryVerificationPolicy
{
    /// <summary>The most one candidate's text may run, in UTF-16 units. See the class comment.</summary>
    public const int MaxChars = 1000;

    /// <summary>What a (query, document) pair costs in tokens beyond one per character of its two texts: the 4
    /// special tokens llama.cpp wraps an XLM-RoBERTa pair in, plus at most one leading <c>▁</c> for each text.</summary>
    public const int PairOverheadTokens = 6;

    /// <summary>The most WINDOWS one candidate is scored in when chunking is on (<see cref="Windows"/>). They are spread
    /// evenly from its first character to its last, so its start, its end and three points between are always read.
    /// Five windows keep at least a quarter's overlap up to four window-lengths, and still read the candidate WHOLE —
    /// the overlap shrinking toward none — up to five: 5,000 characters at the 1,000-character cap, 1,265–2,530 for
    /// mMiniLMv2's fitted budgets of 253–506. Only past five window-lengths do stretches between windows go unread —
    /// 1 − 5 × window ÷ length of the text: a sixth of it at six window-lengths, half at ten. A cap, because the whole
    /// call costs what every window costs: a recall showing the reranker 96 long candidates sends up to 480 pairs.</summary>
    public const int MaxWindows = 5;

    /// <summary>Consecutive windows overlap by at least this fraction of a window (1/<see cref="OverlapDivisor"/>) while
    /// the candidate needs no more than <see cref="MaxWindows"/>, so any span up to a quarter of a window — a sentence,
    /// which is what a household fact's answer is — lies whole inside at least one window instead of being cut in two.
    /// </summary>
    public const int OverlapDivisor = 4;

    private readonly IMemoryVerificationPolicy _inner;
    private readonly int? _window;
    private readonly bool _chunked;

    /// <param name="window">The model's DECLARED token window (<see cref="GgufCatalog.DeclaredWindow"/>), or null
    /// for none — which keeps the 1,000-character cap and leaves the query alone.</param>
    /// <param name="chunked">True when a <see cref="ChunkedScoreProvider"/> scores each candidate in windows — the default,
    /// <see cref="RerankChunking.On"/>: the candidates are then prepared (NFKC under a window) but NOT cut here, because
    /// the windows are cut from the whole text downstream. The query is fitted exactly as without it. False is the cut
    /// Runs 2–6 measured, kept for the bench.</param>
    public RerankInputCap(IMemoryVerificationPolicy inner, int? window = null, bool chunked = false)
    {
        _inner = inner;
        _window = window;
        _chunked = chunked;
    }

    /// <summary>Both the content and the headline, because the scoring policy reads the content and falls back
    /// to the headline when none was supplied — and, under a declared window, the query, which the scoring policy
    /// sends beside every candidate.</summary>
    public Task<MemoryVerification> VerifyAsync(MemoryVerificationRequest request, CancellationToken ct = default)
    {
        var (query, perCandidate) = Fit(request.Query, _window);
        var cut = _chunked ? int.MaxValue : perCandidate;
        return _inner.VerifyAsync(request with
        {
            Query = query,
            Candidates = [.. request.Candidates.Select(c => c with
            {
                Headline = Cap(Prepare(c.Headline, _window), cut),
                Content = c.Content is null ? null : Cap(Prepare(c.Content, _window), cut),
            })],
        }, ct);
    }

    /// <summary>The most characters a query may run beside a reranker that declares no window: half the pair budget of
    /// the 4,096-token batch the preset launches it with — the declared-window rule, applied to that batch. See the class
    /// comment.</summary>
    public const int UndeclaredQueryMaxChars = (LlamaServerRuntime.RerankBatch - PairOverheadTokens) / 2;

    /// <summary>The query as it will be sent, and how many characters each candidate may then run — for one call.
    /// Without a usable window: the query cut to <see cref="UndeclaredQueryMaxChars"/> counted after NFKC, sent as written, and
    /// <see cref="MaxChars"/>. With one: the query NFKC-normalised and cut to half the budget, and each candidate given
    /// what the query left — counted, like the query, on its normalised text (<see cref="Prepare"/>) — so every pair
    /// fits; see the class comment for why a character count of the normalised text bounds the tokens.</summary>
    public static (string Query, int PerCandidate) Fit(string query, int? window)
    {
        if (UsableWindow(window) is not { } tokens) return (CapCountedNfkc(query, UndeclaredQueryMaxChars), MaxChars);
        var fitted = Cap(Prepare(query, tokens), (tokens - PairOverheadTokens) / 2);
        return (fitted, PerCandidate(fitted, tokens));
    }

    /// <summary>How many characters each candidate may run beside a query that is ALREADY fitted — the second half of
    /// <see cref="Fit"/>, split out so the windows a <see cref="ChunkedScoreProvider"/> cuts downstream (it sees only the
    /// fitted query) are exactly the budget the cut uses: one writer for both.</summary>
    public static int PerCandidate(string fittedQuery, int? window) =>
        UsableWindow(window) is { } tokens
            ? Math.Min(MaxChars, tokens - PairOverheadTokens - fittedQuery.Length)
            : MaxChars;

    /// <summary>The most windows ONE rerank call may carry, however fast the machine — <see cref="MaxWindows"/> for each of
    /// the 96 candidates a recall at the default page shows the verifier (4 × min(3 × 8, 100), Lyntai's verification depth
    /// over <c>FactIndex.RankAsync</c>'s over-ask). A larger recall — one naming a kind, or asking for 34 or more, shows up
    /// to 400 — gets fewer windows per candidate instead (<see cref="WindowsPerDocument"/>), down to one: the cut. Measured
    /// on the real llama-server (b10549, one GPU, dense Chinese windows, <c>docs/judge-bench.md</c> Run 6b): 480 full
    /// 1,000-character windows took ~20 s on BGE and LAMAR, and 2,000 took 77–79 s — past the 60-second verification
    /// deadline, so without this cap such a recall would wait a minute and then go unverified. <b>A count is right only
    /// for the GPU it was measured on</b>, so it is a CEILING: below it, a call carries only what
    /// <see cref="RerankPace"/> predicts this machine scores in half the deadline.</summary>
    public const int MaxWindowsPerCall = 480;

    /// <summary>How many windows each document of one call may use: <see cref="MaxWindows"/>, lowered — the same for
    /// every document — until the call's windows fit <see cref="MaxWindowsPerCall"/> AND its pair TOKENS fit
    /// <paramref name="pairTokenBudget"/> (<see cref="RerankPace.PairTokenBudget"/>): <paramref name="query"/> beside each
    /// window, both counted by <see cref="RerankPace.Tokens"/> over the exact spans <see cref="Windows"/> would cut, so a
    /// Chinese window weighs what a Chinese window costs. Never below one, which is the cut — sent even when it does not
    /// fit either limit, since fewer windows than candidates would leave one unscored.</summary>
    public static int WindowsPerDocument(IReadOnlyList<string> documents, int size, string query = "",
        double pairTokenBudget = double.PositiveInfinity)
    {
        var queryTokens = RerankPace.Tokens(query);
        // Cumulative weights per document, so a window's tokens are one subtraction whatever its span.
        var weights = documents.Select(RerankPace.CumulativeTokens).ToList();
        var k = MaxWindows;
        while (k > 1)
        {
            int count = 0;
            double tokens = 0;
            for (var i = 0; i < documents.Count; i++)
                foreach (var (start, end) in WindowSpans(documents[i], size, k))
                {
                    count++;
                    tokens += queryTokens + weights[i][end] - weights[i][start];
                }
            if (count <= MaxWindowsPerCall && tokens <= pairTokenBudget) break;
            k--;
        }
        return k;
    }

    /// <summary>How many windows a text of <paramref name="length"/> needs to be read whole with the minimum overlap —
    /// before any cap.</summary>
    private static int WindowsNeeded(int length, int size)
    {
        if (size <= 0 || length <= size) return 1;
        var stride = Math.Max(1, size - size / OverlapDivisor);
        return 1 + (length - size + stride - 1) / stride;
    }

    /// <summary>A candidate as the WINDOWS a chunked reranker scores it in: the text itself when it fits in one
    /// (<paramref name="size"/> characters or fewer — so a short fact is sent exactly as without chunking), otherwise
    /// windows of <paramref name="size"/> characters, the first at its start and the last at its END, spaced evenly
    /// between. While the text needs at most <paramref name="maxWindows"/> (a stride of three quarters of a window), the
    /// spacing is at most that stride, so consecutive windows overlap by at least a quarter. Past it the
    /// <paramref name="maxWindows"/> windows spread further apart: the overlap shrinks, reaching none at
    /// <paramref name="maxWindows"/> window-lengths, and only beyond that do stretches between them go unread —
    /// 1 − <paramref name="maxWindows"/> × <paramref name="size"/> ÷ length of the text.
    /// With <paramref name="maxWindows"/> = 1 it is the cut: the text's first <paramref name="size"/> characters.
    /// Windows never split a surrogate pair (a boundary moves inward by one unit instead), so a window can run one
    /// short of <paramref name="size"/>, never over. A <paramref name="size"/> of zero or less gives no window to cut:
    /// the text whole, as one — <see cref="ChunkedScoreProvider"/> passes such a request through rather than score
    /// empty strings as if they were the candidates. The spans are <see cref="WindowSpans"/>'s — the one writer the
    /// time sizing (<see cref="WindowsPerDocument"/>) counts too.</summary>
    public static IReadOnlyList<string> Windows(string text, int size, int maxWindows = MaxWindows)
    {
        var spans = WindowSpans(text, size, maxWindows);
        if (spans.Count == 1 && spans[0] == (0, text.Length)) return [text];
        return [.. spans.Select(s => text[s.Start..s.End])];
    }

    /// <summary>Where each of <see cref="Windows"/>'s windows starts and ends in <paramref name="text"/> — computed
    /// once, here, so the windows sent and the windows the time budget counts cannot differ.</summary>
    public static IReadOnlyList<(int Start, int End)> WindowSpans(string text, int size, int maxWindows = MaxWindows)
    {
        if (size <= 0 || text.Length <= size) return [(0, text.Length)];
        var n = Math.Clamp(WindowsNeeded(text.Length, size), 1, Math.Max(1, maxWindows));
        if (n == 1) return [(0, Cap(text, size).Length)];
        var span = text.Length - size;                       // where the last window starts
        var spans = new (int Start, int End)[n];
        for (var i = 0; i < n; i++)
        {
            var start = (int)((long)i * span / (n - 1));     // 0 … span, the last exactly at the tail
            if (start > 0 && char.IsLowSurrogate(text[start]) && char.IsHighSurrogate(text[start - 1])) start++;
            var end = Math.Min(text.Length, start + size);
            if (end < text.Length && char.IsHighSurrogate(text[end - 1]) && char.IsLowSurrogate(text[end])) end--;
            spans[i] = (start, end);
        }
        return spans;
    }

    /// <summary>A declared window, or null when it cannot hold even a pair's overhead — the ONE rule
    /// <see cref="Fit"/> and <see cref="GgufCatalog.DeclaredWindow"/> share, so the preset never launches a model
    /// with a window the fitting ignores. See the class comment.</summary>
    public static int? UsableWindow(int? window) => window > PairOverheadTokens ? window : null;

    /// <summary>A text as it is COUNTED and SENT: NFKC-normalised under a usable window, untouched without one. The
    /// tokenizer applies the same normalisation, so the count is taken on what it will actually read.
    /// <para>A lone surrogate makes <see cref="string.Normalize(NormalizationForm)"/> throw; it becomes U+FFFD first —
    /// one unit, which the measured bound covers — rather than failing the whole recall's verification.</para></summary>
    public static string Prepare(string text, int? window)
    {
        if (UsableWindow(window) is null) return text;
        try { return text.Normalize(NormalizationForm.FormKC); }
        catch (ArgumentException) { return WithoutLoneSurrogates(text).Normalize(NormalizationForm.FormKC); }
    }

    private static string WithoutLoneSurrogates(string text)
    {
        var sb = new StringBuilder(text.Length);
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
            {
                sb.Append(c).Append(text[++i]);
                continue;
            }
            sb.Append(char.IsSurrogate(c) ? '\uFFFD' : c);
        }
        return sb.ToString();
    }

    /// <summary>The longest head of <paramref name="text"/> whose length COUNTED AFTER NFKC is at most
    /// <paramref name="max"/>, the text itself kept as written — the undeclared-window question's cap (see the class
    /// comment). Counted one text element at a time and summed, as Lyntai's D177 counts: never below the NFKC length of
    /// the whole, since composing across elements only shortens it, so the head's NFKC length is at most the sum. A text
    /// already in NFKC and within the bound is returned as it came.</summary>
    public static string CapCountedNfkc(string text, int max)
    {
        if (max <= 0) return "";
        if (text.Length <= max && IsNfkc(text)) return text;
        var counted = 0;
        var end = 0;
        var elements = StringInfo.GetTextElementEnumerator(text);
        while (elements.MoveNext())
        {
            var element = elements.GetTextElement();
            counted += NfkcLength(element);
            if (counted > max) break;
            end = elements.ElementIndex + element.Length;
        }
        return text[..end];
    }

    private static bool IsNfkc(string text)
    {
        try { return text.IsNormalized(NormalizationForm.FormKC); }
        catch (ArgumentException) { return false; }
    }

    // A lone surrogate makes Normalize throw; it is one unit, as Prepare's U+FFFD would be.
    private static int NfkcLength(string element)
    {
        try { return element.Normalize(NormalizationForm.FormKC).Length; }
        catch (ArgumentException) { return element.Length; }
    }

    /// <summary>At most <paramref name="max"/> UTF-16 units, never splitting a surrogate pair (so a cut can land one
    /// short, never one over). No ellipsis: a reranker scores the text, and a mark it was never trained on is noise
    /// in the one thing it reads.</summary>
    public static string Cap(string text, int max)
    {
        if (text.Length <= max) return text;
        if (max <= 0) return "";
        var cut = max;
        if (char.IsHighSurrogate(text[cut - 1])) cut--;
        return text[..cut];
    }
}
