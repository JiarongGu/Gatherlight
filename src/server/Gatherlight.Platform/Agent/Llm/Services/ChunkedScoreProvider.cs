using Lyntai.Inference;
using Lyntai.Memory.Verification;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>Whether a reranker scores a long candidate in WINDOWS (<see cref="ChunkedScoreProvider"/>) — ON by default
/// since 2026-09-24, when <c>docs/judge-bench.md</c> Run 6c's pre-registered rule held. Read ONCE at startup from the
/// measurement knob <c>GATHERLIGHT_RERANK_CHUNKING</c>: <c>on</c>, <c>off</c>, <c>d177</c> (the third paragraph) or
/// <c>boundary</c> (the fourth),
/// anything else (and unset) meaning the default. <b>The knob is KEPT</b>, as the judge-input knob was when its default
/// flipped (that one went on 2026-09-27,
/// with the decorator it steered, when the app adopted Lyntai's <c>ContentChars</c>): <c>off</c> reproduces the cut every
/// reranker was measured under in Runs 2–6, so judge-bench pins it on its <c>rr</c>/<c>rrf</c> arms and those runs
/// re-launch as they ran. Announced at startup whenever it is SET, raw value beside what it resolved to, on
/// the console (what judge-bench reads) and through the logger at Warning (what state/logs keeps) — the pattern every
/// measurement knob follows. It is a benchmark setting, not a household one.
///
/// <para><b>A THIRD value, <c>d177</c> — a measurement mode, never a default</b> (<c>docs/judge-bench.md</c> Run 10,
/// 2026-09-27): Lyntai's own segmentation in place of ours, so the two can be compared within one run. The candidates are
/// prepared exactly as with chunking on — the query fitted, NFKC under a declared window, and NOT cut — but no
/// <see cref="ChunkedScoreProvider"/> wraps the provider (so there is no pace and no <c>RerankAdmission</c>), and the
/// <c>llamacpp-rerank</c> registration carries <c>MaxInputChars</c> and <c>Segmentation</c> instead
/// (<see cref="LyntaiSegmentation"/>), so Lyntai's HTTP reranker segments each over-long document itself and scores it
/// as its best piece (its D177, with Parts 305 and 306).</para>
///
/// <para><b>A FOURTH value, <c>boundary</c> — a measurement mode, never a default</b> (<c>docs/judge-bench.md</c> Run 12,
/// 2026-09-28): OUR windows with one thing changed, WHERE their edges fall. Everything else is <c>on</c>'s — the same
/// <see cref="ChunkedScoreProvider"/>, budget, number of windows per candidate, overlap floor, first window at the start
/// and last at the tail, NFKC handling, pace, admission and skip — and each window's interior edges move, within a slack,
/// onto the nearest text boundary (<see cref="RerankInputCap.WindowSpans(string, int, int, bool)"/>). A candidate that
/// fits one window, and a call sized down to one window per candidate, are sent exactly as under <c>on</c>.</para>
///
/// <para><b>What Run 12 measured, and why it stays a knob</b> (2026-09-28, Lyntai 3.5.1, one GPU, the bench's long,
/// mixed and short fixtures, each reranker in its own run, arms one at a time). The mode put 97–100% of interior window
/// edges on a text boundary, where the default puts 9–15% there. The owner's rule needed mMiniLMv2 significantly better
/// on the long fixture's found@8. It was not: 182 → 188 of 240 (3/9, p = 0.146). Nothing was significantly worse
/// anywhere, and short facts were sent identically. Mixed-fixture BGE gained (196 → 207), but every one of those queries
/// had different candidate notes in the two arms: a recall-reinforcement divergence on the Japanese questions, not the
/// placement. On these fixtures neither placement ever splits an answer, since every answer is shorter than the least
/// overlap, so Lyntai D177's lead for mMiniLMv2 (Run 10) is not explained by where our windows' edges fall. Two runs
/// failed a guard on a ~21 s local connection timeout, so the rule was formally unread. Its clause (a) was false on a run
/// whose every guard held, so no re-run could change the outcome.</para></summary>
public static class RerankChunking
{
    /// <summary>The knob's name.</summary>
    public const string KnobName = "GATHERLIGHT_RERANK_CHUNKING";

    /// <summary>What the knob was set to, or null.</summary>
    public static readonly string? Raw = Environment.GetEnvironmentVariable(KnobName);

    /// <summary>The default when the knob is unset or unrecognised: ON (Run 6c).</summary>
    public const bool Default = true;

    /// <summary>How long candidates are read, for this process.</summary>
    public enum Modes
    {
        /// <summary><c>off</c>: each candidate CUT to its first window (<see cref="RerankInputCap"/>) — Runs 2–6.</summary>
        Cut,

        /// <summary><c>on</c>, the default: read in windows by <see cref="ChunkedScoreProvider"/>, sized by the pace.</summary>
        Windows,

        /// <summary><c>d177</c>, a measurement mode: read in pieces by Lyntai's HTTP reranker (<see cref="LyntaiSegmentation"/>).</summary>
        Lyntai,

        /// <summary><c>boundary</c>, a measurement mode: <see cref="Windows"/> with each window's edges on text boundaries.</summary>
        Boundary,
    }

    /// <summary>The mode this process runs.</summary>
    public static readonly Modes Mode = (Raw ?? "").Trim().ToLowerInvariant() switch
    {
        "on" => Modes.Windows,
        "off" => Modes.Cut,
        "d177" => Modes.Lyntai,
        "boundary" => Modes.Boundary,
        _ => Default ? Modes.Windows : Modes.Cut,
    };

    /// <summary>Whether OUR chunking is on for this process (<see cref="ChunkedScoreProvider"/> wraps the reranker) — in the
    /// default mode and in <c>boundary</c>, which differs from it only in where the windows' edges fall.</summary>
    public static readonly bool On = Mode is Modes.Windows or Modes.Boundary;

    /// <summary>Whether this process's windows have their edges moved onto text boundaries (the <c>boundary</c> mode) —
    /// what <see cref="RerankInputCap.WindowSpans(string, int, int)"/> reads, so every caller cuts the same windows.</summary>
    public static readonly bool AtBoundaries = Mode == Modes.Boundary;

    /// <summary>Whether <see cref="RerankInputCap"/> leaves candidates UNCUT — true unless the mode is the cut, because
    /// every segmenting mode reads the whole text downstream.</summary>
    public static bool Uncut => Mode != Modes.Cut;

    /// <summary>The mode as the knob spells it — what the startup announcement prints.</summary>
    public static string Name => Mode switch
    {
        Modes.Windows => "on", Modes.Lyntai => "d177", Modes.Boundary => "boundary", _ => "off",
    };

