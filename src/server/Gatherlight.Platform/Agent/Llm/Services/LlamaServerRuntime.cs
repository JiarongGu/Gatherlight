using System.Diagnostics;
using System.Text;
using Gatherlight.Server.Platform.Hosting.Resources.Services;
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>What this install's llama-server is doing right now.</summary>
/// <param name="Models">Model ids the router advertises — derived by IT from the GGUF filenames in
/// <c>--models-dir</c>, which is why callers must ask rather than construct them.</param>
/// <param name="Devices">What <c>--list-devices</c> reported. Present even when nothing is serving,
/// because "will this use the GPU" is answerable from the binary alone and is the question behind the
/// whole runtime choice.</param>
/// <param name="Held">Something ACCEPTS connections on our port and does not answer — a hung llama-server, another
/// program, or our own router too busy to reply. Not serving, and not free either: nothing may be spawned beside it,
/// and <paramref name="Problem"/> says so ahead of anything else.</param>
/// <param name="Ours">The router on our port is one THIS process started and still holds. False for an ADOPTED one —
/// an orphan of an earlier run, or the household's own — which a service restart does not end (Dispose kills only
/// ours), so any remedy that ends in 「重启服务」 is true only when this is. The same fact <c>HeldProblem</c> and the
/// not-ours refusal in <see cref="LlamaServerRuntime.EnsureServesAsync"/> read.</param>
/// <param name="DevicesListed"><c>--list-devices</c> ANSWERED — its "Available devices:" header was in the output — so
/// <paramref name="Devices"/> is the binary's own list and an empty one means it sees no device. False when the probe was
/// not run (a Live state), failed, or printed something else: then an empty list means nothing.</param>
public sealed record LlamaServerState(
    string BaseUrl,
    bool Installed,
    bool Serving,
    string? Version,
    string? Executable,
    IReadOnlyList<string> Models,
    IReadOnlyList<string> Devices,
    bool GpuLikely,
    string? Problem,
    bool Held = false,
    bool Ours = false,
    bool DevicesListed = false)
{
    /// <summary>Whether llama.cpp can use a GPU here — <see cref="GpuFrom"/> over what <c>--list-devices</c> answered, and
    /// null when it did not answer. Null is not "no": a recommendation that changes on "no GPU" must not change on "nobody
    /// asked yet" (<see cref="GgufCatalog.RecommendedRerankerFor"/>).</summary>
    public bool? Gpu => DevicesListed ? GpuFrom(Devices) : null;

    /// <summary>The ONE rule for reading a device list <c>--list-devices</c> ANSWERED with: FALSE only when it listed no
    /// device at all — measured with this build (b10549) and its Vulkan devices hidden, its whole answer is "Available
    /// devices:" and "(none)" — TRUE when it lists a Vulkan device (the build this app provisions is the Vulkan one, and a
    /// Vulkan device is a GPU, integrated ones included), and NULL — not known — for a list naming only devices of another
    /// kind (CUDA0, Metal, SYCL0…). Those come from a build we did not provision, and reading them as "no GPU" would claim
    /// a CPU-only machine where there is plainly a device (review, 2026-09-25: the first version did exactly that).
    /// Recognising each backend's prefix as a GPU was the alternative, and was not taken: a prefix list goes stale with the
    /// next backend llama.cpp adds, and unknown keeps the default recommendation and claims nothing, which is the honest
    /// answer for a build nobody here has run.</summary>
    public static bool? GpuFrom(IReadOnlyList<string> devices) =>
        devices.Count == 0 ? false
        : devices.Any(d => d.StartsWith("Vulkan", StringComparison.OrdinalIgnoreCase)) ? true
        : null;
}

public interface ILlamaServerRuntime
{
    /// <summary>Where the router listens. Loopback, always — see <see cref="LlamaServerRuntime"/>.</summary>
    string BaseUrl { get; }

    /// <summary>The provisioned <c>llama-server.exe</c>, or null when 资源 has not fetched it.</summary>
    string? Locate();

    /// <summary>The FULL state, including the build tag and the device list — both of which cost a child
    /// process on a memo miss. For 资源, which displays them.</summary>
    Task<LlamaServerState> ProbeAsync(bool refresh = false, CancellationToken ct = default);

    /// <summary>The last FULL probe, or null when none has run — the build tag and device list without
    /// paying for them.
    ///
    /// <para>For a caller that displays those but must not block on two process starts: on a cold memo the
    /// full probe costs ~1.9 s, and 资源 was paying it on the first open after every restart (measured
    /// 3.24 s for the whole request). The caller composes a cheap row from <see cref="LiveAsync"/> plus
    /// whatever this already holds, and kicks a background refresh when it is empty.</para></summary>
    LlamaServerState? Cached { get; }

    /// <summary>Whether llama.cpp can use a GPU here (<see cref="LlamaServerState.GpuFrom"/>), from the memo of the
    /// provisioned binary's device list — which, unlike <see cref="Cached"/>, <see cref="Invalidate"/> does not clear, by
    /// design: the file has not changed because the server restarted. Null when there is no memo for the file on disk now
    /// (never probed, or the binary replaced since). Never spawns anything, so a panel may read it.
    ///
    /// <para><b>Why not <c>Cached?.Gpu</c></b> (review, 2026-09-25): every start, restart and model removal invalidates the
    /// cached state, so the 推荐 badge and the 判断 row's suggestion flipped from mMiniLMv2 to BGE — "no GPU" read as "not
    /// known" — until a background probe finished.</para></summary>
    bool? Gpu { get; }

    /// <summary>Where a RERANKER's device measurement stands on this machine (<see cref="RerankDeviceMeter"/>): its key
    /// now, and the measurement when one is current. Null when there is no key to ask with — the model file is not on
    /// disk, or this process holds no memo of the binary's build tag and device list (nothing probed yet, or the binary
    /// did not answer). Never spawns anything, so a panel and a registration factory may read it.</summary>
    RerankDeviceLookup? RerankDevice(string modelId);

    /// <summary>What a reranker device measurement is doing right now, as a household progress line (「正在测重排模型 … 第
    /// i/n 个 …」), or null — read by the migration overlay's step line. A field read, never an await.</summary>
    string? MeasuringNow { get; }


    /// <summary>The state a BINDING decision needs: is it installed, is it answering, what models are on
    /// disk. Never spawns anything.
    ///
    /// <para>Separate from <see cref="ProbeAsync"/> because the two questions have different costs and
    /// different owners. 记忆检索 asks "can this layer run here", which is a file check and a loopback
    /// connect; 资源 asks "what exactly did we install", which means running the binary. Measured
    /// 2026-08-22: the recall panel was calling the second to answer the first and spending ~3.4 s of a
    /// ~5 s load on a build number it never displayed. <c>Version</c> and <c>Devices</c> come back empty
    /// here — an honest "not asked" rather than a stale value, so nothing can render one believing it was
    /// checked.</para></summary>
    Task<LlamaServerState> LiveAsync(CancellationToken ct = default);

    /// <summary>Make sure the router is answering, starting it only if the port is silent.</summary>
    Task<bool> EnsureServingAsync(CancellationToken ct = default);

    /// <summary><see cref="EnsureServingAsync"/>, and what THIS call measured on the way — a reranker device measurement
    /// runs inside a start the app performs (<see cref="RerankDeviceMeter"/>) — or null when it measured nothing. Only
    /// this call's: a start that waited behind another caller's measurement did not run it. Set whether or not the router
    /// then came up, because the measurement took its time either way.</summary>
    Task<RouterStart> StartAsync(CancellationToken ct = default);

    /// <summary>Make sure the router is answering AND knows <paramref name="modelId"/> — null when it does,
    /// otherwise the sentence a household reads. A model downloaded after OUR router started restarts it — only
    /// when the router answered without listing it, and only when <see cref="ILlamaRestartPolicy"/> says a
    /// restart loses nothing. See the implementation for why.</summary>
    Task<string?> EnsureServesAsync(string modelId, CancellationToken ct = default);

    /// <summary>Force a model to load NOW, so the first real request does not pay for it. Returns false if
    /// it could not be loaded.</summary>
    Task<bool> WarmAsync(string modelId, GgufCapability kind, CancellationToken ct = default);

    void Invalidate();
}

/// <summary>
/// The self-managed local model runtime: llama.cpp's <c>llama-server</c>, in router mode, owned by this
/// app. Chosen over Ollama on 2026-08-22 after measuring both — <c>docs/self-managed-llm-runtime.md</c>.
///
/// <para><b>It only ever runs the copy 资源 provisioned, and deliberately does NOT look on PATH.</b> That
/// is the opposite of <see cref="OllamaRuntime"/>, and the difference is the point: a household's OWN
/// llama-server is reachable already, as <c>openai-compat</c> with an address they typed. Searching PATH
/// here would collapse "the runtime we install and manage" into "some llama-server we found", which is
/// exactly the ambiguity that let a provisioned Ollama read as a manual prerequisite for months.</para>
///
/// <para><b>TWO THINGS ARE LAUNCH CONTRACT, NOT TUNING</b>, and both were measured:</para>
/// <list type="number">
/// <item><b><c>--n-gpu-layers</c> is mandatory.</b> Without it llama-server runs on the CPU and says
/// nothing about it — measured at 222 ms/query against 7 ms with offload, a silent 30× penalty on the
/// path of every recall. It is written into the generated preset for every model rather than passed once
/// globally, because the per-model form is the one whose effect was verified in the child's own argv.</item>
/// <item><b>Models load LAZILY, so they must be warmed.</b> <c>--models-max</c> is a cap, not a preload:
/// the first request for a model spawns a child and waits for it. Measured at 17.3 s for a 1B q4 chat
/// model. Unwarmed, the first recall after every restart stalls — which is the same shape as the CLI
/// spawn cost this whole exercise exists to remove, just once per restart instead of per call.</item>
/// </list>
///
/// <para><b>Embedding models need <c>embeddings = true</c> and chat models must not have it</b> — the flag
/// restricts a child to embeddings and disables chat, so a mislabelled embedder would serve chat requests
/// that can never succeed and a mislabelled chat model would refuse to talk. The answer comes from
/// <see cref="ResourceProvisioner.GgufKind"/> — exact for what we provision, a stated name
/// heuristic for a GGUF the household dropped in themselves, and ONE writer either way.</para>
///
/// <para><b>Chat models launch with thinking OFF, a generation cap and a context cap</b> (<c>reasoning = off</c>,
/// <c>n-predict</c>, <c>ctx-size</c> — chat sections only). All three fail SILENTLY without it: a thinking-capable
/// template thinks on every judgement, a small model's runaway fills its whole context, and an uncapped child reserves
/// its model's whole TRAINING context in GPU memory up front; none is an error. See <see cref="WritePresets"/>,
/// <see cref="ChatMaxTokens"/> and <see cref="ChatContextTokens"/>.</para>
/// </summary>
public sealed class LlamaServerRuntime : ILlamaServerRuntime, IDisposable
{
    /// <summary>The base of the port range. Not llama.cpp's own 8080 — that is a common port for a
    /// household's own services, and this is a daemon we start without asking. Adjacent to Ollama's 11434 so
    /// the two read as siblings.</summary>
    private const int PortBase = 11435;

