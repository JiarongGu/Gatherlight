using Lyntai.Inference;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>Whether a reranker scores a long candidate in WINDOWS (<see cref="ChunkedScoreProvider"/>) — ON by default
/// since 2026-09-24, when <c>docs/judge-bench.md</c> Run 6c's pre-registered rule held. Read ONCE at startup from the
/// measurement knob <c>GATHERLIGHT_RERANK_CHUNKING</c>: <c>on</c> or <c>off</c>, anything else (and unset) meaning the
/// default. <b>The knob is KEPT</b>, as <c>GATHERLIGHT_JUDGE_INPUT</c> was when its default flipped: <c>off</c> reproduces
/// the cut every reranker was measured under in Runs 2–6, so judge-bench pins it on its <c>rr</c>/<c>rrf</c> arms and
/// those runs re-launch as they ran. Announced at startup whenever it is SET, raw value beside what it resolved to, on
/// the console (what judge-bench reads) and through the logger at Warning (what state/logs keeps) — the pattern every
/// measurement knob follows. It is a benchmark setting, not a household one.</summary>
public static class RerankChunking
{
    /// <summary>The knob's name.</summary>
    public const string KnobName = "GATHERLIGHT_RERANK_CHUNKING";

    /// <summary>What the knob was set to, or null.</summary>
    public static readonly string? Raw = Environment.GetEnvironmentVariable(KnobName);

    /// <summary>The default when the knob is unset or unrecognised: ON (Run 6c).</summary>
    public const bool Default = true;

    /// <summary>Whether chunking is on for this process.</summary>
    public static readonly bool On = (Raw ?? "").Trim().ToLowerInvariant() switch
    {
        "on" => true,
        "off" => false,
        _ => Default,
    };
}

