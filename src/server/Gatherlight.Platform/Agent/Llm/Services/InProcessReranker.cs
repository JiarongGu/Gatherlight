using System.Diagnostics;
using Lyntai.Inference;
using Lyntai.Providers.Onnx;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>
/// The 内置 reranker: <c>cross-encoder/mmarco-mMiniLMv2-L12-H384-v1</c> as ONNX, scored IN PROCESS on the CPU by Lyntai's
/// ONNX provider (<c>Lyntai.Providers.Onnx</c>, its D124/D157) with its OWNED SentencePiece tokenizer read from the
/// model's <c>tokenizer.json</c> (its D191). No llama.cpp, no second process, no port. The same checkpoint llama.cpp
/// serves as <see cref="GgufCatalog.RerankerWithoutGpu"/> — a different quantisation (ONNX qint8 against GGUF Q8_0) and a
/// different tokenizer implementation, so "the same model" is a claim until <c>docs/judge-bench.md</c> Run 13 measures it.
///
/// <para><b>What it adds to Lyntai's provider, each for a reason measured on the real export</b>
/// (<c>docs/self-managed-llm-runtime.md</c>, 2026-09-28):
/// <list type="bullet">
/// <item><b>Passes of <see cref="PassDocuments"/> documents.</b> Lyntai runs a call's rows in ONE forward pass of
/// max(8, documents) rows, padded to the widest, and ONNX Runtime's CPU arena keeps what its largest pass needed: 48 full
/// 512-token windows in one pass took the process to 2.4 GB private, where passes of 8 over the same 96 windows stayed at
/// ~570 MB (4: ~440 MB, 16: ~870 MB, 32: ~1.5 GB) — and throughput barely moved with the pass size on that CPU, inside the
/// run-to-run spread. So a call is split here, into passes of 8 — Lyntai's own minimum — which it then runs as one pass
/// each. <b>What the household pays is still ~0.7–1.0 GB</b>: in the app the process's private memory went from 59 MB
/// with 判断 off to 739 MB after the first judged recall and 1,023 MB after recalls of long notes, then stayed. The
/// arena's growth depends on the order of pass sizes it has seen, and its options (arena, threads) are ONNX Runtime
/// session options that Lyntai's provider does not expose — a stated limit, not tuned further here.</item>
/// <item><b>Longest first.</b> The documents are ordered by their counted tokens (<see cref="RerankPace.Tokens"/>) before
/// they are cut into passes, so a pass holding one long window does not pad seven short facts to its width; the scores
/// are put back in input order, and a pair's score does not depend on what it was batched with (masked padding).</item>
/// <item><b>Off the calling thread, one call at a time, and STOPPED at the next pass when abandoned.</b> Lyntai's
/// provider runs inference on the calling thread and checks the token only at entry, so a verification deadline could
/// never end it. Here each call runs on the thread pool behind a one-slot gate, the caller waits cancellably, and the
/// token is checked between passes — so an abandoned call runs on for at most the pass it is in, and the next call waits
/// behind that pass. That is the difference from llama-server, which scores an abandoned batch to its end, and why this
/// scorer's pace is built with <c>abandonedCallsRunOn: false</c> (<see cref="RerankPace"/>).</item>
/// <item><b>Loaded lazily.</b> 118 MB of weights and a 17 MB tokenizer are not paged in because the container was built:
/// the first recall pays ~1.1 s, and a household with 判断 switched off never pays it. A load that fails (a file damaged
/// by hand) is a <see cref="ProviderVerdict.NotConfigured"/> answer — the verifier is fail-open, so that is NoOpinion —
/// logged at Warning once, never an exception at composition, which is what Lyntai's eager <c>AddOnnxProvider</c> would
/// make it: a broken model file must not keep the app from starting.</item>
/// </list></para>
///
/// <para>The window it is fed to is the one the catalogue DECLARES for the same model (<see cref="GgufCatalog.DeclaredWindow"/>
/// of <see cref="GgufCatalog.RerankerWithoutGpu"/>, 512), through the same <see cref="RerankInputCap"/> and
/// <see cref="ChunkedScoreProvider"/> as llama.cpp's — so every pair already fits. The export's own window, which Lyntai
/// reads from its files (514 positions narrowed to <c>tokenizer_config.json</c>'s 512), is checked against it at load, and
/// a smaller one is logged: Lyntai would then truncate a document's tail rather than refuse, silently.</para>
/// </summary>
public sealed class InProcessReranker : IScoreProvider, IDisposable
{
    /// <summary>The router-facing id — the one the verifier names (<c>ScoringVerificationOptions.ProviderId</c>).</summary>
    public const string ProviderId = "builtin-rerank";

