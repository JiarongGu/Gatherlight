using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
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
/// read 3–5× across runs). And llama.cpp's own default puts the child on the Arc when it is the only GPU it can see (Run
/// 8b, the RTX hidden); with the RTX visible too, the default child used the RTX alone (log-verbosity 4, same date).
/// <c>--list-devices</c> prints the two alike ("Vulkan0: NVIDIA …", "Vulkan1: Intel(R) Arc(TM) Graphics"), so the list
/// cannot say which is integrated, and a name-based rule would be a guess about hardware nobody here has run. A few
/// seconds per device at the first start answers it for THIS machine.</para>
///
/// <para><b>How.</b> ONE device at a time — never two in parallel: two children contending for one package's power budget
/// would each read slower than the machine is (Run 9's voided attempt ran routers side by side). For each: the provisioned
/// <c>llama-server</c> spawned STANDALONE (not the router) with the reranker section's own launch keys
/// (<see cref="LlamaServerRuntime.LaunchKeys"/>, the ones the preset writes — so what is measured is what runs) plus
/// <c>--device</c>, on a loopback port the OS picks (never one in the router's band — <see cref="MeasureAsync"/>); wait
/// for <c>/health</c>; one warm <c>/v1/rerank</c> of a batch of the same size (the RTX's first call of a batch shape carried
/// ~160 ms of set-up: 233 ms, then 71); then one timed call of different documents (<see cref="RerankDeviceBatch"/>); then
/// the process tree is killed. Every wait and call is capped (<see cref="LoadTimeout"/>, <see cref="CallTimeout"/>). A
/// device that times out, fails, exits, or does not score every document (<see cref="RerankReply.Scores"/>) is excluded,
/// its reason recorded as a household sentence and the exception, if any, logged.</para>
///
/// <para><b>An exclusion is RETRIED, a bounded number of times</b> (review, 2026-09-26). Most are transient — a cold Vulkan
/// shader cache, a virus scan of a fresh llama-server at the first start of a new build (exactly when the key changes), a
/// game or another llama-server holding VRAM, contention, a lost port race — and one saved as final would put a reranker
/// on the CPU for good because the RTX was busy once. So at each router start the app performs, a measurement that is
/// current but has excluded devices re-measures THOSE devices only (<see cref="RerankDeviceMeasurement.Retryable"/>), up to
/// <see cref="MaxAttempts"/> attempts each; valid results stay as they are, and this start's preset uses the stored ones
/// meanwhile. After that the exclusion stands until the key changes — and a GPU DRIVER update is not part of the key
/// (<see cref="RerankDeviceKey"/>), which the row says.</para>
///
/// <para><b>Worst case, and who waits for it.</b> Per device at most <see cref="LoadTimeout"/> + 2 × <see cref="CallTimeout"/>
/// (105 s); per reranker lacking a current measurement, that × (1 + GPUs); a retry, that × the excluded devices. Measured
/// on this laptop (2026-09-26, spawn to kill): BGE 16 s on the CPU, 6 s on the RTX, 36 s on the Arc; mMiniLMv2 5–8 s each —
/// 77 s for both on three devices, the start button's request 79 s in all. It runs inside a router start the app performs
/// — behind the migration overlay at boot (<c>LlamaWarmStep</c>, non-essential, which shows <see cref="Now"/> as the step's
/// progress line), or inside a bind or 资源's start button, whose requests no server or client timeout bounds (Kestrel's
/// defaults set none on a request in progress, and the console's fetches set none): the household waits, with the button
/// busy, and the start button's answer then says a measurement ran.</para>
///
/// <para><b>Nothing outlives it.</b> (1) Every measurement child is put in a Windows JOB OBJECT created with
/// <c>JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE</c> and never closed by us (<see cref="MeasurementJob"/>): the OS closes the handle
/// when THIS process ends, however it ends — a crash, a force-quit of a first-boot overlay stuck on a long measurement,
/// TerminateProcess — and the child dies with it. Without it a child on a random port is adopted by nothing, and holds RAM
/// or VRAM until a reboot (and could slow the next measurement). The ROUTER is deliberately NOT in the job: its orphan is
/// adopted by the next start, by design. Verified on the real binary (docs/self-managed-llm-runtime.md, 2026-09-26): the
/// server TerminateProcess'd mid-measurement, the child gone within a second; the same without the job, the child still
/// running. The window between the spawn and the assignment is not covered — a stated limit, milliseconds wide. (2)
/// <see cref="Abort"/> — which <see cref="LlamaServerRuntime.Dispose"/> calls BEFORE it waits for the lifecycle lock — kills
/// the running child and refuses another; a child the caller's cancellation or a cap ends is killed in a <c>finally</c>.
/// The Dispose path itself is asserted by nothing (the e2e harness stops a server with TerminateProcess, which skips it).</para>
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

    /// <summary>How many times an EXCLUDED device is measured under one key before the exclusion stands — the first
    /// measurement and two retries, each at a router start the app performs. See the class comment.</summary>
    public const int MaxAttempts = 3;

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

    /// <summary>How many ports the OS may offer before the measurement gives up on finding one outside the router's band.</summary>
    private const int PortTries = 20;

    private readonly IHttpClientFactory _http;
    private readonly ILogger _log;
    private readonly object _gate = new();
    private readonly CancellationTokenSource _abort = new();
    private Process? _child;
    private bool _aborted;
    private string? _now;
    private static int s_announced;

    public RerankDeviceMeter(IHttpClientFactory http, ILogger log)
    {
        _http = http;
        _log = log;
    }

    /// <summary>What is being measured right now, as a household progress line — null when nothing is. Read by the
    /// migration overlay's step line; a field read, never an await.</summary>
    public string? Now { get { lock (_gate) return _now; } }

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
        if (child is not null) LlamaServerRuntime.KillProcessTree(child, _log, "rerank device measurement");
    }

    /// <summary>Measure <paramref name="modelId"/> on the CPU and every device in <paramref name="key"/>, one at a time —
    /// or, given the <paramref name="previous"/> measurement under the same key, only its RETRYABLE excluded devices,
    /// merged into it (each re-measured device's attempts counted up; the valid results kept as they are).
    /// <paramref name="reserved"/> says which ports must not be offered to a child: the router's own and its band.
    /// Null when <see cref="Abort"/> ended it — a partial measurement is never returned, so never persisted. The caller's
    /// cancellation propagates, the running child killed first.</summary>
    public async Task<RerankDeviceMeasurement?> MeasureAsync(string exe, string modelId, string modelFile,
        RerankDeviceKey key, RerankDeviceMeasurement? previous, Func<int, bool> reserved, CancellationToken ct)
    {
        Announce();
        var window = GgufCatalog.DeclaredWindow(modelId);
        var warm = RerankDeviceBatch.Warm(window);
        var timed = RerankDeviceBatch.Timed(window);
        var all = new List<(string Device, string Name)> { ("none", "CPU") };
        all.AddRange(key.Devices.Select(d => (RerankDeviceKey.DeviceId(d), RerankDeviceKey.DeviceName(d))));
        var retry = previous?.Retryable.Select(r => r.Device).ToHashSet(StringComparer.Ordinal);
        var targets = retry is null ? all : all.Where(t => retry.Contains(t.Device)).ToList();

        _log.LogInformation(
            "rerank device measurement: {Model} on {Count} device(s) ({Devices}){Retry}, one at a time — {Docs} documents, {Tokens:0} pair tokens",
            modelId, targets.Count, string.Join(", ", targets.Select(t => t.Device)),
            retry is null ? "" : " — retrying the ones excluded last time", timed.Documents.Count, timed.PairTokens);
        var fresh = new Dictionary<string, RerankDeviceResult>(StringComparer.Ordinal);
        try
        {
            for (var i = 0; i < targets.Count; i++)
            {
                var (device, name) = targets[i];
                lock (_gate)
                {
                    if (_aborted) return null;
                    _now = $"正在测重排模型 {modelId} 在哪个设备上最快:第 {i + 1}/{targets.Count} 个({name})";
                }
                var r = await OneAsync(exe, modelId, modelFile, device, name, warm, timed, reserved, ct).ConfigureAwait(false);
                lock (_gate) if (_aborted) return null;
                var attempts = (previous?.Results.FirstOrDefault(p => p.Device == device)?.AttemptsSpent ?? 0) + 1;
                r = r with { Attempts = attempts, MeasuredAt = DateTimeOffset.UtcNow };
                if (r.Valid)
                    _log.LogInformation(
                        "rerank device measurement: {Model} on {Device} ({Name}): {Ms} ms for {Tokens:0} pair tokens — {Rate:0.###} ms per 1,000",
                        modelId, device, name, r.ElapsedMs, timed.PairTokens, r.MsPerToken * 1000);
                else
                    _log.LogWarning("rerank device measurement: {Model} on {Device} ({Name}) excluded, attempt {Attempt} of {Max}: {Why}",
                        modelId, device, name, attempts, MaxAttempts, r.Error);
                fresh[device] = r;
            }
        }
        finally
        {
            lock (_gate) _now = null;
        }

        var results = previous is null
            ? targets.Select(t => fresh[t.Device]).ToList()
            : previous.Results.Select(p => fresh.TryGetValue(p.Device, out var n) ? n : p).ToList();
        var m = new RerankDeviceMeasurement(key.Model, key.ModelBytes, key.ModelWriteTicks, key.Build, key.Devices,
            DateTimeOffset.UtcNow, timed.Documents.Count, timed.Characters, timed.PairTokens, results);
        _log.LogInformation("rerank device measurement: {Model} → {Chosen}", modelId,
            m.Fastest is { } f ? $"{f.Device} ({f.Name}), the fastest that gave a result" : "no device gave a valid result; the preset names none");
        return m;
    }

    private async Task<RerankDeviceResult> OneAsync(string exe, string modelId, string modelFile, string device, string name,
        MeasurementBatch warmBatch, MeasurementBatch timedBatch, Func<int, bool> reserved, CancellationToken ct)
    {
        Process? proc = null;
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, _abort.Token);
        try
        {
            if (FreeLoopbackPort(reserved) is not { } port)
            {
                _log.LogWarning("rerank device measurement: no free loopback port outside the router's band after {Tries} tries", PortTries);
                return Excluded(device, name, "没能找到一个可用的端口");
            }
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
            if (proc is null) return Excluded(device, name, "没能启动 llama-server");
            // Dies with this process however this process dies — see MeasurementJob. A child that has already exited
            // cannot be assigned, and has nothing left to leave behind: no warning for it (its exit is reported below).
            if (!MeasurementJob.Assign(proc) && !proc.HasExited)
                _log.LogWarning("rerank device measurement: could not put the child (pid {Pid}) in the kill-on-close job; "
                    + "a forced end of the app during this measurement would leave it running", proc.Id);
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

            // 2. Warm — a batch of the same size, so the timed call pays no first-call set-up for its shape.
            var warm = await CallAsync(http, baseUrl, modelId, device, warmBatch, linked.Token).ConfigureAwait(false);
            if (warm.Error is { } warmWhy) return Excluded(device, name, "预热:" + warmWhy);

            // 3. Timed — different documents, so no prompt cache can answer it from the warm call.
            var timed = await CallAsync(http, baseUrl, modelId, device, timedBatch, linked.Token).ConfigureAwait(false);
            if (timed.Error is { } why) return Excluded(device, name, why);
            return new RerankDeviceResult(device, name, (long)timed.Elapsed.TotalMilliseconds,
                RerankPace.RateOf(timed.Elapsed, timedBatch.PairTokens), null);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return Excluded(device, name, "应用正在关闭");   // Abort; the caller sees _aborted and returns null
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "rerank device measurement: {Model} on {Device} failed", modelId, device);
            return Excluded(device, name, "没能测(原因写在「日志」里)");
        }
        finally
        {
            lock (_gate) if (ReferenceEquals(_child, proc)) _child = null;
            if (proc is not null)
            {
                LlamaServerRuntime.KillProcessTree(proc, _log, "rerank device measurement");
                proc.Dispose();
            }
        }
    }

    /// <summary>One <c>/v1/rerank</c> of <paramref name="batch"/>, capped at <see cref="CallTimeout"/>: its wall-clock
    /// time, or why it is not a result — a household sentence; the exception, if any, goes to the log.</summary>
    private async Task<(TimeSpan Elapsed, string? Error)> CallAsync(HttpClient http, string baseUrl, string modelId,
        string device, MeasurementBatch batch, CancellationToken ct)
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
            _log.LogWarning(ex, "rerank device measurement: a /v1/rerank call to {Model} on {Device} failed", modelId, device);
            return (clock.Elapsed, "打分请求没有得到回应(原因写在「日志」里)");
        }
    }

    private static RerankDeviceResult Excluded(string device, string name, string why) => new(device, name, null, null, why);

    /// <summary>A loopback port the OS picks — never a fixed or known one, and never one <paramref name="reserved"/>
    /// names. On this machine the OS's dynamic range is 1024–15000, which covers the router's own band
    /// (<see cref="LlamaServerRuntime.PortFor"/>, 11435–11498): a port refused now is free, and handing the router's port to
    /// a measurement child would make the router spawned right after it fail to bind — so such a port is refused and
    /// another asked for. A port taken between this check and the child's bind makes the child exit, an exclusion like
    /// any other, retried at the next start.</summary>
    private static int? FreeLoopbackPort(Func<int, bool> reserved)
    {
        for (var i = 0; i < PortTries; i++)
        {
            var l = new TcpListener(IPAddress.Loopback, 0);
            l.Start();
            int port;
            try { port = ((IPEndPoint)l.LocalEndpoint).Port; }
            finally { l.Stop(); }
            if (!reserved(port)) return port;
        }
        return null;
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
}