/// <summary>A reranker that scores each candidate in overlapping WINDOWS and answers with its best window's score — so
/// a long note is judged by its most relevant part, wherever that part sits, rather than by the prefix that fits.
///
/// <para><b>Why.</b> <see cref="RerankInputCap"/> has to bound what one (query, document) pair costs, because one pair
/// past the model's window fails the WHOLE call. Cutting each candidate to a prefix does that, and <c>docs/judge-bench.md</c>
/// Run 6 measured what the prefix costs when the answer is past it: under partition a reranker endorses the eight
/// candidates it scores highest and promotes them ahead of the rest, so a note whose answer it cannot see scores like
/// filler and is pushed OFF a page the engine would have given it — mMiniLMv2 (512-token window) found the answer at the
/// END of a ~900-character note 4 times in 60, against 29 with no judge at all; BGE and LAMAR, past their own
/// 1,000-character cap, 3 and 4 against 30. Run 6c measured this class against the cut under a pre-registered rule, and
/// it became the default: 4 → 44 of 60 there on mMiniLMv2, 3 → 51 / 52 past 1,000 characters on BGE / LAMAR, no
/// significant loss where the cut already read the answer, and byte-identical results on short facts
/// (<see cref="RerankInputCap"/>'s last paragraph has the configuration and the cost).</para>
///
/// <para><b>What it does.</b> Each document of a <see cref="ScoreRequest"/> is split by <see cref="RerankInputCap.Windows"/>
/// into windows of the SAME budget the cut uses (<see cref="RerankInputCap.PerCandidate"/>, from the fitted query the
/// request carries — one writer, so every pair still fits the declared window), ALL windows go to the inner provider in
/// ONE call, and each document's score is the MAX over its windows (MaxP, the standard way a passage-level cross-encoder
/// scores a long document). So <c>ScoringVerificationPolicy</c> still sees one score per candidate, in input order, and
/// its <c>EndorseCount</c> still counts candidates. <b>A request whose every document fits one window is passed through
/// untouched</b> — the same object, so the same bytes on the wire: a household of short facts is sent exactly what it was
/// sent before. So is a request whose budget leaves no room for a window at all, which no usable window produces: an
/// empty window would be scored as if it were the candidate.</para>
///
/// <para><b>Why a provider decorator, not a verification policy.</b> <c>ScoringVerificationPolicy</c> (Lyntai 3.2.0) sends
/// ONE document per candidate and endorses by index; windows as extra candidates would make <c>EndorseCount</c> count
/// windows, and re-implementing the policy to avoid that would fork Lyntai's verifier. The provider seam
/// (<see cref="IScoreProvider"/>: a query and documents in, one score per document out) is exactly one call wide, so a
/// decorator there changes nothing the policy relies on. It is applied where the verifier is built
/// (<c>LlamaCppSource.Wiring</c>), to the one provider the verifier names, and registered nowhere else — and when chunking
/// is on and there is nothing to wrap, building the verifier THROWS (<c>LlamaCppSource.RerankProviders</c>), because the
/// cap then leaves long candidates uncut and one past the window would fail every call. Routing bookkeeping is unchanged
/// by the wrapper: the router keys cooldown on the provider id when the pool never built the instance, which is the case
/// for every DI-registered backend (Lyntai's <c>RegisterProviderLifetime</c>).</para>
///
/// <para><b>What it costs, and why a call is sized by TIME.</b> Every window is a pair the model scores, so a recall costs
/// roughly the tokens it sends: a candidate needing two windows costs about twice what its cut prefix did, and at most
/// <see cref="RerankInputCap.MaxWindows"/> times. Measured on 60 notes of ~900–1,200 characters: a recall's serial median
/// went 2.0 → 3.2 s on BGE and 0.5 → 1.2 s on mMiniLMv2, on one GPU. Short candidates cost nothing extra. A call carries at
/// most <see cref="RerankInputCap.MaxWindowsPerCall"/> windows — a COUNT tuned on that GPU — and, below it, only as many as
/// <see cref="RerankPace"/> predicts will be scored within half the verification deadline on THIS machine: fewer windows
/// per candidate on a slow one, down to one, which is the cut — and one, after a call the deadline cut, until a call
/// answers (<see cref="RerankPace.AfterCut"/>).</para>
///
/// <para><b>And where even ONE window per candidate cannot fit, nothing is sent</b> (<see cref="RerankPace.Admit"/>,
/// <c>docs/judge-bench.md</c> Run 8). On that run's CPU, BGE scored ~3.1 s per 1,000 pair tokens, so a recall of ~59 long
/// notes cost ~118 s at one window each: 230 of 240 chunked recalls waited out the minute, got no verdict, and ended
/// where no judge is — while each cut left its batch running on the router for the next call to queue behind. So when
/// the pace predicts that the one-window call — plus whatever an abandoned call is presumed still to hold the router for
/// — would pass its budget, the call returns at once with a blameless <see cref="ProviderVerdict.Unsupported"/>, which
/// <c>ScoringVerificationPolicy</c> reports as NoOpinion: the engine's page, exactly as a cut leaves it, without the
/// minute. It is logged once per recall at Information, as a pace line ("0 window(s) per long candidate instead of …").
/// Once ten verification deadlines pass with no call able to lower the estimate (a chunked one or a probe; a pass-through
/// call only ever raises it), a skipped recall sends a PROBE instead — the first windows of
/// its longest candidates, sized to a sixth of the budget at the current estimate — so a machine that has become faster
/// is re-measured; when the probe says the whole call now fits, it is sent in the same recall.</para>
///
/// <para><b>A WORKAROUND FOR A LYNTAI GAP, recorded on both sides</b> (dev-conventions: open workaround (6)). Lyntai has
/// closed the gap upstream — <c>docs/task-archive.md</c> Part 287 / D177, with Part 289 closed into it; committed and NOT
/// released, no version promised (read at Lyntai commit <c>e6fa579b</c>). D177 as it stands there: a provider given
/// <c>HttpModelOptions.MaxInputChars</c> SEGMENTS an over-long input (<c>InputSegmentation</c>) and scores a document as
/// its best piece, as here; on a Score registration that bound is the PAIR window, the query keeping at most
/// (1 − <c>MinDocumentShare</c>, default 0.5) of it, cut once per call at a word boundary; it counts characters after NFKC,
/// per text element, and sends the ORIGINAL text; <c>InputSegmentation.MaxPiecesPerInput</c> caps an input's pieces —
/// the first, the last (anchored at the tail) and the rest spread evenly between; <c>Overlap</c> defaults to 0.15 and is
/// configurable. So D177 now does what this class's budget does under a declared window — and this class is QUERY-AWARE
/// only there: for BGE and LAMAR, which declare none, <see cref="RerankInputCap.PerCandidate"/> is 1,000 characters
/// whatever the query. <b>What remains ours</b>: (1) consecutive windows overlap by at least a quarter — settable in D177
/// as <c>Overlap = 0.25</c>, where it is an upper bound (the next piece restarts at the earliest sentence end or space
/// inside it, else where the last ended); (2) under a declared window the text SENT is its NFKC form, where D177 counts
/// NFKC and sends the original (the tokenizer normalises either way; the measurement in <see cref="RerankInputCap"/>
/// found identical token ids for all but 95 scalars newer than the model's table); (3) the call sized by TIME
/// (<see cref="RerankPace"/>), which D177 explicitly rejects as library policy — fitting a call to a latency budget is
/// the deployment's — and cannot carry: <c>MaxPiecesPerInput</c> is fixed at registration, so no decorator can vary a
/// call's pieces per request, and deleting this class deletes the pace. <b>On the bump</b>: measure D177 against this
/// class on Run 6's long fixture within ONE run — the rule, unchanged: not significantly worse at <c>end</c> or
/// <c>beyond</c>, and identical on short facts. D177 cannot carry <see cref="RerankPace"/>, so what follows is an OWNER
/// decision, informed by that comparison: keep this class for the pace, or configure <c>MaxInputChars</c>/
/// <c>Segmentation</c> on the <c>llamacpp-rerank</c> registration (<c>LlamaCppSource.Register</c>) with a fixed
/// <c>MaxPiecesPerInput</c> and lose time-sizing. Either way <see cref="RerankInputCap"/>'s query fit stays until D177's is
/// measured beside it. If D177 fails the rule, keep this class and tell Lyntai why, with the run. The Lyntai half is
/// complete: Part 289's outcome names an app-side segmenting score-provider decorator as the adopter's copy to remove when
/// D177 releases, and Lyntai's <c>docs/memory-measurements.md</c> records our Run 6c as
/// <c>rerank-segmented-adopter-long-notes</c>.</para></summary>
public sealed class ChunkedScoreProvider : IScoreProvider
{
    private readonly IScoreProvider _inner;
    private readonly int? _window;
    private readonly RerankPace _pace;
    private readonly ILogger? _log;

    /// <param name="inner">The reranker's own provider.</param>
    /// <param name="window">The model's DECLARED window (<see cref="GgufCatalog.DeclaredWindow"/>), or null — the same
    /// value <see cref="RerankInputCap"/> is built with, so the windows are its budget.</param>
    /// <param name="pace">How fast this machine scores, and how long one call may take (<see cref="RerankPace"/>).</param>
    public ChunkedScoreProvider(IScoreProvider inner, int? window, RerankPace pace, ILogger? log = null)
    {
        _inner = inner;
        _window = window;
        _pace = pace;
        _log = log;
    }

    public string Id => _inner.Id;
    public ProviderCapabilities Capabilities => _inner.Capabilities;
    public bool IsAvailable => _inner.IsAvailable;
    public Task<ProviderProbeResult> ProbeAsync(CancellationToken ct = default) => _inner.ProbeAsync(ct);

