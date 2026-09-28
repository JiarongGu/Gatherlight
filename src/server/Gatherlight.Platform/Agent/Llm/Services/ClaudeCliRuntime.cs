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

/// <summary>Whose Claude login the app's own spawns use.</summary>
public enum ClaudeSessionMode
{
    /// <summary>The machine's — whatever the household is signed in as in their own terminal. The default,
    /// and what every version before this did: nothing is set, so the CLI finds its usual config dir.</summary>
    Machine,

    /// <summary>The app's own, in <c>{data}/state/resources/claude/home</c>. Separate account, separate
    /// quota — and it does not travel in a backup, because the export carries plans/household/.claude/ui/
    /// uploads and .git, never <c>state/</c>, which is where an OAuth token belongs if it is anywhere.</summary>
    App,
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
    /// <c>CLAUDE_CMD</c>, and its credential home at the chosen SESSION by setting
    /// <c>CLAUDE_CONFIG_DIR</c>. A pre-existing override (tests, an operator's own path) always wins.</summary>
    void Apply();

    /// <summary>Which login the app's own spawns use.
    ///
    /// <para><b>Why this is a choice and not a constant.</b> The CLI keeps credentials in a config
    /// directory, so every process started as the same OS user shares one session — the app was signed in
    /// as whoever the household signs in as in their own terminal. Fine when those are the same account,
    /// wrong when they are not: somebody may want their personal account for their own work and a family or
    /// team account for the planner, and had no way to say so. Verified 2026-08-22 that
    /// <c>CLAUDE_CONFIG_DIR</c> isolates it completely — the same binary reported
    /// <c>loggedIn:false, authMethod:none</c> against a fresh directory while the machine session stayed
    /// signed in, and wrote its own <c>.claude.json</c> there.</para></summary>
    ClaudeSessionMode SessionMode { get; }

    /// <summary>Where the app's own credentials live, whether or not that session is the one in use.</summary>
    string AppSessionHome { get; }

    /// <summary>Choose which login the app uses. LIVE — the next spawn picks it up, because the variable is
    /// re-applied on every probe rather than captured once at startup.</summary>
    void SetSessionMode(ClaudeSessionMode mode);

    /// <summary>The last probe, WITHOUT spawning anything — null when nothing has asked yet.
    ///
    /// <para>For a caller that must not block on a process start: the probe costs ~0.6–0.9 s and 资源 was
    /// awaiting it before it could render ANY row, so one row's extra question held up a whole panel of
    /// file checks. The caller reads this, renders, and lets a background refresh fill the gap.</para></summary>
    ClaudeCliState? Cached { get; }

    /// <summary>Sign OUT of the app's own session. Refuses when the app shares the machine's login — that
    /// credential belongs to the household's own terminal, and signing them out of it from our panel is the
    /// same overreach as deleting models out of a daemon we did not install.</summary>
    Task<bool> LogoutAsync(CancellationToken ct = default);

    /// <summary>Drop the cached probe — called after provisioning, so the panel reflects it at once.</summary>
    void Invalidate();

    /// <summary>Which shell the agent's Bash tool uses, for the 资源 Git-Bash row — the household's own Git
    /// for Windows if the CLI discovers one, else the provisioned PortableGit if installed, else none (the
    /// agent has no shell and uses the file tools). Null off Windows. Never spawns.</summary>
    string? AgentShellDetail();

    /// <summary>Start <c>claude auth login</c> in a window the household can see, and return at once.
    ///
    /// <para><b>Why the app has to do this rather than print a command.</b> The instruction we gave was
    /// "run `claude auth login` in a terminal", which is unactionable in exactly the case we created: a CLI
    /// installed through 资源 lives in <c>{data}/state/resources/claude/</c> and that directory is never
    /// added to PATH — we resolve it internally and pass <c>CLAUDE_CMD</c>. So a household who took our
    /// download offer, typed our instruction, and got "command not found" was following advice that could
    /// not work. This spawns the RESOLVED binary, whatever it turned out to be.</para>
    ///
    /// <para>It cannot COMPLETE the login: the flow opens a browser and waits for a human, and there is no
    /// headless variant. What it removes is the household having to find a path we never told them. Returns
    /// false when there is no binary to run, or when an attempt is already open — a second console window
    /// for the same flow is confusing, not helpful.</para></summary>
    bool StartLogin();
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

