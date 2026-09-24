using Lyntai.Inference;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>Whether a reranker scores a long candidate in WINDOWS (<see cref="ChunkedScoreProvider"/>) — read ONCE at
/// startup from the measurement knob <c>GATHERLIGHT_RERANK_CHUNKING</c>: <c>on</c> or <c>off</c>, anything else (and
/// unset) meaning the default, which is OFF until <c>docs/judge-bench.md</c> Run 6b's pre-registered rule is applied.
/// Announced at startup whenever it is SET, raw value beside what it resolved to, on the console (what judge-bench
/// reads) and through the logger at Warning (what state/logs keeps) — the pattern every measurement knob follows.</summary>
public static class RerankChunking
{
    /// <summary>The knob's name.</summary>
    public const string KnobName = "GATHERLIGHT_RERANK_CHUNKING";

    /// <summary>What the knob was set to, or null.</summary>
    public static readonly string? Raw = Environment.GetEnvironmentVariable(KnobName);

    /// <summary>The default when the knob is unset or unrecognised.</summary>
    public const bool Default = false;

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
/// 1,000-character cap, 3 and 4 against 30.</para>
///
/// <para><b>What it does.</b> Each document of a <see cref="ScoreRequest"/> is split by <see cref="RerankInputCap.Windows"/>
/// into windows of the SAME budget the cut uses (<see cref="RerankInputCap.PerCandidate"/>, from the fitted query the
/// request carries — one writer, so every pair still fits the declared window), ALL windows go to the inner provider in
/// ONE call, and each document's score is the MAX over its windows (MaxP, the standard way a passage-level cross-encoder
/// scores a long document). So <c>ScoringVerificationPolicy</c> still sees one score per candidate, in input order, and
/// its <c>EndorseCount</c> still counts candidates. <b>A request whose every document fits one window is passed through
/// untouched</b> — the same object, so the same bytes on the wire: a household of short facts is sent exactly what it was
/// sent before.</para>
///
/// <para><b>Why a provider decorator, not a verification policy.</b> <c>ScoringVerificationPolicy</c> (Lyntai 3.2.0) sends
/// ONE document per candidate and endorses by index; windows as extra candidates would make <c>EndorseCount</c> count
/// windows, and re-implementing the policy to avoid that would fork Lyntai's verifier. The provider seam
/// (<see cref="IScoreProvider"/>: a query and documents in, one score per document out) is exactly one call wide, so a
/// decorator there changes nothing the policy relies on. It is applied where the verifier is built
/// (<c>LlamaCppSource.Wiring</c>), to the one provider the verifier names, and registered nowhere else. Routing
/// bookkeeping is unchanged by the wrapper: the router keys cooldown on the provider id when the pool never built the
/// instance, which is the case for every DI-registered backend (Lyntai's <c>RegisterProviderLifetime</c>).</para>
///
/// <para><b>What it costs.</b> Every window is a pair the model scores, so a recall costs roughly the characters it sends:
/// a candidate needing two windows costs about twice what its cut prefix did, and at most
/// <see cref="RerankInputCap.MaxWindows"/> times. Short candidates cost nothing extra.</para></summary>
public sealed class ChunkedScoreProvider : IScoreProvider
{
    private readonly IScoreProvider _inner;
    private readonly int? _window;
    private readonly ILogger? _log;

    /// <param name="inner">The reranker's own provider.</param>
    /// <param name="window">The model's DECLARED window (<see cref="GgufCatalog.DeclaredWindow"/>), or null — the same
    /// value <see cref="RerankInputCap"/> is built with, so the windows are its budget.</param>
    public ChunkedScoreProvider(IScoreProvider inner, int? window, ILogger? log = null)
    {
        _inner = inner;
        _window = window;
        _log = log;
    }

    public string Id => _inner.Id;
    public ProviderCapabilities Capabilities => _inner.Capabilities;
    public bool IsAvailable => _inner.IsAvailable;
    public Task<ProviderProbeResult> ProbeAsync(CancellationToken ct = default) => _inner.ProbeAsync(ct);

    public async Task<ScoreResponse> CallAsync(ScoreRequest request, CancellationToken ct = default)
    {
        var size = RerankInputCap.PerCandidate(request.Query, _window);
        // Nothing to split: the request as it came, byte for byte.
        if (request.Documents.All(d => d.Length <= size)) return await _inner.CallAsync(request, ct).ConfigureAwait(false);

        // Fewer windows per document when the call would otherwise carry more than the per-call budget — down to one,
        // which is the cut every candidate got before chunking.
        var perDocument = RerankInputCap.WindowsPerDocument(request.Documents, size);
        var windows = request.Documents.Select(d => RerankInputCap.Windows(d, size, perDocument)).ToList();
        var flat = windows.SelectMany(w => w).ToList();
        var response = await _inner.CallAsync(request with { Documents = flat }, ct).ConfigureAwait(false);
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
}