    public async Task<ScoreResponse> CallAsync(ScoreRequest request, CancellationToken ct = default)
    {
        var size = RerankInputCap.PerCandidate(request.Query, _window);
        // Nothing to split — or no room to split into: the request goes as it came, byte for byte.
        var passThrough = size <= 0 || request.Documents.All(d => d.Length <= size);
        var byCount = passThrough ? 1 : RerankInputCap.WindowsPerDocument(request.Documents, size);

        // FIRST, whether to send anything: the least any call can send and still score every candidate is one window each
        // (a pass-through request IS that), and when even that is predicted past the budget the recall is skipped — or,
        // once the re-probe interval has passed, measured with a probe (RerankPace.Admit).
        var firsts = passThrough ? request.Documents : request.Documents.Select(d => RerankInputCap.Windows(d, size, 1)[0]).ToList();
        var oneWindow = RerankPace.PairTokens(request.Query, firsts);
        var plan = _pace.Admit(oneWindow);
        if (plan.Kind == RerankPace.Admission.Probe)
        {
            var (probe, sent) = await MeasureAsync(request.Query, firsts, oneWindow, ct).ConfigureAwait(false);
            // A probe that had to carry every candidate IS the one-window call: its answer is the verdict.
            if (probe.IsOk && sent == firsts.Count && probe.Scores.Count == firsts.Count) return probe;
            var after = _pace.Admit(oneWindow);
            if (!probe.IsOk || after.Kind != RerankPace.Admission.Send)
                return Skipped(byCount, after, probe.IsOk
                    ? $"a probe of {sent} of {firsts.Count} candidates' first windows just now read {_pace.MsPerToken * 1000:0.###} ms per 1,000 pair tokens; "
                    : $"a probe of {sent} of {firsts.Count} candidates' first windows just now got no usable answer ({probe.Verdict}); ");
            // PARSED ELSEWHERE — judge-bench's PACE_LINE counts "re-measured this machine" as a pace line too.
            _log?.LogInformation(
                "{Id}: re-measured this machine on {Sent} of {Candidates} candidates' first windows: {Pace:0.###} ms per 1,000 pair tokens, so one window per candidate is predicted at ~{Predicted:0.#} s — the judge runs this recall",
                Id, sent, firsts.Count, _pace.MsPerToken * 1000, after.PredictedMs / 1000);
        }
        else if (plan.Kind == RerankPace.Admission.Skip)
            return Skipped(byCount, plan, "");

        // Still timed: a slow pass-through call can teach the pace that this machine is slow, and timing a call changes
        // nothing that is sent.
        if (passThrough)
            return await TimedAsync(request, RerankPace.Call.PassThrough, ct).ConfigureAwait(false);

        // As many windows per document as the call can carry: MaxWindows, lowered — the same for every document — past
        // the per-call ceiling, or past what this machine scores within the time budget, down to one: the cut. After a
        // call the deadline cut, ONE — until an answered call has timed the machine (RerankPace.AfterCut).
        var afterCut = _pace.AfterCut;
        var perDocument = afterCut ? 1
            : RerankInputCap.WindowsPerDocument(request.Documents, size, request.Query, _pace.PairTokenBudget());
        // PARSED ELSEWHERE — keep "window(s) per long candidate instead of" in both messages: judge-bench's PACE_LINE counts
        // it (a bench run in which it appears is VOID) and e2e-p52 cases 6e and 6f assert it.
        if (perDocument < byCount && afterCut)
            _log?.LogInformation(
                "{Id}: {Windows} window(s) per long candidate instead of {ByCount}, until a call answers in time — the last was cut at the verification deadline, which says only that this machine is slower than {Pace:0.###} ms per 1,000 pair tokens",
                Id, perDocument, byCount, _pace.MsPerToken * 1000);
        else if (perDocument < byCount)
            _log?.LogInformation(
                "{Id}: {Windows} window(s) per long candidate instead of {ByCount}, so the call fits ~{Budget:0.#} s at the {Pace:0.###} ms per 1,000 pair tokens (counted by script) measured here",
                Id, perDocument, byCount, _pace.Budget.TotalSeconds, _pace.MsPerToken * 1000);
        var windows = request.Documents.Select(d => RerankInputCap.Windows(d, size, perDocument)).ToList();
        var flat = windows.SelectMany(w => w).ToList();
        var response = await TimedAsync(request with { Documents = flat }, RerankPace.Call.Chunked, ct).ConfigureAwait(false);
        if (!response.IsOk) return response;
        // Pairing windows back to documents by position is only sound when every window was scored — the arity rule
        // the scoring policy applies to documents, one level down.
        if (response.Scores.Count != flat.Count)
            return ScoreResponse.Failure(ProviderVerdict.Failed,
                $"{Id}: scored {response.Scores.Count} of {flat.Count} windows ({request.Documents.Count} documents)");

        var best = new double[windows.Count];
        var k = 0;
        for (var i = 0; i < windows.Count; i++)
        {
            var max = double.NegativeInfinity;
            for (var j = 0; j < windows[i].Count; j++) max = Math.Max(max, response.Scores[k++]);
            best[i] = max;
        }
        _log?.LogDebug("{Id}: scored {Documents} documents as {Windows} windows", Id, windows.Count, flat.Count);
        return ScoreResponse.Success(best, response.Detail, response.Usage);
    }