    /// <summary>The env seams an operator or a test may set, in Lyntai's precedence order. One that set any of
    /// these has chosen the CLI deliberately, and <see cref="Apply"/> must not overrule that choice — the e2e stub
    /// is exactly this case, and clobbering it would silently test a real claude. <c>LYNTAI_PROVIDER_CMD</c> is read
    /// as it was at LAUNCH (<see cref="LaunchedProviderCommand"/>): since round 6 the app itself writes it, to carry
    /// <see cref="IsolationArgs"/>, so its live value is ours.</summary>
    private static readonly string[] Overrides = { "CLAUDE_CMD", "GATHERLIGHT_CLAUDE_CMD" };

    /// <summary>Every claude CLI run Lyntai starts — the agent session and the one-shot provider alike — is told to
    /// read NO configuration of the household's: <c>--setting-sources project</c> drops the USER scope (the machine
    /// account's own settings, hooks, permissions, skills, plugins, env and apiKeyHelper in "machine" login mode) and
    /// the LOCAL scope (<c>.claude/settings.local.json</c>, where Claude Code saves a permission the household
    /// approves interactively, and <c>CLAUDE.local.md</c>); <c>--strict-mcp-config</c> drops a project
    /// <c>.mcp.json</c> (and claude.ai connectors), leaving only the servers the app passes with <c>--mcp-config</c>.
    /// The app's own <c>--settings</c> file — the scope guard's hook included — still applies.
    /// <para><b>The PROJECT scope stays, and it has to</b>: it is what loads the site's knowledge base — the data
    /// folder's <c>CLAUDE.md</c>, <c>.claude/rules</c>, skills, agents and commands. So a project
    /// <c>.claude/settings.json</c> is still READ by the app's runs; the agent cannot write it (PROTECTED), and
    /// <c>ProjectConfigBackstop</c> undoes a run that changed it anyway. What the household put in it themselves that
    /// would take a run off the subscription — an <c>apiKeyHelper</c>, an API key, a provider or an endpoint in its
    /// <c>env</c> — is blanked by the app's own <c>--settings</c>, which outrank it per key
    /// (<c>ChatEnvironmentService.BuildChatSettings</c>). All of it measured on CLI 2.1.283 at 0 tokens
    /// (<c>docs/self-managed-llm-runtime.md</c>, 2026-09-28 and 2026-09-29).</para>
    /// <para><b>Why through the command.</b> Lyntai's <c>ClaudeAgentOptions</c> has no seam for an extra flag (Lyntai
    /// <c>TASKS.md</c> Part 332). Its command variables are tokenised into an executable plus PREFIX arguments, which
    /// both the agent session and the one-shot provider put ahead of their own — so the app writes
    /// <c>LYNTAI_PROVIDER_CMD</c>, the variable Lyntai reads first, as the resolved command plus these flags. The app's
    /// own spawns use <see cref="Locate"/>, which never carries them: the <c>auth status</c> probe adds them itself, so it
    /// reports the account a run will use; <c>logout</c> and the login window do not, since they act on the session.
    /// When Part 332 lands, the flags move onto the options and this composition goes.</para></summary>
    public static readonly IReadOnlyList<string> IsolationArgs = ["--setting-sources", "project", "--strict-mcp-config"];

    private static readonly string IsolationSuffix = " " + string.Join(' ', IsolationArgs);

    /// <summary><c>LYNTAI_PROVIDER_CMD</c> as the process was launched with it (our own suffix stripped, so a relaunch
    /// that inherited the composed value does not compose it twice). Captured on first touch of this type, which
    /// <c>GatherlightApp.Build</c> makes before anything writes the variable (<see cref="PinProviderCommand"/>).</summary>
    private static readonly string? LaunchedProviderCommand = StripIsolation(Environment.GetEnvironmentVariable("LYNTAI_PROVIDER_CMD"));

    private static string? StripIsolation(string? command)
    {
        if (string.IsNullOrWhiteSpace(command)) return null;
        var c = command.Trim();
        while (c.EndsWith(IsolationSuffix, StringComparison.Ordinal)) c = c[..^IsolationSuffix.Length].TrimEnd();
        return c.Length == 0 ? null : c;
    }

    /// <summary>The command line Lyntai runs: <paramref name="command"/> (quoted when it is a bare path holding a
    /// space) plus <see cref="IsolationArgs"/>, exactly once.</summary>
    public static string ProviderCommand(string command, bool isPath)
    {
        var c = StripIsolation(command) ?? PathFallback;
        if (isPath && c.Contains(' ') && !c.StartsWith('"')) c = $"\"{c}\"";
        return c + IsolationSuffix;
    }

