using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Gatherlight.Server.Platform.Hosting.Resources.Services;
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>What the claude CLI actually is on THIS machine, right now. Every field is observed, never
/// assumed: <see cref="Path"/> is a file we resolved, <see cref="LoggedIn"/> is what the CLI itself
/// reported. <see cref="Problem"/> is null when a run would succeed — it is the one sentence the household
/// reads when it would not.</summary>
public sealed record ClaudeCliState(
    string? Path,
    string? Version,
    bool Runnable,
    bool LoggedIn,
    string? Account,
    string? Problem)
{
    /// <summary>Ready = present, runnable AND authenticated. Anything less cannot serve a chat turn.</summary>
    public bool Ready => Runnable && LoggedIn;
}

public interface IClaudeCliRuntime
{
    /// <summary>The claude executable this install would spawn, or null when there is nothing on disk and
    /// no <c>claude</c> on PATH. Re-resolves until it finds one — the 资源 panel can install it mid-life.</summary>
    string? Locate();

    /// <summary>Ask the CLI what it is and whether it is signed in. Cached briefly (the panel polls);
    /// <paramref name="refresh"/> forces a re-probe after provisioning or a login. Never throws.</summary>
    Task<ClaudeCliState> ProbeAsync(bool refresh = false, CancellationToken ct = default);

    /// <summary>Point Lyntai's per-spawn command resolution at a provisioned CLI by setting
    /// <c>CLAUDE_CMD</c>. A pre-existing override (tests, an operator's own path) always wins.</summary>
    void Apply();

    /// <summary>Drop the cached probe — called after provisioning, so the panel reflects it at once.</summary>
    void Invalidate();
}

/// <summary>
/// Resolves and inspects the claude CLI. This exists because the CLI was an ASSUMED machine dependency:
/// a fresh install spawned the PATH <c>claude</c> that was not there and died with a raw Win32
/// "系统找不到指定的文件" in 17ms, surfaced to the household as "计划阶段未能完成(CLI 报告错误)" — a sentence
/// that names neither the cause nor a fix. It is the same class of failure as the missing git that
/// <see cref="Migration.Steps.GitRuntimeStep"/> exists for, with one difference that changes the design:
/// git is BOOT-essential, so startup downloads it inline; claude is PRODUCT-essential but not boot-
/// essential, so blocking the boot on a ~265 MB download would be wrong. The app comes up, says what is
/// missing, and the 资源 panel — reachable precisely because we did not gate — installs it.
///
/// <para>Resolution order mirrors <c>GitCliService.LocateGit</c>: an explicit override, else the portable
/// CLI provisioned into the data folder, else a copy bundled next to the host, else PATH. It re-resolves
/// per call until it finds a real file, because DI builds this singleton long before the download that
/// changes the answer — resolving once in the constructor is the exact trap that left a freshly installed
/// git invisible to a retry.</para>
///
/// <para>The seam into Lyntai is <c>CLAUDE_CMD</c>, not a constructor argument, and that is deliberate:
/// <c>ClaudeAgentSession</c> resolves its command INSIDE the run (per spawn), while
/// <c>AddClaudeCliAgentSession(command)</c> captures its argument once at DI registration. Only the env
/// var can carry an answer that changed after startup — which is the whole point of a mid-life install.</para>
/// </summary>
public sealed class ClaudeCliRuntime : IClaudeCliRuntime
{
    private static readonly UTF8Encoding Utf8NoBom = new(false);
    private static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(30);

    /// <summary>Last resort: whatever "claude" PATH resolves to. Not a resolution — a guess, and on a
    /// fresh household machine a wrong one. CreateProcess appends .exe and searches PATH, so this works
    /// wherever a real install exists; where it does not, the probe says so rather than the chat turn.</summary>
    private const string PathFallback = "claude";

    /// <summary>The env seams Lyntai reads, in ITS precedence order. An operator or a test that set any of
    /// these has chosen the CLI deliberately, and <see cref="Apply"/> must not overrule that choice —
    /// the e2e stub is exactly this case, and clobbering it would silently test a real claude.</summary>
    private static readonly string[] Overrides = { "LYNTAI_PROVIDER_CMD", "CLAUDE_CMD", "GATHERLIGHT_CLAUDE_CMD" };