    /// <summary>One call to the inner provider, timed into the pace: a call that answered as a measurement, a call a
    /// deadline cut off as a lower bound (it ran at least that long). A failed answer teaches nothing — a quick refusal
    /// would read as a fast machine. The pace is told when the call was SENT, so a call that started while an abandoned
    /// one was presumed still running on the router is judged as possibly queued (<see cref="RerankPace.Sending"/>).</summary>
    private async Task<ScoreResponse> TimedAsync(ScoreRequest request, RerankPace.Call kind, CancellationToken ct)
    {
        var tokens = RerankPace.PairTokens(request.Query, request.Documents);
        var ticket = _pace.Sending(kind);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var response = await _inner.CallAsync(request, ct).ConfigureAwait(false);
            if (response.IsOk) _pace.Observe(ticket, clock.Elapsed, tokens, kind);
            return response;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            _pace.AtLeast(ticket, clock.Elapsed, tokens);
            throw;
        }
    }

    /// <summary>The re-measuring call a skipped recall sends once the re-probe interval has passed: the FIRST windows of
    /// the longest candidates — long pairs, like the calls the estimate sizes, since short ones cost less per token —
    /// until they reach <see cref="RerankPace.ProbeTokens"/>, sent in their input order so that a probe needing every
    /// candidate is the one-window call itself. Returns what came back and how many candidates it carried.</summary>
    private async Task<(ScoreResponse Response, int Sent)> MeasureAsync(
        string query, IReadOnlyList<string> firsts, double oneWindow, CancellationToken ct)
    {
        var target = _pace.ProbeTokens();
        var queryTokens = RerankPace.Tokens(query);
        var chosen = new HashSet<int>();
        double tokens = 0;
        foreach (var (i, t) in firsts.Select((d, i) => (i, queryTokens + RerankPace.Tokens(d))).OrderByDescending(x => x.Item2))
        {
            chosen.Add(i);
            tokens += t;
            if (tokens >= target) break;
        }
        var documents = firsts.Where((_, i) => chosen.Contains(i)).ToList();
        _log?.LogDebug("{Id}: probing with {Sent} of {Candidates} first windows, ~{Tokens:0} of the ~{All:0} pair tokens one window each would be",
            Id, documents.Count, firsts.Count, tokens, oneWindow);
        var response = await TimedAsync(new ScoreRequest(query, documents), RerankPace.Call.Probe, ct).ConfigureAwait(false);
        return (response, documents.Count);
    }

    /// <summary>A recall the pace will not send: one Information line, and a blameless failure the scoring policy turns
    /// into NoOpinion — the engine's own page, as a cut leaves it, at once.
    ///
    /// <para><b>Why <see cref="ProviderVerdict.Unsupported"/></b>: Lyntai's router SURFACES it — no fallback, no dead-host
    /// penalty, no cooldown (<c>RoutingPolicy</c>), and <c>IsBlameless</c> — which is what a decision taken here, about this
    /// machine's speed, is: not a fault of the host. <c>Timeout</c> or <c>Failed</c> would count toward benching the
    /// reranker. <b>On the Lyntai bump</b>: its next release logs a non-transient verdict from this policy at Warning
    /// (3.2.0 logs it at Debug), so each skip would log twice — the line below, and a Warning. Keep the line below (the
    /// bench and <c>e2e-p52</c> parse it) and decide then whether that Warning is noise to filter.</para></summary>
    private ScoreResponse Skipped(int byCount, RerankPace.Plan plan, string probed)
    {
        var queue = plan.QueueMs > 0
            ? $", behind the ~{plan.QueueMs / 1000:0.#} s the router is presumed still busy with a call abandoned earlier"
            : "";
        // PARSED ELSEWHERE — keep "0 window(s) per long candidate instead of" and "the judge is skipped": judge-bench's
        // PACE_LINE counts the first (a bench run in which it appears outside a CPU arm is VOID), its PACE_SKIP reads this
        // line, and e2e-p52 case 6h asserts it.
        _log?.LogInformation(
            "{Id}: 0 window(s) per long candidate instead of {ByCount} — the judge is skipped for this recall: {Probed}one window per candidate is predicted at ~{Predicted:0.#} s at the {Pace:0.###} ms per 1,000 pair tokens measured here{Queue}, past the ~{Budget:0.#} s a call has. The engine's own page stands; the first skipped recall after ~{Reprobe:0.#} min sends a probe to re-measure this machine",
            Id, byCount, probed, plan.PredictedMs / 1000, _pace.MsPerToken * 1000, queue, _pace.Budget.TotalSeconds,
            plan.NextProbeIn.TotalMinutes);
        return ScoreResponse.Failure(ProviderVerdict.Unsupported,
            $"{Id}: skipped — one window per candidate is predicted at ~{plan.PredictedMs / 1000:0.#} s{queue}, past the ~{_pace.Budget.TotalSeconds:0.#} s budget");
    }
}

