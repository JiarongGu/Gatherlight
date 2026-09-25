using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>Times the fixed rerank batch (<see cref="RerankDeviceBatch"/>) on the CPU and on every device
/// <c>--list-devices</c> answered with, so a reranker runs where it is FASTEST on this machine rather than where
/// llama.cpp's default puts it (owner decision, 2026-09-26, after <c>docs/judge-bench.md</c> Run 8b).
///
/// <para><b>Why measured, not guessed.</b> On this laptop (Core Ultra 9 185H, RTX 4080 Laptop + Intel Arc iGPU, llama.cpp
/// b10549) the Arc is 3–7× SLOWER than the CPU for the two rerankers measured — BGE 9.6 s per 1,000 pair tokens against
/// 3.35–3.58 on the CPU, mMiniLMv2 1.44 against 0.22–0.24 (<c>docs/self-managed-llm-runtime.md</c>, 2026-09-26; Run 8b
/// read 3–5× across runs). And llama.cpp's
/// own default puts the child on the Arc when it is the only GPU it can see (Run 8b, the RTX hidden); with the RTX visible
/// too, the default child used the RTX alone (log-verbosity 4, same date). <c>--list-devices</c> prints the two alike
/// ("Vulkan0: NVIDIA …", "Vulkan1: Intel(R) Arc(TM) Graphics"), so the list cannot say which is integrated, and a
/// name-based rule would be a guess about hardware nobody here has run. A few seconds per device at the first start
/// answers it for THIS machine.</para>
///
/// <para><b>How.</b> ONE device at a time — never two in parallel: two children contending for one package's power budget
/// would each read slower than the machine is (Run 9's voided attempt ran routers side by side). For each: the provisioned
/// <c>llama-server</c> spawned STANDALONE (not the router) with the reranker section's own launch keys
/// (<see cref="LlamaServerRuntime.LaunchKeys"/>, the ones the preset writes — so what is measured is what runs) plus
/// <c>--device</c>, on a loopback port the OS picks; wait for <c>/health</c>; one warm <c>/v1/rerank</c> of the SAME batch
/// (the RTX's first call of a batch shape carried ~160 ms of set-up: 233 ms, then 71); then one timed call of it; then the
/// process tree is killed. Every wait and call is capped (<see cref="LoadTimeout"/>, <see cref="CallTimeout"/>). A device
/// that times out, fails, exits, or does not score every document (<see cref="RerankReply.Scores"/>) is excluded, and its
/// reason is recorded.</para>
///
/// <para><b>Worst case, and who waits for it.</b> Per device at most <see cref="LoadTimeout"/> + 2 × <see cref="CallTimeout"/>
/// (105 s); per reranker lacking a current measurement, that × (1 + GPUs). Measured on this laptop (2026-09-26, spawn to
/// kill): BGE 16 s on the CPU, 6 s on the RTX, 36 s on the Arc; mMiniLMv2 5–8 s each — 77 s for both on three devices, the
/// start button's request 79 s in all. It runs inside a router start the app performs — behind the
/// migration overlay at boot (<c>LlamaWarmStep</c>, non-essential), or inside a bind or 资源's start button, whose requests
/// no server or client timeout bounds (Kestrel's defaults set none on a request in progress, and the console's fetches set
/// none): the household waits, with the button busy. Only once per model per key (<see cref="RerankDeviceKey"/>).</para>
///
/// <para><b>Nothing outlives it.</b> The running child is held here and <see cref="Abort"/> — which
/// <see cref="LlamaServerRuntime.Dispose"/> calls BEFORE it waits for the lifecycle lock — kills it and refuses another, so a
/// shutdown during a measurement cannot orphan a llama-server: the failure this runtime already fought. A child the
/// caller's cancellation or a cap ends is killed too, in a <c>finally</c>. <b>Stated gap</b>: the Dispose path is asserted by
/// nothing — the e2e harness stops a server with TerminateProcess, which skips Dispose — so it rests on reading.</para>
///
/// <para><b>Test seam</b>: <see cref="CommandSeam"/> names a command the measurement spawns INSTEAD of the provisioned
/// binary, with the same arguments — the precedent is <c>GATHERLIGHT_CLAUDE_CMD</c>. Only the measurement uses it; the build
/// tag and device list are still the provisioned binary's. <see cref="CapKnob"/> can only SHORTEN the caps, so a suite can
/// drive a device that never answers without waiting 105 s. Both announce themselves at Warning when set.</para></summary>
public sealed class RerankDeviceMeter
{
    /// <summary>The measurement-only command seam — see the class comment.</summary>
    public const string CommandSeam = "GATHERLIGHT_LLAMA_MEASURE_CMD";