    /// <summary>What this backend serves — text pairs in, one score per document out. Also the registration's
    /// <c>declares</c>: composition reads it before the factory has run.</summary>
    public static readonly ProviderCapabilities Declared = new()
    {
        Accepts = [ProviderKinds.Text],
        Produces = [ProviderKinds.Score],
        Operations = [ProviderOperation.Complete],
    };

    /// <summary>The files inside the provisioned directory, in the model repository's own layout — so a change here is a
    /// change to <c>ResourceProvisioner</c>'s file list too. The graph keeps its upstream name (the qint8 export, the one
    /// D191 was verified with), named to Lyntai's provider explicitly rather than renamed to <c>onnx/model.onnx</c>, so the
    /// download is traceable to the thing it came from. <c>config.json</c> and <c>tokenizer_config.json</c> are how Lyntai
    /// reads the window: without the second, the first's 514 positions would be taken as the window, two past the table
    /// (Lyntai <c>docs/FIXES.md</c>, 2026-09-26).</summary>
    public const string ModelFile = "onnx/model_qint8_avx512_vnni.onnx";
    public const string TokenizerFile = "tokenizer.json";
    public const string ConfigFile = "config.json";
    public const string TokenizerConfigFile = "tokenizer_config.json";

    /// <summary>Every file the provider reads — what "present" means.</summary>
    public static readonly IReadOnlyList<string> Files = [ModelFile, TokenizerFile, ConfigFile, TokenizerConfigFile];

    /// <summary>Documents per forward pass — see the class comment.</summary>
    public const int PassDocuments = 8;

    /// <summary>How many full windows the pace seed times (<see cref="MeasurePaceSeed"/>) — ~3,400 pair tokens, so the
    /// pace's 50 ms call-overhead allowance is a small share of a call that takes ~0.4 s on the CPU it was measured on.</summary>
    public const int SeedDocuments = 8;

    private readonly string _dir;
    private readonly int? _window;
    private readonly ILogger? _log;
    private readonly Lazy<OnnxProvider> _model;
    private readonly SemaphoreSlim _turn = new(1, 1);
    private int _loadFailureSaid;
    private int _disposed;

    /// <param name="dir">The provisioned model directory.</param>
    /// <param name="window">The window the verifier fits pairs to — checked against the export's own at load.</param>
    public InProcessReranker(string dir, int? window, ILogger? log = null)
    {
        _dir = dir;
        _window = window;
        _log = log;
        _model = new Lazy<OnnxProvider>(Load, LazyThreadSafetyMode.ExecutionAndPublication);
    }

    /// <summary>Is every file on disk? Asked before anything binds to this backend — a missing download is a sentence
    /// in the console, not a failure on the first recall.</summary>
    public static bool IsPresent(string dir) =>
        Files.All(f => File.Exists(Path.Combine(dir, f.Replace('/', Path.DirectorySeparatorChar))));

    public string Id => ProviderId;
    public ProviderCapabilities Capabilities => Declared;
    public bool IsAvailable => true;
    public Task<ProviderProbeResult> ProbeAsync(CancellationToken ct = default) => Task.FromResult(new ProviderProbeResult(true));

    private OnnxProvider Load()
    {
        var started = Stopwatch.StartNew();
        var provider = OnnxProvider.FromDirectory(_dir, new OnnxProviderOptions
        {
            Id = ProviderId,
            Produces = ProviderKinds.Score,
            ModelFile = ModelFile,
            // The d177 MEASUREMENT mode only, as on llama.cpp's registration: Lyntai segments an over-long document
            // itself (by tokens here). In every other mode nothing segments below this class — ours windows upstream.
            Segmentation = RerankChunking.Mode == RerankChunking.Modes.Lyntai
                ? RerankChunking.LyntaiSegmentation(_window).Segmentation : null,
        });
        _log?.LogInformation("{Id}: loaded the in-process reranker in {Ms} ms from {Dir} (its window {Window} tokens)",
            ProviderId, started.ElapsedMilliseconds, _dir, provider.MaxTokens);
        if (RerankInputCap.UsableWindow(_window) is { } declared && provider.MaxTokens < declared)
            _log?.LogWarning(
                "{Id}: the export's window is {Tokens} tokens, smaller than the {Declared} the verifier fits pairs to — a pair "
                + "longer than {Tokens} will have its document cut at the end, silently", ProviderId, provider.MaxTokens, declared);
        return provider;
    }