/// <summary>How fast THIS machine's reranker scores, learned from the calls it makes — so the windows a long candidate is
/// read in fit the verification deadline on a slow machine, not only on the GPU the fixed ceiling was tuned on.
///
/// <para><b>Why.</b> <see cref="RerankInputCap.MaxWindowsPerCall"/> is a COUNT measured on one GPU (RTX 4080 Laptop,
/// llama.cpp b10549): 480 full windows of dense Chinese took ~20 s on BGE and LAMAR (<c>docs/judge-bench.md</c> Run 6b). A
/// CPU-only machine scores many times slower, so the same call can outlast <see cref="VerificationDeadlinePolicy"/>'s 60 s
/// — and a verification cut off there is NoOpinion after a minute's wait, logged at Warning and nowhere a household
/// looks. So a chunked call is sized by TIME: the windows per candidate are chosen so the predicted call fits
/// <see cref="Budget"/>, HALF the verification deadline, the other half being the margin for a prediction that is
/// wrong.</para>
///
/// <para><b>What is estimated: milliseconds per PAIR TOKEN</b> — the query beside each document, summed over the pairs a
/// call sends, which is what a cross-encoder reads. Not per window: a short fact is a window of ~60 characters and a long
/// note's 1,000, so a per-window pace learned from short facts would under-predict a long note by the ratio of their
/// lengths. Not per CHARACTER either, which is what it was until review: a character of Chinese costs ~0.83 tokens and
/// one of English ~0.25 (<see cref="CjkTokensPerChar"/>, <see cref="OtherTokensPerChar"/> — measured on the real router,
/// <c>docs/self-managed-llm-runtime.md</c>), so a per-character pace learned on English under-predicted the same number
/// of Chinese characters by ~3.3× — more than the half-deadline margin covers. So each character is counted as the
/// tokens its script costs (<see cref="Tokens"/>, the ONE writer both the timing and the sizing use), from the text alone,
/// with no <c>/tokenize</c> round trip. <see cref="CallOverheadMs"/> is taken off each call first.</para>
///
/// <para><b>How it moves</b> — each rule a judgement, stated as one, and each chosen so that believing a slow machine
/// wrongly costs a few windows on a few recalls while disbelieving one costs a minute's wait and no verdict:
/// <list type="bullet">
/// <item>Seeded with the GPU measurement (<see cref="SeedMsPerToken"/>), at which the time budget allows more than the
/// ceiling for a question of up to ~500 characters beside dense Chinese windows — so until a call has been timed,
/// nothing changes from the fixed cap on that GPU.</item>
/// <item><b>A call too SMALL to measure teaches nothing</b> — neither the estimate nor the repeat flag below: one whose
/// scoring, at the current estimate, would take under <see cref="MinSignalFactor"/> × <see cref="CallOverheadMs"/>. Its
/// time is then mostly round trip, queueing, or a stall, and dividing it by a few dozen tokens reads any of those as a
/// slow machine: a 33-token call taking 150 ms read 3 ms per token, 60× the seed, and a 17 s model reload on a 30-token
/// call 565. Relative to the ESTIMATE, not a fixed token count, so that on the GPU (the seed) only calls of ~4,000
/// tokens teach — where an unmodelled delay the size of the allowance moves the rate by at most a quarter, inside the
/// ~1.47× the seed's budget leaves above the count ceiling, so jitter there cannot make the pace fire — while on a
/// machine already measured slow, where scoring dominates any call, smaller calls do.</item>
/// <item><b>A slower call that answered</b> is believed at once when the call before it that taught anything was slow
/// too (answered slower than the estimate, or cut off having proved it slow) — and the flag stays set, so a third slow
/// call in a row is believed as well. ALONE, it moves the estimate halfway in log space — the geometric mean of the two
/// — and never more than ×<see cref="MaxLoneRaise"/>, because one outlier (a model reloading, a moment of contention)
/// would otherwise cut every long note of the next recalls to its first window.</item>
/// <item><b>A faster call</b> moves the estimate halfway toward it, arithmetically, so a single fast call can at most
/// halve it: if that call was the misleading one, the next is under-predicted by at most 2×, which the half-deadline
/// margin covers. Halving in log space would recover faster from a large false raise, and could drop a true slow
/// estimate ~10× on one fast call — so the ×4 cap on a lone raise bounds the false raises instead. Only a CHUNKED call
/// lowers it: a pass-through call (every document one window) may raise the estimate and never lowers it, since short
/// pairs cost less per token than long ones (attention grows faster than length).</item>
/// <item><b>A call the deadline CUT</b> (the caller's token cancelled — <see cref="AtLeast"/>) teaches only if it ran
/// longer than the estimate predicted: then it raises the estimate to that lower bound and sets the repeat flag. A
/// cancellation earlier than that — a user's stop, an abandoned request — proves nothing about the rate (it still leaves
/// the router busy; see below). A lower
/// bound is not enough to SIZE by: halving from it, each cut call's successor is cut again whenever the first one's true
/// time was over twice the deadline, so a machine 30× slower would wait the minute four times running. So a cut past
/// <see cref="Budget"/> puts the pace <see cref="AfterCut"/>: every chunked call sends ONE window per candidate — the
/// fewest that scores them all — until one ANSWERS, and that answer is believed whole, in either direction and whatever
/// its size, since it is the measurement the lower bound was missing. On a machine where even one window per candidate
/// is too slow for a recall that big, no sizing can fix it, since fewer windows than candidates would leave one
/// unscored — so that recall is not sent at all (<see cref="Admit"/>, below).</item>
/// <item>A failed answer teaches nothing. It lives as long as the process — each launch re-seeds it at the GPU figure —
/// and there is one per verifier, so one per reranker. <b>Concurrency</b>: two recalls contending for one child each
/// time the other's scoring too, so both read slower than the machine is, and the second is believed as a repeat — it
/// errs toward fewer windows, until a later uncontended chunked call lowers it halfway.</item>
/// </list></para>
///
/// <para><b>An abandoned call is NOT free, and what queues behind it is not believed</b> (<c>docs/judge-bench.md</c> Run 8,
/// "The deadline cuts, and the queue behind an abandoned batch" and "The pace"). llama-server keeps scoring a batch whose
/// request was cancelled — a 1-document call sent after a BGE call abandoned at 15 s took 181.9 s — so on that run's CPU a
/// recall right after a cut was cut 218 of 222 times, and the queue, not the machine, drove the estimate: a 1-note,
/// 801-token call that waited out the minute behind two abandoned batches set it through <see cref="AtLeast"/> to 24× the
/// machine's answered rate, an ANSWERED call that had queued was believed whole at 4.4×, and the run ended at 5.7×, set by
/// a cut 3,398-token call. So, each rule a judgement stated as one:
/// <list type="bullet">
/// <item><b>Every abandoned call</b> (the caller's token cancelled — the deadline, a stop) leaves the router presumed
/// BUSY for the longer of what the estimate still predicted for it and <see cref="QueueFactor"/> × the time it had run —
/// twice as long again: at the rate BGE's answered calls ran there (~3.1 s per 1,000 pair tokens), Run 8's cut calls
/// needed a median ~118 s and at most ~125 s in all, so at most ~65 s past the minute, inside the 120 s presumed. A
/// first call sized at the GPU seed on a far slower machine can run longer than that — a stated limit.</item>
/// <item><b>A call SENT while the router is presumed busy is possibly queued</b> (<see cref="Sending"/>): its time
/// includes the wait, so if it is cut it teaches NOTHING (it proves only that the queue was long), and if it answers
/// it is an UPPER bound — it may lower the estimate, never raise it, and does not end <see cref="AfterCut"/>. Either
/// way an answer means the router reached it, so the busy presumption ends there.</item>
/// <item><b>Nothing is sent where one window per candidate cannot fit</b> (<see cref="Admit"/>): when the one-window
/// call is predicted, plus the presumed queue, past <see cref="Budget"/>, the recall is SKIPPED — NoOpinion at once,
/// where Run 8 waited the full minute for it on 230 of 240 recalls. The prediction is only as good as the estimate, and
/// after a cut the estimate is a lower bound, so a skip errs toward the household's time.</item>
/// <item><b>A skipped recall re-measures</b> once <see cref="ReprobeInterval"/> — ten verification deadlines — has passed
/// since the last call that could LOWER the estimate — a chunked call or a probe; not a pass-through call, which only
/// ever raises it, so short-fact recalls cannot hold off the re-check; from the first skip when there has been none —
/// and nothing is presumed queued: it sends a PROBE of <see cref="ProbeTokens"/>, a sixth of the budget at
/// the current estimate (~5 s at the product's deadline), and the answer is believed whole, like the answer after a cut —
/// so a machine that has become faster (its GPU freed, a smaller page) is found within the interval, and a truly slow one
/// pays ~5 s per interval instead of a minute per recall. The worst a probe can cost is one deadline, if it is cut:
/// bounded, at this interval, to a tenth of the time the judge is being skipped. Replaying Run 8's chunked BGE recalls
/// against these rules (scratch, one queue on the router at the answered median rate, abandoned batches scored to the
/// end): one minute-wait in the whole run where there were 230; 9–14 verdicts, on the recalls small enough to fit, when
/// recalls came 5–60 s apart, against the run's 10; and 1 back to back, where every recall after the cut fell inside the
/// presumed queue — a replay, not a measurement.</item>
/// </list></para>
///
/// <para><b>Unmeasured</b>: how many recalls it takes to settle on a CPU-only machine where calls are SIZED (Run 8's
/// mMiniLMv2 never needed sizing, and its BGE needed one window each and then more than that), and how far a long
/// window's cost outruns a rate learned from short facts. The skip, the queue presumption and the probe were derived
/// from Run 8 and replayed against its record, not run on its CPU. The two token rates are two
/// measurements on the XLM-R tokenizer family: every UTF-16 unit from U+2E80 up (CJK, kana, Hangul syllables, full-width
/// forms, both halves of a surrogate pair) is counted at the CJK rate, the worst measured — emoji measured ~0.48, rare
/// CJK less — and every unit below it at the English one. That leaves counted like English, and unmeasured: other
/// scripts (Cyrillic, Greek, Arabic, Thai, Devanagari…), Hangul conjoining Jamo (U+1100–11FF) and the BMP symbols and
/// emoji of U+2600–27BF, all below U+2E80. That rerank time is proportional to tokens is itself an assumption the GPU
/// and CPU figures fit (Run 8: mMiniLMv2's answered rate steady at ~0.30 s per 1,000 across calls of 133 to 65,463
/// tokens), not a measured law. The floor's factor, the log-space step and its cap, the queue factor, the probe's share
/// and the re-probe interval are judgements. <c>e2e-p52</c> case 6e drives the answered path with a fake
/// router that answers in time proportional to the pair TOKENS it is sent — a lone slow call not believed, the second
/// believed, a fast pass-through not lowering it, a slow small call teaching nothing — case 6f the cut path (a first
/// call ~2× past the deadline; the next recall skipped while the router is presumed busy, then one window and a verdict),
/// case 6g the per-script count, and case 6h the skip (a machine too slow for one window per candidate: cut once, then
/// skipped fast; a short-fact recall that fits is sent and does not restart the interval; then a probe after it — still
/// slow, skipped; then fast, and the judge runs). Confirmed to FAIL with the skip removed (6f, 6h), with the queue
/// presumption removed (6f) and with every sent call restarting the interval (6h's probe).</para></summary>
public sealed class RerankPace
{
    /// <summary>Tokens per UTF-16 unit of CJK text — the worst rate measured on the real router (4,089 Chinese characters
    /// ~3,400 tokens, 6,010 ~4,960; <c>docs/self-managed-llm-runtime.md</c>, 2026-09-23).</summary>
    public const double CjkTokensPerChar = 0.83;