    /// <summary>The test knob that shortens <see cref="LoadTimeout"/> and <see cref="CallTimeout"/> — never lengthens.</summary>
    public const string CapKnob = "GATHERLIGHT_RERANK_MEASURE_CAP_SECONDS";

    private static readonly TimeSpan DefaultLoad = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan DefaultCall = TimeSpan.FromSeconds(30);
    private static readonly double? KnobSeconds =
        double.TryParse(Environment.GetEnvironmentVariable(CapKnob), System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out var s) && s > 0 ? s : null;

    /// <summary>How long a device's child has to load the model and answer <c>/health</c>. BGE loaded in 4–6 s on every
    /// device here; the cap is for a cold disk and a slow driver, not for a normal load.</summary>
    public static readonly TimeSpan LoadTimeout = Capped(DefaultLoad);

    /// <summary>How long the warm call and the timed call each have. The slowest device measured here answered in 14.9 s
    /// (BGE, the Arc), and a device twice that slow — ~20 ms per pair token — could not judge a recall in time anyway.</summary>
    public static readonly TimeSpan CallTimeout = Capped(DefaultCall);

    private static TimeSpan Capped(TimeSpan d) =>
        KnobSeconds is { } k ? TimeSpan.FromSeconds(Math.Min(k, d.TotalSeconds)) : d;

    private readonly IHttpClientFactory _http;
    private readonly ILogger _log;
    private readonly object _gate = new();
    private readonly CancellationTokenSource _abort = new();
    private Process? _child;
    private bool _aborted;
    private static int s_announced;

    public RerankDeviceMeter(IHttpClientFactory http, ILogger log)
    {
        _http = http;
        _log = log;
    }

    /// <summary>Kill the running child, if any, and refuse to start another — for <see cref="LlamaServerRuntime.Dispose"/>.</summary>
    public void Abort()
    {
        Process? child;
        lock (_gate)
        {
            _aborted = true;
            child = _child;
        }
        try { _abort.Cancel(); } catch (ObjectDisposedException) { /* already torn down */ }
        if (child is not null) KillTree(child);
    }

    /// <summary>Measure <paramref name="modelId"/> on the CPU and every device in <paramref name="key"/>, one at a time.
    /// Null when <see cref="Abort"/> ended it — a partial measurement is never returned, so never persisted. The caller's
    /// cancellation propagates, the running child killed first.</summary>
    public async Task<RerankDeviceMeasurement?> MeasureAsync(string exe, string modelId, string modelFile,
        RerankDeviceKey key, CancellationToken ct)
    {
        Announce();
        var batch = RerankDeviceBatch.For(GgufCatalog.DeclaredWindow(modelId));
        var targets = new List<(string Device, string Name)> { ("none", "CPU") };
        targets.AddRange(key.Devices.Select(d => (RerankDeviceKey.DeviceId(d), RerankDeviceKey.DeviceName(d))));

        _log.LogInformation(
            "rerank device measurement: {Model} on {Count} device(s) ({Devices}), one at a time — {Docs} documents, {Tokens:0} pair tokens",
            modelId, targets.Count, string.Join(", ", targets.Select(t => t.Device)), batch.Documents.Count, batch.PairTokens);
        var results = new List<RerankDeviceResult>();
        foreach (var (device, name) in targets)
        {
            lock (_gate) if (_aborted) return null;
            var r = await OneAsync(exe, modelId, modelFile, device, name, batch, ct).ConfigureAwait(false);
            lock (_gate) if (_aborted) return null;
            if (r.Valid)
                _log.LogInformation(
                    "rerank device measurement: {Model} on {Device} ({Name}): {Ms} ms for {Tokens:0} pair tokens — {Rate:0.###} ms per 1,000",
                    modelId, device, name, r.ElapsedMs, batch.PairTokens, r.MsPerToken * 1000);
            else
                _log.LogWarning("rerank device measurement: {Model} on {Device} ({Name}) excluded: {Why}",
                    modelId, device, name, r.Error);
            results.Add(r);
        }
        var m = new RerankDeviceMeasurement(key.Model, key.ModelBytes, key.ModelWriteTicks, key.Build, key.Devices,
            DateTimeOffset.UtcNow, batch.Documents.Count, batch.Characters, batch.PairTokens, results);
        _log.LogInformation("rerank device measurement: {Model} → {Chosen}", modelId,
            m.Fastest is { } f ? $"{f.Device} ({f.Name}), the fastest" : "no device gave a valid result; the preset names none");
        return m;
    }

