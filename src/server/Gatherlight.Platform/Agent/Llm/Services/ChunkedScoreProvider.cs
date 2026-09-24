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
/// roughly the characters it sends: a candidate needing two windows costs about twice what its cut prefix did, and at
/// most <see cref="RerankInputCap.MaxWindows"/> times. Measured on 60 notes of ~900–1,200 characters: a recall's serial
/// median went 2.0 → 3.2 s on BGE and 0.5 → 1.2 s on mMiniLMv2, on one GPU. Short candidates cost nothing extra. A call
/// carries at most <see cref="RerankInputCap.MaxWindowsPerCall"/> windows — a COUNT tuned on that GPU — and, below it, only
/// as many as <see cref="RerankPace"/> predicts will be scored within half the verification deadline on THIS machine:
/// fewer windows per candidate on a slow one, down to one, which is the cut.</para>
///
/// <para><b>A WORKAROUND FOR A LYNTAI GAP, recorded on both sides</b> (dev-conventions: open workaround (6)). Lyntai has
/// closed the gap upstream — <c>docs/task-archive.md</c> Part 287 / D177, committed and NOT released, no version
/// promised: a provider given <c>HttpModelOptions.MaxInputChars</c> SEGMENTS an over-long input
/// (<c>InputSegmentation</c>) and scores a document as its best piece, as here. It is not a drop-in. D177's HTTP bound is
/// a FIXED character count per document that never counts the query (Lyntai's advice: the window minus your longest
/// query, with margin), and it caps neither pieces per document nor pieces per call. This class's budget is QUERY-AWARE
/// — what the fitted query leaves (<see cref="RerankInputCap.PerCandidate"/>) — and counted on the NFKC-normalised text;
/// its windows overlap by at least a quarter (D177: 0.15, ending at a boundary), the last is anchored at the tail, a
/// candidate gets at most five windows and a call at most what <see cref="RerankPace"/> allows; and a request whose every
/// document fits one window is passed through byte for byte. <b>On the bump</b>: measure D177 against this class on
/// Run 6's long fixture within ONE run — the rule: not significantly worse at <c>end</c> or <c>beyond</c>, and identical on
/// short facts. If it holds, delete this class, configure <c>MaxInputChars</c>/<c>Segmentation</c> on the
/// <c>llamacpp-rerank</c> registration (<c>LlamaCppSource.Register</c>), keep <see cref="RerankInputCap"/>'s query fit, and
/// decide what bounds a call's TIME, since D177 bounds none (keep <see cref="RerankPace"/>'s sizing, or ask Lyntai for
/// one). If it does not hold, keep this class and tell Lyntai why.</para></summary>
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
        // Nothing to split — or no room to split into: the request as it came, byte for byte. Still timed: every call
        // teaches the pace, and timing a call changes nothing that is sent.
        if (size <= 0 || request.Documents.All(d => d.Length <= size)) return await TimedAsync(request, ct).ConfigureAwait(false);

        // As many windows per document as the call can carry: MaxWindows, lowered — the same for every document — past
        // the per-call ceiling, or past what this machine scores within the time budget, down to one: the cut.
        var byCount = RerankInputCap.WindowsPerDocument(request.Documents, size);
        var perDocument = RerankInputCap.WindowsPerDocument(request.Documents, size, request.Query.Length, _pace.PairCharBudget());
        if (perDocument < byCount)
            _log?.LogInformation(
                "{Id}: {Windows} window(s) per long candidate instead of {ByCount}, so the call fits ~{Budget:0.#} s at the {Pace:0.###} ms per 1,000 pair characters measured here",
                Id, perDocument, byCount, _pace.Budget.TotalSeconds, _pace.MsPerChar * 1000);
        var windows = request.Documents.Select(d => RerankInputCap.Windows(d, size, perDocument)).ToList();
        var flat = windows.SelectMany(w => w).ToList();
        var response = await TimedAsync(request with { Documents = flat }, ct).ConfigureAwait(false);
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
    /// would read as a fast machine.</summary>
    private async Task<ScoreResponse> TimedAsync(ScoreRequest request, CancellationToken ct)
    {
        var chars = RerankPace.PairChars(request.Query, request.Documents);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var response = await _inner.CallAsync(request, ct).ConfigureAwait(false);
            if (response.IsOk) _pace.Observe(clock.Elapsed, chars);
            return response;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            _pace.AtLeast(clock.Elapsed, chars);
            throw;
        }
    }
}