    /// <summary>Tokens per character of English, measured beside it (6,263 characters ~1,600 tokens, 12,503 ~3,160).</summary>
    public const double OtherTokensPerChar = 0.25;

    /// <summary>The first code unit counted at the CJK rate: U+2E80, CJK Radicals Supplement. Everything from it up —
    /// ideographs, kana, Hangul syllables, full-width forms, and both halves of a surrogate pair — is counted as CJK;
    /// everything below it (Hangul conjoining Jamo and the U+2600–27BF symbols included) as English.</summary>
    public const char CjkFrom = '⺀';

    /// <summary>The GPU measurement the fixed ceiling was tuned on: 480 windows of 1,000 dense Chinese characters in
    /// ~20 s (Run 6b), counted at the CJK rate, the query not counted — which only makes the seed slower, i.e. safer.</summary>
    public const double SeedMsPerToken = 20_000.0 / (480 * 1_000 * CjkTokensPerChar);

    /// <summary>What a call costs before it scores anything — the HTTP round trip, the batch set-up — taken off each
    /// measurement. The two-document bind screen ran in 25–33 ms warm on the real router (<c>LlamaCppSource</c>), so 50 ms
    /// is an allowance above it.</summary>
    public const double CallOverheadMs = 50;

    /// <summary>A call teaches only when its scoring, at the current estimate, would take at least this many times
    /// <see cref="CallOverheadMs"/> — ~4,000 tokens at the seed. See the class comment.</summary>
    public const double MinSignalFactor = 4;

    /// <summary>The most a LONE slower call may multiply the estimate by. See the class comment.</summary>
    public const double MaxLoneRaise = 4;

    /// <summary>A floor, so a run of calls faster than the allowance cannot drive the estimate to zero and the budget to
    /// infinity — the per-call ceiling then decides, as it did before this class.</summary>
    private const double MinMsPerToken = 1e-4;

    /// <summary>An abandoned call is presumed to keep the router busy for this many times as long AGAIN as it had run (or
    /// for what the estimate still predicted for it, when that is longer). See the class comment for Run 8's figures.</summary>
    public const double QueueFactor = 2;

    /// <summary>How many verification deadlines pass with no call able to lower the estimate before a skipped recall re-measures the machine
    /// with a probe — the deadline being twice <see cref="Budget"/>. See the class comment.</summary>
    public const double ReprobeDeadlines = 10;