    /// <summary>What the <c>d177</c> mode sets on the <c>llamacpp-rerank</c> registration for a reranker with declared
    /// window <paramref name="window"/> — the configuration Run 10 states per model, mapped onto ours as closely as
    /// Lyntai 3.5.1 allows:
    /// <list type="bullet">
    /// <item>a DECLARED window (mMiniLMv2, 512): the pair bound is the window less a pair's overhead (506), the query keeping at
    /// most half (253) — our <see cref="RerankInputCap.Fit"/> exactly — and a document what the query leaves;</item>
    /// <item>NO declared window (BGE, LAMAR, launched at the 4,096-token batch): the bound is that batch less the overhead
    /// (4,090), so the query keeps at most 2,045 (<see cref="RerankInputCap.UndeclaredQueryMaxChars"/>), and a document
    /// piece is at most <see cref="RerankInputCap.MaxChars"/> (1,000) whatever the query;</item>
    /// <item>both: an overlap of a quarter (an UPPER bound in Lyntai, a lower one in ours) and at most
    /// <see cref="RerankInputCap.MaxWindows"/> pieces per document.</item>
    /// </list>
    /// What no setting can match: Lyntai cuts each piece at a boundary in its latter half and lets the last one run short,
    /// where ours cuts every window to the full budget and anchors the last at the tail; Lyntai COUNTS the normalised text
    /// and sends the original, which here is already normalised under a declared window (<see cref="RerankInputCap"/> stays
    /// in front); and it has no per-call total, where ours caps a call at <see cref="RerankInputCap.MaxWindowsPerCall"/>.</summary>
    public static (int MaxInputChars, InputSegmentation Segmentation) LyntaiSegmentation(int? window) =>
        RerankInputCap.UsableWindow(window) is { } tokens
            ? (tokens - RerankInputCap.PairOverheadTokens,
                new InputSegmentation { MinDocumentShare = 0.5, Overlap = 0.25, MaxPiecesPerInput = RerankInputCap.MaxWindows })
            : (LlamaServerRuntime.RerankBatch - RerankInputCap.PairOverheadTokens,
                new InputSegmentation
                {
                    MinDocumentShare = 0.5, Overlap = 0.25, MaxPiecesPerInput = RerankInputCap.MaxWindows,
                    MaxDocumentPiece = RerankInputCap.MaxChars,
                });
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
/// <para><b>WHETHER a recall is sent at all is decided ABOVE Lyntai</b>, by <see cref="RerankAdmission"/>: where even one
/// window per candidate cannot fit, nothing reaches this class and no verdict reaches Lyntai. What stays here is what must
/// be a provider call: the sizing above, the timing every call feeds <see cref="RerankPace"/>, and the probe the admission
/// asks for (<see cref="ProbeAsync"/>) — the provider is the one place that can time a call to the router.</para>
///
/// <para><b>A WORKAROUND FOR A LYNTAI GAP, recorded on both sides — and KEPT by measurement</b> (dev-conventions:
/// workaround (6)). Lyntai closed the gap upstream — <c>docs/task-archive.md</c> Part 287 / D177, with Part 289 closed into
/// it — and RELEASED it in 3.3.0 (read first at Lyntai commit <c>e6fa579b</c>; nothing through 3.5.1 changed the
/// segmentation described here). The 3.4 and 3.5 bumps KEPT this class, and Run 10 (below) kept it for good under the
/// owner's rule; outside the <c>d177</c> measurement mode nothing on the <c>llamacpp-rerank</c> registration segments.
/// D177 as released: a provider given
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
/// the deployment's — and could not carry through 3.4.0: <c>MaxPiecesPerInput</c> was fixed at registration, so no
/// decorator could vary a call's pieces per request, and deleting this class deleted the pace. Two items of Lyntai
/// <c>docs/task-archive.md</c> Part 310 — our upgrade's findings — bear on that, both RELEASED in 3.5.0: Part 305's
/// <c>ScoreRequest.MaxPiecesPerInput</c> narrows the registration's cap for one call, so a decorator can now size a D177
/// call by <see cref="RerankPace"/> without segmenting it itself; and Part 306's <c>InputSegmentation.MaxDocumentPiece</c>
/// bounds a document's pieces apart from the query, which can express this class's rule for a model declaring no window
/// (1,000 characters whatever the query) — read only where a window is set, so such a model needs <c>MaxInputChars</c>
/// set generously beside it. What 3.5.0 still does not give such a decorator is what was SENT: D177 counts no pieces for
/// its caller, and the HTTP reranker returns no usage, so the pace would learn from a bound rather than a count.
/// <b>Run 10 kept this class</b> (<c>docs/judge-bench.md</c> Run 10, 2026-09-27, Lyntai 3.5.1): the owner's rule was to
/// switch only if D177 were significantly BETTER for BGE on the long fixture's found@8, worse for no reranker at any
/// position or on the mixed fixture's short targets, and byte-identical on short facts. For BGE it was significantly
/// WORSE (201 → 171 of 240, 31/1) — mostly, post hoc, through a co-recall link dynamic on the Japanese-worded questions
/// rather than through how either segmenter scores a note — LAMAR could not tell the two apart, and short facts were
/// byte-identical. mMiniLMv2 did significantly BETTER under D177 (long 182 → 196, mixed 184 → 198), most where the answer
/// is late in a note; the likely reason, untested, is D177's sentence-boundary piece placement, so the follow-up worth
/// measuring is boundary-cut windows in this class, not a switch. What would reopen it is a within-run result under the
/// same rule in which D177 is better for BGE — worth running once a pace over D177 can learn from what was sent rather than
/// a bound — or the owner changing the rule. The Lyntai half: Part 289's outcome still names an app-side segmenting
/// score-provider decorator as the adopter's copy to remove when D177 releases; it has released and this class stays, so
/// Run 10's answer is owed to Lyntai's side (dev-conventions says so). Lyntai's <c>docs/memory-measurements.md</c> records
/// our Run 6c as <c>rerank-segmented-adopter-long-notes</c>.</para></summary>
public sealed class ChunkedScoreProvider : IScoreProvider
{
    // Set by RerankAdmission around a recall whose probe would have carried EVERY candidate: that probe IS the one-window
    // call, so the call goes through Lyntai as the recall's own — one window per candidate, timed as a probe (believed
    // whole) — and its answer is the verdict. An AsyncLocal because the recall reaches this class through Lyntai's policy
    // and router, in the same logical flow and with nothing of ours in between; nothing else sets it.
    private static readonly AsyncLocal<bool> s_asProbe = new();

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

    /// <summary>The least a call can send and still score every candidate — one window each — for a request of
    /// <paramref name="documents"/> beside the fitted <paramref name="query"/>: the first windows, how many windows the
    /// count ceiling alone would give each long candidate, whether every document already fits one window (the request
    /// then passes through as it came), and the pair tokens of that one-window call. The ONE computation both
    /// <see cref="RerankAdmission"/> (whether to send) and <see cref="CallAsync"/> (what to send) read.</summary>
    public OneWindowShape Shape(string query, IReadOnlyList<string> documents)
    {
        var size = RerankInputCap.PerCandidate(query, _window);
        // Nothing to split — or no room to split into: the request goes as it came, byte for byte.
        var passThrough = size <= 0 || documents.All(d => d.Length <= size);
        var byCount = passThrough ? 1 : RerankInputCap.WindowsPerDocument(documents, size);
        var firsts = passThrough ? documents : documents.Select(d => RerankInputCap.Windows(d, size, 1)[0]).ToList();
        return new OneWindowShape(firsts, byCount, passThrough, size, RerankPace.PairTokens(query, firsts));
    }

    /// <summary><see cref="Shape"/>'s answer.</summary>
    /// <param name="Firsts">Each document's first window — the document itself when it fits one.</param>
    /// <param name="ByCount">Windows per long candidate by the count ceiling alone; 1 for a pass-through request.</param>
    /// <param name="PassThrough">Every document fits one window, so the request is sent exactly as it came.</param>
    /// <param name="Size">The per-candidate budget in characters (<see cref="RerankInputCap.PerCandidate"/>).</param>
    /// <param name="PairTokens">The one-window call's pair tokens (<see cref="RerankPace.PairTokens"/>).</param>
    public readonly record struct OneWindowShape(
        IReadOnlyList<string> Firsts, int ByCount, bool PassThrough, int Size, double PairTokens);

    /// <summary>Marks the calls made inside the scope as the recall's PROBE (see <c>s_asProbe</c>). For
    /// <see cref="RerankAdmission"/> alone.</summary>
    internal static ProbeScope SendAsProbe()
    {
        var was = s_asProbe.Value;
        s_asProbe.Value = true;
        return new ProbeScope(was);
    }

