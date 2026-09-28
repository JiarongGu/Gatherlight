using System.Collections;
using System.Diagnostics;

namespace Gatherlight.Server.Platform.Kernel.Services;

/// <summary>
/// What a child process of this app inherits from the environment the app was LAUNCHED in, decided in one place, per
/// class of child. A child the app starts works on the app's behalf, so the launcher's own context (a git operation it
/// was in the middle of, the Claude Code session it was typed into, a node it wanted preloaded) is not the child's
/// unless a class below says it is.
///
/// <para><b>Two mechanisms, because not every spawn has a seam.</b></para>
/// <list type="number">
/// <item><b>The whole process forgets the launcher's context at startup</b> (<see cref="ForgetLauncherContext"/>): the
/// repository it named (<see cref="RepositoryVariables"/>), the Claude Code session it belonged to
/// (<see cref="ParentSessionVariables"/>), whatever would take the claude CLI off the subscription login
/// (<see cref="OffSubscriptionVariables"/>), whatever could add the agent a tool past the scope guard
/// (<see cref="AgentToolVariables"/>) and the app's own secrets (<see cref="AppSecretVariables"/>, which the app
/// itself reads through <see cref="Launched"/>). No child the app starts has any use for them, and three spawns cannot be
/// reached per call: Lyntai's CLI runs go through its sealed <c>ProcessRunner</c>, whose <c>environment</c> argument can
/// only SET variables (a BYO <c>IProcessRunner</c> would be the seam, but Lyntai then reports every CLI as available without looking —
/// <c>CliProviderEngine.IsAvailable</c> is optimistic for any runner that is not its own — so a missing CLI would stop
/// being skipped by the router); <c>ClaudeCliRuntime.StartLogin</c> uses ShellExecute, which carries no environment of
/// its own; and Playwright's driver builds its <c>ProcessStartInfo</c> inside the library. All three inherit this
/// process's environment, so that is where the forgetting happens. It is also where the app already talks to Lyntai's
/// CLI spawns: <c>ClaudeCliRuntime.Apply</c> sets <c>CLAUDE_CMD</c> and <c>CLAUDE_CONFIG_DIR</c> here.</item>
/// <item><b>A class that needs less is narrowed at its own spawn</b>: git (<see cref="ForGit"/>), node running code we
/// ship (<see cref="ForPlatformNode"/>), the capability sandbox (<see cref="ForSandbox"/>) and llama.cpp
/// (<see cref="ForLlamaServer"/>).</item>
/// </list>
///
/// <para><b>What every child keeps.</b> Everything else the app was started with: <c>PATH</c>, <c>SystemRoot</c>/
/// <c>windir</c>, <c>TEMP</c>/<c>TMP</c>, <c>USERPROFILE</c>/<c>HOME</c>, the proxy variables and CA settings a network
/// client needs, <c>CLAUDE_CONFIG_DIR</c> and <c>CLAUDE_CMD</c> (the app's own, set by <c>ClaudeCliRuntime.Apply</c>), the
/// app's own <c>GATHERLIGHT_*</c> but its secrets, the subscription login (<c>CLAUDE_CODE_OAUTH_TOKEN</c>) and the
/// household's CLI settings that pick no other account (the model, <c>AWS_*</c>/<c>GOOGLE_*</c> without their switch).
/// The capability sandbox is the exception: it keeps an allow-list and nothing else (<see cref="ForSandbox"/>).</para>
///
/// <para><b>Children left as they are, and why.</b> An external stdio MCP server (<c>StdioMcpConnection.Start</c>) is the
/// household's own program, unsandboxed by design; it loses only what the whole process forgot, because its environment
/// is otherwise the household's to configure (a proxy, a CA file, their own <c>NODE_OPTIONS</c>) and the app has no
/// policy over what it needs. The same holds for the claude CLI and its agent's Bash, which are the household's
/// authenticated CLI, and for 系统模式's <c>npm run build</c>, a developer's toolchain. <c>where.exe</c> lookups read only
/// PATH/PATHEXT. The desktop host's ShellExecute launches (the launcher, a restart, opening a folder or URL) inherit
/// this process's environment too, already cleaned.</para>
///
/// <para>Names are matched case-insensitively on Windows, where the environment is.</para>
/// </summary>
public static class ChildEnvironment
{
    private static StringComparison Cmp =>
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    // ---- 1 · every child: the launcher's repository and its Claude Code session -------------------------------------

