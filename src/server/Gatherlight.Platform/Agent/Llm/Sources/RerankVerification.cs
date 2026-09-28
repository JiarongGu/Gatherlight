using Gatherlight.Server.Platform.Agent.Llm.Services;
using Lyntai;
using Lyntai.Inference;
using Lyntai.Memory.Verification;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>What 判断 is made of when a RERANKER does the checking — whichever runtime scores the pairs. ONE writer for the
/// two reranker judges: llama.cpp's (<see cref="LlamaCppSource"/>, a <c>/v1/rerank</c> endpoint) and 内置's
/// (<see cref="BuiltInJudgeSource"/>, an ONNX cross-encoder in this process). They differ in where the model runs and
/// nothing else: the same input fit, the same windows, the same pace, the same admission, the same page.
///
/// <para><b>Why shared rather than copied.</b> Every piece here was measured and reviewed as a chain — the fit
/// (<see cref="RerankInputCap"/>) bounds each pair to the model's window, the windows (<see cref="ChunkedScoreProvider"/>)
/// read a long candidate whole, the pace (<see cref="RerankPace"/>) sizes a call to the deadline, the admission
/// (<see cref="RerankAdmission"/>) skips a recall the machine cannot judge in time — and each link is fail-open, so a
/// second copy that drifted from the first would make one judge quietly worse with every check still green. The ids,
/// window and seed are the only things a source supplies.</para></summary>
public static class RerankVerification
{
    /// <summary><c>recall_facts</c>' default page, read from the tool that owns it. Lyntai: endorsing more than a page
    /// REPLACES the ranking instead of refining it, and the verifier is never told the caller's limit — so it has to be a
    /// constant, and the one constant that means "a page" is the tool's.</summary>
    public const int EndorseCount = Storage.Knowledge.Tools.RecallFactsTool.DefaultRecallLimit;

    /// <summary>The verifier for a reranker registered under <paramref name="providerId"/> whose model declares
    /// <paramref name="window"/> tokens (null: none — the 1,000-character cap).
    ///
    /// <para>CAPPED: one pair past the model's window fails the whole rerank call on llama.cpp and is truncated in process
    /// — see <see cref="RerankInputCap"/>. The window is the one the model's row DECLARES, never a branch on the id.
    /// CHUNKED when <see cref="RerankChunking"/> is on: the reranker's own provider is wrapped so a long candidate is
    /// scored in windows of that same budget (<see cref="ChunkedScoreProvider"/>), and the cap then prepares candidates
    /// without cutting them — which is why <see cref="Providers"/> throws when it finds nothing to wrap. And ADMITTED:
    /// whether a recall is sent at all is decided between the cap and the scoring policy (<see cref="RerankAdmission"/>),
    /// so a recall this machine cannot judge in time makes no call and hands Lyntai no verdict. Both read the one
    /// <see cref="RerankPace"/> <see cref="AddPace"/> registers — the one the 判断 row reads too.</para>
    ///
    /// <para><c>ScoringVerificationPolicy</c> THROWS at construction when its <c>ProviderId</c> names no registered
    /// backend, so a source builds this only for a model its <c>Register</c> registered a provider for — both branch on
    /// the same context.</para></summary>
    public static IMemoryVerificationPolicy Build(IServiceProvider sp, string providerId, int? window)
    {
        var chunked = RerankChunking.On;
        var pace = sp.GetRequiredService<RerankPace>();
        var (providers, wrapped) = Providers(sp, providerId, window, chunked, pace);
        IMemoryVerificationPolicy verifier = new ScoringVerificationPolicy(
            providers,
            new ScoringVerificationOptions { ProviderId = providerId, EndorseCount = EndorseCount },
            sp.GetService<ILogger<ScoringVerificationPolicy>>(),
            sp.GetService<IProviderRouterFactory>());
        if (wrapped is not null)
            verifier = new RerankAdmission(verifier, wrapped, pace, sp.GetService<ILogger<RerankAdmission>>());
        // Uncut in every segmenting mode: ours windows downstream (evenly, or at boundaries in the boundary measurement
        // mode, Run 12), and in the d177 measurement mode the registration segments — with no wrapper, no pace and no
        // admission (Run 10).
        return new RerankInputCap(verifier, window, RerankChunking.Uncut);
    }

    /// <summary>The providers the verifier chooses from — every registered one, with the reranker's own
    /// (<paramref name="providerId"/>) wrapped in a <see cref="ChunkedScoreProvider"/> when chunking is on — and that
    /// wrapper, for <see cref="RerankAdmission"/>. Wrapped HERE, where the verifier is built, and registered nowhere: the
    /// wrapper is part of how this judge scores, not a backend anything else may route to. Its time budget is half the
    /// verification deadline (<see cref="RerankPace"/>). The FIRST provider with that id is wrapped and returned, the one
    /// <c>ScoringVerificationPolicy</c> selects by the same id.
    ///
    /// <para><b>Chunking on and nothing wrapped THROWS</b>, as <c>ScoringVerificationPolicy</c> throws for a
    /// <c>ProviderId</c> it cannot resolve. The two halves are coupled: with chunking on, <see cref="RerankInputCap"/> stops
    /// cutting candidates because the wrapper windows them, so a registration the wrapper does not recognise — the id
    /// renamed, or a provider that no longer implements <c>IScoreProvider</c> after a Lyntai upgrade — would send every
    /// long candidate WHOLE, and one past the model's window would fail (llama.cpp) or be truncated (in process) on every
    /// call it is in, fail-open and silent.</para></summary>
    private static (IReadOnlyList<IModelProvider> Providers, ChunkedScoreProvider? Wrapped) Providers(
        IServiceProvider sp, string providerId, int? window, bool chunked, RerankPace pace)
    {
        var all = sp.GetServices<IModelProvider>().ToList();
        if (!chunked) return (all, null);
        var log = sp.GetService<ILogger<ChunkedScoreProvider>>();
        ChunkedScoreProvider? wrapped = null;
        var providers = all.Select(p =>
        {
            if (wrapped is not null || p is not IScoreProvider score
                || !string.Equals(p.Id, providerId, StringComparison.OrdinalIgnoreCase)) return p;
            wrapped = new ChunkedScoreProvider(score, window, pace, log);
            return (IModelProvider)wrapped;
        }).ToList();
        if (wrapped is null)
            throw new InvalidOperationException(
                $"{RerankChunking.KnobName} is on, but no registered backend is a score provider with the id '{providerId}' "
                + $"({(all.Count == 0 ? "(none)" : string.Join(", ", all.Select(p => $"{p.Id}{(p is IScoreProvider ? "" : " (not a score provider)")}")))}) "
                + "— so nothing would window a long candidate, and the input cap no longer cuts one: one past the model's "
                + "window would fail, or be cut, on every rerank call it is in.");
        return (providers, wrapped);
    }