    internal readonly struct ProbeScope(bool was) : IDisposable
    {
        public void Dispose() => s_asProbe.Value = was;
    }

    public async Task<ScoreResponse> CallAsync(ScoreRequest request, CancellationToken ct = default)
    {
        var shape = Shape(request.Query, request.Documents);
        var asProbe = s_asProbe.Value;

        // Still timed: a slow pass-through call can teach the pace that this machine is slow, and timing a call changes
        // nothing that is sent.
        if (shape.PassThrough)
        {
            var whole = await TimedAsync(request, asProbe ? RerankPace.Call.Probe : RerankPace.Call.PassThrough, ct)
                .ConfigureAwait(false);
            if (asProbe && whole.IsOk) LogWholeProbe(request.Documents.Count);
            return whole;
        }

        // As many windows per document as the call can carry: MaxWindows, lowered — the same for every document — past
        // the per-call ceiling, or past what this machine scores within the time budget, down to one: the cut. After a
        // call the deadline cut, ONE — until an answered call has timed the machine (RerankPace.AfterCut). A probe that is
        // the whole recall is ONE window each too: it is the one-window call.
        var afterCut = _pace.AfterCut;
        var perDocument = asProbe || afterCut ? 1
            : RerankInputCap.WindowsPerDocument(request.Documents, shape.Size, request.Query, _pace.PairTokenBudget());
        var windows = request.Documents.Select(d => RerankInputCap.Windows(d, shape.Size, perDocument)).ToList();
        var flat = windows.SelectMany(w => w).ToList();
        if (!asProbe && perDocument < shape.ByCount)
            LogSized(perDocument, shape.ByCount, afterCut, RerankPace.PairTokens(request.Query, flat));
        var response = await TimedAsync(request with { Documents = flat },
            asProbe ? RerankPace.Call.Probe : RerankPace.Call.Chunked, ct).ConfigureAwait(false);
        if (!response.IsOk) return response;
        // Pairing windows back to documents by position is only sound when every window was scored — the arity rule
        // the scoring policy applies to documents, one level down.
        if (response.Scores.Count != flat.Count)
            return ScoreResponse.Failure(ProviderVerdict.Failed,
                $"{Id}: scored {response.Scores.Count} of {flat.Count} windows ({request.Documents.Count} documents)");
        if (asProbe) LogWholeProbe(request.Documents.Count);

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

    /// <summary>The Information line for a call the pace sent fewer windows than the count ceiling would — in one of three
    /// forms, each saying why.
    /// <para>PARSED ELSEWHERE — keep "window(s) per long candidate instead of" in every form: judge-bench's PACE_LINE
    /// counts it (a bench run in which it appears is VOID), its PACE_SIZED / PACE_AFTER_CUT / PACE_FEWEST read the three,
    /// and e2e-p52 cases 6e and 6f assert the first two.</para></summary>
    private void LogSized(int perDocument, int byCount, bool afterCut, double pairTokens)
    {
        if (afterCut)
            _log?.LogInformation(
                "{Id}: {Windows} window(s) per long candidate instead of {ByCount}, until a call answers in time — the last was cut at the verification deadline, which says only that this machine is slower than {Pace:0.###} ms per 1,000 pair tokens",
                Id, perDocument, byCount, _pace.MsPerToken * 1000);
        else if (_pace.PredictMs(pairTokens) <= _pace.Budget.TotalMilliseconds)
            _log?.LogInformation(
                "{Id}: {Windows} window(s) per long candidate instead of {ByCount}, so the call fits ~{Budget:0.#} s at the {Pace:0.###} ms per 1,000 pair tokens (counted by script) measured here",
                Id, perDocument, byCount, _pace.Budget.TotalSeconds, _pace.MsPerToken * 1000);
        else
            // One window each is past the budget a SIZED call has, and inside the limit RerankAdmission sends a one-window
            // call under: it is the fewest that scores every candidate, so it goes as it is, and says so.
            _log?.LogInformation(
                "{Id}: {Windows} window(s) per long candidate instead of {ByCount}, the fewest that scores every candidate: predicted at ~{Predicted:0.#} s at the {Pace:0.###} ms per 1,000 pair tokens measured here — past the ~{Budget:0.#} s a sized call has, inside the ~{Limit:0.#} s a one-window call may take",
                Id, perDocument, byCount, _pace.PredictMs(pairTokens) / 1000, _pace.MsPerToken * 1000,
                _pace.Budget.TotalSeconds, _pace.OneWindowLimit.TotalSeconds);
    }

    /// <summary>A probe that carried every candidate answered, and its answer is the recall's verdict. PARSED ELSEWHERE —
    /// judge-bench's PACE_REMEASURED reads "re-measured this machine on N of M candidates' first windows: X ms per 1,000
    /// pair tokens", as it does the line <see cref="RerankAdmission"/> logs for a probe of some of them.</summary>
    private void LogWholeProbe(int candidates) =>
        _log?.LogInformation(
            "{Id}: re-measured this machine on {Sent} of {Candidates} candidates' first windows: {Pace:0.###} ms per 1,000 pair tokens — that probe was the whole one-window call, so its answer is this recall's verdict",
            Id, candidates, candidates, _pace.MsPerToken * 1000);

    /// <summary>One call to the inner provider, timed into the pace: a call that answered as a measurement, a call a
    /// deadline cut off as a lower bound (it ran at least that long). A failed answer teaches nothing — a quick refusal
    /// would read as a fast machine. The pace is told when the call was SENT and when it is DONE, so a call that started
    /// while an abandoned one was presumed still running on the router, or while another was in flight, is judged as
    /// possibly queued (<see cref="RerankPace.Sending"/>).</summary>
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
        finally
        {
            _pace.Done();
        }
    }

    /// <summary>Which of <paramref name="shape"/>'s first windows a probe carries: the LONGEST candidates' — long pairs,
    /// like the calls the estimate sizes, since short ones cost less per token — until they reach
    /// <see cref="RerankPace.ProbeTokens"/>, returned in their input order. When that is every candidate the probe IS the
    /// one-window call, and <see cref="RerankAdmission"/> sends it as the recall's own.</summary>
    internal IReadOnlyList<int> ProbeSelection(string query, OneWindowShape shape)
    {
        var target = _pace.ProbeTokens();
        var queryTokens = RerankPace.Tokens(query);
        var chosen = new List<int>();
        double tokens = 0;
        foreach (var (i, t) in shape.Firsts.Select((d, i) => (i, queryTokens + RerankPace.Tokens(d))).OrderByDescending(x => x.Item2))
        {
            chosen.Add(i);
            tokens += t;
            if (tokens >= target) break;
        }
        chosen.Sort();
        return chosen;
    }

