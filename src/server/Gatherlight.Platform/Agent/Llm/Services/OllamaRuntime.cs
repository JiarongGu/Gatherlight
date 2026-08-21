using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>One model the local Ollama holds.</summary>
public sealed record OllamaModel(string Name, long SizeBytes);

/// <summary>What Ollama is on THIS machine right now — observed, never assumed. <see cref="Problem"/> is
/// null when semantic recall could run, and is the one sentence the household reads when it could not.</summary>
public sealed record OllamaState(
    string BaseUrl,
    bool Installed,
    bool Serving,
    string? Version,
    string? Executable,
    IReadOnlyList<OllamaModel> Models,
    bool GpuLikely,
    string? Problem)
{
    public bool Has(string model) => Models.Any(m => Matches(m.Name, model));

    /// <summary>Ollama reports `nomic-embed-text:latest` for a model pulled as `nomic-embed-text`, so a
    /// plain equality check would report a freshly pulled model as missing and offer to pull it again.</summary>
    public static bool Matches(string held, string wanted) =>
        held.Equals(wanted, StringComparison.OrdinalIgnoreCase)
        || held.Equals($"{wanted}:latest", StringComparison.OrdinalIgnoreCase)
        || (wanted.EndsWith(":latest", StringComparison.OrdinalIgnoreCase)
            && held.Equals(wanted[..^7], StringComparison.OrdinalIgnoreCase));
}

public interface IOllamaRuntime
{
    /// <summary>Where this install would reach Ollama. Loopback unless an operator deliberately says
    /// otherwise — see <see cref="OllamaRuntime"/> for why that default is a privacy boundary.</summary>
    string BaseUrl { get; }

    /// <summary>An <c>ollama</c> executable we could start, or null when there is none to start. A
    /// household running Ollama as their own app/service needs none of this — we only ever start a
    /// server when the port is silent.</summary>
    string? Locate();

    /// <summary>Ask Ollama what it is and what it holds. Cached briefly; never throws.</summary>
    Task<OllamaState> ProbeAsync(bool refresh = false, CancellationToken ct = default);

    /// <summary>Make sure something is answering on <see cref="BaseUrl"/>, starting a server ONLY when
    /// nothing already is. Returns false when we could not (nothing installed, or it would not come up).</summary>
    Task<bool> EnsureServingAsync(CancellationToken ct = default);

    /// <summary>Pull a model, reporting percent + a human line. Throws with Ollama's own reason on failure —
    /// the caller is an explicit household action (a button), so a silent no-op would be worse.</summary>
    Task PullModelAsync(string model, Action<int, string?>? onProgress = null, CancellationToken ct = default);

    /// <summary>Embed one short string and report what came back. This is how a model NOBODY CATALOGUED can
    /// still be adopted safely: the catalog is a shortlist, so the two things the app must know about a
    /// chosen model — that it embeds at all, and how wide its vectors are — are asked of the model itself
    /// rather than looked up. Width matters because it decides whether a switch invalidates stored vectors.
    /// <para>Returns null when the model cannot embed (a chat model named by mistake, a bad id, Ollama
    /// down) — which is the answer the caller needs BEFORE saving a setting that would otherwise leave
    /// recall silently empty.</para></summary>
    Task<EmbedProbe?> ProbeEmbeddingAsync(string model, CancellationToken ct = default);

    void Invalidate();
}

/// <summary>What one real embed call reported: vector width and how long it took, warm-ish.</summary>
public sealed record EmbedProbe(int Dimensions, int Milliseconds);