    private async Task<RerankDeviceResult> OneAsync(string exe, string modelId, string modelFile, string device, string name,
        (string Query, IReadOnlyList<string> Documents, int Characters, double PairTokens) batch, CancellationToken ct)
    {
        Process? proc = null;
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, _abort.Token);
        try
        {
            var port = FreeLoopbackPort();
            var (file, lead) = Command(exe);
            var psi = new ProcessStartInfo(file)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(Path.GetFullPath(exe)) ?? "",
            };
            foreach (var a in lead) psi.ArgumentList.Add(a);
            psi.ArgumentList.Add("-m");
            psi.ArgumentList.Add(modelFile);
            foreach (var (k, v) in LlamaServerRuntime.LaunchKeys(modelId, device))
            {
                psi.ArgumentList.Add($"--{k}");
                if (v != "true") psi.ArgumentList.Add(v);
            }
            psi.ArgumentList.Add("--host");
            psi.ArgumentList.Add("127.0.0.1");
            psi.ArgumentList.Add("--port");
            psi.ArgumentList.Add(port.ToString());

            lock (_gate)
            {
                if (_aborted) return Excluded(device, name, "应用正在关闭");
                proc = Process.Start(psi);
                _child = proc;
            }
            if (proc is null) return Excluded(device, name, "没能启动");
            // Drained, not read — a filled pipe blocks the child.
            proc.OutputDataReceived += (_, _) => { };
            proc.ErrorDataReceived += (_, _) => { };
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();

            var baseUrl = $"http://127.0.0.1:{port}";
            using var http = _http.CreateClient();
            http.Timeout = Timeout.InfiniteTimeSpan;   // every request below carries its own cap

            // 1. Loaded: /health answers 200 (503 while the model loads).
            var loading = Stopwatch.StartNew();
            for (;;)
            {
                if (proc.HasExited) return Excluded(device, name, $"进程在载入模型时退出了(退出码 {proc.ExitCode})");
                if (loading.Elapsed >= LoadTimeout)
                    return Excluded(device, name, $"{LoadTimeout.TotalSeconds:0} 秒内没有载入完模型");
                try
                {
                    using var probe = CancellationTokenSource.CreateLinkedTokenSource(linked.Token);
                    probe.CancelAfter(TimeSpan.FromSeconds(2));
                    using var h = await http.GetAsync($"{baseUrl}/health", probe.Token).ConfigureAwait(false);
                    if (h.IsSuccessStatusCode) break;
                }
                catch (Exception) when (!linked.IsCancellationRequested) { /* not up yet */ }
                await Task.Delay(250, linked.Token).ConfigureAwait(false);
            }

            // 2. Warm — the SAME batch, so the timed call pays no first-call set-up for its shape.
            var warm = await CallAsync(http, baseUrl, modelId, batch, linked.Token).ConfigureAwait(false);
            if (warm.Error is { } warmWhy) return Excluded(device, name, "预热:" + warmWhy);