    /// <summary>The re-measuring call <see cref="RerankAdmission"/> sends once the re-probe interval has passed: the first
    /// windows <paramref name="selection"/> names (<see cref="ProbeSelection"/>), timed as a <see cref="RerankPace.Call.Probe"/>.
    /// Sent to the reranker's own provider directly, not through Lyntai's router: it is a measurement of this machine, not
    /// the recall's verdict, and whatever it reads decides only whether the recall is sent.</summary>
    internal async Task<ScoreResponse> ProbeAsync(string query, OneWindowShape shape, IReadOnlyList<int> selection,
        CancellationToken ct)
    {
        var documents = selection.Select(i => shape.Firsts[i]).ToList();
        _log?.LogDebug("{Id}: probing with {Sent} of {Candidates} first windows, ~{Tokens:0} of the ~{All:0} pair tokens one window each would be",
            Id, documents.Count, shape.Firsts.Count, RerankPace.PairTokens(query, documents), shape.PairTokens);
        return await TimedAsync(new ScoreRequest(query, documents), RerankPace.Call.Probe, ct).ConfigureAwait(false);
    }
}

/// <summary>Decides, ABOVE Lyntai, whether a recall's rerank call is sent at all — and, where even one window per candidate
/// cannot be scored in time on this machine, answers <see cref="MemoryVerification.NoOpinion"/> at once: the engine's own
/// page, as a deadline cut leaves it, without the minute (<c>docs/judge-bench.md</c> Run 8).
///
/// <para><b>Why here, and not in the provider where it was first put</b> (review, 2026-09-25). The first version returned a
/// blameless <see cref="ProviderVerdict.Unsupported"/> from <see cref="ChunkedScoreProvider"/>, which
/// <c>ScoringVerificationPolicy</c> reports as NoOpinion. Lyntai 3.3.0 (its commit <c>6c45d051</c>, unreleased when this was
/// decided) logs a verdict that is not transient at WARNING in that policy, so every skipped recall would have logged a
/// Warning — and the in-code plan to filter it would also have hidden <c>ContextWindowExceeded</c>, <c>AuthFailed</c> and
/// <c>Refused</c>, the very failures that release raised to Warning; it also used <c>Unsupported</c> for something Lyntai's own meaning of
/// it (a capability or transport gap) does not cover. Decided here, a skip makes no provider call and hands Lyntai no
/// verdict at all, so there is nothing to log twice and nothing to filter.</para>
///
/// <para><b>What it sees.</b> It sits directly inside <see cref="RerankInputCap"/>, which has already fitted the query and
/// prepared the candidates, and directly outside <c>ScoringVerificationPolicy</c>, which sends each candidate's content
/// (its headline when it has none) — so the documents it computes the one-window call from
/// (<see cref="ChunkedScoreProvider.Shape"/>) are exactly the ones the provider will be sent. It asks the shared
/// <see cref="RerankPace"/> to <see cref="RerankPace.Admit"/> that call: Send, Skip, or — once the re-probe interval has
/// passed — Probe, which it has the provider send directly (<see cref="ChunkedScoreProvider.ProbeAsync"/>), then asks again.
/// A probe that would carry every candidate is the one-window call itself, so that recall is sent as usual with the call
/// marked a probe, and its answer is the verdict. Every recall is counted into the pace's skip counter
/// (<see cref="RerankPace.CountRecall"/>), which the 判断 row reads.</para>
///
/// <para>Only built where <see cref="ChunkedScoreProvider"/> is, i.e. with <see cref="RerankChunking"/> on: the cut Runs
/// 2–6 measured (the knob off) runs as it ran, with no pace at all.</para></summary>
public sealed class RerankAdmission : IMemoryVerificationPolicy
{
    private readonly IMemoryVerificationPolicy _inner;
    private readonly ChunkedScoreProvider _chunked;
    private readonly RerankPace _pace;
    private readonly ILogger? _log;

    /// <param name="inner">The scoring policy, whose provider is <paramref name="chunked"/>.</param>
    /// <param name="chunked">The reranker's provider as the scoring policy will call it.</param>
    /// <param name="pace">The same pace <paramref name="chunked"/> times its calls into.</param>
    public RerankAdmission(IMemoryVerificationPolicy inner, ChunkedScoreProvider chunked, RerankPace pace, ILogger? log = null)
    {
        _inner = inner;
        _chunked = chunked;
        _pace = pace;
        _log = log;
    }