    /// <summary>How many ports the per-install hash may land in. Small, because a collision between two
    /// installs is recoverable (the second adopts the first's router) while a wide range would wander into
    /// ports something else may own.</summary>
    private const int PortSpan = 64;

    /// <summary>Enough for one embedder plus one judge, which is every layer this product has. Higher would
    /// let an idle model hold VRAM for nothing; lower would evict one of the two on every alternation.</summary>
    private const int MaxResidentModels = 2;

    /// <summary>All layers offloaded. llama.cpp clamps to what the model has, so "99" is the idiom for
    /// "as many as will fit" rather than a number anyone tuned.</summary>
    private const int GpuLayers = 99;

    /// <summary>A cross-encoder scores (query, document) as ONE sequence, which must fit one physical batch;
    /// 4096 is how Lyntai's own harness runs the same reranker files. Launch CONTRACT, like GpuLayers. The default
    /// only: a reranker whose catalogue row declares a window (<see cref="GgufCatalog.DeclaredWindow"/>) is launched
    /// with that one. Public because it is also the pair limit <see cref="RerankInputCap"/> caps an undeclared-window
    /// reranker's query against (<see cref="RerankInputCap.UndeclaredQueryMaxChars"/>) — one writer for both.</summary>
    public const int RerankBatch = 4096;

    /// <summary>The most a CHAT child generates for one request — written as <c>n-predict</c>, which llama-server
    /// uses as the default for a request naming no <c>max_tokens</c> and as the ceiling for one that does. Lyntai's
    /// memory seams send none, so without it a small model's runaway reply fills the child's whole context (Run 5's
    /// screen: gemma-3-270m to 31,073 tokens in 154 s) — and the router does not stop a child's generation when the
    /// app gives up on the request, so the waste outlives the timeout.
    ///
    /// <para><b>Why 512.</b> The longest LEGITIMATE output of either seam, measured with <c>/tokenize</c> on the three
    /// small chat models' own tokenizers (Qwen3-0.6B, Qwen3.5-0.8B, gemma-3-1b; 2026-09-24): a verdict naming a whole
    /// page of 8 is 19 tokens, the annotator's four subject handles 18–26 (31–40 at twice its accepted maximum), and a
    /// verdict naming EVERY candidate a recall at the DEFAULT limit of 8 can show (96) is 282 — 385–388 pretty-printed
    /// in a code fence. 512 holds all of those with room. What it cuts is a verdict endorsing more than ~170
    /// candidates, which only a recall showing the judge more than that can reach: the judge sees 4× what
    /// <c>FactIndex.RankAsync</c> asks for — min(3 × limit, 100) with no kind, 100 with one — so a recall naming a kind
    /// (up to 400; 1,495 tokens to name them all), or a kind-less one asking for 15 or more (180 at 15, 400 from 34).
    /// Whichever it is, Lyntai names "endorses a large fraction of what it sees" as the judge's FAILURE signal, because
    /// partition then replaces the page. A cut reply fails to parse and is NoOpinion: the engine's page stands, which is
    /// the better outcome there anyway. Run 5's screen measured the replies actually given, with thinking off: 6–21
    /// tokens.</para>
    ///
    /// <para><b>The cap turns an ALWAYS-THINKING model silent rather than slow.</b> <c>reasoning = off</c> works by the
    /// chat template rendering a pre-closed think block; a dropped-in model whose template thinks regardless (ignores
    /// <c>--reasoning off</c>) spends its 512 tokens inside the thinking and is cut before it writes a verdict or a
    /// subject list. That reply does not parse, and both seams fail open — so such a model verifies nothing and tags
    /// nothing, on every call, in about the time the cap takes to decode, with no error anywhere. Uncapped it would have
    /// been slow instead (seconds to minutes per call, Run 5's screen), which at least shows. No catalogued model does
    /// this; the fix for one that does is a row measured on the bench, not a larger cap.</para>
    ///
    /// <para><b>What it bounds a runaway to: cap ÷ decode rate.</b> Measured on the real binary under the preset this
    /// file generates (2026-09-24, llama.cpp b10549, Qwen3-0.6B-Q8_0 on one laptop GPU): a prompt asking for every
    /// number to 100,000 stopped at exactly 512 completion tokens, <c>finish_reason: length</c>, in 2.4 s (229 tokens/s
    /// decode). A CPU-only machine decodes several times slower, and pays that many times more — still bounded. The
    /// same router answered a verification-shaped request (Lyntai's verifier prompt, 60 fixture notes, 1,632 prompt
    /// tokens) in 93–276 ms with 13–19 completion tokens and no reasoning at all.</para></summary>
    private const int ChatMaxTokens = 512;

    /// <summary>The context a CHAT child launches with — written as <c>ctx-size</c>, on chat sections only. Unset, a
    /// child takes its model's TRAINING context and llama.cpp reserves the whole KV cache for it up front. For
    /// Qwen3-0.6B that is 40,960 tokens with full attention on all 28 layers: 4,480 MiB of KV cache for a 604 MiB model,
    /// and the app's router plus that child took +5,175 MiB of GPU memory by nvidia-smi — for prompts that measure a
    /// quarter of it (docs/self-managed-llm-runtime.md, 2026-09-24).
    ///
    /// <para><b>Why 16,384: the MEASURED worst case, with margin.</b> Prompts built exactly as Lyntai 3.2.0's verifier
    /// and annotator build them, counted by llama-server b10549 on each model's own tokenizer and chat template
    /// (Qwen3-0.6B / Gemma 3 1B; 2026-09-24). The deepest verification shows the judge 400 candidates (4 × what
    /// <c>FactIndex.RankAsync</c> asks for: a recall naming a kind, or asking for 34 or more), each line capped at
    /// <see cref="JudgeSeesContentPolicy.MaxChars"/>. 400 of the bench fixture's facts (household-shaped, median 29
    /// characters) with its longest question: 9,993 / 10,395 tokens; with the <see cref="ChatMaxTokens"/> reply, at most
    /// 10,907 — a third of the window to spare. 400 candidates of 100 ENGLISH characters: 12,565 / 12,830. The deepest
    /// annotation (Lyntai's 24 known subjects and 8 earlier facts, then the write): 604 / 606 tokens with fixture facts,
    /// 2,909 / 3,132 with every fact at 400 Chinese characters.</para>
    ///
    /// <para><b>What does not fit, and what happens then.</b> 400 candidates of 100 CHINESE characters is 30,819 /
    /// 32,941 tokens, and 400 at the 400-character cap 114,476 / 124,166 — past both models' own training windows too,
    /// so no cap holds that (uncapped, Gemma 3 1B already refused the first). llama-server refuses an over-long prompt
    /// whole — HTTP 400 <c>exceed_context_size_error</c>, nothing generated — and both seams fail open: verification to
    /// NoOpinion (the engine's page stands), annotation to no subjects (the fact is indexed without them, and an
    /// indexed row is never revisited). At 16,384 a verification overflows when 400 candidates average more than ~45–50
    /// Chinese characters (~130 English), or fewer run longer (100 at the cap is 28,698); an annotation when the 8
    /// earlier facts and the write run ~20,000 Chinese characters between them. Accepted, because a small judge shown
    /// that much is already past its use: at 400 fixture candidates Qwen3-0.6B's replies either ran into
    /// <see cref="ChatMaxTokens"/> (finish <c>length</c>: unparsed, NoOpinion — all six app-driven calls, capped or not)
    /// or endorsed well over a hundred candidates, Lyntai's own failure signal. And a household fact is granular.</para>
    ///
    /// <para><b>Measured on the real binary under the preset the app writes</b> (2026-09-24, b10549, Vulkan, one RTX 4080
    /// Laptop GPU; <c>docs/self-managed-llm-runtime.md</c>): Qwen3-0.6B's KV cache 4,480 → 1,792 MiB, its projected
    /// footprint 5,150 → 2,438 MiB, and the app's router plus that child +5,175 → +2,472 MiB by nvidia-smi; the
    /// 400-candidate verification still answered (9,979 prompt tokens, HTTP 200). Gemma 3 1B, whose sliding-window
    /// layers already kept its cache small, went 183 → 119 MiB of KV (+1,108 → +1,026 MiB) and answered as before.</para>
    ///
    /// <para><b>It also takes away llama.cpp's own shrinking, knowingly.</b> Its default <c>--fit on</c> adjusts only
    /// what the launch left UNSET: uncapped on a GPU short of room, it cut Qwen3's context to leave 1 GiB free
    /// (simulated with <c>fit-target</c>: 40,960 → 12,032, logged only at verbosity 4), so the window a household got
    /// depended on what else held the GPU at load time. With the cap set it logs "context size set by user → no change"
    /// and — <c>n-gpu-layers</c> being set too, as it always was — "abort", and loads as asked. So the footprint is now
    /// the same on every machine, and a GPU without that much room is where it goes unmeasured: the position every
    /// model here was already in, <c>n-gpu-layers</c> having always been set.</para>
    ///
    /// <para><b>The window is SHARED by requests in flight at once</b> — the child runs 4 slots over one unified cache.
    /// Measured at the cap: a deep verification with an annotation (fixture-sized, or every fact at 400 Chinese
    /// characters) in flight beside it, or with a default 96-candidate verification, all answered. TWO deep
    /// verifications at once (~10.5k each) do not fit together, and llama.cpp then fails BOTH — HTTP 500 "Context size
    /// has been exceeded" in ~1.6 s — so both leave the engine's page; the child serves the next request normally.
    /// Uncapped, by the same arithmetic, it would take four (not measured).</para></summary>
    private const int ChatContextTokens = 16384;

    /// <summary>How long a freshly spawned router has to answer before it is killed as never-ours.</summary>
    private static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(20);

    /// <summary>How long a restart waits for the router it killed to let go of the port. In ten measured restarts
    /// the port was already free when the kill returned; the cap is for the case that made a restart fail — see
    /// <see cref="WaitForPortReleaseAsync"/>.</summary>
    private static readonly TimeSpan PortReleaseTimeout = TimeSpan.FromSeconds(15);