    /// <summary>What share of <see cref="Budget"/> a probe is sized to at the current estimate — ~5 s at the product's
    /// deadline: long enough that the 50 ms overhead allowance is a percent of it on a slow machine, short enough that a
    /// truly slow one pays seconds, not the minute.</summary>
    public const double ProbeShareOfBudget = 1.0 / 6;

    /// <summary>What a timed call was, which decides what it may teach (the class comment's rules).</summary>
    public enum Call
    {
        /// <summary>Every document fit one window, so the request went as it came: may raise the estimate, never lower it.</summary>
        PassThrough,

        /// <summary>At least one document went as several windows (or as its first, the cut).</summary>
        Chunked,

        /// <summary>A re-measuring call a skipped recall sent (<see cref="Admission.Probe"/>): believed whole, like the
        /// answer after a cut — unless it was possibly queued.</summary>
        Probe,
    }

    /// <summary>What a recall's call is to be (<see cref="Admit"/>).</summary>
    public enum Admission
    {
        /// <summary>One window per candidate fits the budget: send, sized as usual.</summary>
        Send,

        /// <summary>It does not: send nothing, and let the engine's page stand.</summary>
        Skip,

        /// <summary>It does not, but the re-probe interval has passed: send a probe (<see cref="ProbeTokens"/>) first.</summary>
        Probe,
    }

    /// <summary><see cref="Admit"/>'s answer, with what it was decided on — for the log line.</summary>
    /// <param name="PredictedMs">The one-window call, predicted at the current estimate, overhead included.</param>
    /// <param name="QueueMs">How much longer the router is presumed busy with an abandoned call; 0 when it is not.</param>
    /// <param name="NextProbeIn">How long until a skipped recall would probe, if nothing is sent meanwhile.</param>
    public readonly record struct Plan(Admission Kind, double PredictedMs, double QueueMs, TimeSpan NextProbeIn);

    /// <summary>A call as it was sent (<see cref="Sending"/>): whether the router was then presumed busy with an
    /// abandoned one, which decides what its answer or its cut may teach.</summary>
    public readonly record struct Ticket(bool Queued);

    private readonly object _gate = new();
    private readonly Func<TimeSpan> _clock;
    private double _msPerToken;
    // The last call that taught anything was SLOW — answered slower than the estimate, or cut off having proved it slow —
    // so the next slower answer is a repeat and is believed at once. Stays set across a believed repeat.
    private bool _slowBefore;
    // A call was cut past the budget, so the estimate is only a lower bound: one window per candidate until an answer.
    private bool _afterCut;
    // Until when the router is presumed still scoring a call that was abandoned (the clock's reading).
    private TimeSpan _busyUntil = TimeSpan.MinValue;
    // When a call that could LOWER the estimate — a chunked call or a probe — was last sent; the re-probe interval runs
    // from it, or from the first skip when none has been. Not a pass-through call: it may raise the estimate and never
    // lower it, so if it restarted the interval, a machine that became fast would stay skipped for as long as short-fact
    // recalls kept coming.
    private TimeSpan? _lastMeasuring;

    /// <param name="budget">How long one call may be predicted to take — half the verification deadline.</param>
    /// <param name="seedMsPerToken">The estimate before any call is timed.</param>
    /// <param name="clock">A monotonic clock; the process's uptime when null.</param>
    public RerankPace(TimeSpan budget, double seedMsPerToken = SeedMsPerToken, Func<TimeSpan>? clock = null)
    {
        Budget = budget;
        _msPerToken = Math.Max(MinMsPerToken, seedMsPerToken > 0 ? seedMsPerToken : SeedMsPerToken);
        _clock = clock ?? (() => TimeSpan.FromMilliseconds(Environment.TickCount64));
    }

    /// <summary>How long one call may be predicted to take.</summary>
    public TimeSpan Budget { get; }

    /// <summary>How long a skipped recall waits before it probes — from the last call that could lower the estimate (a
    /// chunked call or a probe), or from the first skip when none has been: <see cref="ReprobeDeadlines"/> verification
    /// deadlines — 10 minutes at the product's 60 s, and proportionally less under the test knob.</summary>
    public TimeSpan ReprobeInterval => Budget * 2 * ReprobeDeadlines;

    /// <summary>The current estimate, in milliseconds per pair token.</summary>
    public double MsPerToken { get { lock (_gate) return _msPerToken; } }

    /// <summary>True from a call cut past <see cref="Budget"/> until a chunked call answers: the estimate is then only a
    /// lower bound, and <see cref="ChunkedScoreProvider"/> sends one window per candidate.</summary>
    public bool AfterCut { get { lock (_gate) return _afterCut; } }

    /// <summary>How many pair tokens one call may carry within <see cref="Budget"/> at the current estimate.</summary>
    public double PairTokenBudget()
    {
        var ms = Budget.TotalMilliseconds - CallOverheadMs;
        return ms <= 0 ? 0 : ms / MsPerToken;
    }

    /// <summary>Whether a recall's call is to be sent at all, given the pair tokens it would carry at ONE window per
    /// candidate — the least that scores them all. Send when that call, predicted at the current estimate and behind any
    /// presumed queue, fits <see cref="Budget"/>; otherwise Skip — or Probe, once <see cref="ReprobeInterval"/> has passed
    /// and nothing is presumed queued. A Probe is claimed here (it restarts the interval), so two recalls at once cannot
    /// both probe; the first skip with nothing measured yet starts the interval.</summary>
    public Plan Admit(double oneWindowPairTokens)
    {
        lock (_gate)
        {
            var now = _clock();
            var predicted = CallOverheadMs + Math.Max(0, oneWindowPairTokens) * _msPerToken;
            var queue = _busyUntil > now ? (_busyUntil - now).TotalMilliseconds : 0;
            var nextProbe = _lastMeasuring is { } last ? last + ReprobeInterval - now : ReprobeInterval;
            if (nextProbe < TimeSpan.Zero) nextProbe = TimeSpan.Zero;
            if (predicted + queue <= Budget.TotalMilliseconds) return new Plan(Admission.Send, predicted, queue, nextProbe);
            if (queue > 0 || nextProbe > TimeSpan.Zero)
            {
                _lastMeasuring ??= now;
                return new Plan(Admission.Skip, predicted, queue, nextProbe);
            }
            _lastMeasuring = now;
            return new Plan(Admission.Probe, predicted, queue, ReprobeInterval);
        }
    }