    /// <summary>Called once at startup, before anything can spawn a CLI: the variable Lyntai reads first is set from
    /// what is known without the container — an override, or PATH's claude. <see cref="Apply"/> refines it once the
    /// provisioned copy is known.</summary>
    public static void PinProviderCommand()
    {
        var over = ExplicitOverride();
        Environment.SetEnvironmentVariable("LYNTAI_PROVIDER_CMD", ProviderCommand(over ?? PathFallback, isPath: false));
    }

    private readonly IPlatformContext _platform;
    private readonly ILogger<ClaudeCliRuntime> _log;
    private readonly object _gate = new();
    private ClaudeCliState? _cached;
    private DateTimeOffset _cachedAt;
    private string? _applied;

    private readonly Kernel.Services.IAppConfigService? _appConfig;

    /// <summary>The key the session choice lives under. <c>app_config</c> rather than settings.json for the
    /// same reason 判断's on/off is: it is read PER CALL, so it takes effect on the next spawn instead of at
    /// the next restart, and nothing here has to exist before the database opens.</summary>
    private const string SessionKey = "claude.session";

    public string AppSessionHome =>
        System.IO.Path.Combine(_platform.ResourcesPath, "claude", "home");

    public ClaudeSessionMode SessionMode =>
        string.Equals(_appConfig?.Get(SessionKey), "app", StringComparison.OrdinalIgnoreCase)
            ? ClaudeSessionMode.App : ClaudeSessionMode.Machine;

    public ClaudeCliState? Cached { get { lock (_gate) return _cached; } }

    public void SetSessionMode(ClaudeSessionMode mode)
    {
        if (_appConfig is null) return;
        _appConfig.Set(SessionKey, mode == ClaudeSessionMode.App ? "app" : "machine");
        // The stored login state belongs to the OLD session, so it is not merely stale — it is about a
        // different account. Dropping it forces the next probe to ask the session just switched to.
        Invalidate();
        Apply();
        _log.LogInformation("Agent CLI: session set to {Mode}", mode);
    }

    public async Task<bool> LogoutAsync(CancellationToken ct = default)
    {
        // The machine's login is the household's own. Signing them out of their terminal from our panel is
        // the overreach this codebase already had to unlearn once, with somebody else's model daemon.
        if (SessionMode != ClaudeSessionMode.App) return false;
        var exe = Locate();
        if (exe is null) return false;
        Apply();
        var run = await RunAsync(exe, new[] { "auth", "logout" }, ct);
        var (ok, err) = (run.Ok, run.Stderr);
        Invalidate();
        if (!ok) _log.LogWarning("claude auth logout failed: {Err}", Trim(err, 200));
        else _log.LogInformation("Agent CLI: signed out of the app's own session");
        return ok;
    }

    public ClaudeCliRuntime(IPlatformContext platform, ILogger<ClaudeCliRuntime> log,
        Kernel.Services.IAppConfigService? appConfig = null)
    {
        _platform = platform;
        _log = log;
        _appConfig = appConfig;
    }

    /// <summary>The operator's (or a test's) chosen command, or null. Given <paramref name="resourcesPath"/>, a value that
    /// names the app's OWN copy of the CLI is not an override: the app writes <c>CLAUDE_CMD</c> itself for the
    /// provisioned copy (and a relaunched app inherits it, and the composed <c>LYNTAI_PROVIDER_CMD</c> with it), so read
    /// as a choice it froze the command after the first probe — unquoted, which splits a path holding a space.</summary>
    private static string? ExplicitOverride(string? resourcesPath = null)
    {
        if (LaunchedProviderCommand is { } launched && !NamesOurCopy(launched, resourcesPath)) return launched;
        foreach (var name in Overrides)
        {
            var v = Environment.GetEnvironmentVariable(name);
            if (!string.IsNullOrWhiteSpace(v) && !NamesOurCopy(v, resourcesPath)) return v;
        }
        return null;
    }

    // Whether a command line is exactly the app's provisioned or bundled claude (one token, quoted or not).
    private static bool NamesOurCopy(string command, string? resourcesPath)
    {
        if (resourcesPath is null) return false;
        var c = command.Trim();
        if (c.Length >= 2 && c[0] == '"' && c[^1] == '"' && c.IndexOf('"', 1) == c.Length - 1) c = c[1..^1];
        return string.Equals(c, ResourceProvisioner.ProvisionedClaude(resourcesPath), StringComparison.OrdinalIgnoreCase)
            || string.Equals(c, System.IO.Path.Combine(AppContext.BaseDirectory, "claude", "claude.exe"), StringComparison.OrdinalIgnoreCase);
    }

