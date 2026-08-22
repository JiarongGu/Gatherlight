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
public sealed record LlamaServerState(
    string BaseUrl,
    bool Installed,
    bool Serving,
    string? Version,
    string? Executable,
    IReadOnlyList<string> Models,
    IReadOnlyList<string> Devices,
    bool GpuLikely,
    string? Problem);

public interface ILlamaServerRuntime
{
    /// <summary>Where the router listens. Loopback, always — see <see cref="LlamaServerRuntime"/>.</summary>
    string BaseUrl { get; }

    /// <summary>The provisioned <c>llama-server.exe</c>, or null when 资源 has not fetched it.</summary>
    string? Locate();

    /// <summary>The FULL state, including the build tag and the device list — both of which cost a child
    /// process on a memo miss. For 资源, which displays them.</summary>
    Task<LlamaServerState> ProbeAsync(bool refresh = false, CancellationToken ct = default);

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

    /// <summary>Force a model to load NOW, so the first real request does not pay for it. Returns false if
    /// it could not be loaded.</summary>
    Task<bool> WarmAsync(string modelId, bool isEmbedding, CancellationToken ct = default);

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
/// <see cref="ResourceProvisioner.IsEmbeddingGguf"/> — exact for what we provision, a stated name
/// heuristic for a GGUF the household dropped in themselves, and ONE writer either way.</para>
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

    private readonly IPlatformContext _platform;
    private readonly ILogger<LlamaServerRuntime> _log;
    private readonly IHttpClientFactory _http;
    private readonly object _gate = new();
    private LlamaServerState? _cached;
    private DateTimeOffset _cachedAt;
    // Memoized facts about the BINARY — see BinaryFactsAsync. Deliberately not cleared by Invalidate():
    // that exists for the live state, and the file has not changed just because the server was restarted.
    private (string Key, string? Version, IReadOnlyList<string> Devices)? _binaryFacts;
    private Process? _started;