/// <summary>
/// The local Ollama used ONLY to embed facts for semantic recall — never for planning, which stays the
/// authenticated claude CLI. Two properties make this acceptable in a self-hosted family planner, and
/// both are enforced here rather than promised in a doc:
///
/// <para><b>It is local.</b> Embedding a fact means sending the household's private material to whatever
/// does the embedding. A cloud embeddings API would ship their plans and household data to a third party
/// on every single write. So <see cref="BaseUrl"/> must be LOOPBACK: a remote URL is refused unless an
/// operator sets it deliberately, the same posture <c>ResourceProvisioner.Override</c> takes for a
/// resource source. A misconfigured URL here would be a silent, continuous data leak.</para>
///
/// <para><b>It is optional.</b> Nothing here is required for the app to work — with no Ollama the whole
/// feature is absent and recall behaves exactly as it did before it existed. That is why every method is
/// non-throwing except the explicit pull, and why we never install or manage a household's own Ollama:
/// we start a server only when the port is silent, so an existing app/service is left alone.</para>
/// </summary>
public sealed class OllamaRuntime : IOllamaRuntime
{
    public const string DefaultBaseUrl = "http://127.0.0.1:11434";
    private static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(20);
    private static readonly UTF8Encoding Utf8NoBom = new(false);

    // Long enough for a first-token-on-a-cold-model pull to keep streaming, but the PROBE gets its own
    // short deadline below: a probe that hangs makes the panel look broken.
    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };

    private readonly IPlatformContext _platform;
    private readonly ServerConfigService? _config;
    private readonly ILogger<OllamaRuntime> _log;
    private readonly object _gate = new();
    private OllamaState? _cached;
    private DateTimeOffset _cachedAt;
    private Process? _started;

    public OllamaRuntime(IPlatformContext platform, ILogger<OllamaRuntime> log,
        ServerConfigService? config = null)
    {
        _platform = platform;
        _log = log;
        _config = config;
    }

    /// <summary>Where a provisioned Ollama lands. Only used when the household chose to have us install
    /// one; a machine-wide install is found on PATH instead and is preferred, because it is the one the
    /// household maintains (and the one with their GPU runtimes).</summary>
    public static string ProvisionedExe(string resourcesPath) =>
        Path.Combine(resourcesPath, "ollama", "ollama.exe");

    public string BaseUrl => ResolveBaseUrl(_config?.Current.Memory.OllamaUrl, _log);

    /// <summary>Env override → configured value → loopback default, with the loopback guard applied to
    /// BOTH sources. Static because the DI wiring must resolve the same URL at startup (to configure the
    /// embedder) that this service will later probe — two answers for one endpoint is how an install ends
    /// up embedding against one host and reporting another.</summary>
    public static string ResolveBaseUrl(string? configured, ILogger? log = null)
    {
        var raw = Environment.GetEnvironmentVariable("GATHERLIGHT_OLLAMA_URL");
        if (string.IsNullOrWhiteSpace(raw)) raw = configured;
        if (string.IsNullOrWhiteSpace(raw)) return DefaultBaseUrl;

        // A non-loopback embedder endpoint sends every household fact off this machine, forever, with
        // nothing on screen to show it. Refuse it unless the operator ALSO says they meant it.
        if (Uri.TryCreate(raw, UriKind.Absolute, out var u) && !u.IsLoopback
            && Environment.GetEnvironmentVariable("GATHERLIGHT_OLLAMA_ALLOW_REMOTE") != "1")
        {
            log?.LogWarning(
                "Ignoring Ollama URL {Url}: a non-loopback embedder would send household facts off this " +
                "machine. Set GATHERLIGHT_OLLAMA_ALLOW_REMOTE=1 if that is truly intended.", raw);
            return DefaultBaseUrl;
        }
        return raw.TrimEnd('/');
    }

    public string? Locate()
    {
        var provisioned = ProvisionedExe(_platform.ResourcesPath);
        if (File.Exists(provisioned)) return provisioned;

        // A machine-wide install (the household's own, with whatever GPU support they set up) is the one
        // we would rather use — but only to START it if nothing is listening; we never manage it.
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            try
            {
                var candidate = Path.Combine(dir.Trim(), "ollama.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException) { /* a malformed PATH entry is not our problem to report */ }
        }
        return null;
    }

    public void Invalidate() { lock (_gate) _cached = null; }

    public async Task<OllamaState> ProbeAsync(bool refresh = false, CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (!refresh && _cached is not null && DateTimeOffset.UtcNow - _cachedAt < CacheFor)
                return _cached;
        }
        var state = await MeasureAsync(ct);
        lock (_gate) { _cached = state; _cachedAt = DateTimeOffset.UtcNow; }
        return state;
    }

    private async Task<OllamaState> MeasureAsync(CancellationToken ct)
    {
        var baseUrl = BaseUrl;
        var exe = Locate();
        var models = await TagsAsync(baseUrl, ct);

        if (models is null)
        {
            return new OllamaState(baseUrl, Installed: exe is not null, Serving: false, Version: null,
                Executable: exe, Models: Array.Empty<OllamaModel>(), GpuLikely: false,
                Problem: exe is null
                    ? "未安装 Ollama —— 语义检索需要它;可在「资源」面板安装,或自行安装后重启应用。"
                    : "已安装 Ollama,但服务未运行 —— 请在「资源」面板点击「启动」,或自行运行 `ollama serve`。");
        }

        return new OllamaState(baseUrl, Installed: true, Serving: true,
            Version: await VersionAsync(baseUrl, ct), Executable: exe, Models: models,
            GpuLikely: GpuLikely(exe), Problem: null);
    }

    /// <summary>Is a GPU runtime present beside the executable? Ollama ships CUDA/ROCm/Vulkan runners in
    /// <c>lib/ollama/*</c>, so their presence is the cheap, offline signal for "this install can use a
    /// GPU" — enough to steer a model RECOMMENDATION, which is all it is used for. It deliberately does
    /// not claim a GPU is actually present and working; only Ollama knows that, at load time.</summary>
    private static bool GpuLikely(string? exe)
    {
        if (exe is null) return false;
        try
        {
            var lib = Path.Combine(Path.GetDirectoryName(exe)!, "lib", "ollama");
            if (!Directory.Exists(lib)) return false;
            return Directory.EnumerateDirectories(lib)
                .Select(d => Path.GetFileName(d) ?? "")
                .Any(n => n.StartsWith("cuda", StringComparison.OrdinalIgnoreCase)
                       || n.StartsWith("rocm", StringComparison.OrdinalIgnoreCase)
                       || n.StartsWith("vulkan", StringComparison.OrdinalIgnoreCase));
        }
        catch (IOException) { return false; }
    }

    private async Task<IReadOnlyList<OllamaModel>?> TagsAsync(string baseUrl, CancellationToken ct)
    {
        try
        {
            // Short and fixed: this runs behind a panel poll, and "not running" must be a fast answer
            // rather than a spinner nobody can explain.
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(4));
            using var resp = await Http.GetAsync($"{baseUrl}/api/tags", cts.Token);
            if (!resp.IsSuccessStatusCode) return null;
            await using var s = await resp.Content.ReadAsStreamAsync(cts.Token);
            using var doc = await JsonDocument.ParseAsync(s, cancellationToken: cts.Token);
            if (!doc.RootElement.TryGetProperty("models", out var arr) || arr.ValueKind != JsonValueKind.Array)
                return Array.Empty<OllamaModel>();
            return arr.EnumerateArray()
                .Select(m => new OllamaModel(
                    m.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "",
                    m.TryGetProperty("size", out var sz) && sz.TryGetInt64(out var v) ? v : 0))
                .Where(m => m.Name.Length > 0)
                .ToList();
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            return null;   // not serving — a fact about the machine, not an error to surface
        }
    }

    private async Task<string?> VersionAsync(string baseUrl, CancellationToken ct)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(4));
            await using var s = await Http.GetStreamAsync($"{baseUrl}/api/version", cts.Token);
            using var doc = await JsonDocument.ParseAsync(s, cancellationToken: cts.Token);
            return doc.RootElement.TryGetProperty("version", out var v) ? v.GetString() : null;
        }
        catch { return null; }
    }

    public async Task<bool> EnsureServingAsync(CancellationToken ct = default)
    {
        var baseUrl = BaseUrl;
        if (await TagsAsync(baseUrl, ct) is not null) return true;   // someone is already serving — leave it alone

        var exe = Locate();
        if (exe is null) return false;

        // Only reached when the port is SILENT, so this cannot fight a household's own running instance.
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = exe,
                WorkingDirectory = Path.GetTempPath(),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Utf8NoBom,
                StandardErrorEncoding = Utf8NoBom,
            };
            psi.ArgumentList.Add("serve");
            _started = Process.Start(psi);
            _log.LogInformation("Started ollama serve from {Exe}", exe);
        }
        catch (Exception ex)
        {
            _log.LogWarning("Could not start ollama serve from {Exe}: {Msg}", exe, ex.Message);
            return false;
        }

        // Give it a bounded moment to bind, then answer honestly either way.
        for (var i = 0; i < 20; i++)
        {
            await Task.Delay(500, ct);
            if (await TagsAsync(baseUrl, ct) is not null) { Invalidate(); return true; }
        }
        _log.LogWarning("ollama serve was started but nothing is answering on {Url}", baseUrl);
        return false;
    }

    public async Task<EmbedProbe?> ProbeEmbeddingAsync(string model, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(model)) return null;
        try
        {
            // The OpenAI-COMPATIBLE route, deliberately: it is the one AddOpenAiCompatibleEmbedder uses, so
            // a model that answers here is a model the app can actually embed with. Ollama's native
            // /api/embed can accept a model this path rejects, which would make the probe a false yes.
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{BaseUrl}/v1/embeddings")
            {
                Content = new StringContent(
                    JsonSerializer.Serialize(new { model, input = "记忆检索的探测文本 · embedding probe" }),
                    Utf8NoBom, "application/json"),
            };
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromMinutes(3));   // a cold model loads from disk on the first call
            var started = System.Diagnostics.Stopwatch.StartNew();
            using var resp = await Http.SendAsync(req, cts.Token);
            if (!resp.IsSuccessStatusCode)
            {
                _log.LogInformation("embedding probe: {Model} answered {Status}", model, (int)resp.StatusCode);
                return null;
            }
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(cts.Token));
            if (!doc.RootElement.TryGetProperty("data", out var data) || data.GetArrayLength() == 0) return null;
            if (!data[0].TryGetProperty("embedding", out var vec) || vec.ValueKind != JsonValueKind.Array) return null;
            var dims = vec.GetArrayLength();
            return dims > 0 ? new EmbedProbe(dims, (int)started.ElapsedMilliseconds) : null;
        }
        catch (Exception ex)
        {
            _log.LogInformation("embedding probe failed for {Model}: {Msg}", model, ex.Message);
            return null;
        }
    }

    public async Task PullModelAsync(string model, Action<int, string?>? onProgress = null,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(model)) throw new ArgumentException("model is required", nameof(model));
        if (!await EnsureServingAsync(ct))
            throw new InvalidOperationException("Ollama 未运行,无法下载模型。");

        var baseUrl = BaseUrl;
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/api/pull")
        {
            Content = new StringContent(
                JsonSerializer.Serialize(new { model, stream = true }), Utf8NoBom, "application/json"),
        };
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromHours(2));      // a multi-GB model on a slow line is not a hang
        using var resp = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.EnsureSuccessStatusCode();

        // NDJSON: {"status":"pulling …","total":N,"completed":M} … then {"status":"success"}
        await using var stream = await resp.Content.ReadAsStreamAsync(cts.Token);
        using var reader = new StreamReader(stream, Utf8NoBom);
        string? line;
        var ok = false;
        while ((line = await reader.ReadLineAsync(cts.Token)) is not null)
        {
            if (line.Length == 0) continue;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                if (root.TryGetProperty("error", out var err))
                    throw new InvalidOperationException($"Ollama 拒绝下载:{err.GetString()}");
                var status = root.TryGetProperty("status", out var st) ? st.GetString() : null;
                if (status is not null && status.Contains("success", StringComparison.OrdinalIgnoreCase)) ok = true;
                if (root.TryGetProperty("total", out var t) && root.TryGetProperty("completed", out var c)
                    && t.TryGetInt64(out var total) && c.TryGetInt64(out var done) && total > 0)
                    onProgress?.Invoke((int)(done * 100 / total), status);
                else
                    onProgress?.Invoke(0, status);
            }
            catch (JsonException) { /* a partial line mid-stream is not a failure */ }
        }
        Invalidate();
        if (!ok) throw new InvalidOperationException("模型下载未完成(Ollama 未报告成功)。");
    }
}