    /// <summary>The loaded provider, or the sentence a failed load answers with — said at Warning once, then at Debug.</summary>
    private OnnxProvider? Loaded(out string? failure)
    {
        try
        {
            failure = null;
            return _model.Value;
        }
        catch (Exception ex)
        {
            failure = $"{ProviderId}: the in-process reranker did not load from {_dir}: {ex.Message}";
            if (Interlocked.Exchange(ref _loadFailureSaid, 1) == 0) _log?.LogWarning(ex, "{Failure}", failure);
            else _log?.LogDebug("{Failure}", failure);
            return null;
        }
    }

    /// <summary>One call: scored in passes on the thread pool, one call at a time, stopped at the next pass once
    /// <paramref name="ct"/> is cancelled (the class comment).</summary>
    public async Task<ScoreResponse> CallAsync(ScoreRequest request, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Documents.Count == 0) return new ScoreResponse(ProviderVerdict.Ok, []);

        await _turn.WaitAsync(ct).ConfigureAwait(false);
        // The gate is released by the WORK, not by this caller: an abandoned call keeps it for the pass it is in.
        var work = Task.Run(() =>
        {
            try { return Score(request, ct); }
            finally { _turn.Release(); }
        });
        try
        {
            var scores = await work.WaitAsync(ct).ConfigureAwait(false);
            return scores is null
                ? ScoreResponse.Failure(ProviderVerdict.NotConfigured, $"{ProviderId}: the in-process reranker could not load")
                : ScoreResponse.Success(scores);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // It stops at its next pass and nobody awaits it any more: observe that ending, so it is not reported as unobserved.
            _ = work.ContinueWith(static t => _ = t.Exception, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            throw;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log?.LogWarning(ex, "{Id}: scoring {Documents} documents in process failed", ProviderId, request.Documents.Count);
            return ScoreResponse.Failure(ProviderVerdict.Failed, $"{ProviderId}: {ex.Message}");
        }
    }

    /// <summary>The scores for <paramref name="request"/>'s documents in input order, or null when the model did not load.
    /// Synchronous: Lyntai's provider scores on the calling thread.</summary>
    private double[]? Score(ScoreRequest request, CancellationToken ct)
    {
        if (Loaded(out _) is not { } model) return null;
        var documents = request.Documents;
        // Longest first, so a pass holding a long window does not pad short facts to its width; ties keep input order.
        var order = Enumerable.Range(0, documents.Count)
            .OrderByDescending(i => RerankPace.Tokens(documents[i])).ThenBy(i => i).ToArray();
        var scores = new double[documents.Count];
        for (var start = 0; start < order.Length; start += PassDocuments)
        {
            ct.ThrowIfCancellationRequested();
            var pass = order.AsSpan(start, Math.Min(PassDocuments, order.Length - start)).ToArray();
            var response = model.CallAsync(request with { Documents = [.. pass.Select(i => documents[i])] }, CancellationToken.None)
                .GetAwaiter().GetResult();
            if (!response.IsOk || response.Scores.Count != pass.Length)
                throw new InvalidOperationException(
                    $"scored {response.Scores.Count} of {pass.Length} documents ({response.Verdict}: {response.Detail})");
            for (var k = 0; k < pass.Length; k++) scores[pass[k]] = response.Scores[k];
        }
        return scores;
    }

    /// <summary>Score <paramref name="documents"/> against <paramref name="query"/> directly, outside the router — the
    /// bind-time screen, which is measuring THIS model rather than asking whichever backend can answer. Throws when the
    /// model does not load or a pass fails, so the screen can say why.</summary>
    public double[] ScoreNow(string query, IReadOnlyList<string> documents)
    {
        _ = _model.Value;   // a load failure throws here, with its own message
        _turn.Wait();
        try { return Score(new ScoreRequest(query, documents), CancellationToken.None)!; }
        finally { _turn.Release(); }
    }