    /// <summary>How many pair tokens a probe carries: <see cref="ProbeShareOfBudget"/> of the budget at the current
    /// estimate, the overhead allowance taken off first.</summary>
    public double ProbeTokens()
    {
        var ms = Budget.TotalMilliseconds * ProbeShareOfBudget - CallOverheadMs;
        return ms <= 0 ? 0 : ms / MsPerToken;
    }

    /// <summary>A call of <paramref name="kind"/> is being sent now: says whether the router is presumed still busy with
    /// an abandoned call — which makes this one possibly queued (the class comment) — and, for a call whose answer could
    /// lower the estimate (chunked, or a probe), restarts the re-probe interval.</summary>
    public Ticket Sending(Call kind)
    {
        lock (_gate)
        {
            var now = _clock();
            if (kind != Call.PassThrough) _lastMeasuring = now;
            return new Ticket(_busyUntil > now);
        }
    }

    /// <summary>A call that answered: <paramref name="elapsed"/> for <paramref name="pairTokens"/>.</summary>
    public void Observe(Ticket ticket, TimeSpan elapsed, double pairTokens, Call kind)
    {
        lock (_gate)
        {
            // The router reached this call, so whatever it held before it is done.
            var now = _clock();
            if (_busyUntil > now) _busyUntil = now;
        }
        if (!(pairTokens > 0)) return;
        var observed = Rate(elapsed, pairTokens);
        lock (_gate)
        {
            if (ticket.Queued)
            {
                // Its time includes the wait, so it is an UPPER bound: it may lower the estimate, never raise it, and it
                // is not the measurement a cut was missing (AfterCut stays).
                if (observed < _msPerToken) _msPerToken = observed;
                return;
            }
            if ((_afterCut && kind == Call.Chunked) || kind == Call.Probe)
            {
                // The measurement a cut was missing, or the one a probe was sent for: believed whole, in either direction,
                // whatever its size.
                _slowBefore = observed > _msPerToken;
                _msPerToken = observed;
                _afterCut = false;
                return;
            }
            if (TooSmall(pairTokens)) return;
            if (observed > _msPerToken)
            {
                // Slower: believed at once on a repeat; alone, halfway in log space and at most ×MaxLoneRaise.
                _msPerToken = _slowBefore ? observed : Math.Min(Math.Sqrt(_msPerToken * observed), MaxLoneRaise * _msPerToken);
                _slowBefore = true;
                return;
            }
            _slowBefore = false;
            if (kind == Call.Chunked) _msPerToken = Math.Max(MinMsPerToken, _msPerToken + (observed - _msPerToken) / 2);
        }
    }

    /// <summary>A call cut off after <paramref name="elapsed"/> — it would have taken at least that long, and the router
    /// is presumed to go on scoring it (the class comment).</summary>
    public void AtLeast(Ticket ticket, TimeSpan elapsed, double pairTokens)
    {
        lock (_gate)
        {
            // Whatever it proves, the router keeps it: busy for the longer of what the estimate still predicted for it and
            // QueueFactor × the time it had run.
            var predicted = CallOverheadMs + Math.Max(0, pairTokens) * _msPerToken;
            var remaining = Math.Max(predicted - elapsed.TotalMilliseconds, QueueFactor * elapsed.TotalMilliseconds);
            var until = _clock() + TimeSpan.FromMilliseconds(Math.Max(0, remaining));
            if (until > _busyUntil) _busyUntil = until;
        }
        // Possibly queued: its time was the queue's, so it proves nothing about the machine.
        if (ticket.Queued || !(pairTokens > 0)) return;
        var observed = Rate(elapsed, pairTokens);
        lock (_gate)
        {
            // Cancelled before it was due to finish, or too small to say anything: proves nothing.
            if (TooSmall(pairTokens) || observed <= _msPerToken) return;
            _msPerToken = observed;
            _slowBefore = true;
            if (elapsed > Budget) _afterCut = true;
        }
    }

    // Under the lock.
    private bool TooSmall(double pairTokens) => pairTokens * _msPerToken < MinSignalFactor * CallOverheadMs;

    private static double Rate(TimeSpan elapsed, double pairTokens) =>
        Math.Max(MinMsPerToken, (elapsed.TotalMilliseconds - CallOverheadMs) / pairTokens);

    /// <summary>What one character is counted as: <see cref="CjkTokensPerChar"/> from <see cref="CjkFrom"/> up,
    /// <see cref="OtherTokensPerChar"/> below it.</summary>
    public static double Weight(char c) => c >= CjkFrom ? CjkTokensPerChar : OtherTokensPerChar;

    /// <summary>A text's tokens as this class counts them — the one writer the timing and the sizing share.</summary>
    public static double Tokens(string text)
    {
        var sum = 0.0;
        foreach (var c in text) sum += Weight(c);
        return sum;
    }

    /// <summary><see cref="Tokens"/> of every prefix: entry <c>i</c> counts the first <c>i</c> characters, so a window's
    /// tokens are one subtraction (<see cref="RerankInputCap.WindowsPerDocument"/>).</summary>
    public static double[] CumulativeTokens(string text)
    {
        var sums = new double[text.Length + 1];
        for (var i = 0; i < text.Length; i++) sums[i + 1] = sums[i] + Weight(text[i]);
        return sums;
    }

    /// <summary>The pair tokens a call sends: the query beside each document.</summary>
    public static double PairTokens(string query, IReadOnlyList<string> documents)
    {
        var q = Tokens(query);
        return documents.Sum(d => q + Tokens(d));
    }
}