    /// <summary>How fast this machine scores — ONE per process, shared by the verifier <see cref="Build"/> builds (its
    /// admission and its chunked provider) and the 判断 row, which reads its skip count (<c>MemoryRecallController</c>). Its
    /// budget is half the verification deadline.
    /// <para><paramref name="measuredSeed"/> is where the estimate STARTS, read at the pace's first use (a positive rate
    /// replaces the GPU figure; null keeps it) — each source measures its own runtime its own way, and both apply
    /// <see cref="RerankDeviceVerdict.NeverFasterThanTheGpuFigure"/>. <paramref name="abandonedCallsRunOn"/>: whether the
    /// scorer goes on scoring a call whose caller gave up (<see cref="RerankPace"/>'s class comment).</para></summary>
    public static void AddPace(LyntaiBuilder b, Func<IServiceProvider, double?> measuredSeed, bool abandonedCallsRunOn) =>
        b.Services.AddSingleton(sp => new RerankPace(VerificationDeadlinePolicy.Configured / 2,
            measuredSeed: () => measuredSeed(sp), abandonedCallsRunOn: abandonedCallsRunOn));
}

/// <summary>The screen a reranker must pass before it may bind — one pair and one rule, whichever runtime scores it
/// (<see cref="LlamaCppSource"/> over <c>/v1/rerank</c>, <see cref="BuiltInJudgeSource"/> in process). Chinese query,
/// Chinese documents — the household's own case. "It returned scores" is not enough: Lyntai found a converted model that
/// ranked backwards while passing a looser check, and a fail-open verifier would turn that into recall that quietly
/// gets worse.
///
/// <para><b>The DISTRACTOR shares more of the query than the answer does, on purpose.</b> One answer plus unrelated noise
/// is passed by a model that only counts overlap — a lexical scorer, or a cross-encoder a bad conversion reduced to
/// mean-pooled cosine — which is what Lyntai's <c>devtools/scripts/rerank-screen.mjs</c> records about its own first
/// fixture (it passed a GGUF that ranks the discriminating pair BACKWARDS). Here the distractor repeats the question's
/// words and never answers it; the answer states the price. By distinct query characters a lexical scorer rates them
/// 1.000 against 0.667, and by character bigrams the distractor wins too — so overlap ranks it FIRST and fails. The answer
/// is also SECOND in input order, so a model returning input order fails as well. The pair it replaced was worse than
/// weak: overlap ranked its ANSWER first (0.750 against 0.125), so a lexical model passed it outright; the pair first
/// proposed instead only tied.</para>
///
/// <para><b>Measured 2026-09-23</b> on both catalogued llama.cpp rerankers through llama-server's router, pinned GGUFs
/// sha-verified, three runs each with identical scores: LAMAR-600m.Q5_K_M puts the answer ahead by 4.131,
/// bge-reranker-v2-m3-Q5_K_M by 3.400; reversing those real scores — a backwards GGUF — fails. Cold ~4.8 s (the model
/// load), warm 25–33 ms. <b>And 2026-09-28 in process</b>, the pinned ONNX mMiniLMv2: answer 8.9394, distractor −2.7389
/// (docs/self-managed-llm-runtime.md). The screen still asserts only the ORDERING: a spread is one model's scale, and a
/// household-dropped reranker may score on another.</para></summary>
public static class RerankScreen
{
    public const string Query = "游泳馆成人票多少钱?";

    public static readonly IReadOnlyList<string> Documents =
    [
        "游泳馆成人票到底多少钱,很多人在门口问价格,工作人员说这个问题他们也不太清楚多少钱一张最准。",
        "游泳馆成人票每张四十元,儿童半价。",
    ];

    /// <summary>Which of <see cref="Documents"/> answers <see cref="Query"/>.</summary>
    public const int Answer = 1;

    /// <summary>Did the model put the answer STRICTLY first? ORDERING, never a margin: a household-dropped reranker may
    /// score on another scale, so the answer strictly first is every model's assertion while a threshold would be one
    /// model's. <paramref name="scores"/> must hold one score per document, in input order — every caller reads a
    /// reply that scored each exactly once, because an unfilled slot's default zero could outrank a real negative
    /// logit.</summary>
    public static bool AnswerFirst(IReadOnlyList<double> scores) =>
        scores.Count == Documents.Count && scores.Where((_, i) => i != Answer).All(s => s < scores[Answer]);
}