/// <summary>How fast THIS machine's reranker scores, learned from the calls it makes — so the windows a long candidate is
/// read in fit the verification deadline on a slow machine, not only on the GPU the fixed ceiling was tuned on.
///
/// <para><b>Why.</b> <see cref="RerankInputCap.MaxWindowsPerCall"/> is a COUNT measured on one GPU (RTX 4080 Laptop,
/// llama.cpp b10549): 480 full windows took ~20 s on BGE and LAMAR (<c>docs/judge-bench.md</c> Run 6b). A CPU-only machine
/// scores many times slower, so the same call can outlast <see cref="VerificationDeadlinePolicy"/>'s 60 s — and a
/// verification cut off there is NoOpinion after a minute's wait, logged at Warning and nowhere a household looks. So a
/// chunked call is sized by TIME: the windows per candidate are chosen so the predicted call fits <see cref="Budget"/>,
/// HALF the verification deadline, the other half being the margin for a prediction that is wrong.</para>
///
/// <para><b>What is estimated: milliseconds per PAIR CHARACTER</b> — the query's length plus the document's, summed over
/// the pairs a call sends, which is what a cross-encoder reads. Not per window: a short fact is a window of ~60
/// characters and a long note's window 1,000, so a per-window pace learned from short facts would under-predict a long
/// note by the ratio of their lengths, where a per-character one lets every call teach it — the pass-through calls of a
/// household of short facts included. It still under-predicts a long window somewhat (attention grows faster than
/// length), which the other half of the deadline covers. <see cref="CallOverheadMs"/> is taken off each call first, so a
/// call of two short facts, nearly all round trip, does not read as a slow machine.</para>
///
/// <para><b>How it moves.</b> Seeded with the GPU measurement (<see cref="SeedMsPerChar"/>), at which the time budget
/// allows more than the ceiling — so until a call has been timed nothing changes from the fixed cap. A SLOWER call is
/// believed at once; a faster one moves the estimate halfway toward it. A call a deadline cut off raises it to at least
/// what that call proved: the time it had run, over what it sent. Pessimistic on purpose: believing a slow machine
/// wrongly costs a few windows on a few recalls, while disbelieving it costs a minute's wait and no verdict. A failed
/// answer teaches nothing. It lives as long as the process — a restart re-seeds it — and there is one per verifier, so
/// one per reranker.</para>
///
/// <para><b>Unmeasured</b>: it has not run on a CPU-only machine, so how many recalls it takes to settle there, and how
/// far a long window's cost outruns the per-character rate learned from short facts, are not known. <c>e2e-p52</c> case
/// 6e drives it with a fake router that answers in time proportional to the pair characters it is sent.</para></summary>
public sealed class RerankPace
{
    /// <summary>The GPU measurement the fixed ceiling was tuned on: 480 windows of 1,000 characters in ~20 s (Run 6b),
    /// the query not counted — which only makes the seed slower, i.e. safer.</summary>
    public const double SeedMsPerChar = 20_000.0 / (480 * 1_000);

    /// <summary>What a call costs before it scores anything — the HTTP round trip, the batch set-up — taken off each
    /// measurement. The two-document bind screen ran in 25–33 ms warm on the real router (<c>LlamaCppSource</c>), so 50 ms
    /// is an allowance above it.</summary>
    public const double CallOverheadMs = 50;

    /// <summary>A floor, so a run of calls faster than the allowance cannot drive the estimate to zero and the budget to
    /// infinity — the per-call ceiling then decides, as it did before this class.</summary>
    private const double MinMsPerChar = 1e-4;

    private readonly object _gate = new();
    private double _msPerChar;

    /// <param name="budget">How long one call may be predicted to take — half the verification deadline.</param>
    /// <param name="seedMsPerChar">The estimate before any call is timed.</param>
    public RerankPace(TimeSpan budget, double seedMsPerChar = SeedMsPerChar)
    {
        Budget = budget;
        _msPerChar = Math.Max(MinMsPerChar, seedMsPerChar > 0 ? seedMsPerChar : SeedMsPerChar);
    }

    /// <summary>How long one call may be predicted to take.</summary>
    public TimeSpan Budget { get; }

    /// <summary>The current estimate, in milliseconds per pair character.</summary>
    public double MsPerChar { get { lock (_gate) return _msPerChar; } }

    /// <summary>How many pair characters one call may carry within <see cref="Budget"/> at the current estimate.</summary>
    public long PairCharBudget()
    {
        var ms = Budget.TotalMilliseconds - CallOverheadMs;
        return ms <= 0 ? 0 : (long)Math.Min(long.MaxValue / 2, Math.Floor(ms / MsPerChar));
    }

    /// <summary>A call that answered: <paramref name="elapsed"/> for <paramref name="pairChars"/>.</summary>
    public void Observe(TimeSpan elapsed, long pairChars) => Update(elapsed, pairChars, lowerBound: false);

    /// <summary>A call cut off after <paramref name="elapsed"/> — it would have taken at least that long.</summary>
    public void AtLeast(TimeSpan elapsed, long pairChars) => Update(elapsed, pairChars, lowerBound: true);

    private void Update(TimeSpan elapsed, long pairChars, bool lowerBound)
    {
        if (pairChars <= 0) return;
        var observed = Math.Max(MinMsPerChar, (elapsed.TotalMilliseconds - CallOverheadMs) / pairChars);
        lock (_gate)
        {
            if (observed > _msPerChar) _msPerChar = observed;
            else if (!lowerBound) _msPerChar = Math.Max(MinMsPerChar, _msPerChar + (observed - _msPerChar) / 2);
        }
    }

    /// <summary>The pair characters a call sends: the query beside each document.</summary>
    public static long PairChars(string query, IReadOnlyList<string> documents) =>
        documents.Sum(d => (long)query.Length + d.Length);
}