    /// <summary>Where the pace STARTS, measured here at its first use — the in-process counterpart of llama.cpp's device
    /// measurement (<see cref="RerankDeviceMeter"/>, which is llama.cpp's and has nothing to measure here): a warm call, then
    /// <see cref="SeedDocuments"/> full windows of dense Chinese at the budget the fit gives this window, timed, in the
    /// pace's unit (<see cref="RerankPace.RateOf"/>, ms per pair token as <see cref="RerankPace.Tokens"/> counts them) and
    /// under the same floor (<see cref="RerankDeviceVerdict.NeverFasterThanTheGpuFigure"/>). Null — the GPU figure — when it
    /// cannot be measured, and the log says why either way, because the pace's other lines quote its estimate.
    ///
    /// <para><b>Why dense Chinese full windows, and eight of them.</b> The shape a chunked call sends and the costliest the
    /// pace counts: the device batch's mixed prose is cheaper per counted token, and its four documents (~740 pair tokens)
    /// took ~70–85 ms here, of which the pace's 50 ms allowance is most — the rate read 26–47 ms per 1,000 pair tokens and
    /// floored to the GPU figure, a third of what long windows cost on this CPU (docs/self-managed-llm-runtime.md,
    /// 2026-09-28). Eight dense windows read 92–106 in a quiet process and 150 at a quiet start of the app — and 394 at a
    /// start where annotation spawns ran beside it: one call at one moment, so contention can only make the first sizing
    /// more careful. Run on the recall that first uses the pace, under its lock: ~0.3–0.5 s here beside the ~1.0–1.4 s
    /// model load that recall pays anyway.</para></summary>
    public double? MeasurePaceSeed()
    {
        try
        {
            var warm = SeedBatch(1);
            var timed = SeedBatch(1 + SeedDocuments);
            ScoreNow(warm.Query, warm.Documents);
            var clock = Stopwatch.StartNew();
            ScoreNow(timed.Query, timed.Documents);
            var elapsed = clock.Elapsed;
            var tokens = RerankPace.PairTokens(timed.Query, timed.Documents);
            var rate = RerankPace.RateOf(elapsed, tokens);
            var seed = RerankDeviceVerdict.NeverFasterThanTheGpuFigure(rate);
            _log?.LogInformation(
                "{Id}: the rerank pace starts from {Seed:0.###} ms per 1,000 pair tokens — this machine's CPU, measured in process at the pace's first use ({Documents} full windows, {Tokens:0} pair tokens in {Ms:0} ms: {Rate:0.###}), never below the GPU figure {Gpu:0.###}",
                ProviderId, seed * 1000, timed.Documents.Count, tokens, elapsed.TotalMilliseconds, rate * 1000,
                RerankPace.SeedMsPerToken * 1000);
            return seed;
        }
        catch (Exception ex)
        {
            _log?.LogInformation(
                "{Id}: the rerank pace starts from the GPU figure, {Gpu:0.###} ms per 1,000 pair tokens — the in-process measurement failed: {Why}",
                ProviderId, RerankPace.SeedMsPerToken * 1000, ex.Message);
            return null;
        }
    }

    /// <summary>Invented, never a household's: a community library's notices, dense Chinese.</summary>
    private const string SeedProse =
        "社区图书室每周二和周四晚上开放到九点,借书要带借阅卡,每人每次最多借五本,逾期一天罚款一角。"
        + "新到的杂志放在入口右侧的架子上,儿童绘本在最里面的矮书架,旧报纸每月底清理一次。";

    private const string SeedQuery = "社区图书室晚上开到几点?每次最多能借几本书?";

    /// <summary><see cref="SeedDocuments"/> documents, each a FULL window for <see cref="_window"/> — numbered from
    /// <paramref name="first"/>, so the warm call and the timed call are different text of the same size.</summary>
    private (string Query, IReadOnlyList<string> Documents) SeedBatch(int first)
    {
        var (query, per) = RerankInputCap.Fit(SeedQuery, _window);
        var docs = Enumerable.Range(first, SeedDocuments).Select(n =>
        {
            var text = RerankInputCap.Prepare($"第{n}份通知:" + string.Concat(Enumerable.Repeat(SeedProse, 1 + per / SeedProse.Length)), _window);
            return text.Length <= per ? text : text[..per];
        }).ToList();
        return (query, docs);
    }

    /// <summary>Releases the native session — after the pass in flight, if any, so it is never disposed under a run.</summary>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        // A pass still running after this long is left to finish with the process: disposing a session under a run is a
        // native fault, and at shutdown a session not disposed costs nothing.
        if (!_turn.Wait(TimeSpan.FromSeconds(10))) return;
        try
        {
            if (_model.IsValueCreated) _model.Value.Dispose();
        }
        finally
        {
            _turn.Release();
        }
    }
}