    private readonly IPlatformContext _platform;
    private readonly ILogger<ClaudeCliRuntime> _log;
    private readonly object _gate = new();
    private ClaudeCliState? _cached;
    private DateTimeOffset _cachedAt;
    private string? _applied;

    public ClaudeCliRuntime(IPlatformContext platform, ILogger<ClaudeCliRuntime> log)
    {
        _platform = platform;
        _log = log;
    }

    private static string? ExplicitOverride()
    {
        foreach (var name in Overrides)
        {
            var v = Environment.GetEnvironmentVariable(name);
            if (!string.IsNullOrWhiteSpace(v)) return v;
        }
        return null;
    }

    public string? Locate()
    {
        // An override may be a whole command line ("node stub.mjs"), not a path — hand it back verbatim and
        // let Lyntai's tokenizer deal with it. Probing still works: we spawn it the same way Lyntai does.
        var over = ExplicitOverride();
        if (over is not null) return over;

        var provisioned = ResourceProvisioner.ProvisionedClaude(_platform.ResourcesPath);
        if (File.Exists(provisioned)) return provisioned;

        var bundled = System.IO.Path.Combine(AppContext.BaseDirectory, "claude", "claude.exe");
        if (File.Exists(bundled)) return bundled;

        return PathFallback;
    }

    public void Apply()
    {
        if (ExplicitOverride() is not null) return;          // a deliberate choice outranks ours
        var provisioned = ResourceProvisioner.ProvisionedClaude(_platform.ResourcesPath);
        if (!File.Exists(provisioned)) return;               // nothing of ours to point at; PATH stands
        // Log the SWITCH, not the state. This runs on every probe (see ProbeAsync) and the panel polls
        // it while a download is in flight — logging unconditionally would bury the file log in a line
        // per second that says nothing new.
        if (!string.Equals(_applied, provisioned, StringComparison.OrdinalIgnoreCase))
        {
            _applied = provisioned;
            _log.LogInformation("Agent CLI: using the provisioned claude at {Path}", provisioned);
        }
        Environment.SetEnvironmentVariable("CLAUDE_CMD", provisioned);
    }

    public void Invalidate()
    {
        lock (_gate) { _cached = null; }
    }

    public async Task<ClaudeCliState> ProbeAsync(bool refresh = false, CancellationToken ct = default)
    {
        // Apply on every probe, not just at startup. A CLI installed from the 资源 panel appears AFTER the
        // startup step ran, and the panel polls this endpoint — so the first poll after the download points
        // Lyntai at the new binary and the next chat just works. Without it the household would have to
        // restart the server to use something the app had just finished installing, which is the p49
        // "git appears mid-life" lesson repeated. Cheap enough to be unconditional: one File.Exists.
        Apply();

        lock (_gate)
        {
            if (!refresh && _cached is not null && DateTimeOffset.UtcNow - _cachedAt < CacheFor)
                return _cached;
        }

        var state = await MeasureAsync(ct);
        lock (_gate) { _cached = state; _cachedAt = DateTimeOffset.UtcNow; }
        return state;
    }