    public async Task<MemoryVerification> VerifyAsync(MemoryVerificationRequest request, CancellationToken ct = default)
    {
        // Nothing to score: the scoring policy answers NoOpinion without a call, and it is not a recall the judge skipped.
        if (request.Candidates.Count == 0) return await _inner.VerifyAsync(request, ct).ConfigureAwait(false);

        // What ScoringVerificationPolicy (Lyntai 3.2.0) sends: CONTENT, falling back to the headline.
        var documents = request.Candidates.Select(c => c.Content ?? c.Headline).ToList();
        var shape = _chunked.Shape(request.Query, documents);
        var plan = _pace.Admit(shape.PairTokens);
        if (plan.Kind == RerankPace.Admission.Skip) return Skipped(shape, plan, "");

        if (plan.Kind == RerankPace.Admission.Probe)
        {
            var selection = _chunked.ProbeSelection(request.Query, shape);
            if (selection.Count == shape.Firsts.Count)
            {
                // The probe would carry every candidate: it IS the one-window call, so it goes as the recall's own call,
                // timed as a probe, and its answer is the verdict (ChunkedScoreProvider logs the re-measure line).
                _pace.CountRecall(skipped: false);
                using (ChunkedScoreProvider.SendAsProbe())
                    return await _inner.VerifyAsync(request, ct).ConfigureAwait(false);
            }

            ScoreResponse probe;
            try
            {
                probe = await _chunked.ProbeAsync(request.Query, shape, selection, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                // The deadline (or the caller) ended the probe: the judge did not run this recall.
                _pace.CountRecall(skipped: true);
                throw;
            }
            var after = _pace.Admit(shape.PairTokens, afterProbe: true);
            if (!probe.IsOk || after.Kind != RerankPace.Admission.Send)
                return Skipped(shape, after, probe.IsOk
                    ? $"a probe of {selection.Count} of {shape.Firsts.Count} candidates' first windows just now read {_pace.MsPerToken * 1000:0.###} ms per 1,000 pair tokens; "
                    : $"a probe of {selection.Count} of {shape.Firsts.Count} candidates' first windows just now got no usable answer ({probe.Verdict}); ");
            // PARSED ELSEWHERE — judge-bench's PACE_LINE counts "re-measured this machine" as a pace line too, and its
            // PACE_REMEASURED reads this one; e2e-p52 case 6h asserts it.
            _log?.LogInformation(
                "{Id}: re-measured this machine on {Sent} of {Candidates} candidates' first windows: {Pace:0.###} ms per 1,000 pair tokens, so one window per candidate is predicted at ~{Predicted:0.#} s — the judge runs this recall",
                _chunked.Id, selection.Count, shape.Firsts.Count, _pace.MsPerToken * 1000, after.PredictedMs / 1000);
        }

        _pace.CountRecall(skipped: false);
        return await _inner.VerifyAsync(request, ct).ConfigureAwait(false);
    }

    /// <summary>A recall the pace will not send: one Information line, counted as skipped, and NoOpinion — the engine's own
    /// page, as a cut leaves it, at once.</summary>
    private MemoryVerification Skipped(ChunkedScoreProvider.OneWindowShape shape, RerankPace.Plan plan, string probed)
    {
        _pace.CountRecall(skipped: true);
        // A recall of short facts has no long candidate to read fewer windows of — it is skipped all the same.
        var what = shape.PassThrough
            ? "0 window(s) per candidate instead of 1 (none is long)"
            : $"0 window(s) per long candidate instead of {shape.ByCount}";
        var why = plan.QueueMs > 0
            ? $", behind the ~{plan.QueueMs / 1000:0.#} s the router is presumed still busy with a call abandoned earlier — sent now, it would wait behind that call"
            : plan.AfterCut
                ? $", past the ~{plan.LimitMs / 1000:0.#} s a call has while the last deadline cut leaves the estimate a lower bound"
                : $", past the ~{plan.LimitMs / 1000:0.#} s a call has";
        // PARSED ELSEWHERE — keep "0 window(s) per (long )candidate instead of", "the judge is skipped for this recall" and
        // "behind the ~N s the router is presumed still busy": judge-bench's PACE_LINE counts the first (a bench run in which
        // it appears outside a CPU arm is VOID), its PACE_SKIP reads this line, and e2e-p52 cases 6f and 6h assert it.
        _log?.LogInformation(
            "{Id}: {What} — the judge is skipped for this recall: {Probed}one window per candidate is predicted at ~{Predicted:0.#} s at the {Pace:0.###} ms per 1,000 pair tokens measured here{Why}. The engine's own page stands; the first skipped recall after ~{Reprobe:0.#} min sends a probe to re-measure this machine",
            _chunked.Id, what, probed, plan.PredictedMs / 1000, _pace.MsPerToken * 1000, why, plan.NextProbeIn.TotalMinutes);
        return MemoryVerification.NoOpinion;
    }
}

/// <summary>How fast THIS machine's reranker scores, learned from the calls it makes — so the windows a long candidate is
/// read in fit the verification deadline on a slow machine, not only on the GPU the fixed ceiling was tuned on; and whether
/// a recall should be sent at all (<see cref="Admit"/>).
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
/// nothing changes from the fixed cap on that GPU. <b>Unless this machine measured the bound reranker</b>
/// (<see cref="RerankDeviceMeter"/>, at a router start the app performs): then the estimate starts from the rate that
/// measurement read on the device the reranker runs on, never faster than the GPU figure
/// (<see cref="RerankDeviceVerdict.PaceSeed"/>) — so the first recall of long notes on a slow machine is sized, or
/// skipped, from what the machine did rather than cut at the deadline as Run 8's was. Read at the pace's FIRST USE, not
/// at its construction: the verifier is built when the fact index is, before the startup step that measures, and the
/// first recall comes only after the migration gate lifts. Read once; a process that had no memo of the binary's facts
/// by then keeps the GPU figure.</item>
/// <item><b>A call too SMALL to measure teaches nothing</b> — neither the estimate nor the repeat flag below: one whose
/// scoring, at the current estimate, would take under <see cref="MinSignalFactor"/> × <see cref="CallOverheadMs"/>. Its
/// time is then mostly round trip, queueing, or a stall, and dividing it by a few dozen tokens reads any of those as a
/// slow machine: a 33-token call taking 150 ms read 3 ms per token, 60× the seed, and a 17 s model reload on a 30-token
/// call 565. Relative to the ESTIMATE, not a fixed token count, so that on the GPU (the seed) only calls of ~4,000
/// tokens teach — where an unmodelled delay the size of the allowance moves the rate by at most a quarter, inside the
/// ~1.47× the seed's budget leaves above the count ceiling, so jitter there cannot make the pace fire — while on a
/// machine already measured slow, where scoring dominates any call, smaller calls do. A PROBE is the exception: it is
/// believed whole whatever its size (below), so a probe small enough to be mostly overhead — the machine having become
/// far faster than the estimate it was sized at — reads the floor, <c>1e-4</c> ms per token; harmless, because the
/// per-call ceiling then bounds every call, as it did before this class existed.</item>
/// <item><b>A slower call — answered, or CUT by the deadline</b> — is believed at once when the call before it that taught
/// anything was slow too (answered slower than the estimate, or cut off having proved it slow) — and the flag stays set,
/// so a third slow call in a row is believed as well. ALONE, it moves the estimate halfway in log space — the geometric
/// mean of the two — and never more than ×<see cref="MaxLoneRaise"/>, because one outlier (a model reloading, a moment of
/// contention) would otherwise cut every long note of the next recalls to its first window. <b>A cut is damped exactly
/// like an answer</b> (review, 2026-09-25): believed in full, ONE GPU stall — a 70 s model reload on a 5,800-token
/// pass-through call, cut at 60 s — set the estimate to 206× the seed, and every recall above ~2,900 pair tokens was then
/// skipped for the ten minutes until a probe, silently. The price is stated: a machine that truly is that slow waits the
/// deadline TWICE — the lone cut raises the estimate at most ×4, so the next recall that fits that estimate is sent and
/// cut again, and the second cut, a repeat, is believed.</item>
/// <item><b>A faster call</b> moves the estimate halfway toward it, arithmetically, so a single fast call can at most
/// halve it: if that call was the misleading one, the next is under-predicted by at most 2×, which the half-deadline
/// margin covers. Halving in log space would recover faster from a large false raise, and could drop a true slow
/// estimate ~10× on one fast call — so the ×4 cap on a lone raise bounds the false raises instead. Only a CHUNKED call
/// lowers it: a pass-through call (every document one window) may raise the estimate and never lowers it, since short
/// pairs cost less per token than long ones (attention grows faster than length).</item>
/// <item><b>A call the deadline CUT</b> (the caller's token cancelled — <see cref="AtLeast"/>) teaches only if it ran
/// longer than the estimate predicted: then it raises the estimate toward that lower bound (damped when alone, above) and
/// sets the repeat flag. A cancellation earlier than that — a user's stop, an abandoned request — proves nothing about the
/// rate. A lower bound is not enough to SIZE by: halving from it, each cut call's successor is cut again whenever the
/// first one's true time was over twice the deadline, so a machine 30× slower would wait the minute four times running.
/// So a cut past <see cref="Budget"/> puts the pace <see cref="AfterCut"/>: every chunked call sends ONE window per
/// candidate — the fewest that scores them all — until one ANSWERS, and that answer is believed whole, in either
/// direction and whatever its size, since it is the measurement the lower bound was missing. On a machine where even one
/// window per candidate is too slow for a recall that big, no sizing can fix it, since fewer windows than candidates would
/// leave one unscored — so that recall is not sent at all (<see cref="Admit"/>, below).</item>
/// <item><b>A clock that jumped teaches nothing</b>: a call timed past <see cref="ClockJumpDeadlines"/> × the verification
/// deadline cannot have run that long under the deadline that cancels it, so the gap is the clock's — a machine that
/// slept mid-recall, if <c>Stopwatch</c> (QueryPerformanceCounter) counts the sleep, which is believed and NOT verified
/// on Windows. It teaches no rate; the busy presumption below still starts, capped.</item>
/// <item>A failed answer teaches nothing. It lives as long as the process — each launch re-seeds it, at this machine's
/// measurement when there is one and the GPU figure otherwise — and there is one per process: the verifier's, registered
/// once, which is also what the 判断 row reads.
/// <b>Concurrency</b>: two recalls contending for one child each time the other's scoring too, so both read slower than
/// the machine is. A call sent while another is IN FLIGHT is therefore possibly queued (below), like one sent behind an
/// abandoned call.</item>
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
/// <item><b>A call abandoned PAST its prediction</b> (the caller's token cancelled — the deadline, a stop) leaves the router
/// presumed BUSY for <see cref="QueueFactor"/> × the time it had run — twice as long again: at the rate BGE's answered
/// calls ran there (~3.1 s per 1,000 pair tokens), Run 8's cut calls needed a median ~118 s and at most ~125 s in all, so
/// at most ~65 s past the minute, inside the 120 s presumed. A call abandoned BEFORE its prediction — a user's stop —
/// proves nothing about the machine, so it leaves the router presumed busy only for what the estimate still predicted for
/// it. Either way never longer than <see cref="QueueFactor"/> verification deadlines: a clock that jumped (above) would
/// otherwise presume the router busy for hours and hold every probe off. A first call sized at the GPU seed on a far
/// slower machine can run longer than the presumption — a stated limit.</item>
/// <item><b>A call SENT while the router is presumed busy, or while another call is in flight, is possibly queued</b>
/// (<see cref="Sending"/>): its time includes the wait, so if it is cut it teaches NOTHING (it proves only that the queue
/// was long), and if it answers it is an UPPER bound — it never raises the estimate, lowers it only as an unqueued answer
/// of its kind would (a probe to it, a chunked call halfway, a pass-through call not at all), and does not end
/// <see cref="AfterCut"/>. An answer ends the busy presumption only when its call was sent AFTER the abandoned one — the
/// router reached it, so what was ahead of it is done; one sent before says nothing about the call behind it.</item>
/// <item><b>Nothing is sent while the router is presumed busy, nor where one window per candidate cannot fit</b>
/// (<see cref="Admit"/>): a recall is sent only when nothing is presumed queued AND its one-window call is predicted inside
/// <see cref="OneWindowLimit"/>; otherwise it is SKIPPED — NoOpinion at once, where Run 8 waited the full minute for it on
/// 230 of 240 recalls. A call sent behind a presumed queue used to go whenever the queue plus its prediction fitted the
/// budget; being queued, its cut taught nothing and extended the presumption, so a slow machine could wait the minute
/// again and again without ever learning, and never reach a probe (review, 2026-09-25).</item>
/// <item><b>The limit a one-window call is sent under</b> — <see cref="OneWindowLimit"/>, the ONE writer the admission,
/// the sizing line and the household note read. While the estimate comes from an ANSWER, <see cref="OneWindowShareOfDeadline"/>
/// (0.8) of the verification deadline, 48 s at the product's 60: a one-window call is already the smallest call that
/// scores every candidate, so there is nothing left to size down, and the half-deadline margin the SIZED calls keep would
/// throw away verdicts arriving in 30–60 s (mMiniLMv2 on Run 8's CPU, a kind-filtered recall of 400 long candidates: ~47 s).
/// Why 0.8: an answered rate on one machine is steady — Run 8's mMiniLMv2 answered at 0.257–0.327 ms per token p10–p90
/// across calls of 133 to 65,463 tokens, a p90 9% over its median — so a call predicted at 0.8 of the deadline overruns it
/// only if it runs 25% over its prediction, ~3× that spread; the remaining 20% is the margin, and a miss costs one
/// deadline, which the damped raise then corrects. A lone fast answer halving the estimate (above) is the case that
/// margin does not cover, and it is bounded: halving happens only on a chunked answer, which is itself a measurement at
/// that size. While <see cref="AfterCut"/>, the estimate is only a LOWER bound, so the limit is <see cref="Budget"/>, half
/// the deadline, as for every sized call.</item>
/// <item><b>A skipped recall re-measures</b> once <see cref="ReprobeInterval"/> — ten verification deadlines — has passed
/// since the last call that could LOWER the estimate — a chunked call or a probe; not a pass-through call, which only
/// ever raises it, so short-fact recalls cannot hold off the re-check; from the first skip when there has been none —
/// and nothing is presumed queued: it sends a PROBE of <see cref="ProbeTokens"/>, a sixth of the budget at
/// the current estimate (~5 s at the product's deadline), and the answer is believed whole, like the answer after a cut —
/// so a machine that has become faster (its GPU freed, a smaller page) is found within the interval, and a truly slow one
/// pays ~5 s per interval instead of a minute per recall. The worst a probe can cost is one deadline, if it is cut:
/// bounded, at this interval, to a tenth of the time the judge is being skipped. Replaying Run 8's chunked BGE recalls
/// against the first version of these rules (scratch, one queue on the router at the answered median rate, abandoned
/// batches scored to the end): one minute-wait in the whole run where there were 230; 9–14 verdicts, on the recalls small
/// enough to fit, when recalls came 5–60 s apart, against the run's 10; and 1 back to back, where every recall after the
/// cut fell inside the presumed queue — a replay, not a measurement, and one the damped cut above changes to two
/// minute-waits.</item>
/// <item><b>Every recall is counted</b> (<see cref="CountRecall"/>): whether it was skipped, over the last
/// <see cref="RecentRecalls"/>. A skip is otherwise visible only as an Information line in state/logs — fail-open and
/// unreported, the pattern this area keeps correcting — so the 判断 row reads the count, cached, and says how many recent
/// recalls went without a verdict, with the smaller reranker to try (<c>GgufCatalog.SkipNotice</c>).</item>
/// </list></para>
///
/// <para><b>Unmeasured</b>: how many recalls it takes to settle on a CPU-only machine where calls are SIZED (Run 8's
/// mMiniLMv2 never needed sizing, and its BGE needed one window each and then more than that), and how far a long
/// window's cost outruns a rate learned from short facts. The skip, the queue presumption, the probe, the damped cut and
/// the 0.8 limit were derived from Run 8 and reviewed against its record, not run on its CPU. The two token rates are two
/// measurements on the XLM-R tokenizer family: every UTF-16 unit from U+2E80 up (CJK, kana, Hangul syllables, full-width
/// forms, both halves of a surrogate pair) is counted at the CJK rate, the worst measured — emoji measured ~0.48, rare
/// CJK less — and every unit below it at the English one. That leaves counted like English, and unmeasured: other
/// scripts (Cyrillic, Greek, Arabic, Thai, Devanagari…), Hangul conjoining Jamo (U+1100–11FF) and the BMP symbols and
/// emoji of U+2600–27BF, all below U+2E80. That rerank time is proportional to tokens is itself an assumption the GPU
/// and CPU figures fit (Run 8: mMiniLMv2's answered rate steady at ~0.30 s per 1,000 across calls of 133 to 65,463
/// tokens), not a measured law. The floor's factor, the log-space step and its cap, the queue factor and its cap, the
/// clock-jump factor, the 0.8 limit, the probe's share and the re-probe interval are judgements. <c>e2e-p52</c> case 6e
/// drives the answered path with a fake router that answers in time proportional to the pair TOKENS it is sent — a lone
/// slow call not believed, the second believed, a fast pass-through not lowering it, a slow small call teaching nothing,
/// a user's stop presuming the router busy only for the rest of its prediction —
/// case 6f the cut path (a first call ~2.8× past the deadline, damped; the next recall skipped while the router is
/// presumed busy, then one window and a verdict), case 6g the per-script count, case 6h the skip (a machine too slow for
/// one window per candidate: cut TWICE — the lone cut damped, the second believed — skipped behind each; skipped fast for
/// the pace alone; a short-fact recall that fits is sent and does not restart the interval; then a probe after it —
/// still slow, skipped; then fast, and the judge runs; and the 判断 row's skip count), and case 6i the damped lone cut (ONE
/// pass-through call stalled past the deadline on an otherwise fast fake; the next big recall is judged, not skipped).
/// Confirmed to FAIL (2026-09-25, each change reverted on its own build): with the skip removed (6f, 6h), with every sent
/// call restarting the interval (6h's probe), with a lone cut believed in full (6i, and 6h's second cut), with a send
/// allowed whenever queue plus prediction fit (6h's short-fact recall behind the queue), with the one-window limit held at
/// half the deadline (6h's three-note recall), with the in-flight mark removed (6i's last recall), with a user's stop
/// presumed at twice its run (6e's last recall) and with the counter unread (6h's 判断 row and badge); and, in the first
/// version of these rules, with the queue presumption removed (6f). Not driven, each for a reason stated in
/// dev-conventions: the presumption's cap and the clock-jump rule (they bind only when the clock jumps), a queued answer
/// lowering the estimate only as its kind allows, and the re-measure line of a probe that was the whole call.</para></summary>
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