            // 3. Timed.
            var timed = await CallAsync(http, baseUrl, modelId, batch, linked.Token).ConfigureAwait(false);
            if (timed.Error is { } why) return Excluded(device, name, why);
            return new RerankDeviceResult(device, name, (long)timed.Elapsed.TotalMilliseconds,
                RerankPace.RateOf(timed.Elapsed, batch.PairTokens), null);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return Excluded(device, name, "应用正在关闭");   // Abort; the caller sees _aborted and returns null
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return Excluded(device, name, $"没能测:{ex.Message}");
        }
        finally
        {
            lock (_gate) if (ReferenceEquals(_child, proc)) _child = null;
            if (proc is not null)
            {
                KillTree(proc);
                proc.Dispose();
            }
        }
    }

    /// <summary>One <c>/v1/rerank</c> of the batch, capped at <see cref="CallTimeout"/>: its wall-clock time, or why it is
    /// not a result.</summary>
    private static async Task<(TimeSpan Elapsed, string? Error)> CallAsync(HttpClient http, string baseUrl, string modelId,
        (string Query, IReadOnlyList<string> Documents, int Characters, double PairTokens) batch, CancellationToken ct)
    {
        using var cap = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cap.CancelAfter(CallTimeout);
        var body = JsonSerializer.Serialize(new
        {
            model = modelId, query = batch.Query, documents = batch.Documents, top_n = batch.Documents.Count,
        });
        var clock = Stopwatch.StartNew();
        try
        {
            using var content = new StringContent(body, new UTF8Encoding(false), "application/json");
            using var res = await http.PostAsync($"{baseUrl}/v1/rerank", content, cap.Token).ConfigureAwait(false);
            var text = await res.Content.ReadAsStringAsync(cap.Token).ConfigureAwait(false);
            clock.Stop();
            if (!res.IsSuccessStatusCode) return (clock.Elapsed, $"打分失败(HTTP {(int)res.StatusCode})");
            if (RerankReply.Scores(text, batch.Documents.Count) is null)
                return (clock.Elapsed, $"只给 {batch.Documents.Count} 段里的 {RerankReply.Scored(text, batch.Documents.Count)} 段打了分");
            return (clock.Elapsed, null);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return (clock.Elapsed, $"{CallTimeout.TotalSeconds:0} 秒内没有打完分");
        }
        catch (HttpRequestException ex)
        {
            return (clock.Elapsed, $"打分请求失败:{ex.Message}");
        }
    }

    private static RerankDeviceResult Excluded(string device, string name, string why) => new(device, name, null, null, why);

    /// <summary>A loopback port the OS picks — never a fixed or known one, and never the router's (that one is held
    /// or refused already, and this runs before the router is spawned).</summary>
    private static int FreeLoopbackPort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        try { return ((IPEndPoint)l.LocalEndpoint).Port; }
        finally { l.Stop(); }
    }

    /// <summary>The executable and leading arguments: the provisioned binary, or the <see cref="CommandSeam"/> command.</summary>
    private static (string File, IReadOnlyList<string> Lead) Command(string exe)
    {
        var seam = Environment.GetEnvironmentVariable(CommandSeam);
        if (string.IsNullOrWhiteSpace(seam)) return (exe, Array.Empty<string>());
        var parts = Split(seam);
        return (parts[0], parts.Skip(1).ToList());
    }

    /// <summary>Split a command line on spaces, keeping double-quoted runs together.</summary>
    private static List<string> Split(string cmd)
    {
        var parts = new List<string>();
        var sb = new StringBuilder();
        var quoted = false;
        foreach (var c in cmd.Trim())
        {
            if (c == '"') { quoted = !quoted; continue; }
            if (c == ' ' && !quoted)
            {
                if (sb.Length > 0) { parts.Add(sb.ToString()); sb.Clear(); }
                continue;
            }
            sb.Append(c);
        }
        if (sb.Length > 0) parts.Add(sb.ToString());
        return parts;
    }

    private void Announce()
    {
        if (Interlocked.Exchange(ref s_announced, 1) != 0) return;
        if (Environment.GetEnvironmentVariable(CommandSeam) is { Length: > 0 } seam)
            _log.LogWarning("Test seam set: {Seam} — reranker device measurements spawn '{Cmd}' instead of llama-server", CommandSeam, seam);
        if (KnobSeconds is { } k)
            _log.LogWarning("Test knob set: {Knob} = {Seconds} — a device measurement's load and calls are capped at {Load:0.#} / {Call:0.#} s",
                CapKnob, k, LoadTimeout.TotalSeconds, CallTimeout.TotalSeconds);
    }

    private void KillTree(Process proc)
    {
        try
        {
            if (!proc.HasExited)
            {
                proc.Kill(entireProcessTree: true);
                if (!proc.WaitForExit(5000))
                    _log.LogWarning("rerank device measurement: llama-server (pid {Pid}) had not exited 5 s after it was killed", proc.Id);
            }
        }
        catch (Exception ex) { _log.LogDebug("rerank device measurement: stopping a child: {Msg}", ex.Message); }
    }
}