    /// <summary>The variables that NAME the repository a git works on (or a part of it), or reconfigure one from outside
    /// it. None of them is ever ours to inherit: the app locates its repositories by working directory and configures
    /// them in their own <c>.git/config</c>. Forgotten by the whole process at startup, and stripped again from every git
    /// the app starts (<see cref="ForGit"/>).
    /// <list type="bullet">
    /// <item><c>GIT_DIR</c>, <c>GIT_WORK_TREE</c>, <c>GIT_COMMON_DIR</c> — the repository, its working tree, the shared
    /// half of a worktree's repository.</item>
    /// <item><c>GIT_INDEX_FILE</c>, <c>GIT_OBJECT_DIRECTORY</c>, <c>GIT_ALTERNATE_OBJECT_DIRECTORIES</c>,
    /// <c>GIT_NAMESPACE</c> — its index, its object store (written to, and read from), its ref namespace.</item>
    /// <item><c>GIT_CONFIG</c> — makes <c>git config</c> read AND WRITE that file instead of the repository's: the data
    /// repo's <c>git config user.name Gatherlight</c> would land in someone else's file.</item>
    /// <item><c>GIT_CONFIG_PARAMETERS</c>, <c>GIT_CONFIG_COUNT</c> and its <c>GIT_CONFIG_KEY_n</c>/<c>GIT_CONFIG_VALUE_n</c>
    /// pairs (<see cref="RepositoryPrefixes"/>) — configuration given to the PARENT's command (<c>git -c</c>), exported to
    /// its children; it can carry <c>core.worktree</c> or <c>core.bare</c>, and it answers the data repo's
    /// <c>git config user.name</c> probe, so an injected identity would sign every commit of the audit trail.</item>
    /// <item><c>GIT_EXEC_PATH</c> — the PARENT git's helper directory. Ours may be another build (the provisioned MinGit
    /// beside a system git), and would then run that build's helpers; unset, each git finds its own.</item>
    /// </list>
    /// <para><b>The incident behind the list (2026-09-27).</b> A debugging agent ran <c>git bisect run</c> from a linked
    /// worktree, and bisect run exports <c>GIT_DIR</c> (<c>.git/worktrees/&lt;name&gt;</c>) and <c>GIT_EXEC_PATH</c> to every
    /// child — measured, with <c>GIT_CONFIG_PARAMETERS</c> too when it was started as <c>git -c k=v bisect run</c>. A
    /// fixture server passed them on, so its data-repo commands ran against the developer's MAIN repository: <c>git
    /// init</c> set <c>core.bare = true</c> there, the fixture's commits landed on the worktree's HEAD, and
    /// <c>DataRepoMaintenance</c>'s <c>reflog expire --expire=now --all</c> and <c>gc --prune=now</c> erased every reflog.
    /// The claude CLI and its agent's Bash run git in the data folder too, so the whole process forgets them, not only the
    /// app's own git.</para>
    /// <para><b>Kept, and why.</b> <c>GIT_CONFIG_GLOBAL</c> / <c>GIT_CONFIG_SYSTEM</c> / <c>GIT_CONFIG_NOSYSTEM</c> choose
    /// which of the household's OWN config files are read — never which repository — and the app writes only
    /// repository-local config. <c>GIT_DISCOVERY_ACROSS_FILESYSTEM</c> only widens the walk-up, which the ceiling bounds
    /// anyway. Identity and date overrides (<c>GIT_AUTHOR_*</c>, <c>GIT_COMMITTER_*</c>) change what a commit says, not
    /// where it lands (git hands <c>GIT_AUTHOR_*</c> to a hook, measured — one more reason never to start the app from
    /// one). <c>GIT_EDITOR</c>, <c>GIT_PREFIX</c>, <c>GIT_TRACE*</c>, <c>GIT_PAGER</c> select nothing.</para></summary>
    public static readonly IReadOnlyList<string> RepositoryVariables =
    [
        "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR",
        "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
        "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
        "GIT_EXEC_PATH",
    ];