    /// <summary>The most a LONE slower call — answered or cut — may multiply the estimate by. See the class comment.</summary>
    public const double MaxLoneRaise = 4;

    /// <summary>A floor, so a run of calls faster than the allowance cannot drive the estimate to zero and the budget to
    /// infinity — the per-call ceiling then decides, as it did before this class.</summary>
    private const double MinMsPerToken = 1e-4;

    /// <summary>A call abandoned past its prediction is presumed to keep the router busy for this many times as long AGAIN
    /// as it had run — and no presumption lasts longer than this many verification deadlines. See the class comment for
    /// Run 8's figures.</summary>
    public const double QueueFactor = 2;

    /// <summary>How many verification deadlines pass with no call able to lower the estimate before a skipped recall
    /// re-measures the machine with a probe — the deadline being twice <see cref="Budget"/>. See the class comment.</summary>
    public const double ReprobeDeadlines = 10;

    /// <summary>What share of <see cref="Budget"/> a probe is sized to at the current estimate — ~5 s at the product's
    /// deadline: long enough that the 50 ms overhead allowance is a percent of it on a slow machine, short enough that a
    /// truly slow one pays seconds, not the minute.</summary>
    public const double ProbeShareOfBudget = 1.0 / 6;

    /// <summary>What share of the verification DEADLINE a one-window call may be predicted to take and still be sent, while
    /// the estimate comes from an answer — 48 s at the product's 60. See the class comment (<see cref="OneWindowLimit"/>).</summary>
    public const double OneWindowShareOfDeadline = 0.8;

