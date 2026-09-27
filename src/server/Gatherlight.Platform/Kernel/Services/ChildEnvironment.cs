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
/// repository it named (<see cref="RepositoryVariables"/>) and the Claude Code session it belonged to
/// (<see cref="ParentSessionVariables"/>). No child the app starts has any use for either, and three spawns cannot be
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
/// app's own <c>GATHERLIGHT_*</c>, and the household's own CLI configuration (<c>ANTHROPIC_*</c>,
/// <c>CLAUDE_CODE_USE_*</c> and the like). The capability sandbox is the exception: it keeps an allow-list and nothing
/// else (<see cref="ForSandbox"/>).</para>
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
    /// <para><b>Kept</b>: settings rather than identities — <c>CLAUDE_EFFORT</c>, <c>CLAUDE_CONFIG_DIR</c> (which the app
    /// manages itself), <c>ANTHROPIC_*</c>, <c>CLAUDE_CODE_USE_*</c> and the like are the household's own CLI
    /// configuration, the same the CLI gets in their terminal.</para></summary>
    public static readonly IReadOnlyList<string> ParentSessionVariables =
    [
        "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SSE_PORT", "CLAUDE_PID",
    ];

    /// <summary>Remove the launcher's repository (<see cref="RepositoryVariables"/>) and Claude Code session
    /// (<see cref="ParentSessionVariables"/>) from THIS process's environment, so no child inherits them. Called once at
    /// the top of <c>GatherlightApp.Build</c>, before anything is spawned; idempotent. Returns the NAMES removed — never
    /// their values, one of which is a token — for the startup log.</summary>
    public static IReadOnlyList<string> ForgetLauncherContext()
    {
        var removed = new List<string>();
        foreach (DictionaryEntry e in Environment.GetEnvironmentVariables())
        {
            var key = (string)e.Key;
            if (!Matches(key, RepositoryVariables, RepositoryPrefixes) && !Matches(key, ParentSessionVariables, [])) continue;
            Environment.SetEnvironmentVariable(key, null);
            removed.Add(key);
        }
        removed.Sort(StringComparer.Ordinal);
        return removed;
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