    public string? Locate()
    {
        // An override may be a whole command line ("node stub.mjs"), not a path — hand it back verbatim and
        // let Lyntai's tokenizer deal with it. Probing still works: we spawn it the same way Lyntai does.
        var over = ExplicitOverride(_platform.ResourcesPath);
        if (over is not null) return over;

        var provisioned = ResourceProvisioner.ProvisionedClaude(_platform.ResourcesPath);
        if (File.Exists(provisioned)) return provisioned;

        var bundled = System.IO.Path.Combine(AppContext.BaseDirectory, "claude", "claude.exe");
        if (File.Exists(bundled)) return bundled;

        return PathFallback;
    }

    public void Apply()
    {
        // The SESSION is applied even when the COMMAND is not: a household using their own machine-wide
        // claude may still want the app signed in as a different account, and those are separate questions.
        // Cleared rather than left set when they share the machine's login — a stale CLAUDE_CONFIG_DIR
        // would silently keep the app on an account they had just switched away from.
        if (SessionMode == ClaudeSessionMode.App)
        {
            Directory.CreateDirectory(AppSessionHome);
            Environment.SetEnvironmentVariable("CLAUDE_CONFIG_DIR", AppSessionHome);
        }
        else
        {
            Environment.SetEnvironmentVariable("CLAUDE_CONFIG_DIR", null);
        }

        // Guarantee the agent a shell the app can guard — BEFORE the claude-override return, because a
        // household running their own claude still needs a Git Bash the CLI will use.
        ApplyGitBash();

        // What Lyntai runs is what Locate() resolves, plus the isolation flags — set on EVERY Apply, before the
        // override return, so an override (the e2e stub) carries them too.
        var located = Locate() ?? PathFallback;
        var isPath = ExplicitOverride(_platform.ResourcesPath) is null && !string.Equals(located, PathFallback, StringComparison.Ordinal);
        var providerCommand = ProviderCommand(located, isPath);
        if (!string.Equals(_appliedProvider, providerCommand, StringComparison.Ordinal))
        {
            _appliedProvider = providerCommand;
            _log.LogInformation("Agent CLI: Lyntai runs {Command}", providerCommand);
        }
        Environment.SetEnvironmentVariable("LYNTAI_PROVIDER_CMD", providerCommand);

        if (ExplicitOverride(_platform.ResourcesPath) is not null) return;   // a deliberate choice outranks ours
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

    // The provider command last written, so the switch is logged once rather than on every probe.
    private static string? _appliedProvider;

    // The last git-bash path the app set, so a later probe can tell its own value from the household's. STATIC, because
    // the variable it describes is process-wide and the desktop host builds a new runtime on every in-process server
    // restart: per instance, the next runtime read the value the previous one set as the HOUSEHOLD'S and never updated
    // or cleared it again (round-6 review). A value naming our own provisioned bash.exe is ours besides, whoever set it
    // — a relaunched app inherits it from the process before (IsOurGitBash).
    private static string? _appliedGitBash;

    private bool IsOurGitBash(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        if (string.Equals(value, _appliedGitBash, StringComparison.OrdinalIgnoreCase)) return true;
        try
        {
            return string.Equals(System.IO.Path.GetFullPath(value),
                System.IO.Path.GetFullPath(ProvisionedGitBashPath(_platform.ResourcesPath)), StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    /// <summary>Point the CLI at a Git Bash the app can guard, on Windows, when it would otherwise find NONE.
    ///
    /// <para><b>Why.</b> The scope guard runs behind the CLI's <c>Bash</c> tool, which needs a POSIX shell —
    /// Git Bash. Without one the CLI falls back to the <c>PowerShell</c> tool, which <see cref="UnguardedTools"/>
    /// removes from every run — so a household with no Git Bash has no shell at all (the file tools are the
    /// substitute). If they install our provisioned PortableGit, this hands the CLI its <c>bin\bash.exe</c> so
    /// the agent gets a guarded Bash. MinGit — what the DATA REPO runs on — ships no <c>bash.exe</c> and cannot
    /// serve (measured, <c>docs/self-managed-llm-runtime.md</c>), which is why this is a separate resource.</para>
    ///
    /// <para><b>Never overrules the household.</b> Their own <c>CLAUDE_CODE_GIT_BASH_PATH</c>, or a Git for
    /// Windows the CLI already discovers (<c>C:\Program Files\Git</c>, <c>(x86)</c>, or <c>git</c> on PATH →
    /// <c>..\..\bin\bash.exe</c>), wins — we set the variable only when the CLI would find nothing. Re-applied
    /// per probe, so a PortableGit installed mid-life is adopted with no restart; cleared (if we set it) once a
    /// real Git Bash appears.</para></summary>
    private void ApplyGitBash()
    {
        if (!OperatingSystem.IsWindows()) return;

        var current = Environment.GetEnvironmentVariable("CLAUDE_CODE_GIT_BASH_PATH");
        // Set by the household (or anything other than us) → leave it entirely.
        if (!string.IsNullOrWhiteSpace(current) && !IsOurGitBash(current))
            return;

        // The CLI can already find one → do not compete; drop ours if we had set it.
        if (GitBashDiscoverable())
        {
            if (_appliedGitBash is not null || IsOurGitBash(current))
            {
                Environment.SetEnvironmentVariable("CLAUDE_CODE_GIT_BASH_PATH", null);
                _appliedGitBash = null;
                _log.LogInformation("Agent shell: a Git Bash is now discoverable; using it instead of the provisioned one");
            }
            return;
        }

        var provisioned = ProvisionedGitBash(_platform.ResourcesPath);
        if (provisioned is null)
        {
            // Nothing to offer yet. If we had set one and it has since vanished, stop naming it.
            if (_appliedGitBash is not null || IsOurGitBash(current))
            {
                Environment.SetEnvironmentVariable("CLAUDE_CODE_GIT_BASH_PATH", null);
                _appliedGitBash = null;
            }
            return;
        }

        if (!string.Equals(_appliedGitBash, provisioned, StringComparison.OrdinalIgnoreCase))
        {
            _appliedGitBash = provisioned;
            _log.LogInformation("Agent shell: the CLI found no Git Bash, so using the provisioned one at {Path}", provisioned);
        }
        Environment.SetEnvironmentVariable("CLAUDE_CODE_GIT_BASH_PATH", provisioned);
    }

    public string? AgentShellDetail()
    {
        if (!OperatingSystem.IsWindows()) return null;
        var household = Environment.GetEnvironmentVariable("CLAUDE_CODE_GIT_BASH_PATH");
        if (!string.IsNullOrWhiteSpace(household) && !IsOurGitBash(household))
            return "系统已设置了 Git Bash,规划助手用它作为命令行(应用不改这个设置)。";
        if (GitBashDiscoverable())
            return "系统已装 Git for Windows,规划助手用它作为命令行 —— 无需下载。";
        if (ProvisionedGitBash(_platform.ResourcesPath) is not null)
            return "规划助手用这个 Git Bash 作为命令行(应用能对它把关)。";
        return "规划助手默认没有可用的命令行。下载后它就有一个应用能把关的命令行(移动/整理文件、跑技能脚本);"
            + "不下载也行,助手仍可用文件工具(移动/重命名/删除、看大小)和读取/搜索。";
    }

    /// <summary>The provisioned PortableGit's <c>bin\bash.exe</c> — a real Git-for-Windows bash the CLI drives,
    /// unlike MinGit's — or null when it is not installed.</summary>
    public static string? ProvisionedGitBash(string resourcesPath)
    {
        var bash = ProvisionedGitBashPath(resourcesPath);
        return File.Exists(bash) ? bash : null;
    }

    private static string ProvisionedGitBashPath(string resourcesPath) =>
        System.IO.Path.Combine(resourcesPath, "git-bash", "bin", "bash.exe");

    private static bool? _gitBashDiscoverableCache;

    /// <summary>Would the CLI find a Git Bash on its own? Mirrors its discovery order (its docs): the
    /// default installs, then <c>git</c> on PATH's sibling <c>..\bin\bash.exe</c>. Used to NOT set our
    /// variable when the household already has one.
    /// <para><b>No spawn, cached.</b> This ran on every <see cref="ApplyGitBash"/> probe AND every 资源
    /// render (<see cref="AgentShellDetail"/>), and it used to <c>Process.Start("where.exe git")</c> —
    /// up to 3 s on the request path, the exact "a panel must not await a process" trap. It now SCANS the
    /// PATH directories itself (no child process) and caches the deterministic filesystem result; a Git
    /// Bash installed mid-session is picked up on the next restart, an acceptable rare case. The
    /// <c>GATHERLIGHT_ASSUME_NO_GIT_BASH</c> test seam is read UNCACHED, before the cache, so a fixture can
    /// still force "none" per boot.</para></summary>
    private static bool GitBashDiscoverable()
    {
        if (Environment.GetEnvironmentVariable("GATHERLIGHT_ASSUME_NO_GIT_BASH") == "1") return false;
        return _gitBashDiscoverableCache ??= ScanForGitBash();
    }

    private static bool ScanForGitBash()
    {
        foreach (var root in new[] { @"C:\Program Files\Git", @"C:\Program Files (x86)\Git" })
            if (File.Exists(System.IO.Path.Combine(root, "bin", "bash.exe"))) return true;
        // git on PATH → its sibling ..\bin\bash.exe (a PATH dir is <git>\cmd or <git>\bin). Scan PATH
        // WITHOUT spawning where.exe. Skip a git shim shipped inside a node_modules / virtualenv — not a
        // Git-for-Windows install with a bash beside it.
        var pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var raw in pathVar.Split(System.IO.Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                if (raw.Contains("node_modules", StringComparison.OrdinalIgnoreCase)
                    || raw.Contains(@"\venv", StringComparison.OrdinalIgnoreCase)
                    || raw.Contains(@"\.venv", StringComparison.OrdinalIgnoreCase)) continue;
                var dir = System.IO.Path.TrimEndingDirectorySeparator(raw);
                var hasGit = File.Exists(System.IO.Path.Combine(dir, "git.exe"))
                    || File.Exists(System.IO.Path.Combine(dir, "git.cmd"))
                    || File.Exists(System.IO.Path.Combine(dir, "git"));
                if (!hasGit) continue;
                var gitRoot = System.IO.Path.GetDirectoryName(dir);
                if (gitRoot is not null && File.Exists(System.IO.Path.Combine(gitRoot, "bin", "bash.exe"))) return true;
            }
            catch { /* a malformed PATH entry proves nothing — skip it */ }
        }
        return false;
    }

    // One login attempt at a time. A second window for the same browser flow helps nobody, and the flow is
    // long enough (a human, a browser, an account chooser) that double-clicking is the normal case.
    private Process? _login;

    public bool StartLogin()
    {
        lock (_gate)
        {
            if (_login is { HasExited: false }) return false;
            _login = null;
        }

        var exe = Locate();
        if (exe is null) return false;

        try
        {
            // UseShellExecute + a visible window ON PURPOSE. `claude auth login` prints a URL and waits;
            // with the console hidden the household would see a spinner in our panel and no way to act, and
            // with output redirected the CLI may not treat it as a terminal at all. This is the one spawn in
            // the codebase that WANTS a window — every other one is CreateNoWindow, and the difference is
            // that this one's whole purpose is to be interacted with.
            var p = Process.Start(new ProcessStartInfo(exe)
            {
                Arguments = "auth login",
                UseShellExecute = true,
                CreateNoWindow = false,
                WorkingDirectory = System.IO.Path.GetDirectoryName(exe)!,
            });
            if (p is null) return false;
            lock (_gate) { _login = p; }
            // The probe is stale the moment the household finishes, and we cannot know when that is — so
            // drop it now and let the panel's polling discover the new state rather than caching a "not
            // logged in" answer across the whole flow.
            Invalidate();
            _log.LogInformation("started claude auth login using {Exe}", exe);
            return true;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "could not start claude auth login using {Exe}", exe);
            return false;
        }
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
        //
        // It carries IsolationArgs, ahead of the subcommand, so it reports the account the RUNS will use: a USER-scope
        // apiKeyHelper or Bedrock selector made it answer `api_key_helper` / `bedrock` while every run, which drops that
        // scope, used the subscription (measured at 0 tokens: `auth status` honours --setting-sources, and --settings;
        // docs/self-managed-llm-runtime.md 2026-09-29). Logout and the login window take no flags: they act on the
        // session itself, not on what a run reads.
        var (ok, stdout, err) = await RunAsync(exe, [.. IsolationArgs, "auth", "status", "--json"], ct);
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
                    : "Claude CLI 尚未登录 —— 在「资源 · Resources」面板里点 Claude CLI 那一行的「登录」,\n                        浏览器里完成一次登录后即可。");
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