    /// <summary>A call timed past this many verification deadlines did not run that long — the clock jumped. See the class
    /// comment.</summary>
    public const double ClockJumpDeadlines = 1.5;

    /// <summary>How many recent recalls the skip counter covers (<see cref="RecentSkips"/>).</summary>
    public const int RecentRecalls = 20;

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
        /// <summary>Nothing is presumed queued and one window per candidate fits <see cref="OneWindowLimit"/>: send, sized as
        /// usual.</summary>
        Send,

        /// <summary>It does not: send nothing, and let the engine's page stand.</summary>
        Skip,

        /// <summary>It does not fit, nothing is queued, and the re-probe interval has passed: send a probe
        /// (<see cref="ProbeTokens"/>) first.</summary>
        Probe,
    }

    /// <summary><see cref="Admit"/>'s answer, with what it was decided on — for the log line.</summary>
    /// <param name="PredictedMs">The one-window call, predicted at the current estimate, overhead included.</param>
    /// <param name="QueueMs">How much longer the router is presumed busy with an abandoned call; 0 when it is not.</param>
    /// <param name="LimitMs">The limit the call was held to (<see cref="OneWindowLimit"/>).</param>
    /// <param name="AfterCut">Whether that limit was the after-cut one (<see cref="Budget"/>).</param>
    /// <param name="NextProbeIn">How long until a skipped recall would probe, if nothing is sent meanwhile.</param>
    public readonly record struct Plan(Admission Kind, double PredictedMs, double QueueMs, double LimitMs, bool AfterCut,
        TimeSpan NextProbeIn);

    /// <summary>A call as it was sent (<see cref="Sending"/>): when, by the pace's clock, and whether the router was then
    /// presumed busy with an abandoned call or another call was in flight — which decides what its answer or its cut may
    /// teach, and whether its answer ends the busy presumption.</summary>
    public readonly record struct Ticket(TimeSpan SentAt, bool Queued);

    private readonly object _gate = new();
    private readonly Func<TimeSpan> _clock;
    private double _msPerToken;
    // The last call that taught anything was SLOW — answered slower than the estimate, or cut off having proved it slow —
    // so the next slower answer or cut is a repeat and is believed at once. Stays set across a believed repeat.
    private bool _slowBefore;
    // A call was cut past the budget, so the estimate is only a lower bound: one window per candidate until an answer.
    private bool _afterCut;
    // Until when the router is presumed still scoring a call that was abandoned (the clock's reading) — and when that call
    // was SENT, so an answer to a call sent before it cannot end the presumption.
    private TimeSpan _busyUntil = TimeSpan.MinValue;
    private TimeSpan _busyFrom = TimeSpan.MinValue;
    // Calls sent and not yet done: one sent while another is in flight is possibly queued behind it.
    private int _inFlight;
    // When a call that could LOWER the estimate — a chunked call or a probe — was last sent; the re-probe interval runs
    // from it, or from the first skip when none has been. Not a pass-through call: it may raise the estimate and never
    // lower it, so if it restarted the interval, a machine that became fast would stay skipped for as long as short-fact
    // recalls kept coming.
    private TimeSpan? _lastMeasuring;
    // The measured seed, read once at first use and then dropped (SeedLocked); null once read, or when none was given.
    private Func<double?>? _measuredSeed;
    // The last RecentRecalls recalls, true where the judge was skipped: a ring, _recentNext the next slot to write.
    private readonly bool[] _recent = new bool[RecentRecalls];
    private int _recentCount;
    private int _recentNext;

    /// <param name="budget">How long one sized call may be predicted to take — half the verification deadline.</param>
    /// <param name="seedMsPerToken">The estimate before any call is timed.</param>
    /// <param name="clock">A monotonic clock; the process's uptime when null.</param>
    /// <param name="measuredSeed">Read ONCE, at the pace's first use: a positive value replaces
    /// <paramref name="seedMsPerToken"/> — this machine's measurement of the bound reranker (the class comment).</param>
    public RerankPace(TimeSpan budget, double seedMsPerToken = SeedMsPerToken, Func<TimeSpan>? clock = null,
        Func<double?>? measuredSeed = null)
    {
        Budget = budget;
        _msPerToken = Math.Max(MinMsPerToken, seedMsPerToken > 0 ? seedMsPerToken : SeedMsPerToken);
        _clock = clock ?? (() => TimeSpan.FromMilliseconds(Environment.TickCount64));
        _measuredSeed = measuredSeed;
    }

    // Under the lock, before anything reads or moves the estimate: the measured seed, once. A reader that throws or answers
    // nothing leaves the constructor's seed.
    private void SeedLocked()
    {
        if (_measuredSeed is not { } read) return;
        _measuredSeed = null;
        double? seed = null;
        try { seed = read(); } catch { /* no measurement to start from */ }
        if (seed is { } s && s > 0 && double.IsFinite(s)) _msPerToken = Math.Max(MinMsPerToken, s);
    }

    /// <summary>How long one sized call may be predicted to take.</summary>
    public TimeSpan Budget { get; }

    /// <summary>The verification deadline this pace was built for: twice <see cref="Budget"/>.</summary>
    public TimeSpan Deadline => Budget * 2;

    /// <summary>How long a skipped recall waits before it probes — from the last call that could lower the estimate (a
    /// chunked call or a probe), or from the first skip when none has been: <see cref="ReprobeDeadlines"/> verification
    /// deadlines — 10 minutes at the product's 60 s, and proportionally less under the test knob.</summary>
    public TimeSpan ReprobeInterval => Deadline * ReprobeDeadlines;

    /// <summary>The current estimate, in milliseconds per pair token.</summary>
    public double MsPerToken { get { lock (_gate) { SeedLocked(); return _msPerToken; } } }

    /// <summary>True from a call cut past <see cref="Budget"/> until a chunked call answers: the estimate is then only a
    /// lower bound, and <see cref="ChunkedScoreProvider"/> sends one window per candidate.</summary>
    public bool AfterCut { get { lock (_gate) return _afterCut; } }

    /// <summary>The most a ONE-WINDOW call may be predicted to take and still be sent: <see cref="Budget"/> while
    /// <see cref="AfterCut"/> (the estimate is only a lower bound), otherwise <see cref="OneWindowShareOfDeadline"/> of the
    /// verification deadline. The one writer — see the class comment.</summary>
    public TimeSpan OneWindowLimit { get { lock (_gate) return LimitLocked(); } }

    // Under the lock.
    private TimeSpan LimitLocked() => _afterCut ? Budget : Deadline * OneWindowShareOfDeadline;

    /// <summary>How long a call of <paramref name="pairTokens"/> is predicted to take at the current estimate, overhead
    /// included.</summary>
    public double PredictMs(double pairTokens)
    {
        lock (_gate)
        {
            SeedLocked();
            return CallOverheadMs + Math.Max(0, pairTokens) * _msPerToken;
        }
    }