    private readonly IPlatformContext _platform;
    private readonly ILogger<LlamaServerRuntime> _log;
    private readonly IHttpClientFactory _http;
    private readonly object _gate = new();
    private LlamaServerState? _cached;
    private DateTimeOffset _cachedAt;
    /// <summary>Bumped by every invalidation, under <see cref="_gate"/>. A probe notes it before its first await and
    /// caches only if it is unchanged, so an invalidation that lands while a probe is out — a start or restart
    /// ending, a spawn answering — cannot be undone by that probe writing back what was just retracted.</summary>
    private long _probeEpoch;
    // Memoized facts about the BINARY — see BinaryFactsAsync. Deliberately not cleared by Invalidate():
    // that exists for the live state, and the file has not changed just because the server was restarted.
    private (string Key, string? Version, IReadOnlyList<string>? Devices)? _binaryFacts;

    /// <summary>The router WE started — set only once it ANSWERED. Assigned at spawn, a second router that
    /// lost the race for the port and exited made the live one look adopted: the next bind told the household
    /// to kill our own process, and Dispose orphaned it.</summary>
    private Process? _started;

    /// <summary>True from <see cref="StopOursCore"/> in a restart until the restart returns — the new router ours, or
    /// the restart given up. In that window a probe that runs WITHOUT the lifecycle lock — the panel's — can see the
    /// dying or starting router as HELD, and must not blame "another process" for our own restart. Read and written
    /// under <see cref="_gate"/>; cleared together with the cached probe (see <see cref="EnsureServesAsync"/>).</summary>
    private bool _restarting;

    /// <summary>True while <see cref="SpawnAsync"/> runs — ANY start, a fresh one included. <see cref="_started"/> is
    /// set only once the new router answers, so before that a panel probe that finds the port held by our own
    /// starting router had nothing to tell it apart from a stranger's, and blamed "another process". Read and written
    /// under <see cref="_gate"/>; cleared together with the cached probe on every exit of the spawn.</summary>
    private bool _starting;

    /// <summary>ONE lock over start, restart and stop. Probe-then-spawn is a check-then-act on a port, and
    /// three callers can overlap (a bind on either layer, 资源's start button, the startup warm step); a restart
    /// holds the router down for seconds, which is exactly the window a concurrent "not serving → spawn" sees.
    /// Whatever needs the router while it holds this waits, and then finds it up.</summary>
    private readonly SemaphoreSlim _lifecycle = new(1, 1);

    /// <summary>Set by <see cref="Dispose"/>, read under <see cref="_lifecycle"/> and again after a spawn
    /// answers — so nothing a background re-warm or a late restart does can start a router after shutdown.</summary>
    private volatile bool _disposed;

    private readonly ILlamaRestartPolicy? _restartPolicy;

    /// <summary>Times each installed reranker on the CPU and every GPU before a router of ours starts — see
    /// <see cref="MeasureRerankersAsync"/>. Held here so <see cref="Dispose"/> can kill a measurement child.</summary>
    private readonly RerankDeviceMeter _meter;

    /// <summary>Measurements this process took and could NOT save (<see cref="RerankDeviceStore.Save"/> threw), by model.
    /// They are the NEWEST under their key by construction, so everything in this process reads them first: the router it
    /// started runs with them, <see cref="RerankDevice"/> answers from here with <c>Saved = false</c>, and the next start
    /// retries from them (their attempts advance) and tries the save again. Memory only: after an app restart the store
    /// holds none, so the model is measured again from scratch — which is what the row says.</summary>
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, RerankDeviceMeasurement> _unsaved =
        new(StringComparer.OrdinalIgnoreCase);


    public LlamaServerRuntime(IPlatformContext platform, IHttpClientFactory http,
        ILogger<LlamaServerRuntime> log, ILlamaRestartPolicy? restartPolicy = null)
    {
        _platform = platform;
        _http = http;
        _log = log;
        _restartPolicy = restartPolicy;
        _meter = new RerankDeviceMeter(http, log);
    }

    /// <summary>Env override → loopback default, with the loopback guard applied. Non-loopback is refused
    /// for the same reason as Ollama's: every fact the household writes goes to whatever does the
    /// embedding, and a remote address does that silently and forever.</summary>
    public string BaseUrl => ResolveBaseUrl(_platform.ResourcesPath, _log);

    /// <summary>Env override → loopback default, guard applied. STATIC for the same reason
    /// <see cref="OllamaRuntime.ResolveBaseUrl"/> is: the recall source resolves this endpoint at DI
    /// registration time, before any container exists, and this service resolves it again later. Two answers
    /// for one endpoint is how an install ends up embedding against one address and reporting another.</summary>
    /// <summary>The port THIS install's router listens on — derived from the data folder.
    ///
    /// <para><b>A fixed port was wrong, and an e2e run proved it.</b> With one hard-coded 11435, a second
    /// Gatherlight on the same machine finds the first's router already answering, adopts it (which is the
    /// correct behaviour for OUR router surviving a restart) and then serves the OTHER install's models from
    /// the other install's data folder. The suite hit exactly this: a fixture with no llama-server binary
    /// reported <c>installed:false, serving:true</c> and listed a model belonging to the developer's real
    /// install. Ollama can hard-code 11434 because a household runs one shared Ollama; this router is
    /// private, holds our models, and is started by us — so it must be per-install.</para>
    ///
    /// <para>Deterministic rather than ephemeral, because a restart has to find its own router again for
    /// adoption to work. FNV-1a over the resolved data path, so two folders differing anywhere land
    /// apart.</para></summary>
    public static int PortFor(string dataPath)
    {
        var key = Path.GetFullPath(dataPath).TrimEnd(Path.DirectorySeparatorChar).ToLowerInvariant();
        unchecked
        {
            var h = 2166136261u;
            foreach (var c in key) { h ^= c; h *= 16777619u; }
            return PortBase + (int)(h % PortSpan);
        }
    }

    public static string ResolveBaseUrl(string dataPath, ILogger? log = null)
    {
        var raw = Environment.GetEnvironmentVariable("GATHERLIGHT_LLAMACPP_URL");
        if (string.IsNullOrWhiteSpace(raw)) return $"http://127.0.0.1:{PortFor(dataPath)}";
        if (Uri.TryCreate(raw, UriKind.Absolute, out var u) && !u.IsLoopback
            && Environment.GetEnvironmentVariable("GATHERLIGHT_LLM_ALLOW_REMOTE") != "1")
        {
            log?.LogWarning(
                "Ignoring llama-server URL {Url}: a non-loopback runtime would send household facts off "
                + "this machine. Set GATHERLIGHT_LLM_ALLOW_REMOTE=1 if that is truly intended.", raw);
            return $"http://127.0.0.1:{PortFor(dataPath)}";
        }
        return raw.TrimEnd('/');
    }

    public string? Locate()
    {
        var exe = ResourceProvisioner.ProvisionedLlamaServer(_platform.ResourcesPath);
        return File.Exists(exe) ? exe : null;
    }

    private string ModelsDir() => ResourceProvisioner.ProvisionedGgufDir(_platform.ResourcesPath);

    /// <summary>Every GGUF id on disk — delegated, so the router's own id rule has one writer. See
    /// <see cref="ResourceProvisioner.InstalledGgufIds"/>.</summary>
    private IReadOnlyList<string> LocalGgufIds() =>
        ResourceProvisioner.InstalledGgufIds(_platform.ResourcesPath);