    private async Task<ClaudeCliState> MeasureAsync(CancellationToken ct)
    {
        var exe = Locate();
        var version = ReadInstalledVersion();

        // `auth status --json` is the whole probe: it proves the binary RUNS (installed is not usable —
        // a blocked exe, a half-extracted download and a wrong architecture all look fine on disk) and it
        // reports the login state as data rather than as prose. Exit code is 1 when signed out, and the
        // JSON is still on stdout, so parse first and treat the exit code as a hint.
        var (ok, stdout, err) = await RunAsync(exe, new[] { "auth", "status", "--json" }, ct);
        if (!ok)
        {
            return new ClaudeCliState(
                Path: null, Version: version, Runnable: false, LoggedIn: false, Account: null,
                Problem: "未找到可用的 Claude CLI —— 请在「资源」面板下载,或自行安装后重启应用。");
        }

        try
        {
            using var doc = JsonDocument.Parse(stdout);
            var root = doc.RootElement;
            var loggedIn = root.TryGetProperty("loggedIn", out var li) && li.ValueKind == JsonValueKind.True;
            string? account = null;
            if (root.TryGetProperty("email", out var em) && em.ValueKind == JsonValueKind.String)
                account = em.GetString();
            if (root.TryGetProperty("subscriptionType", out var st) && st.ValueKind == JsonValueKind.String)
                account = account is null ? st.GetString() : $"{account}({st.GetString()})";

            return new ClaudeCliState(
                Path: exe, Version: version, Runnable: true, LoggedIn: loggedIn, Account: account,
                // The app can DETECT this exactly and cannot fix it: `claude auth login` is a browser flow
                // with no headless variant, so the household completes it once, by hand. Saying which
                // command, on which machine, is the entire remedy — so say it.
                Problem: loggedIn
                    ? null
                    : "Claude CLI 尚未登录 —— 请在本机命令行运行 `claude auth login` 完成一次登录后重试。");
        }
        catch (JsonException)
        {
            // It ran but did not answer in the shape we parse — a version older than `auth status --json`,
            // or something wrapping the binary. Report the truth (we cannot tell) rather than a guess.
            _log.LogWarning("claude auth status returned unparseable output: {Out}", Trim(stdout, 200));
            return new ClaudeCliState(
                Path: exe, Version: version, Runnable: true, LoggedIn: false, Account: null,
                Problem: "无法确认 Claude CLI 的登录状态(输出格式不符)—— 请在「资源」面板更新到最新版本。" +
                         (string.IsNullOrWhiteSpace(err) ? "" : $" 详情:{Trim(err, 120)}"));
        }
    }

    private string? ReadInstalledVersion() =>
        ResourceProvisioner.InstalledClaudeVersion(_platform.ResourcesPath);

    /// <summary>Spawn the CLI the way Lyntai does — ArgumentList only (never a shell), BOM-less UTF-8 both
    /// directions, from a NEUTRAL cwd so the data folder's CLAUDE.md and knowledge base are not loaded for
    /// what is a one-line status query. Returns ok=false when the process could not be started at all.</summary>
    private async Task<(bool Ok, string Stdout, string Stderr)> RunAsync(
        string? exe, string[] args, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(exe)) return (false, "", "");

        // An override can carry prefix args ("node stub.mjs"); split the leading token off so we spawn the
        // program and pass the rest through, matching Lyntai's own quote-aware resolution closely enough
        // for a status probe.
        var (file, prefix) = SplitCommand(exe);

        var psi = new ProcessStartInfo
        {
            FileName = file,
            WorkingDirectory = System.IO.Path.GetTempPath(),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Utf8NoBom,
            StandardErrorEncoding = Utf8NoBom,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in prefix) psi.ArgumentList.Add(a);
        foreach (var a in args) psi.ArgumentList.Add(a);

        try
        {
            using var p = Process.Start(psi);
            if (p is null) return (false, "", "");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            var stdout = await p.StandardOutput.ReadToEndAsync(timeout.Token);
            var stderr = await p.StandardError.ReadToEndAsync(timeout.Token);
            await p.WaitForExitAsync(timeout.Token);
            return (true, stdout, stderr);
        }
        catch (OperationCanceledException)
        {
            return (false, "", "probe timed out");
        }
        catch (Exception ex)
        {
            // The Win32 "file not found" lands here. Log the real reason once; the caller turns it into a
            // sentence about claude rather than re-surfacing a localized OS string nobody can act on.
            _log.LogInformation("claude probe could not start '{Exe}': {Msg}", exe, ex.Message);
            return (false, "", ex.Message);
        }
    }

    private static (string File, IReadOnlyList<string> Prefix) SplitCommand(string command)
    {
        var trimmed = command.Trim();
        if (trimmed.StartsWith('"'))
        {
            var close = trimmed.IndexOf('"', 1);
            if (close > 1)
                return (trimmed[1..close], Tokenize(trimmed[(close + 1)..]));
        }
        var space = trimmed.IndexOf(' ');
        return space < 0 ? (trimmed, Array.Empty<string>()) : (trimmed[..space], Tokenize(trimmed[space..]));
    }

    private static IReadOnlyList<string> Tokenize(string rest) =>
        rest.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(t => t.Trim('"'))
            .ToArray();

    private static string Trim(string s, int max)
    {
        s = s.Trim();
        return s.Length <= max ? s : s[..max] + "…";
    }
}