    public LlamaServerRuntime(IPlatformContext platform, IHttpClientFactory http,
        ILogger<LlamaServerRuntime> log)
    {
        _platform = platform;
        _http = http;
        _log = log;
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

    /// <summary>Which models are EMBEDDERS — delegated, never re-derived. See
    /// <see cref="ResourceProvisioner.IsEmbeddingGguf"/> for why this has exactly one writer.</summary>
    private static bool IsEmbeddingModel(string modelId) =>
        ResourceProvisioner.IsEmbeddingGguf(modelId);

    /// <summary>Write the router's preset file. Regenerated on every start rather than kept, because it is
    /// derived state: the models on disk are the truth, and a stale section naming a deleted GGUF is a
    /// child that fails to spawn.</summary>
    private string WritePresets(IReadOnlyList<string> models)
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
            sb.AppendLine($"n-gpu-layers = {GpuLayers}");
            // `embeddings` RESTRICTS a child to embedding-only. Right for an embedder, fatal for a judge.
            if (IsEmbeddingModel(m)) sb.AppendLine("embeddings = true");
        }
        File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false));
        return path;
    }

    public void Invalidate() { lock (_gate) _cached = null; }

    /// <summary>Is the router answering? The CHEAP half of a probe — one HTTP GET, no child processes.
    ///
    /// <para>Split out because the startup poll used <c>ProbeAsync(refresh: true)</c> in a 40-iteration
    /// loop, and a full probe shells out to <c>--version</c> and <c>--list-devices</c>. That was up to 80
    /// process spawns while waiting 20 s for a server to come up — wasteful, and slow enough to make the
    /// wait it was measuring longer than the thing it was waiting for.</para></summary>
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
        // 300 ms is generous for loopback by two orders of magnitude, and it is the whole cost of being
        // wrong: a false negative just means the panel says "not started", which is a state it can
        // already show and which starting it corrects.
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMilliseconds(300));
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

    private async Task<(bool Serving, IReadOnlyList<string> Models)> IsServingAsync(CancellationToken ct)
    {
        // A CLOSED loopback port is not free to ask about. Measured on 2026-08-22: a refused connect to
        // 127.0.0.1 costs 2.016 s on this platform — the OS retransmits before it gives up, and
        // HttpClient.Timeout does not bound the connect phase, so the 4 s below never came into it. That
        // two seconds was most of what the 记忆检索 panel spent loading, every visit, for a household with
        // no layer bound to llama.cpp — i.e. the default. A server we started is on loopback and answers in
        // single-digit milliseconds, so anything slower than this gate is not a slow server, it is no
        // server; failing the gate is the same answer as a refused GET, arrived at 10× sooner.
        if (!await CanConnectAsync(ct)) return (false, Array.Empty<string>());

        try
        {
            using var http = _http.CreateClient();
            http.Timeout = TimeSpan.FromSeconds(4);
            using var res = await http.GetAsync($"{BaseUrl}/v1/models", ct);
            if (!res.IsSuccessStatusCode) return (false, Array.Empty<string>());
            using var doc = System.Text.Json.JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            var models = doc.RootElement.TryGetProperty("data", out var data)
                ? data.EnumerateArray()
                    .Select(e => e.TryGetProperty("id", out var id) ? id.GetString() : null)
                    .Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).ToList()
                : (IReadOnlyList<string>)Array.Empty<string>();
            return (true, models);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return (false, Array.Empty<string>());
        }
    }

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
        var exe = Locate();
        var (version, devices) = exe is null || !withBinaryFacts
            ? (null, (IReadOnlyList<string>)Array.Empty<string>())
            : await BinaryFactsAsync(exe, ct);

        var (serving, models) = await IsServingAsync(ct);

        var problem = exe is null
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
            problem);

        // Only the FULL state is cached: a Live one has empty Version/Devices by design, and letting it
        // populate this would serve 资源 a blank build number that looks like a failed install.
        if (withBinaryFacts) lock (_gate) { _cached = state; _cachedAt = DateTimeOffset.UtcNow; }
        return state;
    }

    public async Task<bool> EnsureServingAsync(CancellationToken ct = default)
    {
        var state = await ProbeAsync(refresh: true, ct);
        // Something already answers. It might be ours from a previous start, or a household's own on this
        // port — either way we do not start a second one, exactly as the Ollama arm does not.
        if (state.Serving) return true;
        if (state.Executable is null) return false;

        var models = LocalGgufIds();
        if (models.Count == 0)
        {
            _log.LogInformation("llama-server not started: no GGUF models in {Dir}", ModelsDir());
            return false;
        }

        var presets = WritePresets(models);
        var port = new Uri(BaseUrl).Port;
        var args = new List<string>
        {
            "--models-dir", ModelsDir(),
            "--models-preset", presets,
            "--models-max", MaxResidentModels.ToString(),
            "--host", "127.0.0.1",
            "--port", port.ToString(),
        };

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

            var proc = Process.Start(psi);
            if (proc is null) return false;
            lock (_gate) _started = proc;
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
            for (var i = 0; i < 40; i++)
            {
                if (proc.HasExited)
                {
                    _log.LogWarning("llama-server exited during startup with code {Code}", proc.ExitCode);
                    return false;
                }
                // The CHEAP check — see IsServingAsync. Re-probing the binary here spawned two child
                // processes per iteration.
                if ((await IsServingAsync(ct)).Serving) { Invalidate(); return true; }
                await Task.Delay(500, ct);
            }
            _log.LogWarning("llama-server did not answer on {Url} within 20s", BaseUrl);
            return false;
        }
        catch (Exception ex)
        {
            _log.LogWarning("starting llama-server failed: {Msg}", ex.Message);
            return false;
        }
    }

    public async Task<bool> WarmAsync(string modelId, bool isEmbedding, CancellationToken ct = default)
    {
        if (!await EnsureServingAsync(ct)) return false;
        try
        {
            using var http = _http.CreateClient();
            // Generous, because this is the call that PAYS the load — measured at 17.3 s for a 1B q4, and a
            // larger judge will be worse. Timing out here would leave the child loading anyway, so the only
            // thing a short timeout buys is a wrong answer.
            http.Timeout = TimeSpan.FromMinutes(3);
            var (path, body) = isEmbedding
                ? ("/v1/embeddings",
                   $"{{\"model\":\"{modelId}\",\"input\":[\"warm\"]}}")
                : ("/v1/chat/completions",
                   $"{{\"model\":\"{modelId}\",\"messages\":[{{\"role\":\"user\",\"content\":\"hi\"}}],\"max_tokens\":1}}");
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
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning("warming {Model} failed: {Msg}", modelId, ex.Message);
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
    private async Task<(string? Version, IReadOnlyList<string> Devices)> BinaryFactsAsync(
        string exe, CancellationToken ct)
    {
        string key;
        try
        {
            var fi = new FileInfo(exe);
            key = $"{exe}|{fi.LastWriteTimeUtc.Ticks}|{fi.Length}";
        }
        catch
        {
            // Cannot identify the file, so cannot safely reuse an answer about it. Ask.
            key = Guid.NewGuid().ToString();
        }

        lock (_gate)
        {
            if (_binaryFacts is { } f && f.Key == key) return (f.Version, f.Devices);
        }

        var devicesTask = DevicesAsync(exe, ct);
        var versionTask = VersionAsync(exe, ct);
        var devices = await devicesTask;
        var version = await versionTask;

        lock (_gate) { _binaryFacts = (key, version, devices); }
        return (version, devices);
    }

    private async Task<string?> VersionAsync(string exe, CancellationToken ct)
    {
        var text = await RunAsync(exe, "--version", ct);
        // "version: 0.1.2-dev (build 10549, commit b2e5e9b28)" — the BUILD is the useful part, since that
        // is what the release is tagged with and what our checksum is pinned to.
        var m = System.Text.RegularExpressions.Regex.Match(text ?? "", @"build (\d+)");
        return m.Success ? $"b{m.Groups[1].Value}" : null;
    }

    private async Task<IReadOnlyList<string>> DevicesAsync(string exe, CancellationToken ct)
    {
        var text = await RunAsync(exe, "--list-devices", ct);
        if (string.IsNullOrWhiteSpace(text)) return Array.Empty<string>();
        return text.Split('\n')
            .Select(l => l.Trim())
            .Where(l => l.Length > 0 && !l.StartsWith("Available devices", StringComparison.OrdinalIgnoreCase))
            .ToList();
    }

    private async Task<string?> RunAsync(string exe, string arg, CancellationToken ct)
    {
        try
        {
            var psi = new ProcessStartInfo(exe)
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(exe)!,
            };
            psi.ArgumentList.Add(arg);
            using var p = Process.Start(psi);
            if (p is null) return null;
            // Both streams: llama-server writes its banner to stderr on some builds and stdout on others.
            var outT = p.StandardOutput.ReadToEndAsync(ct);
            var errT = p.StandardError.ReadToEndAsync(ct);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            await p.WaitForExitAsync(timeout.Token);
            return (await outT) + "\n" + (await errT);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogDebug("llama-server {Arg} failed: {Msg}", arg, ex.Message);
            return null;
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
    /// reboots, not a pile of them.</para></summary>
    public void Dispose()
    {
        Process? proc;
        lock (_gate) { proc = _started; _started = null; }
        if (proc is null) return;
        try
        {
            if (!proc.HasExited)
            {
                proc.Kill(entireProcessTree: true);
                proc.WaitForExit(5000);
            }
        }
        catch (Exception ex) { _log.LogDebug("stopping llama-server: {Msg}", ex.Message); }
        finally { proc.Dispose(); }
    }
}