    /// <summary>Write the router's preset file. Regenerated on every start rather than kept, because it is
    /// derived state: the models on disk are the truth, and a stale section naming a deleted GGUF is a
    /// child that fails to spawn. Each section is <see cref="LaunchKeys"/> — the ONE writer of the launch contract,
    /// which the reranker device measurement launches its standalone children with too.
    /// <para><paramref name="devices"/>: the device each MEASURED reranker runs on (<see cref="RerankDeviceMeter"/>) — the
    /// fastest of its current measurement once it is PINNED (<see cref="RerankDeviceMeasurement.Pinned"/>), <c>none</c> for
    /// the CPU. A reranker without one — never measured, or a device of unknown speed still to be measured — and every
    /// other kind, gets no device key:
    /// llama.cpp chooses, as it always did.</para></summary>
    private string WritePresets(IReadOnlyList<string> models, IReadOnlyDictionary<string, string> devices)
    {
        var path = Path.Combine(ModelsDir(), "presets.ini");
        var sb = new StringBuilder();
        sb.AppendLine("; Generated by Gatherlight on every start — edits here are lost.");
        sb.AppendLine("; n-gpu-layers is CONTRACT, not tuning: without it llama-server runs on the CPU at");
        sb.AppendLine("; ~30x the latency and logs nothing about it.");
        foreach (var m in models)
        {
            sb.AppendLine();
            sb.AppendLine($"[{m}]");
            foreach (var (key, value) in LaunchKeys(m, devices.TryGetValue(m, out var d) ? d : null))
                sb.AppendLine($"{key} = {value}");
        }
        File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false));
        return path;
    }

    /// <summary>The keys a model's child is launched with — a preset section's lines, and (for a reranker's device
    /// measurement) a standalone child's flags: <c>--key value</c>, or <c>--key</c> alone for <c>true</c>, which is how the
    /// router itself passes a preset to its child (read back from the child's argv on b10549). ONE writer, so a reranker is
    /// measured under exactly the launch it then runs with.
    /// <para><paramref name="device"/> is written on a RERANKER section only, and only when given.</para></summary>
    public static IReadOnlyList<(string Key, string Value)> LaunchKeys(string model, string? device)
    {
        // n-gpu-layers on EVERY section — the launch contract (class comment). On a reranker section measured fastest on the
        // CPU it stands beside `device = none`, and is harmless there: verified on b10549 (2026-09-26, BGE, both GPUs
        // visible) — the child's log still says "offloaded 25/25 layers to GPU", but its model buffer is CPU_Mapped
        // (440 MiB) and its compute buffer CPU, with no Vulkan buffer at all, and it scored at the CPU's rate: 3.35 s per
        // 1,000 pair tokens with 99 against 3.20–3.34 with 0, and 3.6–3.7 on a 16-document batch, where a GPU would have
        // taken well under a second. (Run 8 found `n-gpu-layers = 0` ALONE still offloads a big batch to a visible GPU —
        // it is `device = none` that keeps the child on the CPU.)
        var keys = new List<(string, string)> { ("n-gpu-layers", GpuLayers.ToString()) };
        switch (ResourceProvisioner.GgufKind(model))
        {
            // `embeddings` RESTRICTS a child to embedding-only. Right for an embedder, fatal for a judge.
            case GgufCapability.Embedding:
                keys.Add(("embeddings", "true"));
                break;
            // A CHAT child — the only kind that generates — launches with thinking OFF, a generation cap and a
            // context cap.
            //
            // `reasoning = off` IS A WORKAROUND FOR A LYNTAI GAP, recorded on both sides (dev-conventions: open
            // workaround (5)). Both memory seams ask for no reasoning (TextReasoning.Suppress), and Lyntai 3.2.0's
            // OpenAI-shaped payload drops the field — Lyntai docs/task-archive.md Part 288, "the OpenAI-shaped wire
            // drops TextReasoning.Suppress", CLOSED upstream as D179 but NOT released (no version promised).
            // llama-server's default `--reasoning auto` then opens a thinking block for any
            // template that supports one: Qwen3-0.6B thought on every call (1.3–7.5 s), Qwen3.5-0.8B for 17.5 s and
            // then past a 300 s client timeout (docs/judge-bench.md, Run 5's screen). The router passes this key to
            // the child as `--reasoning off`; the template then renders its pre-closed think block, and replies ran
            // 6–21 tokens. For a template with nothing to turn off (Gemma 3) the rendered prompt is byte-identical.
            // NOT `reasoning-budget = 0`: the template stays in thinking mode, the model writes its reasoning into
            // the content, and 4 of 6 replies did not parse. KEEP THIS LINE UNTIL D179 SHIPS — and even then it goes
            // LAST. D179 is CONFIGURED fields: HttpModelOptions.SuppressReasoningFields, a JSON object Lyntai merges
            // into a chat request only when the call asks Suppress; like DocumentPrefix, the library knows no vendor's
            // spelling and ships no default. So the bump wires nothing by itself. In order:
            // (1) set SuppressReasoningFields = {"chat_template_kwargs":{"enable_thinking":false}} on the `llamacpp`
            // registration — the AddLlamaProvider line in LlamaCppSource.Register, through the preset's options-action
            // overload D179 added — a spelling that is TEMPLATE-specific (a template reading another key ignores it)
            // and was tried only as a dedicated server's `--chat-template-kwargs` flag, never as a request field or a
            // preset key; (2) verify EACH catalogued chat model on the real binary with this line removed: no
            // `<think>`, no reasoning_content, replies as short as they ran under this line (6–21 tokens); (3) only
            // then delete this line and p51's assertion of it. The other order puts every Qwen judge back to thinking
            // on every call, silently.
            //
            // `n-predict` is our own launch contract, not a workaround — see ChatMaxTokens.
            //
            // `ctx-size` is launch contract too — see ChatContextTokens. Unset, the child reserves its model's whole
            // TRAINING context (Qwen3-0.6B: 40,960 tokens, 4,480 MiB of KV for a 604 MiB model; +5,175 MiB of GPU
            // memory with the router, measured); 16,384 holds the measured worst prompt with a third to spare, and
            // took the same child to +2,472 MiB on the real binary (docs/self-managed-llm-runtime.md, 2026-09-24).
            // Chat sections ONLY: a reranker's window is its whole-pair contract (below) and an embedder takes its
            // own — neither was measured under any other. p51 pins all three halves.
            case GgufCapability.Completion:
                keys.Add(("reasoning", "off"));
                keys.Add(("n-predict", ChatMaxTokens.ToString()));
                keys.Add(("ctx-size", ChatContextTokens.ToString()));
                break;
            // `reranking` restricts it to /v1/rerank, and the pair must fit one batch — see RerankBatch. A row
            // that DECLARES a smaller window gets that instead (GgufCatalog.DeclaredWindow — the read
            // RerankInputCap and ChunkedScoreProvider fit the input to, so they cannot disagree). llama.cpp serves mMiniLMv2 512-token
            // slots whatever the preset asks; a preset claiming 4096 for it states a limit nothing honours.
            //
            // `device` — the device the reranker was MEASURED fastest on (RerankDeviceMeter), when it has a current
            // measurement; absent otherwise, and llama.cpp chooses. The router passes it to the child as `--device <id>`
            // (read back from the child's argv, b10549, 2026-09-26: `device = Vulkan1` → `--device Vulkan1`, and the child
            // logged `using device Vulkan1 (Intel(R) Arc(TM) Graphics)`). Rerankers ONLY: embedders and chat models were
            // never measured anywhere but on llama.cpp's own choice, so they keep it. p51 and p53 pin both halves.
            case GgufCapability.Reranking:
                var window = GgufCatalog.DeclaredWindow(model) ?? RerankBatch;
                keys.Add(("reranking", "true"));
                keys.Add(("ctx-size", window.ToString()));
                keys.Add(("batch-size", window.ToString()));
                keys.Add(("ubatch-size", window.ToString()));
                if (device is { Length: > 0 }) keys.Add(("device", device));
                break;
        }
        return keys;
    }

    /// <summary>The device each installed RERANKER runs on, by id. Measured now for any without a current measurement
    /// (<see cref="RerankDeviceMeter"/>, one reranker and one device at a time); for one WITH a current measurement that
    /// still has excluded devices with attempts left, those devices only are measured again and merged in
    /// (<see cref="RerankDeviceMeasurement.Retryable"/>); the rest read from the store. Needs the binary's build tag and a
    /// device list it ANSWERED (<see cref="LlamaServerState.DevicesListed"/>): without either there is no key to measure
    /// under, nothing is measured, and no reranker gets a device key — today's launch. A reranker whose measurement found no
    /// valid device gets none either, and neither does one with an excluded device of UNKNOWN speed still to be measured
    /// (<see cref="RerankDeviceMeasurement.Pinned"/>): one exclusion is often transient, and pinning the fastest device that
    /// DID answer would move the reranker off a GPU llama.cpp's own choice would have used (final review). One that timed
    /// out does not hold the pin back — its lower bound already proves it slower (re-review). Persisted as each finishes; one ended by Dispose is not; one that could not be saved
    /// is used for this start and kept in <see cref="_unsaved"/> for the readers. A throw measuring one model is logged and
    /// the next model measured; the caller contains anything else.</summary>
    private async Task<IReadOnlyDictionary<string, string>> MeasureRerankersAsync(LlamaServerState state,
        IReadOnlyList<string> models, CancellationToken ct, MeasurementSink? sink = null)
    {
        var chosen = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var rerankers = models.Where(m => ResourceProvisioner.GgufKind(m) == GgufCapability.Reranking).ToList();
        if (rerankers.Count == 0) return chosen;
        if (state.Executable is not { } exe || state.Version is not { } build || !state.DevicesListed)
        {
            _log.LogInformation(
                "rerank device measurement skipped: the llama-server binary did not answer {What}; rerankers launch where llama.cpp puts them",
                state.Version is null ? "--version" : "--list-devices");
            return chosen;
        }
        var routerPort = new Uri(BaseUrl).Port;
        bool Reserved(int port) => port == routerPort || (port >= PortBase && port < PortBase + PortSpan);
        var clock = Stopwatch.StartNew();
        var measured = new List<string>();
        foreach (var id in rerankers)
        {
            if (_disposed) break;
            try
            {
                var file = ResourceProvisioner.GgufFile(_platform.ResourcesPath, id);
                if (RerankDeviceKey.For(id, file, build, state.Devices) is not { } key) continue;
                // This process's unsaved measurement first — newer by construction — then the stored one.
                var m = Unsaved(id, key) ?? RerankDeviceStore.Current(_platform.ResourcesPath, key);
                // What is known already names the device FIRST, so a throw in the retry below cannot cost this start the
                // device key a valid stored result gives it (review, 2026-09-26) — only a PINNED one, though; while a
                // device of unknown speed is still to be measured llama.cpp chooses.
                if (m?.Pinned is { } known) chosen[id] = known.Device;
                var save = m is not null && _unsaved.ContainsKey(id);   // an earlier save failed: try it again
                if (m is null || m.Retryable.Count > 0)
                {
                    var taken = await _meter.MeasureAsync(exe, id, file!, key, m, Reserved, ct);
                    if (taken is null) break;   // Dispose ended it: nothing is saved, and nothing is started after it
                    m = taken;
                    measured.Add(id);
                    save = true;
                }
                if (save)
                {
                    try
                    {
                        RerankDeviceStore.Save(_platform.ResourcesPath, m);
                        _unsaved.TryRemove(id, out _);
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                    {
                        // Used for THIS start all the same, and shown as unsaved; the next start tries the save again.
                        _log.LogWarning(ex, "rerank device measurement for {Model} could not be saved", id);
                        _unsaved[id] = m;
                    }
                }
                if (m.Pinned is { } best) chosen[id] = best.Device;
                else chosen.Remove(id);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                _log.LogWarning(ex, "rerank device measurement for {Model} failed; it keeps the device it already had, if any", id);
            }
        }
        if (measured.Count > 0) sink?.Add(new RerankMeasurementReport(measured, clock.Elapsed));
        return chosen;
    }

    /// <summary>Drop the cached probe, and void any probe still in flight — see <see cref="_probeEpoch"/>.</summary>
    public void Invalidate() { lock (_gate) InvalidateLocked(); }

    /// <summary><see cref="Invalidate"/> for a caller already holding <see cref="_gate"/>, so a transition flag and
    /// the cache it fed are dropped in ONE step.</summary>
    private void InvalidateLocked() { _cached = null; _probeEpoch++; }

    public LlamaServerState? Cached { get { lock (_gate) return _cached; } }

    public bool? Gpu
    {
        get
        {
            if (Locate() is not { } exe || BinaryKey(exe) is not { } key) return null;
            lock (_gate)
                return _binaryFacts is { } f && f.Key == key && f.Devices is { } devices
                    ? LlamaServerState.GpuFrom(devices)
                    : null;
        }
    }

    public RerankDeviceLookup? RerankDevice(string modelId)
    {
        if (Locate() is not { } exe || BinaryKey(exe) is not { } binary) return null;
        string? build;
        IReadOnlyList<string>? devices;
        lock (_gate)
        {
            if (_binaryFacts is not { } f || f.Key != binary) return null;
            (build, devices) = (f.Version, f.Devices);
        }
        var key = RerankDeviceKey.For(modelId, ResourceProvisioner.GgufFile(_platform.ResourcesPath, modelId), build, devices);
        if (key is null) return null;
        // The unsaved one FIRST: it is newer than anything stored under this key by construction (a merged retry whose save
        // failed sits beside the older measurement it was merged from), and it is what the router was started with.
        if (Unsaved(modelId, key) is { } unsaved) return new RerankDeviceLookup(key, unsaved, Saved: false);
        return new RerankDeviceLookup(key, RerankDeviceStore.Current(_platform.ResourcesPath, key));
    }

    /// <summary>This process's unsaved measurement of <paramref name="modelId"/>, when it is under <paramref name="key"/>.</summary>
    private RerankDeviceMeasurement? Unsaved(string modelId, RerankDeviceKey key) =>
        _unsaved.TryGetValue(modelId, out var u) && key.Matches(u) ? u : null;

    public string? MeasuringNow => _meter.Now;


    /// <summary>Is anything accepting connections on our port, answered within a bounded time?
    ///
    /// <para>A raw TCP connect rather than a shorter <c>HttpClient</c> timeout, because the cost being
    /// bounded here IS the connect, and <c>HttpClient.Timeout</c> covers the whole request — it cannot cut
    /// a connect short. Doing it with a socket also keeps this out of the DI-configured client, so no other
    /// caller's timeouts change.</para>
    ///
    /// <para><b>This must stay a real check rather than "did we start one?"</b> A forced kill orphans a
    /// router that the next start ADOPTS instead of duplicating, so the answer cannot come from our own
    /// child-process handle: after a hard kill we hold nothing and there is still a server on that
    /// port.</para></summary>
    private async Task<bool> CanConnectAsync(CancellationToken ct)
    {
        // 120 ms. A loopback server answers in single-digit milliseconds, so this is still an order of
        // magnitude of headroom — and it is paid on EVERY 资源 open while the router is not running, which
        // is the common case. 300 ms was the first guess and then measured as the whole remaining cost of
        // that panel (0.31 s), so the number is now sized to what it actually waits for rather than to
        // being comfortably safe. The cost of being wrong is unchanged: a false negative says "not
        // started", which the panel can already show and which starting it corrects.
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMilliseconds(120));
        try
        {
            if (!Uri.TryCreate(BaseUrl, UriKind.Absolute, out var uri)) return false;
            using var tcp = new System.Net.Sockets.TcpClient();
            await tcp.ConnectAsync(uri.Host, uri.Port, timeout.Token);
            return tcp.Connected;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;   // the CALLER gave up — distinct from our own gate firing, and not our answer to give
        }
        catch
        {
            return false;
        }
    }

    /// <summary>What is on our port — the CHEAP half of a probe: one connect and one HTTP GET, no child processes.
    ///
    /// <para><b>THREE answers, because two of them used to be one.</b> REFUSED: nothing listens, so a router may
    /// be started. ANSWERING: a router replied to <c>/v1/models</c>, with its models. HELD: something ACCEPTED the
    /// connection and gave no usable answer — a timeout, a non-2xx reply, a body that is not the model list.
    /// A held port is not free: it belongs to a hung llama-server, another program, or a router of ours too busy
    /// to reply. Reading it as "not serving" made the app spawn a second router BESIDE it, which cannot bind the
    /// port (or, if llama-server's HTTP library shares it on Windows — unmeasured — would split requests between
    /// two routers without anyone knowing), and every sentence then named the wrong cause.</para>
    ///
    /// <para>Split from <see cref="ProbeAsync"/> because the startup poll used <c>ProbeAsync(refresh: true)</c>
    /// in a 40-iteration loop, and a full probe shells out to <c>--version</c> and <c>--list-devices</c> — up to
    /// 80 process spawns while waiting for a server to come up.</para></summary>
    private async Task<PortProbe> IsServingAsync(CancellationToken ct)
    {
        // A CLOSED loopback port is not free to ask about. Measured on 2026-08-22: a refused connect to
        // 127.0.0.1 costs 2.016 s on this platform — the OS retransmits before it gives up, and
        // HttpClient.Timeout does not bound the connect phase, so the 4 s below never came into it. That
        // two seconds was most of what the 记忆检索 panel spent loading, every visit, for a household with
        // no layer bound to llama.cpp — i.e. the default. A server we started is on loopback and answers in
        // single-digit milliseconds, so anything slower than this gate is not a slow server, it is no
        // server; failing the gate is the same answer as a refused GET, arrived at 10× sooner.
        if (!await CanConnectAsync(ct)) return PortProbe.Refused;

        try
        {
            using var http = _http.CreateClient();
            http.Timeout = TimeSpan.FromSeconds(4);
            using var res = await http.GetAsync($"{BaseUrl}/v1/models", ct);
            if (!res.IsSuccessStatusCode) return PortProbe.Held;
            using var doc = System.Text.Json.JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            // A JSON 200 with no `data` array is not a model list, so not a llama-server: HELD, not an empty router
            // to adopt.
            if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != System.Text.Json.JsonValueKind.Array)
                return PortProbe.Held;
            var models = data.EnumerateArray()
                .Select(e => e.TryGetProperty("id", out var id) ? id.GetString() : null)
                .Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).ToList();
            return new PortProbe(PortState.Answering, models);
        }
        // A probe that timed out is HELD — never an escaping cancellation. HttpClient's own 4 s timeout
        // arrives as a TaskCanceledException, so the filter used to be the exception's TYPE and let it through:
        // a router that accepted the connection and never answered (one dying from a restart, measured on the
        // real binary) turned the bind into a bare 500 and left llama.cpp stopped. Only the caller's TOKEN tells
        // its cancellation apart — the rule WarmCoreAsync and the reranker screen already follow.
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            _log.LogDebug("llama-server: /v1/models did not answer: {Msg}",
                ex is OperationCanceledException ? "no answer within 4 s" : ex.Message);
            return PortProbe.Held;
        }
    }

    private enum PortState { Refused, Answering, Held }

    /// <summary>One probe of our port — see <see cref="IsServingAsync"/>.</summary>
    private readonly record struct PortProbe(PortState State, IReadOnlyList<string> Models)
    {
        public static readonly PortProbe Refused = new(PortState.Refused, Array.Empty<string>());
        public static readonly PortProbe Held = new(PortState.Held, Array.Empty<string>());
        public bool Serving => State == PortState.Answering;
        public bool IsHeld => State == PortState.Held;
    }

    /// <summary>What to do about an ADOPTED router that does not list a model — ONE writer for the clause, because
    /// two surfaces say it: the refusal in <see cref="EnsureServesAsync"/> (a bind, and the startup warm step), and
    /// 资源's start button reporting a bound model it left cold. The start button once said 「重启服务」 here, which is
    /// true only of OUR router: a service restart ends ours (Dispose) and leaves an adopted one running, to be adopted
    /// again. 「再试」 is the next start or bind, either of which then spawns a router of ours that lists every file.</summary>
    internal const string NotOursRemedy =
        "这个 llama.cpp 进程不是应用这次启动的(可能是上次异常退出后留下的),应用不会替你结束它 —— "
        + "在任务管理器里结束 llama-server.exe 后再试,应用会重新启动它。";

    /// <summary>The sentence for a HELD port, which takes precedence over every other problem: nothing else can be
    /// fixed while it stands, and 「还没有下载」 beside it would send the household to download something that could
    /// not start anyway. Four cases, because the remedy differs. During OUR restart (<see cref="_restarting"/>) the
    /// holder is our own router, dying or starting: wait. During our own START (<see cref="_starting"/>) it is the
    /// router we are starting, which is not <see cref="_started"/> until it answers: wait. A router WE started and
    /// still hold is busy, and a service restart ends it (Dispose kills it). Anything else is not ours to end — the
    /// same rule, and the same remedy (任务管理器), as the refusal for an ADOPTED router in
    /// <see cref="EnsureServesAsync"/>.
    /// <para>The two 「稍等几秒」 sentences are true only WHILE their flag is set, which is why clearing a flag also
    /// drops the cache — and why a restart that gives up never passes this sentence on (<see cref="RestartBlocked"/>).</para></summary>
    private string HeldProblem()
    {
        var port = new Uri(BaseUrl).Port;
        bool ours, restarting, starting;
        lock (_gate) { ours = _started is { HasExited: false }; restarting = _restarting; starting = _starting; }
        return restarting
            ? "应用正在重启 llama.cpp,稍等几秒。"
            : starting
            ? "应用正在启动 llama.cpp,稍等几秒。"
            : ours
            ? $"应用启动的 llama.cpp 还在运行,但端口 {port} 上这次没有回应 —— 稍后再试;一直这样的话,请重启服务。"
            : $"llama.cpp 用的{HeldBy(port)}。应用不会在它旁边再启动一个,也不会替你结束它 —— 在任务管理器里"
              + "结束它后再试,应用会重新启动 llama.cpp;或者重启电脑。";
    }

    /// <summary>What holds a HELD port, as far as the app can tell — ONE writer, because two sentences say it: a held
    /// port that no router or transition of ours explains (<see cref="HeldProblem"/>), and a restart that found the port held after it
    /// stopped our router (<see cref="RestartBlocked"/>). "Not as llama.cpp answers" rather than "does not answer": a
    /// non-2xx or an HTML page IS an answer, just not a model list. And it names BOTH candidates, because the app
    /// cannot tell them apart: the holder after a restart may be a stranger that took the freed port, or our OLD router
    /// still dying, whose accept was too slow for the release check to see — which is also why
    /// <see cref="NotOursRemedy"/> ("not started by the app this time") cannot be said there.</summary>
    private static string HeldBy(int port) =>
        $"端口 {port} 被另一个进程占着:它接受连接,却没有像 llama.cpp 那样回答(可能是没有正常退出的 llama-server.exe,也可能是别的程序)";

    /// <summary>A restart's FINAL answer when, after our router stopped and its port was released, the re-probe found
    /// the port HELD. The probe's own sentence cannot be passed on: it ran while <see cref="_restarting"/> was set, so
    /// it said 「应用正在重启 llama.cpp,稍等几秒」 — as the bind's last word, from a restart that had given up with
    /// nothing of ours running. So: what happened, that llama.cpp is NOT running, and what to do — WAITING first, because
    /// the likeliest holder is our own old router still dying; then ending it; then a reboot, the one remedy that always
    /// works. NOT 「重启服务」: a service restart ends neither a stranger nor a router stuck in teardown (Kill's own wait
    /// already failed), so it would send the household round a restart for nothing — <see cref="NotOursRemedy"/>'s
    /// lesson. 「再选一次」 is a new bind, which finds the port free once the holder is gone and starts a router listing
    /// every model; the bind that got this answer saved nothing.</summary>
    private string RestartBlocked(string modelId) =>
        $"应用为了载入 {modelId} 停下了 llama.cpp,但没能启动新的:{HeldBy(new Uri(BaseUrl).Port)}。应用不会在它旁边再启动一个,"
        + "所以 llama.cpp 现在没有在运行 —— 稍等片刻再试一次;仍然这样的话,在任务管理器里结束它后再试,或者重启电脑。"
        + "这次的选择没有保存,端口空出来后在「记忆检索」里再选一次这个模型。";

    public async Task<LlamaServerState> ProbeAsync(bool refresh = false, CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (!refresh && _cached is not null && DateTimeOffset.UtcNow - _cachedAt < TimeSpan.FromSeconds(20))
                return _cached;
        }
        return await BuildAsync(withBinaryFacts: true, ct);
    }

    /// <summary>No cache of its own: everything it reads is already cheap, and a second clock over a
    /// 300 ms answer would only add a window in which the panel shows a server that has since stopped.</summary>
    public Task<LlamaServerState> LiveAsync(CancellationToken ct = default) =>
        BuildAsync(withBinaryFacts: false, ct);

    private async Task<LlamaServerState> BuildAsync(bool withBinaryFacts, CancellationToken ct)
    {
        // Noted BEFORE the first await — see _probeEpoch. The state is still returned to this caller either way.
        long epoch;
        lock (_gate) epoch = _probeEpoch;
        var exe = Locate();
        var (version, listed) = exe is null || !withBinaryFacts
            ? (null, (IReadOnlyList<string>?)null)
            : await BinaryFactsAsync(exe, ct);
        var devices = listed ?? Array.Empty<string>();

        var probe = await IsServingAsync(ct);
        var (serving, models) = (probe.Serving, probe.Models);
        bool ours;
        lock (_gate) ours = _started is { HasExited: false };

        var problem = probe.IsHeld ? HeldProblem()
            : exe is null
            ? "还没有下载 —— 在「资源 · Resources」面板下载「本机模型运行时 · llama.cpp」(约 35 MB)。"
            : LocalGgufIds().Count == 0
                ? "运行时已就绪,但还没有任何模型 —— 在「资源 · Resources」面板下载一个。"
                : null;

        var state = new LlamaServerState(
            BaseUrl, exe is not null, serving, version, exe,
            serving ? models : LocalGgufIds(),
            devices,
            // A Vulkan device the binary can actually see. Reported rather than guessed, unlike the
            // GpuLikely elsewhere in this codebase, because --list-devices answers it exactly.
            devices.Any(d => d.StartsWith("Vulkan", StringComparison.OrdinalIgnoreCase)),
            problem,
            probe.IsHeld,
            ours,
            DevicesListed: listed is not null);

        // Only the FULL state is cached: a Live one has empty Version/Devices by design, and letting it
        // populate this would serve 资源 a blank build number that looks like a failed install. And only if nothing
        // was invalidated while this probe was out: a start or restart that ended meanwhile retracted exactly the
        // 「稍等几秒」 this may carry.
        if (withBinaryFacts)
            lock (_gate)
            {
                if (epoch == _probeEpoch) { _cached = state; _cachedAt = DateTimeOffset.UtcNow; }
            }
        return state;
    }

    public async Task<bool> EnsureServingAsync(CancellationToken ct = default) => (await StartAsync(ct)).Ok;

    public async Task<RouterStart> StartAsync(CancellationToken ct = default)
    {
        var sink = new MeasurementSink();
        await _lifecycle.WaitAsync(ct);
        try { return new RouterStart((await EnsureServingCoreAsync(ct, sink)).Ok, sink.Report); }
        finally { _lifecycle.Release(); }
    }

    /// <summary>Where a measurement reports what it did, for the one call that asked (<see cref="StartAsync"/>, and
    /// <see cref="EnsureServesAsync"/>, which can start or restart the router twice in one call — so reports add up).</summary>
    private sealed class MeasurementSink
    {
        public RerankMeasurementReport? Report;

        public void Add(RerankMeasurementReport r) =>
            Report = Report is not { } had ? r
                : new RerankMeasurementReport(had.Models.Concat(r.Models).Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
                    had.Took + r.Took);
    }

    /// <summary>Probe, and spawn only if the port is silent. Callers hold <see cref="_lifecycle"/> — the public
    /// door takes it, and the restart in <see cref="EnsureServesAsync"/> calls this while holding it already.
    /// <para><c>Held</c> is the probe's sentence when the port is HELD, so a caller can pass the real cause on
    /// instead of 「没能启动」.</para></summary>
    private async Task<(bool Ok, string? Held)> EnsureServingCoreAsync(CancellationToken ct, MeasurementSink? sink = null)
    {
        if (_disposed) return (false, null);
        var state = await ProbeAsync(refresh: true, ct);
        // Something already answers. It might be ours from a previous start, or a household's own on this
        // port — either way we do not start a second one.
        if (state.Serving) return (true, null);
        // Something HOLDS the port and does not answer. Never spawn beside it — see IsServingAsync.
        if (state.Held)
        {
            _log.LogWarning("llama-server not started: port {Port} accepts connections but does not answer",
                new Uri(BaseUrl).Port);
            return (false, state.Problem);
        }
        return (await SpawnAsync(state, ct, sink), null);
    }

    /// <summary>Start a router on a port the probe found SILENT, and wait for it to answer. Every installed reranker
    /// without a current device measurement is measured FIRST (<see cref="MeasureRerankersAsync"/>), so the preset
    /// written next names the device each one is fastest on. Only here: this is the one path that starts a router of OURS
    /// — a start or a restart, both under <see cref="_lifecycle"/> — and never one we adopted, whose presets are not ours.</summary>
    private async Task<bool> SpawnAsync(LlamaServerState state, CancellationToken ct, MeasurementSink? sink = null)
    {
        if (state.Executable is null) return false;

        var models = LocalGgufIds();
        if (models.Count == 0)
        {
            _log.LogInformation("llama-server not started: no GGUF models in {Dir}", ModelsDir());
            return false;
        }

        // CONTAINED: the measurement is an optimisation of where a reranker runs, so nothing it throws may stop the router
        // it precedes (review, 2026-09-26) — the router then starts with no device keys, as before. Only the caller's
        // cancellation propagates.
        IReadOnlyDictionary<string, string> devices;
        try { devices = await MeasureRerankersAsync(state, models, ct, sink); }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            _log.LogWarning(ex, "rerank device measurement failed; the router starts with no device keys");
            devices = new Dictionary<string, string>();
        }
        // A shutdown that arrived during the measurement (Dispose aborted it) starts nothing after it.
        if (_disposed) return false;
        var presets = WritePresets(models, devices);
        var port = new Uri(BaseUrl).Port;
        var args = new List<string>
        {
            "--models-dir", ModelsDir(),
            "--models-preset", presets,
            "--models-max", MaxResidentModels.ToString(),
            "--host", "127.0.0.1",
            "--port", port.ToString(),
        };

        Process? proc = null;
        // Our own start window: until the new router answers it is not _started, and a panel probe that finds the
        // port held by it must not blame "another process". Cleared in the finally, with the cache — see _starting.
        lock (_gate) _starting = true;
        try
        {
            var psi = new ProcessStartInfo(state.Executable)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(state.Executable)!,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);

            proc = Process.Start(psi);
            if (proc is null) return false;
            // Drained, not read: a filled pipe blocks the child, and llama-server is chatty at its default
            // verbosity. Interesting lines go to our own log via the probe, not by parsing its stdout.
            proc.OutputDataReceived += (_, _) => { };
            proc.ErrorDataReceived += (_, _) => { };
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();

            _log.LogInformation("llama-server starting: {Exe} on port {Port} with {Count} model(s)",
                state.Executable, port, models.Count);

            // The ROUTER answers as soon as it is up; children come later, on demand. So this waits for the
            // router only, and warming is a separate, per-model step.
            // A DEADLINE, not a count of polls: one probe can take its whole 4 s (and reports "not serving" now,
            // rather than throwing into the catch below, which killed a router that was merely still starting),
            // so forty polls could have been three minutes. Twenty seconds of wall clock, however the polls fall.
            var waiting = Stopwatch.StartNew();
            while (waiting.Elapsed < StartTimeout)
            {
                if (proc.HasExited)
                {
                    _log.LogWarning("llama-server exited during startup with code {Code}", proc.ExitCode);
                    proc.Dispose();
                    return false;
                }
                // The CHEAP check — see IsServingAsync. Re-probing the binary here spawned two child
                // processes per iteration.
                if ((await IsServingAsync(ct)).Serving)
                {
                    // OURS only now, and only if the app is still running — a Dispose that arrived while this
                    // waited must not leave a router behind it.
                    lock (_gate)
                    {
                        if (!_disposed) { _started = proc; proc = null; }
                    }
                    if (proc is not null) { Kill(proc); return false; }
                    return true;   // the finally drops the cached "not serving"
                }
                await Task.Delay(500, ct);
            }
            _log.LogWarning("llama-server did not answer on {Url} within {Seconds}s", BaseUrl, StartTimeout.TotalSeconds);
            // Never answered, so never ours — and not left running either, holding the port and the GPU.
            Kill(proc);
            return false;
        }
        catch (Exception ex)
        {
            _log.LogWarning("starting llama-server failed: {Msg}", ex.Message);
            if (proc is not null) Kill(proc);
            return false;
        }
        // EVERY exit — answered, never answered, exited, disposed, thrown, cancelled. The flag goes with the cache in
        // one step: a 「应用正在启动」 cached during the start is false once it has ended either way.
        finally { lock (_gate) { _starting = false; InvalidateLocked(); } }
    }

    /// <summary>
    /// The router, answering and knowing <paramref name="modelId"/>.
    ///
    /// <para><b>Why "answering" is not enough — measured 2026-09-23 against the real llama-server
    /// (<c>docs/self-managed-llm-runtime.md</c>).</b> The router reads <c>--models-dir</c> and its preset file
    /// ONCE, at start. A GGUF dropped in afterwards is not listed by <c>/v1/models</c>, and a request naming it
    /// gets <c>400 model '…' not found</c> — before AND after the preset file is rewritten, until the router is
    /// restarted.</para>
    ///
    /// <para><b>Restart OURS, only when it provably lacks the model, and only when a restart loses
    /// nothing.</b> Three conditions, each for a failure found in review:</para>
    /// <list type="bullet">
    /// <item><b>Provably lacks it</b> — the probe ANSWERED and did not list it. A probe that failed (the
    /// 120 ms connect gate, the 4 s <c>/v1/models</c>) says nothing about the model, and reading it as "not
    /// listed" restarted a healthy router on two slow probes in a row.</item>
    /// <item><b>Ours</b> — a router we adopted (an orphan of an earlier run, or a household's own) is not ours
    /// to kill, and an app restart would only adopt it again; the household is told which process to end.</item>
    /// <item><b>Loses nothing</b> — <see cref="ILlamaRestartPolicy"/>. While the router is down every call to
    /// it fails, and a fact written then is stored WITHOUT its vector — keyword-only until the next start's back-fill
    /// re-indexes it (the fact index leaves such a write unindexed) — or, under a chat judge, its subject tags,
    /// permanently and silently (the engine catches a failed write-time embed; annotation fails open). So it is
    /// refused while 语义 embeds through this router or 判断 annotates through it (a chat model, switched on) —
    /// which covers every reindex that reaches llama.cpp — with a sentence saying so; and, saying only that a
    /// service restart is owed, while such a binding is saved but not yet running. What remains is a reranker
    /// judge's verification, or a chat judge switched off; verification fails open.</item>
    /// </list>
    /// <para><b>The restart waits for the old router to let go of its port</b> before it spawns the new one
    /// (<see cref="WaitForPortReleaseAsync"/>). A bind once came back 500 with llama.cpp left stopped: the probe's
    /// timeout escaped, most likely because the kill's 5 s wait ran out and the dying router's socket still
    /// accepted the re-probe (<c>docs/self-managed-llm-runtime.md</c> §2026-09-23). A port still HELD after that
    /// wait ends the restart with <see cref="RestartBlocked"/> — never with the re-probe's own 「稍等几秒」.</para>
    /// <para>After a restart the requested model is warmed HERE, before returning, so the caller's own screen
    /// or proof is not a second concurrent load; what was warm before is then re-warmed ONE AT A TIME, off the
    /// request path — llama.cpp loads concurrently badly (its #20137), and <c>--models-max</c> is 2.</para>
    /// </summary>
    public async Task<string?> EnsureServesAsync(string modelId, CancellationToken ct = default)
    {
        // What a start or restart here measures goes to the caller's capture, if it opened one — a bind does
        // (RerankMeasurementCapture), so its toast can say where the time went, on a refusal too.
        var sink = new MeasurementSink();
        await _lifecycle.WaitAsync(ct);
        try
        {
            var start = await EnsureServingCoreAsync(ct, sink);
            if (!start.Ok) return start.Held ?? "llama.cpp 没能启动 —— 请看「日志」里的原因。";
            var live = await IsServingAsync(ct);
            if (!live.Serving) return "llama.cpp 正在运行,但这次没有及时回应 —— 稍后再试。";
            if (live.Models.Contains(modelId, StringComparer.OrdinalIgnoreCase)) return null;

            if (!LocalGgufIds().Contains(modelId, StringComparer.OrdinalIgnoreCase))
                return $"{modelId} 不在模型目录里 —— 在「资源 · Resources」面板下载它。";

            var unknown = $"{modelId} 是在 llama.cpp 启动之后才下载的,正在运行的 llama.cpp 要重启才会载入它。";
            bool ours;
            lock (_gate) ours = _started is { HasExited: false };
            if (!ours) return unknown + NotOursRemedy;
            if (_restartPolicy?.WhyNotNow() is { } notNow) return unknown + notNow;

            // Re-warm only OUR models. The real router also lists what sits in the machine's llama.cpp/Hugging
            // Face cache (seen on a real restart: four cached chat models beside ours), and a model the household
            // loaded for something else is not ours to load again.
            var local = LocalGgufIds();
            var warm = (await LoadedModelsAsync(ct))
                .Where(m => local.Contains(m, StringComparer.OrdinalIgnoreCase)).ToList();
            _log.LogInformation(
                "llama-server: restarting our router — {Model} was added after it started; re-warming {Warm}",
                modelId, string.Join(", ", warm));
            // Our own restart window: a panel probe outside the lock must not blame "another process" for it.
            (bool Ok, string? Held) restarted;
            lock (_gate) _restarting = true;
            try
            {
                StopOursCore();
                // No `unknown` prefix here: it says the running llama.cpp must be restarted, and by now none is running.
                if (!await WaitForPortReleaseAsync(ct))
                    return $"应用为了载入 {modelId} 停下了 llama.cpp,但旧的 llama-server 进程 {PortReleaseTimeout.TotalSeconds:0} 秒内"
                         + $"没有让出端口 {new Uri(BaseUrl).Port},所以这次没有重新启动它,llama.cpp 现在没有在运行 —— 稍等片刻再试一次;"
                         + "如果仍然这样,在任务管理器里结束 llama-server.exe 后重启服务。"
                         + LlamaRestartPolicy.ReselectAfterRestart;
                // Only now, with the port FREE, is it probed — so a router we just killed is never reported as a
                // stranger holding the port; that case is the sentence above.
                restarted = await EnsureServingCoreAsync(ct, sink);
            }
            // Cleared on EVERY exit, WITH the cached probe: any 「应用正在重启」 computed in the window — by a panel probe,
            // or by the re-probe above — is false once the restart has returned, whether the new router is ours (then
            // HeldProblem's "ours" case applies) or the restart gave up with nothing running. Left cached, the panel
            // repeated it for 20 s.
            finally { lock (_gate) { _restarting = false; InvalidateLocked(); } }
            // HELD even though the port was released: something took it, or our old router accepted too slowly for the
            // release check to see it. `restarted.Held` is the re-probe's sentence, computed while _restarting was set —
            // 「稍等几秒」 from a restart that has given up — so it is replaced, never passed on.
            if (!restarted.Ok)
                return restarted.Held is not null
                    ? RestartBlocked(modelId)
                    : "llama.cpp 重启后没能启动 —— 请看「日志」里的原因。";
            live = await IsServingAsync(ct);
            if (!live.Models.Contains(modelId, StringComparer.OrdinalIgnoreCase))
                return $"llama.cpp 重启后仍然没有列出 {modelId} —— 请看「日志」里的原因。";

            await WarmCoreAsync(modelId, ResourceProvisioner.GgufKind(modelId), ct);
            var again = warm
                .Where(m => !string.Equals(m, modelId, StringComparison.OrdinalIgnoreCase))
                .Take(MaxResidentModels - 1)
                .ToList();
            if (again.Count > 0)
                _ = Task.Run(async () =>
                {
                    foreach (var m in again) await WarmAsync(m, ResourceProvisioner.GgufKind(m), CancellationToken.None);
                });
            return null;
        }
        finally
        {
            _lifecycle.Release();
            if (sink.Report is { } ran) RerankMeasurementCapture.Current?.Add(ran);
        }
    }

    /// <summary>The models the router currently holds LOADED — <c>status.value == "loaded"</c> in its
    /// <c>/v1/models</c>. Empty when it says nothing about status (an older build, or not our router).</summary>
    private async Task<IReadOnlyList<string>> LoadedModelsAsync(CancellationToken ct)
    {
        try
        {
            using var http = _http.CreateClient();
            http.Timeout = TimeSpan.FromSeconds(4);
            using var doc = System.Text.Json.JsonDocument.Parse(await http.GetStringAsync($"{BaseUrl}/v1/models", ct));
            if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != System.Text.Json.JsonValueKind.Array)
                return Array.Empty<string>();
            return data.EnumerateArray()
                .Where(e => e.TryGetProperty("status", out var s) && s.ValueKind == System.Text.Json.JsonValueKind.Object
                    && s.TryGetProperty("value", out var v) && v.ValueKind == System.Text.Json.JsonValueKind.String
                    && v.GetString() == "loaded"
                    && e.TryGetProperty("id", out var id) && id.ValueKind == System.Text.Json.JsonValueKind.String)
                .Select(e => e.GetProperty("id").GetString()!)
                .ToList();
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            _log.LogDebug("llama-server: reading loaded models failed: {Msg}", ex.Message);
            return Array.Empty<string>();
        }
    }

    private static readonly TimeSpan WarmTimeout = TimeSpan.FromMinutes(3);

    public async Task<bool> WarmAsync(string modelId, GgufCapability kind, CancellationToken ct = default)
    {
        if (await EnsureServesAsync(modelId, ct) is { } why)
        {
            _log.LogWarning("warming {Model} skipped: {Why}", modelId, why);
            return false;
        }
        return await WarmCoreAsync(modelId, kind, ct);
    }

    /// <summary>The warm request itself, against a router already known to list the model.</summary>
    private async Task<bool> WarmCoreAsync(string modelId, GgufCapability kind, CancellationToken ct)
    {
        try
        {
            using var http = _http.CreateClient();
            // Generous, because this is the call that PAYS the load — measured at 17.3 s for a 1B q4, and a
            // larger judge will be worse. Timing out here would leave the child loading anyway, so the only
            // thing a short timeout buys is a wrong answer.
            http.Timeout = WarmTimeout;
            // THREE call shapes, because each preset restricts its child to ONE API: an embedder answers only
            // /v1/embeddings, a reranker only /v1/rerank, and a judge the chat route.
            var (path, body) = kind switch
            {
                GgufCapability.Embedding => ("/v1/embeddings",
                    $"{{\"model\":\"{modelId}\",\"input\":[\"warm\"]}}"),
                GgufCapability.Reranking => ("/v1/rerank",
                    $"{{\"model\":\"{modelId}\",\"query\":\"warm\",\"documents\":[\"warm\"],\"top_n\":1}}"),
                _ => ("/v1/chat/completions",
                    $"{{\"model\":\"{modelId}\",\"messages\":[{{\"role\":\"user\",\"content\":\"hi\"}}],\"max_tokens\":1}}"),
            };
            var started = Stopwatch.StartNew();
            using var content = new StringContent(body, new UTF8Encoding(false), "application/json");
            using var res = await http.PostAsync($"{BaseUrl}{path}", content, ct);
            if (!res.IsSuccessStatusCode)
            {
                _log.LogWarning("warming {Model} failed: HTTP {Code}", modelId, (int)res.StatusCode);
                return false;
            }
            _log.LogInformation("llama-server model {Model} warm in {Ms}ms", modelId, started.ElapsedMilliseconds);
            return true;
        }
        // The CALLER's cancellation is told apart by its token, never by the exception's type: HttpClient's own
        // timeout arrives as a TaskCanceledException too, and letting that escape turned a slow model load into
        // a bare 500 on the binding endpoint instead of the refusal sentence its caller writes.
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            _log.LogWarning("warming {Model} failed: {Msg}", modelId,
                ex is OperationCanceledException ? $"no answer within {WarmTimeout}" : ex.Message);
            return false;
        }
    }

    /// <summary>The build tag and the device list, which are properties of the BINARY and not of the
    /// running server — so they are memoized on the file's identity rather than on a clock.
    ///
    /// <para><b>Why this is not a micro-optimisation.</b> Both answers cost a child process, and this
    /// binary is not a cheap one to start: measured on 2026-08-22, <c>--version</c> takes 1811 ms and
    /// <c>--list-devices</c> 1592 ms, because llama-server loads its Vulkan backends before printing
    /// anything. <see cref="ProbeAsync"/> ran both, so a cold 记忆检索 panel spent ~3.4 s of its ~5 s
    /// waiting for two strings that had not changed since the file was downloaded. The 20-second cache did
    /// not help: it is exactly the wrong granularity here, short enough that every real visit to the panel
    /// missed it and long enough to look like it was doing something.</para>
    ///
    /// <para>Keyed on path + last-write-time + length, so the provisioner replacing the exe invalidates
    /// this by itself — no <see cref="Invalidate"/> call to remember, and therefore none to forget. That
    /// matters because a stale BUILD number is the one thing that would make an update look like it had not
    /// applied.</para>
    ///
    /// <para>The two spawns also run concurrently now, so even a genuine miss costs one of them rather than
    /// both. A duplicate miss under load does the work twice and stores the same answer twice, which is
    /// why this takes no lock across the await — the alternative is holding one while spawning a process.</para></summary>
    private async Task<(string? Version, IReadOnlyList<string>? Devices)> BinaryFactsAsync(
        string exe, CancellationToken ct)
    {
        // Cannot identify the file, so cannot safely reuse an answer about it. Ask.
        var key = BinaryKey(exe) ?? Guid.NewGuid().ToString();

        lock (_gate)
        {
            if (_binaryFacts is { } f && f.Key == key) return (f.Version, f.Devices);
        }

        var devicesTask = DevicesAsync(exe, ct);
        var versionTask = VersionAsync(exe, ct);
        var devices = await devicesTask;
        var version = await versionTask;

        // A device list that did not answer is not remembered: it is "unknown", and a transient failure (a 15 s timeout
        // under load) memoized on the file's identity would stay unknown until the binary changed.
        if (devices is not null) lock (_gate) { _binaryFacts = (key, version, devices); }
        return (version, devices);
    }

    /// <summary>The identity the binary facts are memoized on — path, last write, length — or null when the file cannot
    /// be read. One writer, for the memo and for <see cref="Gpu"/>'s read of it.</summary>
    private static string? BinaryKey(string exe)
    {
        try
        {
            var fi = new FileInfo(exe);
            return $"{exe}|{fi.LastWriteTimeUtc.Ticks}|{fi.Length}";
        }
        catch
        {
            return null;
        }
    }

    private async Task<string?> VersionAsync(string exe, CancellationToken ct)
    {
        var text = await RunAsync(exe, "--version", ct);
        // "version: 0.1.2-dev (build 10549, commit b2e5e9b28)" — the BUILD is the useful part, since that
        // is what the release is tagged with and what our checksum is pinned to.
        var m = System.Text.RegularExpressions.Regex.Match(text ?? "", @"build (\d+)");
        return m.Success ? $"b{m.Groups[1].Value}" : null;
    }

    /// <summary>What <c>--list-devices</c> printed, less its header — or NULL when it did not answer with that header (it
    /// failed, timed out, or printed something else), because an empty list must mean "no device" and nothing else
    /// (<see cref="LlamaServerState.Gpu"/>). The "(none)" line b10549 prints when it sees no device is not a device.</summary>
    private async Task<IReadOnlyList<string>?> DevicesAsync(string exe, CancellationToken ct)
    {
        var text = await RunAsync(exe, "--list-devices", ct);
        if (string.IsNullOrWhiteSpace(text)) return null;
        var raw = text.Replace("\r", "").Split('\n');
        var header = Array.FindIndex(raw, l => l.TrimStart().StartsWith("Available devices", StringComparison.OrdinalIgnoreCase));
        if (header < 0) return null;
        // Only the INDENTED lines right under the header are devices. The output is stdout and stderr together, and
        // anything else llama.cpp logs lands there too: with LLAMA_ARG_LOG_VERBOSITY=4 in the environment (found
        // 2026-09-26) its stderr carries "load_backend: loaded … backend" lines, which a take-every-line reading turned
        // into three "devices" — and, since the device list keys the reranker device measurement, into a re-measure on
        // devices that do not exist.
        return raw.Skip(header + 1)
            .TakeWhile(l => l.Length > 0 && char.IsWhiteSpace(l[0]))
            .Select(l => l.Trim())
            .Where(l => l.Length > 0 && l != "(none)")
            .ToList();
    }

    private async Task<string?> RunAsync(string exe, string arg, CancellationToken ct)
    {
        Process? p = null;
        try
        {
            var psi = new ProcessStartInfo(exe)
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(exe)!,
            };
            psi.ArgumentList.Add(arg);
            p = Process.Start(psi);
            if (p is null) return null;
            // Both streams: llama-server writes its banner to stderr on some builds and stdout on others.
            var outT = p.StandardOutput.ReadToEndAsync(ct);
            var errT = p.StandardError.ReadToEndAsync(ct);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            await p.WaitForExitAsync(timeout.Token);
            return (await outT) + "\n" + (await errT);
        }
        // Our own 15 s timeout is "no answer", not the caller's cancellation — told apart by the caller's TOKEN,
        // as in IsServingAsync. Filtering on the type let it escape, out of a probe, as a 500.
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            _log.LogDebug("llama-server {Arg} failed: {Msg}", arg,
                ex is OperationCanceledException ? "no answer within 15 s" : ex.Message);
            return null;
        }
        finally
        {
            // A child that did not finish — timed out, or its caller gave up — is not left running.
            if (p is not null)
            {
                try { if (!p.HasExited) p.Kill(entireProcessTree: true); } catch { /* already gone */ }
                p.Dispose();
            }
        }
    }

    /// <summary>Kill the router we started — and its children, which is the part that matters.
    ///
    /// <para>Windows does not kill a child when its parent exits, so without this an app restart leaves a
    /// router and one child per loaded model holding GPU memory, invisible to the household and to us. It
    /// is the same reason the claude CLI is killed with <c>entireProcessTree: true</c>.</para>
    ///
    /// <para><b>Only if WE started it.</b> <c>_started</c> is null when something was already answering on
    /// the port — a household's own llama-server, or ours surviving from a previous run — and killing a
    /// process we did not start is not ours to do.</para>
    ///
    /// <para><b>A FORCED kill still orphans it, and that is a stated limit rather than a hidden one.</b>
    /// Dispose runs on graceful shutdown; <c>Stop-Process -Force</c> or a crash skips it, and only a Windows
    /// Job Object would cover that. What makes the gap tolerable is measured: a surviving router is ADOPTED
    /// on the next start, not duplicated — <see cref="EnsureServingAsync"/> finds the port answering and
    /// returns without spawning anything, verified 2026-08-22 (two processes before and after a restart, not
    /// four). So the failure mode is an idle router holding VRAM until the app comes back or the machine
    /// reboots, not a pile of them.</para>
    ///
    /// <para><b>Disposed FIRST, then the lock.</b> The flag is set before the lifecycle lock is taken —
    /// bounded, because a shutdown must not hang on a start that is still polling — so a restart or a
    /// background re-warm already in flight finds the flag and cannot spawn a router after this returns.</para></summary>
    public void Dispose()
    {
        _disposed = true;
        // A reranker device measurement runs UNDER the lifecycle lock and can hold it for minutes; its child is killed here,
        // before the wait, so a shutdown during one leaves no llama-server behind (RerankDeviceMeter).
        _meter.Abort();
        var held = _lifecycle.Wait(TimeSpan.FromSeconds(30));
        try { StopOursCore(); }
        finally { if (held) _lifecycle.Release(); }
    }

    /// <summary>Stop the router WE started, children and all; a no-op for one we adopted. Callers hold
    /// <see cref="_lifecycle"/> (Dispose, and the restart in <see cref="EnsureServesAsync"/>), which is why the
    /// live state is invalidated here too: a cached "serving" must not outlive the process it describes.</summary>
    private void StopOursCore()
    {
        Process? proc;
        lock (_gate) { proc = _started; _started = null; }
        if (proc is not null) Kill(proc);
        Invalidate();
    }

    /// <summary>After <see cref="StopOursCore"/> on a restart: poll until nothing accepts on our port, at most
    /// <see cref="PortReleaseTimeout"/>. False when it never freed — the caller then says so instead of
    /// spawning a router that cannot bind, or probing one that is dying.
    ///
    /// <para><b>Why the kill is not enough.</b> <see cref="Kill"/> waits 5 s for the process and carries on
    /// either way. A router that has not exited may still hold its listening socket, which ACCEPTS a connection
    /// and never answers — the likely reading of a bind that, on the real binary, waited 5 s + 4 s and returned
    /// 500 with no router left running, before a probe timeout read as "not serving". Normally the port is free
    /// by the time the kill returns (ten restarts on the real binary: never waited, 0.8–2.7 s after the decision
    /// to restart).</para></summary>
    private async Task<bool> WaitForPortReleaseAsync(CancellationToken ct)
    {
        var waited = Stopwatch.StartNew();
        var polls = 0;
        while (await CanConnectAsync(ct))
        {
            if (waited.Elapsed >= PortReleaseTimeout)
            {
                _log.LogWarning("llama-server: port {Port} still accepted connections {Ms}ms after our router was stopped",
                    new Uri(BaseUrl).Port, waited.ElapsedMilliseconds);
                return false;
            }
            polls++;
            await Task.Delay(200, ct);
        }
        _log.LogInformation("llama-server: port {Port} free {Ms}ms after the stop ({Polls} poll(s) waited)",
            new Uri(BaseUrl).Port, waited.ElapsedMilliseconds, polls);
        return true;
    }

    /// <summary>Kill a router process tree and wait briefly for it — the children hold GPU memory.</summary>
    private void Kill(Process proc)
    {
        try { KillProcessTree(proc, _log, "llama-server"); }
        finally { proc.Dispose(); }
    }

    /// <summary>Kill a llama-server process tree and wait up to 5 s for it, saying so when it outlives that — ONE writer
    /// for the router's stop and the device measurement's children (<see cref="RerankDeviceMeter"/>). Does not dispose:
    /// the caller owns the handle.</summary>
    internal static void KillProcessTree(Process proc, ILogger log, string what)
    {
        try
        {
            if (!proc.HasExited)
            {
                proc.Kill(entireProcessTree: true);
                // Said, because the caller carries on regardless: a router that outlives this may still hold
                // the port, which is what WaitForPortReleaseAsync then waits out.
                if (!proc.WaitForExit(5000))
                    log.LogWarning("{What} (pid {Pid}) had not exited 5 s after it was killed", what, proc.Id);
            }
        }
        catch (Exception ex) { log.LogDebug("stopping {What}: {Msg}", what, ex.Message); }
    }
}