/// <summary>A Windows JOB OBJECT that kills every process in it when its last handle closes
/// (<c>JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE</c>) — and the only handle is this process's, held for its whole life and never
/// closed by us, so the OS closes it when this process ends, however it ends, and the measurement children die with it.
/// Created lazily, once. On anything but Windows, or when the calls fail, <see cref="Assign"/> answers false and the
/// caller logs that the protection is missing — the measurement itself goes on.</summary>
internal static class MeasurementJob
{
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;

    private static readonly Lazy<IntPtr> Job = new(Create);

    public static bool Assign(Process process)
    {
        if (!OperatingSystem.IsWindows()) return false;
        var job = Job.Value;
        if (job == IntPtr.Zero) return false;
        try { return AssignProcessToJobObject(job, process.Handle); }
        catch (Exception) { return false; }
    }

    private static IntPtr Create()
    {
        if (!OperatingSystem.IsWindows()) return IntPtr.Zero;
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        var info = new JobObjectExtendedLimit { BasicLimitInformation = new JobObjectBasicLimit { LimitFlags = JobObjectLimitKillOnJobClose } };
        return SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf<JobObjectExtendedLimit>())
            ? job : IntPtr.Zero;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimit
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimit
    {
        public JobObjectBasicLimit BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JobObjectExtendedLimit info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
}