    /// <summary>Stripped as families: the numbered pairs <c>GIT_CONFIG_COUNT</c> counts.</summary>
    public static readonly IReadOnlyList<string> RepositoryPrefixes = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];

    /// <summary>The variables Claude Code exports to the commands it runs, which tie a process to THAT session: its id,
    /// its pid and executable, the pipe and token of its messaging channel, the IDE port it is attached to, and the flags
    /// saying a process is inside it. All but the IDE port were in the environment of a Bash command a Claude Code
    /// session ran here (2026-09-28), and the installed CLI's binary (2.1.283) names every one of them. So a server started from such a session — the dev
    /// loop, every e2e fixture — handed them to every claude it spawned: the app's agent was announced to the CLI as a
    /// child of the developer's session, with the address of that session's channel. A CLI the app starts belongs to no
    /// session but its own, and it sets these afresh for its own agent's Bash.
    /// <para><c>CLAUDE_EFFORT</c> and <c>TRACEPARENT</c> (with its W3C companion <c>TRACESTATE</c>, which the binary names
    /// too) come from the same per-session builder as the rest (security review, 2026-09-28): the parent session's effort
    /// level, and the trace its commands belong to. Inherited, the app's agent ran at the developer's effort and its spans
    /// joined the developer's trace. <c>AI_AGENT</c> stays: the CLI sets it for itself whatever it inherits.</para>
    /// <para><b>Kept</b>: <c>CLAUDE_CONFIG_DIR</c>, which the app manages itself, and the household's own CLI settings —
    /// the model (<c>ANTHROPIC_MODEL</c>, <c>ANTHROPIC_DEFAULT_*_MODEL</c>) and the like. What moves the CLI off the
    /// subscription login, or sends its requests elsewhere, is <see cref="OffSubscriptionVariables"/>.</para></summary>
    public static readonly IReadOnlyList<string> ParentSessionVariables =
    [
        "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SSE_PORT", "CLAUDE_PID",
        "CLAUDE_EFFORT", "TRACEPARENT", "TRACESTATE",
    ];

    /// <summary>The variables that would move the claude CLI OFF the household's subscription login, or send its requests
    /// — prompts and family data included — somewhere other than Anthropic's API. The rule is "LLM via the authenticated
    /// claude CLI only, never an API key", and until round 6 it held only while nobody set one of these: the CLI's own
    /// documentation ranks every credential below ABOVE the <c>/login</c> subscription, and says an
    /// <c>ANTHROPIC_API_KEY</c> "is always used when present" in <c>-p</c> mode, which is how the app runs it. So an
    /// inherited key billed the household's API account while 资源 said the CLI was signed in. The owner decided
    /// (2026-09-28): strip it, enforce the rule. Every name was checked in the installed CLI's binary (2.1.283), and its
    /// meaning in the CLI's authentication and environment-variable docs where documented. Three kinds:
    /// <list type="bullet">
    /// <item><b>A credential</b> other than the subscription login: <c>ANTHROPIC_API_KEY</c>, <c>ANTHROPIC_AUTH_TOKEN</c>
    /// (a bearer for a gateway), the providers' own keys <c>ANTHROPIC_AWS_API_KEY</c>, <c>ANTHROPIC_FOUNDRY_API_KEY</c>,
    /// <c>ANTHROPIC_FOUNDRY_AUTH_TOKEN</c>, the Workload Identity Federation tokens <c>ANTHROPIC_IDENTITY_TOKEN</c> /
    /// <c>_FILE</c>, and <c>CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR</c> (an API key through an inherited descriptor).</item>
    /// <item><b>A selector</b> that picks another account: the provider switches <c>CLAUDE_CODE_USE_BEDROCK</c>,
    /// <c>_VERTEX</c>, <c>_FOUNDRY</c> (rank 1 in the docs' order) and the siblings the binary names beside them —
    /// <c>_ANTHROPIC_AWS</c>, <c>_ANTHROPIC_GOOGLE_CLOUD</c>, <c>_GATEWAY</c>, <c>_MANTLE</c>; <c>ANTHROPIC_PROFILE</c> and
    /// <c>ANTHROPIC_FEDERATION_RULE_ID</c>, which select a Console profile or federation credential ranked above
    /// <c>/login</c> (the federation needs <c>ANTHROPIC_ORGANIZATION_ID</c> beside it, so the rule id alone is enough to
    /// strip); and <c>ANTHROPIC_CONFIG_DIR</c>, the directory whose ACTIVE profile ranks above <c>/login</c> when it is a
    /// federation one. The other <c>CLAUDE_CODE_USE_*</c> the binary names are features, not accounts: those that can
    /// change the agent's tools are <see cref="AgentToolVariables"/>, and <c>_NATIVE_FILE_SEARCH</c> stays.</item>
    /// <item><b>An endpoint</b>: <c>ANTHROPIC_BASE_URL</c> and <c>CLAUDE_CODE_API_BASE_URL</c>, every provider's
    /// <c>ANTHROPIC_*_BASE_URL</c> (<see cref="IsOffSubscriptionVariable"/> matches the family, so one the next CLI adds is
    /// covered), <c>ANTHROPIC_API_HOST</c> (undocumented; named in the binary, stripped by what its name says),
    /// <c>ANTHROPIC_UNIX_SOCKET</c> (requests over a local socket instead of to the API) and
    /// <c>ANTHROPIC_CUSTOM_HEADERS</c>, which can carry a credential or a routing header. The security review rated the
    /// base URL highest: with the subscription token still attached, it sends every prompt, and the household's data in
    /// it, to another host.</item>
    /// </list>
    /// <para><b>Kept, and why.</b> <c>CLAUDE_CODE_OAUTH_TOKEN</c> — the docs: "a long-lived OAuth token generated by
    /// <c>claude setup-token</c> … authenticates with your Claude subscription"; it IS the subscription login, which the
    /// rule allows — with <c>CLAUDE_CODE_OAUTH_REFRESH_TOKEN</c>, <c>CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR</c> and the
    /// OAuth client settings. It ranks above <c>/login</c>, so while it is set it decides WHICH subscription the app uses,
    /// over the app's own login mode. <c>AWS_*</c> and <c>GOOGLE_*</c> (<c>AWS_BEARER_TOKEN_BEDROCK</c> included), and the
    /// providers' project, region, resource and workspace ids: other programs read them, and without the switch above
    /// they select nothing for the CLI — the switch is what the docs rank first. The model settings, and the proxy and CA
    /// variables a network client needs (<c>HTTPS_PROXY</c> is the household's network, not an endpoint of the API).</para>
    /// <para><b>What an environment strip cannot reach</b>: an <c>env</c> block or an <c>apiKeyHelper</c> in the CLI's
    /// OWN settings files (the machine's <c>~/.claude/settings.json</c> in machine login mode, managed settings), and an
    /// active federation profile in the default Anthropic configuration directory. Those are the CLI's configuration,
    /// read by the CLI itself.</para>
    /// <para>Stripped from the whole PROCESS, because Lyntai's CLI runs have no per-spawn seam (the class comment). So an
    /// external MCP server loses them too: one that calls the Anthropic API itself takes its key from the server's own
    /// configured environment, which is applied after the inherited one.</para></summary>
    public static readonly IReadOnlyList<string> OffSubscriptionVariables =
    [
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_AWS_API_KEY", "ANTHROPIC_FOUNDRY_API_KEY",
        "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE",
        "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
        "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_GATEWAY",
        "CLAUDE_CODE_USE_MANTLE", "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_CONFIG_DIR",
        "ANTHROPIC_BASE_URL", "CLAUDE_CODE_API_BASE_URL", "ANTHROPIC_API_HOST", "ANTHROPIC_UNIX_SOCKET",
        "ANTHROPIC_CUSTOM_HEADERS",
    ];

    /// <summary>Whether <paramref name="key"/> is one of <see cref="OffSubscriptionVariables"/>, or any
    /// <c>ANTHROPIC_…_BASE_URL</c>.</summary>
    public static bool IsOffSubscriptionVariable(string key) =>
        Matches(key, OffSubscriptionVariables, [])
        || (key.StartsWith("ANTHROPIC_", Cmp) && key.EndsWith("_BASE_URL", Cmp));

    /// <summary>The app's OWN secrets that an environment can carry: the remote-access bearer token and the TLS
    /// certificate's password (every <c>GATHERLIGHT_*</c> the server reads was checked; these are the two that hold a
    /// secret — the rest are URLs, paths, ports, flags and test knobs). No child of the app needs either: the agent
    /// reaches the app's tools through the loopback channel's own per-start token, never this one. And a child that could
    /// read the access token could hand it on — the agent's Bash can print it, and an external MCP server is someone
    /// else's code. So the whole process forgets them at startup, and the app reads them through <see cref="Launched"/>,
    /// which remembers what was forgotten: the desktop host rebuilds its options on every start of the in-process server,
    /// and the settings panel says which settings the environment overrides.
    /// <para><b>Kept</b>, every other <c>GATHERLIGHT_*</c>: none is a secret, and some children read their own (the
    /// claude stub's <c>GATHERLIGHT_STUB_*</c> knobs, the measurement fake's configuration). The capability sandbox gets
    /// none of them, by its allow-list.</para></summary>
    public static readonly IReadOnlyList<string> AppSecretVariables = ["GATHERLIGHT_ACCESS_TOKEN", "GATHERLIGHT_TLS_CERT_PASSWORD"];

    /// <summary>The CLI's feature switches that can ADD a tool, or change how one is mediated, past what the app configures
    /// and the scope guard sees (a jail question, security review 2026-09-28). Each <c>CLAUDE_CODE_USE_*</c> the installed
    /// binary (2.1.283) names that is not an account selector (<see cref="OffSubscriptionVariables"/>) was checked:
    /// <list type="bullet">
    /// <item><c>CLAUDE_CODE_USE_POWERSHELL_TOOL</c> — STRIPPED. It turns on the PowerShell tool, which the guard's matcher
    /// does not list. But on Windows the tool is on by DEFAULT without it (the CLI's tools reference), so stripping the
    /// switch is not what closes the gap: every agent run disallows the tool (<c>UnguardedTools</c>).</item>
    /// <item><c>CLAUDE_CODE_USE_COWORK_PLUGINS</c> — STRIPPED. Undocumented (none of the CLI's 210 documentation pages names
    /// it); by its name it loads the plugins of another product's store, and plugins contribute exactly what the app
    /// configures itself — MCP servers, hooks (which run outside the permission checks, and a PreToolUse hook can approve
    /// a call), skills and subagents.</item>
    /// <item><c>CLAUDE_CODE_USE_CCR_V2</c> — STRIPPED, failing closed. Undocumented too; by its name the protocol of
    /// Claude Code Remote sessions, a channel by which another client drives a session — which a local <c>-p</c> run the
    /// app starts never uses. It is stripped because nothing shows it leaves the tool set alone and the app has no use for
    /// it, not because it was measured to add a tool.</item>
    /// <item><c>CLAUDE_CODE_USE_NATIVE_FILE_SEARCH</c> — KEPT. Documented: it makes the CLI discover custom commands,
    /// subagents and output styles with Node.js file APIs instead of ripgrep, and "does not affect the Grep or file search
    /// tools" — no tool is added or replaced, and file access is mediated as before.</item>
    /// </list>
    /// The rest (<c>_BEDROCK</c> and its siblings) pick another account and are <see cref="OffSubscriptionVariables"/>.</summary>
    public static readonly IReadOnlyList<string> AgentToolVariables =
        ["CLAUDE_CODE_USE_POWERSHELL_TOOL", "CLAUDE_CODE_USE_COWORK_PLUGINS", "CLAUDE_CODE_USE_CCR_V2"];

    /// <summary>What <see cref="ForgetLauncherContext"/> removed, by kind — names only, for the startup log.</summary>
    public sealed record Forgotten(
        IReadOnlyList<string> LauncherContext, IReadOnlyList<string> OffSubscription, IReadOnlyList<string> AgentTools,
        IReadOnlyList<string> AppSecrets)
    {
        /// <summary>Whether anything was removed.</summary>
        public bool Any => LauncherContext.Count + OffSubscription.Count + AgentTools.Count + AppSecrets.Count > 0;
    }

    private static readonly object RememberedGate = new();
    private static readonly Dictionary<string, string> Remembered = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Remove from THIS process's environment, so no child inherits them: the launcher's repository
    /// (<see cref="RepositoryVariables"/>) and Claude Code session (<see cref="ParentSessionVariables"/>), what would take
    /// the claude CLI off the subscription login (<see cref="OffSubscriptionVariables"/>), what could add a tool past the
    /// guard (<see cref="AgentToolVariables"/>), and the app's own secrets
    /// (<see cref="AppSecretVariables"/>, whose values it remembers for <see cref="Launched"/>). Called once at the top of
    /// <c>GatherlightApp.Build</c>, before anything is spawned; idempotent. Returns the NAMES removed — never their values,
    /// several of which are credentials — for the startup log.</summary>
    public static Forgotten ForgetLauncherContext()
    {
        var context = new List<string>();
        var offSubscription = new List<string>();
        var agentTools = new List<string>();
        var secrets = new List<string>();
        foreach (DictionaryEntry e in Environment.GetEnvironmentVariables())
        {
            var key = (string)e.Key;
            List<string>? into =
                Matches(key, RepositoryVariables, RepositoryPrefixes) || Matches(key, ParentSessionVariables, []) ? context
                : IsOffSubscriptionVariable(key) ? offSubscription
                : Matches(key, AgentToolVariables, []) ? agentTools
                : Matches(key, AppSecretVariables, []) ? secrets
                : null;
            if (into is null) continue;
            if (into == secrets && e.Value is string value)
                lock (RememberedGate) Remembered[key] = value;
            Environment.SetEnvironmentVariable(key, null);
            into.Add(key);
        }
        foreach (var list in new[] { context, offSubscription, agentTools, secrets }) list.Sort(StringComparer.Ordinal);
        return new Forgotten(context, offSubscription, agentTools, secrets);
    }

    /// <summary>The value of <paramref name="name"/> as the app was LAUNCHED with it: the process environment while the
    /// variable is there, else what <see cref="ForgetLauncherContext"/> remembered when it removed one of
    /// <see cref="AppSecretVariables"/>. For the app's own readers of its own settings (the access token, the TLS
    /// password, the settings panel's env-override list) — never for a child, which is why the value is not put back.
    /// The one child that gets it back is the app itself, relaunched (<see cref="ForRelaunch"/>).</summary>
    public static string? Launched(string name)
    {
        var live = Environment.GetEnvironmentVariable(name);
        if (live is not null) return live;
        lock (RememberedGate) return Remembered.TryGetValue(name, out var v) ? v : null;
    }

    /// <summary>A start of the APP ITSELF, relaunched — the desktop host restarting, or handing over to the native
    /// launcher to apply an update. The new process inherits THIS one's environment, which
    /// <see cref="ForgetLauncherContext"/> has already cleaned, so a relaunch silently lost what was given only by
    /// environment: the remote-access token (a LAN or WAN household locked out of its own install until someone set it
    /// again) and the TLS certificate's password. This puts back what the floor remembered — the
    /// <see cref="AppSecretVariables"/>, and only those: the launcher's repository and Claude Code session, and what would
    /// take the CLI off its subscription, stay forgotten, and the new process forgets its own at startup exactly as this
    /// one did. The one exception to "never for a child", because this child is the app.
    /// <para>A CREATED process, not a shell-executed one: only CreateProcess takes an environment block (with
    /// <c>UseShellExecute = true</c>, <see cref="ProcessStartInfo.Environment"/> is ignored). Both relaunch sites start an
    /// .exe by path, so nothing a shell adds is lost.</para></summary>
    public static ProcessStartInfo ForRelaunch(string fileName, string arguments = "", string? workingDirectory = null)
    {
        var psi = new ProcessStartInfo(fileName, arguments) { UseShellExecute = false };
        if (workingDirectory is not null) psi.WorkingDirectory = workingDirectory;
        lock (RememberedGate)
            foreach (var (key, value) in Remembered)
                if (!psi.Environment.ContainsKey(key)) psi.Environment[key] = value;
        return psi;
    }

    // ---- 2 · git ---------------------------------------------------------------------------------------------------

    /// <summary>Confine <paramref name="psi"/>'s git to the repository at <paramref name="repoRoot"/>: strip what would
    /// name another (<see cref="RepositoryVariables"/> — again, so a git never depends on the startup call having run),
    /// and bound discovery at the root's parent.
    /// <para><b>Two halves, because git chooses a repository two ways.</b> By DISCOVERY — walking up from the working
    /// directory — which <c>GIT_CEILING_DIRECTORIES</c> bounds. And by NAME, from the environment, which skips discovery
    /// altogether: git's own documentation says the ceiling "will not exclude … a GIT_DIR set on the command line or in
    /// the environment".</para>
    /// <para><b>The ceiling</b> stops git walking up. Without one, a git command run in a folder whose own repo is missing
    /// or damaged discovers the nearest ANCESTOR repo and operates on that — silently and successfully. Observed for real:
    /// a restore into a data folder with a broken .git committed the surrounding project's staged changes under the message
    /// "restore: import backup (N files)". It is the root's PARENT, so discovery may find <c>{root}/.git</c> and may not
    /// climb past it; <c>git init</c> still works — the ceiling bounds the search, not creation — and a genuinely missing
    /// repo now fails where it should. Set here over whatever was inherited.</para></summary>
    public static void ForGit(ProcessStartInfo psi, string repoRoot)
    {
        Strip(psi.Environment, RepositoryVariables, RepositoryPrefixes);
        var root = Path.GetFullPath(repoRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var parent = Path.GetDirectoryName(root);
        if (!string.IsNullOrEmpty(parent)) psi.Environment["GIT_CEILING_DIRECTORIES"] = parent;
    }

    // ---- 3 · node running code we ship -----------------------------------------------------------------------------

    /// <summary>The variables with which the ENVIRONMENT, rather than our argv, decides what code a node runs:
    /// <c>NODE_OPTIONS</c> takes almost any command-line option — <c>--require</c>/<c>--import</c> run a file before ours,
    /// <c>--allow-*</c> make a node without <c>--permission</c> refuse to start at all (measured, Node 24.15), and a flag
    /// another node version does not know does the same — and <c>NODE_PATH</c> adds module directories to resolution.</summary>
    public static readonly IReadOnlyList<string> NodeCodeVariables = ["NODE_OPTIONS", "NODE_PATH"];

    /// <summary>A node child running code WE ship — the Node leaf tools (<c>NodeLeafTool</c>, both run shapes, and the
    /// <c>npx tsx</c> tree under the source shape). The household's <c>NODE_OPTIONS</c> is meant for their own node
    /// programs; in ours it can only make the tool behave other than as built and tested, or not start: the leaf may run on
    /// the provisioned node, the Playwright driver's or PATH's, three versions of which one set of flags suits at most one.
    /// Everything else stays: the leaf reads files and writes one, and needs no network, so nothing else in the
    /// environment changes what it does.</summary>
    public static void ForPlatformNode(ProcessStartInfo psi) => Strip(psi.Environment, NodeCodeVariables, []);

    // ---- 4 · the capability sandbox --------------------------------------------------------------------------------

    /// <summary>What a sandboxed capability's node gets from the environment, whatever its grant: what node needs to run on
    /// this OS (the system root, the temp and home folders <c>os.tmpdir()</c>/<c>os.homedir()</c> read, PATH) and the
    /// household's time zone and locale. Rendered into <c>.claude/tool-spec.md</c>, so the contract the agent writes
    /// against says exactly this.</summary>
    public static readonly IReadOnlyList<string> SandboxVariables =
    [
        "SystemRoot", "windir", "SystemDrive", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "HOME", "PATH",
        "TZ", "LANG", "LC_ALL",
    ];

    /// <summary>Added for a grant with <c>net: true</c>: the proxy settings and the extra trust anchors a network client
    /// behind the household's proxy needs (<c>NODE_USE_ENV_PROXY</c> is what makes Node 24 read the proxy variables at
    /// all). They change where the capability's requests go and which certificates it trusts, which is the household's
    /// network configuration — and meaningless to a capability that cannot open a socket.</summary>
    public static readonly IReadOnlyList<string> SandboxNetVariables =
    [
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
        "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS",
    ];

    /// <summary>The sandboxed capability's environment: an ALLOW-LIST (<see cref="SandboxVariables"/>, plus
    /// <see cref="SandboxNetVariables"/> under <paramref name="net"/>), everything else removed. Applied by
    /// <c>NodeCapabilityLauncher.Build</c> and by <c>CapabilityRuntime</c>'s probe, so the probe tests what will run.
    /// <para><b>An allow-list, because this child is WEAKER than its parent by design</b> and its parent's environment
    /// can widen it. Measured on Node 24.15 under the exact launch (<c>--permission</c>, the grant's
    /// <c>--allow-fs-*</c>, <c>--import</c> of <c>cap-guard.mjs</c>), with <c>NODE_OPTIONS</c> inherited:
    /// <c>--require &lt;file&gt;</c> ran that file — outside every read grant — BEFORE the preload, and it handed the
    /// capability <c>require('net')</c> and <c>require('http')</c> through a global: the network denial, gone;
    /// <c>--allow-child-process</c> and <c>--allow-worker</c> reopened spawn and workers, the two denials cap-guard's
    /// promise rests on; <c>--allow-fs-read=*</c> / <c>--allow-fs-write=*</c> widened the jail to the whole disk;
    /// <c>--allow-addons</c> re-enabled native addons. (<c>--import</c> from <c>NODE_OPTIONS</c> was refused: an ESM load
    /// is checked against the read grant.) A deny-list would have to track every variable a future node reads —
    /// <c>NODE_*</c>, <c>OPENSSL_*</c>, <c>UV_*</c> — and drift the first time one is added. And the capability reads its
    /// environment as <c>process.env</c>: agent-authored code saw every variable the household started the app with,
    /// <c>GATHERLIGHT_ACCESS_TOKEN</c> too when the token is given that way, and returns its output to the agent.</para>
    /// <para>Nothing here can fail open: removing a variable cannot widen the sandbox, and the launcher still refuses to
    /// start a capability without a runtime that enforces <c>--permission</c> or without its preload.</para></summary>
    public static void ForSandbox(ProcessStartInfo psi, bool net)
    {
        var env = psi.Environment;
        var keep = net ? SandboxVariables.Concat(SandboxNetVariables).ToList() : SandboxVariables;
        foreach (var key in env.Keys.ToList())
            if (!keep.Any(n => string.Equals(key, n, Cmp)))
                env.Remove(key);
    }

    // ---- 5 · llama.cpp's llama-server ------------------------------------------------------------------------------

    /// <summary>llama-server — the router the app provisions and starts, its <c>--version</c>/<c>--list-devices</c>
    /// probes, and the reranker device-measurement children. llama.cpp reads an environment variable for nearly every
    /// command-line option, and argv wins only for the options we pass, so an inherited one reaches every option we do
    /// not: stripped here are
    /// <list type="bullet">
    /// <item><c>LLAMA_API_KEY</c> — the router then demands a key the app's own clients never send. Measured on the
    /// provisioned build (b10549): <c>/v1/models</c> answered 401 without it and 200 with it, and the runtime reads a port
    /// that accepts but gives no model list as HELD by a stranger, so the app would refuse to spawn beside its own router
    /// and every recall would fail open, silently;</item>
    /// <item>every other <c>LLAMA_ARG_*</c> but the <c>LLAMA_ARG_LOG_*</c> family — each is a launch argument by another
    /// name, and the launch is the app's CONTRACT (dev-conventions: <c>--n-gpu-layers</c>, <c>reasoning</c>,
    /// <c>ctx-size</c>). Some change how the router must be ADDRESSED (<c>LLAMA_ARG_API_KEY_FILE</c>,
    /// <c>LLAMA_ARG_API_PREFIX</c>, <c>LLAMA_ARG_SSL_CERT_FILE</c>/<c>_KEY_FILE</c>), some whether it works at all
    /// (<c>LLAMA_ARG_MODELS_AUTOLOAD</c>), the rest what was measured (<c>LLAMA_ARG_CACHE_TYPE_K</c> quantizes the KV cache,
    /// <c>LLAMA_ARG_FLASH_ATTN</c>, <c>LLAMA_ARG_THREADS</c>…);</item>
    /// <item><c>LLAMA_SERVER_*</c> — the router's own protocol with the children it spawns (<c>LLAMA_SERVER_CHILD_MODE</c>,
    /// <c>LLAMA_SERVER_ROUTER_PORT</c>) and debug switches that fake timings.</item>
    /// </list>
    /// <para><b>Kept</b>: <c>LLAMA_ARG_LOG_*</c>, which change only what llama.cpp writes about itself and are how this
    /// project reads a child's device and offload lines through the app (<c>docs/self-managed-llm-runtime.md</c>);
    /// <c>GGML_*</c> and the vendors' device variables — a machine's device configuration, which a household with a
    /// broken GPU may need and this project uses to emulate machines (<c>GGML_VK_VISIBLE_DEVICES</c>); and
    /// <c>LLAMA_CACHE</c>, the machine's download cache, which the router only lists and the app already filters to its own
    /// models.</para></summary>
    public static void ForLlamaServer(ProcessStartInfo psi)
    {
        var env = psi.Environment;
        foreach (var key in env.Keys.ToList())
            if (IsLlamaLaunchVariable(key))
                env.Remove(key);
    }

    /// <summary>Whether <see cref="ForLlamaServer"/> removes <paramref name="key"/>.</summary>
    public static bool IsLlamaLaunchVariable(string key) =>
        string.Equals(key, "LLAMA_API_KEY", Cmp)
        || (key.StartsWith("LLAMA_ARG_", Cmp) && !key.StartsWith("LLAMA_ARG_LOG_", Cmp))
        || key.StartsWith("LLAMA_SERVER_", Cmp);

    // ---- shared ----------------------------------------------------------------------------------------------------

    private static void Strip(IDictionary<string, string?> env, IReadOnlyList<string> names, IReadOnlyList<string> prefixes)
    {
        foreach (var key in env.Keys.ToList())
            if (Matches(key, names, prefixes))
                env.Remove(key);
    }

    private static bool Matches(string key, IReadOnlyList<string> names, IReadOnlyList<string> prefixes) =>
        names.Any(n => string.Equals(key, n, Cmp)) || prefixes.Any(p => key.StartsWith(p, Cmp));
}