    /// <summary>How many pair tokens one call may carry within <see cref="Budget"/> at the current estimate.</summary>
    public double PairTokenBudget()
    {
        var ms = Budget.TotalMilliseconds - CallOverheadMs;
        return ms <= 0 ? 0 : ms / MsPerToken;
    }

    /// <summary>Whether a recall's call is to be sent at all, given the pair tokens it would carry at ONE window per
    /// candidate — the least that scores them all. Send when nothing is presumed queued AND that call, predicted at the
    /// current estimate, fits <see cref="OneWindowLimit"/>; otherwise Skip — or Probe, once <see cref="ReprobeInterval"/>
    /// has passed and nothing is presumed queued. A Probe is claimed here (it restarts the interval), so two recalls at
    /// once cannot both probe; the first skip with nothing measured yet starts the interval. <paramref name="afterProbe"/>
    /// asks again once a probe has answered: Send or Skip, never another probe.</summary>
    public Plan Admit(double oneWindowPairTokens, bool afterProbe = false)
    {
        lock (_gate)
        {
            SeedLocked();
            var now = _clock();
            var predicted = CallOverheadMs + Math.Max(0, oneWindowPairTokens) * _msPerToken;
            var queue = _busyUntil > now ? (_busyUntil - now).TotalMilliseconds : 0;
            var limit = LimitLocked().TotalMilliseconds;
            var nextProbe = _lastMeasuring is { } last ? last + ReprobeInterval - now : ReprobeInterval;
            if (nextProbe < TimeSpan.Zero) nextProbe = TimeSpan.Zero;
            if (queue <= 0 && predicted <= limit) return new Plan(Admission.Send, predicted, 0, limit, _afterCut, nextProbe);
            if (afterProbe || queue > 0 || nextProbe > TimeSpan.Zero)
            {
                _lastMeasuring ??= now;
                return new Plan(Admission.Skip, predicted, queue, limit, _afterCut, nextProbe);
            }
            _lastMeasuring = now;
            return new Plan(Admission.Probe, predicted, 0, limit, _afterCut, ReprobeInterval);
        }
    }

    /// <summary>One recall's outcome, for <see cref="RecentSkips"/>: whether the judge was skipped.</summary>
    public void CountRecall(bool skipped)
    {
        lock (_gate)
        {
            _recent[_recentNext] = skipped;
            _recentNext = (_recentNext + 1) % RecentRecalls;
            if (_recentCount < RecentRecalls) _recentCount++;
        }
    }

    /// <summary>Of the last <see cref="RecentRecalls"/> recalls (fewer since the process started), how many the judge
    /// skipped — read by the 判断 row without awaiting anything.</summary>
    public (int Skipped, int Recalls) RecentSkips
    {
        get
        {
            lock (_gate)
            {
                var skipped = 0;
                for (var i = 0; i < _recentCount; i++) if (_recent[i]) skipped++;
                return (skipped, _recentCount);
            }
        }
    }

    /// <summary>How many pair tokens a probe carries: <see cref="ProbeShareOfBudget"/> of the budget at the current
    /// estimate, the overhead allowance taken off first.</summary>
    public double ProbeTokens()
    {
        var ms = Budget.TotalMilliseconds * ProbeShareOfBudget - CallOverheadMs;
        return ms <= 0 ? 0 : ms / MsPerToken;
    }

    /// <summary>A call of <paramref name="kind"/> is being sent now: says when, and whether it is possibly queued — the
    /// router presumed still busy with an abandoned call, or another call in flight (the class comment) — and, for a call
    /// whose answer could lower the estimate (chunked, or a probe), restarts the re-probe interval. Every ticket is ended by
    /// <see cref="Done"/>.</summary>
    public Ticket Sending(Call kind)
    {
        lock (_gate)
        {
            var now = _clock();
            if (kind != Call.PassThrough) _lastMeasuring = now;
            var queued = _busyUntil > now || _inFlight > 0;
            _inFlight++;
            return new Ticket(now, queued);
        }
    }

    /// <summary>A call sent through <see cref="Sending"/> is over — answered, failed or cut.</summary>
    public void Done()
    {
        lock (_gate) if (_inFlight > 0) _inFlight--;
    }

    /// <summary>A call that answered: <paramref name="elapsed"/> for <paramref name="pairTokens"/>.</summary>
    public void Observe(Ticket ticket, TimeSpan elapsed, double pairTokens, Call kind)
    {
        lock (_gate)
        {
            SeedLocked();
            // The router reached this call, so whatever it held from a call abandoned BEFORE this one was sent is done.
            var now = _clock();
            if (_busyUntil > now && ticket.SentAt > _busyFrom) _busyUntil = now;
            if (!(pairTokens > 0) || ClockJumped(elapsed)) return;
            var observed = RateOf(elapsed, pairTokens);
            if (ticket.Queued)
            {
                // Its time includes the wait, so it is an UPPER bound: it never raises the estimate, lowers it only as an
                // unqueued answer of its kind would, and is not the measurement a cut was missing (AfterCut stays).
                if (observed >= _msPerToken) return;
                if (kind == Call.Probe) _msPerToken = observed;
                else if (kind == Call.Chunked) _msPerToken = Math.Max(MinMsPerToken, _msPerToken + (observed - _msPerToken) / 2);
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
                _msPerToken = _slowBefore ? observed : LoneRaise(observed);
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
            SeedLocked();
            // Whatever it proves, the router keeps it: busy for QueueFactor × the time it ran when it ran past what the
            // estimate predicted, for the rest of that prediction when it was stopped sooner — and never longer than
            // QueueFactor verification deadlines.
            var ran = elapsed.TotalMilliseconds;
            var predicted = CallOverheadMs + Math.Max(0, pairTokens) * _msPerToken;
            var remaining = ran > predicted ? QueueFactor * ran : predicted - ran;
            remaining = Math.Min(remaining, QueueFactor * Deadline.TotalMilliseconds);
            var until = _clock() + TimeSpan.FromMilliseconds(Math.Max(0, remaining));
            if (until > _busyUntil)
            {
                _busyUntil = until;
                _busyFrom = ticket.SentAt;
            }

            // Possibly queued: its time was the queue's, so it proves nothing about the machine. Nor does a clock that
            // jumped.
            if (ticket.Queued || !(pairTokens > 0) || ClockJumped(elapsed)) return;
            var observed = RateOf(elapsed, pairTokens);
            // Cancelled before it was due to finish, or too small to say anything: proves nothing.
            if (TooSmall(pairTokens) || observed <= _msPerToken) return;
            // A lower bound, damped like a slower answer when alone: one stall must not switch the judge off.
            _msPerToken = _slowBefore ? observed : LoneRaise(observed);
            _slowBefore = true;
            if (elapsed > Budget) _afterCut = true;
        }
    }

    // Under the lock: a lone slower call, answered or cut, moves the estimate halfway in log space, at most ×MaxLoneRaise.
    private double LoneRaise(double observed) => Math.Min(Math.Sqrt(_msPerToken * observed), MaxLoneRaise * _msPerToken);

    // Under the lock.
    private bool TooSmall(double pairTokens) => pairTokens * _msPerToken < MinSignalFactor * CallOverheadMs;

    private bool ClockJumped(TimeSpan elapsed) => elapsed > Deadline * ClockJumpDeadlines;

    /// <summary>A call's rate in this class's unit — ms per pair token, <see cref="CallOverheadMs"/> taken off, floored at
    /// 1e-4. Public because the reranker device measurement reads its timed call through it (<see cref="RerankDeviceMeter"/>):
    /// one unit, one formula.</summary>
    public static double RateOf(TimeSpan elapsed, double pairTokens) =>
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
