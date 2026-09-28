using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Site.Services;

namespace Gatherlight.Server.Platform.Agent.Chat.Services;

/// <summary>
/// Generates the runtime files the spawned claude needs. Two live under <c>state/</c> — APP STATE,
/// gitignored, regenerated every boot: <c>state/settings.chat.json</c> (acceptEdits + the PreToolUse
/// scope-guard hook, passed via --settings on the execute phase) and <c>state/agent/scope-guard.mjs</c> —
/// the agent's SECURITY jail (reads confined to the data folder minus <c>state/</c>, writes to plans/
/// household/ .claude/ ui/ except the PROTECTED set, Bash denied git-history/network/inline-eval/shell-
/// launch/crawl/path-escape and state+protected paths). The guard used to live in the data repo at
/// <c>.claude/hooks/scope-guard.mjs</c>; it is deleted from there on boot (<c>RemoveLegacyGuard</c>).
/// <para><b><c>state/</c> is still INSIDE the data folder</b> — carved out of the guard's CHECKS, not out of
/// the filesystem. The guard's integrity rests on three legs: Edit/Write/Read cannot reach <c>state/</c>
/// (solid — every such call passes through the guard); the Bash path-token scan refuses a token naming it
/// (best effort); and no nested shell (best effort). A constructed token (<c>$PWD/state/agent/…</c>) or a
/// nested shell slipping past the last two can overwrite the guard and neuter it until the next boot, and
/// can READ <c>state/</c> (the database, the TLS key) in an execute run where a Bash exists — the declared
/// residual "code inside an agent-authored script needs an OS sandbox", which was declined.</para>
/// Regenerated every boot, hardening reaches an old data folder the moment a newer build boots it.
/// Out-of-boundary work must route through an MCP tool.
/// <para>Two CONTRACTS ride the same version gate for the same reason — they are protocol, not
/// knowledge-base content, and the seeder deliberately never overwrites a file the household edited:
/// <c>.claude/ui-spec.md</c> (the block vocabulary, <c>UI_CONTRACT_VERSION</c>) and
/// <c>.claude/tool-spec.md</c> (how to author a capability, <c>TOOL_CONTRACT_VERSION</c>). A stale
/// one is not inert: the agent emits trees the validator rejects, or drafts a tool that reaches for
/// something the sandbox denies and fails at run time, after a human approved it.</para>
/// <para>All three go through one <c>ShouldReissue</c>; the rule is identical and was written three
/// times before it was written once.</para>
/// </summary>
public sealed class ChatEnvironmentService
{
    private readonly ISiteContext _site;
    private readonly IPlatformContext _platform;
    private readonly GatherlightServerOptions _options;
    private readonly ISiteManifestStore _manifest;
    private readonly IReadOnlyList<Ui.Data.IUiDataSource> _sources;

    public ChatEnvironmentService(
        ISiteContext site, IPlatformContext platform, GatherlightServerOptions options, ISiteManifestStore manifest,
        IEnumerable<Ui.Data.IUiDataSource> sources)
    {
        _site = site;
        _platform = platform;
        _options = options;
        _manifest = manifest;
        _sources = sources.OrderBy(s => s.Id, StringComparer.Ordinal).ToList();
    }

    public string SettingsPath => Path.Combine(_platform.StatePath, "settings.chat.json");
    public string SystemSettingsPath => Path.Combine(_platform.StatePath, "settings.system.json");
    /// <summary>The read-only (plan / revise) settings — <c>blockReadsOutsideWorkingDirectories</c> + the
    /// guard hook, no acceptEdits. A plan run passed no settings at all before, so a read-only Bash could
    /// read outside the data folder and a plan-phase Bash was unguarded.</summary>
    public string ReadOnlySettingsPath => Path.Combine(_platform.StatePath, "settings.chat.readonly.json");
    public string SystemReadOnlySettingsPath => Path.Combine(_platform.StatePath, "settings.system.readonly.json");
    /// <summary>The planner scope guard lives under <c>state/agent/</c> — APP STATE (gitignored, not in the
    /// data repo's audit trail, not carried by the backup), regenerated every boot like the settings files.
    /// <c>state/</c> is carved out of the guard's CHECKS (no Edit/Write/Read, no Bash token naming it), not out
    /// of the filesystem: the guard's integrity rests on those checks — the tool path solidly, the Bash token
    /// scan and the nested-shell denial only best-effort (see the class summary for the residual). The old copy
    /// at <c>.claude/hooks/scope-guard.mjs</c> sat in a directory Edit was protected from and Bash was not
    /// checked for at all.</summary>
    public string ScopeGuardPath => Path.Combine(_platform.StatePath, "agent", "scope-guard.mjs");
    /// <summary>Where an earlier build generated the guard, inside the data repo. Deleted on boot.</summary>
    private string LegacyScopeGuardPath => Path.Combine(_site.ZhikuPath, "hooks", "scope-guard.mjs");
    public string UiSpecPath => Path.Combine(_site.ZhikuPath, "ui-spec.md");
    /// <summary>The tool-authoring contract. Same app-managed, version-gated treatment as the UI one,
    /// and for the same reason: the agent is TOLD it may draft a capability, but until this existed
    /// the whole schema — the grant vocabulary, the stdin/stdout protocol, and above all what the
    /// sandbox refuses — lived in one paragraph of the system prompt. A draft that reaches for
    /// `fetch` or `child_process` fails at RUN time, after a human has already approved it.</summary>
    public string ToolSpecPath => Path.Combine(_site.ZhikuPath, "tool-spec.md");

    /// <summary>Returns the data-root-relative paths of app-managed files newly written this run
    /// (caller commits them to the data repo). Empty when everything was already current.</summary>
    public IReadOnlyList<string> EnsureFiles()
    {
        var deny = _manifest.Current.Capabilities.Deny;

        // The planner scope guard is APP STATE, not knowledge-base content: it lives under state/agent/
        // (gitignored, backup-excluded; state/ is carved out of the guard's own checks) and is regenerated
        // every boot like the settings files — never version-gated or committed. So hardening reaches an old
        // data folder the moment a newer build boots it, and a guard neutered mid-session by the declared
        // residual (a constructed Bash token, a nested shell) is restored at the next boot. Referenced by
        // ABSOLUTE path.
        Directory.CreateDirectory(Path.GetDirectoryName(ScopeGuardPath)!);
        File.WriteAllText(ScopeGuardPath, RenderScopeGuard());
        var plannerGuardCmd = $"node \\\"{ScopeGuardPath.Replace('\\', '/')}\\\"";

        File.WriteAllText(SettingsPath, BuildChatSettings(plannerGuardCmd, deny));
        // 系统模式 settings: same acceptEdits shape, but the PreToolUse hook is the code repo's tracked
        // system scope guard (deny-list: whole repo except guard/, src/server, settings, .git), referenced
        // absolutely since the run's $CLAUDE_PROJECT_DIR is the code repo. Built from the SAME template with
        // a different guard command — NOT a string.Replace that could silently no-op (and leave system mode
        // running the PLANNER scope) if the settings JSON is ever reformatted.
        var systemGuard = Path.Combine(_options.CodeRootPath, "guard", "system-scope-guard.mjs")
            .Replace('\\', '/');
        var systemGuardCmd = $"node \\\"{systemGuard}\\\"";
        File.WriteAllText(SystemSettingsPath, BuildChatSettings(systemGuardCmd, deny));
        // Read-only (plan / revise) settings: the read fence + the guard hook, no acceptEdits, and NO Bash
        // in the allow-list (a read-only run has Bash disallowed entirely — see UnguardedTools).
        File.WriteAllText(ReadOnlySettingsPath, BuildChatSettings(plannerGuardCmd, deny, readOnly: true));
        File.WriteAllText(SystemReadOnlySettingsPath, BuildChatSettings(systemGuardCmd, deny, readOnly: true));
        RemoveStaleMcpConfig();

        var created = new List<string>();
        // An earlier build generated the guard into the data repo at .claude/hooks/scope-guard.mjs, where
        // the agent could reach it (Edit was PROTECTED, Bash was not). Delete that copy and return its path
        // so the deletion is committed out of the audit trail — a guard the agent can touch, or a stale file
        // that configures nothing, is worse than none.
        if (RemoveLegacyGuard()) created.Add(".claude/hooks/scope-guard.mjs");
        if (ShouldReissue(UiSpecPath, ShippedUiContractVersion, UiVersionRe))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(UiSpecPath)!);
            File.WriteAllText(UiSpecPath, RenderUiSpec());
            created.Add(".claude/ui-spec.md");
        }
        if (ShouldReissue(ToolSpecPath, ShippedToolContractVersion, ToolVersionRe))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ToolSpecPath)!);
            File.WriteAllText(ToolSpecPath, RenderToolSpec());
            created.Add(".claude/tool-spec.md");
        }
        return created;
    }

    /// <summary>Removes <c>state/mcp.chat.json</c>, which earlier builds generated to point the spawned
    /// agent at the PUBLIC listener. The agent's MCP now comes from the loopback channel
    /// (<c>AgentMcpWiring</c>), built per run — so a copy left in an existing data folder configures
    /// nothing, and a file that configures nothing is worse than no file at all: the next person
    /// debugging "the agent says the tool is missing" will read it and believe it. Best-effort — a
    /// locked file is not a reason to fail startup.</summary>
    private void RemoveStaleMcpConfig()
    {
        var stale = Path.Combine(_platform.StatePath, "mcp.chat.json");
        try { if (File.Exists(stale)) File.Delete(stale); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    /// <summary>Deletes the legacy in-repo guard at <c>.claude/hooks/scope-guard.mjs</c> (now under
    /// <c>state/agent/</c>). Returns true only if a file was there — the caller returns the path so the
    /// deletion is committed (it is tracked in HEAD on an upgraded install). Best-effort: a locked file is
    /// not a reason to fail startup, and the guard the agent actually runs is the state/ one either way.</summary>
    private bool RemoveLegacyGuard()
    {
        try
        {
            if (!File.Exists(LegacyScopeGuardPath)) return false;
            File.Delete(LegacyScopeGuardPath);
            return true;
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    /// <summary>The guard is generated, not shipped verbatim: its WRITE_DIRS come from the site
    /// manifest's declared record directories (plus .claude and the UI directory), so a site that
    /// keeps its artifacts somewhere else is jailed correctly without editing the guard. WRITE_EXTS
    /// rides the same manifest: the UI directory is writable only as flat <c>.json</c>, so a path the
    /// agent may write there is exactly a page. PROTECTED stays hardcoded —
    /// a site must not be able to widen its own jail by editing its own manifest. DENIED comes from
    /// the same manifest's capabilities.deny — a tool withheld in the allow-list (BuildChatSettings)
    /// must ALSO be denied here, so re-opening one plane (e.g. hand-editing the generated settings
    /// file) doesn't quietly reopen the other.</summary>
    private string RenderScopeGuard()
    {
        var uiDir = _manifest.Current.Ui.Spec.Trim('/');
        var dirs = _manifest.Current.Records.Concat([".claude", uiDir]).Where(d => d.Length > 0).Distinct();
        var literal = "[" + string.Join(", ", dirs.Select(d => $"'{d.Replace("'", "\\'")}'")) + "]";
        var deniedLiteral = "[" + string.Join(", ", _manifest.Current.Capabilities.Deny.Select(d => $"'{d.Replace("'", "\\'")}'")) + "]";
        // The UI directory holds pages and nothing else. Rendered from the manifest like WRITE_DIRS,
        // so a site that relocates its UI directory stays jailed correctly.
        var extsLiteral = uiDir.Length == 0 ? "{}" : $"{{ '{uiDir.Replace("'", "\\'")}': ['.json'] }}";
        return ScopeGuardMjs
            .Replace("__WRITE_DIRS__", literal)
            .Replace("__DENIED_TOOLS__", deniedLiteral)
            .Replace("__WRITE_EXTS__", extsLiteral);
    }

    // Every app-managed file follows the SAME rule, so it is written once: (re)issue when missing OR
    // when an older version is on disk, so a hardened guard / a grown contract reaches data folders
    // seeded by an earlier build (and a weakened or tampered copy is replaced). Same-version files
    // are left alone — no spurious data-repo commit — and so is a NEWER on-disk version (a dev ahead
    // of the server). An unreadable file re-issues: a guard we cannot read is not one we can trust.
    // The UI contract is app-managed, not knowledge-base content: an agent working from a stale
    // vocabulary emits trees that fail validation and the household sees fallback cards. Same
    // version-gated re-issue as the scope guard — a newer on-disk version is left alone.
    private const string UiVersionRe = @"UI_CONTRACT_VERSION:\s*(\d+)";
    private static readonly int ShippedUiContractVersion = ReadVersion(UiSpecTemplate, UiVersionRe);

    /// <summary>
    /// The contract the agent reads, with the bindable queries rendered from the ACTUAL registered
    /// sources rather than a hand-maintained list. Registering a source therefore tells the agent it
    /// exists, in the same commit — S3a's lesson, re-learned in S3b: a capability the agent is never
    /// told about is unreachable while every check stays green.
    /// </summary>
    private string RenderUiSpec()
    {
        var rows = _sources.Select(s =>
        {
            var ps = s.Params.Count == 0
                ? "—"
                : string.Join(", ", s.Params.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p =>
                    $"`{p.Key}`{(p.Value.Required ? " (required)" : "")}"));
            return $"| `{s.Id}` | {s.Description} | {ps} | {string.Join(" · ", s.Columns)} |";
        });

        var table = string.Join("\n", new[]
        {
            "| query | 返回什么 · Returns | params | columns |",
            "|---|---|---|---|",
        }.Concat(rows));

        return UiSpecTemplate.Replace("__QUERIES__", table, StringComparison.Ordinal);
    }

    private const string ToolVersionRe = @"TOOL_CONTRACT_VERSION:\s*(\d+)";
    private static readonly int ShippedToolContractVersion = ReadVersion(ToolSpecTemplate, ToolVersionRe);

    private static int ReadVersion(string body, string pattern)
    {
        var m = System.Text.RegularExpressions.Regex.Match(body, pattern);
        return m.Success && int.TryParse(m.Groups[1].Value, out var v) ? v : 0;
    }

    private static bool ShouldReissue(string path, int shipped, string pattern)
    {
        if (!File.Exists(path)) return true;
        try { return ReadVersion(File.ReadAllText(path), pattern) < shipped; }
        catch { return true; }
    }

    /// <summary>
    /// The tool-authoring contract, with the SANDBOX'S ACTUAL DENIALS read out of the shipped
    /// <c>cap-guard.mjs</c> rather than restated here. A contract that merely describes the sandbox
    /// drifts the first time the sandbox changes, and the agent only discovers the drift when an
    /// approved capability throws at run time — after a human has already said yes to it.
    /// </summary>
    private string RenderToolSpec()
    {
        var records = _manifest.Current.Records;
        var readDirs = string.Join(" · ", records.Select(r => $"`{r}`").Append("`cache`"));

        // Parsed from the preload the launcher actually imports. If it cannot be read, say so in the
        // contract rather than printing a list that might be wrong.
        var blocked = "(could not read the sandbox preload — treat ALL network modules as blocked)";
        try
        {
            var guard = File.ReadAllText(ResourcePaths.CapGuard);
            var m = System.Text.RegularExpressions.Regex.Match(guard, @"BLOCKED\s*=\s*new Set\(\[(.*?)\]\)",
                System.Text.RegularExpressions.RegexOptions.Singleline);
            if (m.Success)
                blocked = string.Join(" · ", m.Groups[1].Value
                    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Select(s => $"`{s.Trim('\'', '"')}`"));
        }
        catch (IOException) { /* fall through to the honest placeholder */ }

        // The variables the launcher lets through, from the list it applies — never restated here.
        static string Names(IEnumerable<string> names) => string.Join(" · ", names.Select(n => $"`{n}`"));

        return ToolSpecTemplate
            .Replace("__RECORD_DIRS__", readDirs, StringComparison.Ordinal)
            .Replace("__BLOCKED_MODULES__", blocked, StringComparison.Ordinal)
            .Replace("__SANDBOX_ENV__", Names(ChildEnvironment.SandboxVariables), StringComparison.Ordinal)
            .Replace("__SANDBOX_NET_ENV__", Names(ChildEnvironment.SandboxNetVariables), StringComparison.Ordinal);
    }

    // The chat (planner) and 系统模式 settings share ONE template; only the PreToolUse guard command
    // differs. Building both from BuildChatSettings — rather than deriving one from the other via
    // string.Replace — means a reformat can't silently drop the substitution and mis-scope a run. Both
    // guard commands are built at EnsureFiles time from an ABSOLUTE path (the planner's under state/agent/,
    // the system's under guard/), so neither depends on the run's $CLAUDE_PROJECT_DIR.

    /// <summary>The CLI built-ins granted to the agent by default — WebFetch among them, which the
    /// scope guard's PreToolUse matcher never intercepted (see RenderScopeGuard's DENIED plane for
    /// the other half of closing that gap).</summary>
    private static readonly string[] BuiltinTools =
        ["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit", "TodoWrite", "WebFetch", "WebSearch", "Skill", "Bash"];

    /// <summary>The tool names the guard's PreToolUse logic actually has something to say about
    /// (path/command inspection). This is the matcher's floor — unchanged from before capabilities.deny
    /// existed, and NOT widened to every tool: the guard already allow()s anything it doesn't
    /// recognise, so matching more would only add dispatch latency to calls the hook has no opinion
    /// on.</summary>
    private static readonly string[] GuardMatchedTools =
        ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "Read", "Grep", "Glob"];

    /// <summary>Emits the fixed allow-list minus anything the site's capabilities.deny withholds
    /// (case-insensitive) — a deny entry must remove a built-in from BOTH this generated allow-list
    /// AND the guard's DENIED check, or it isn't actually denied.</summary>
    private static string BuildChatSettings(string guardCommand, IReadOnlyList<string> deny, bool readOnly = false)
    {
        // A read-only (plan / revise) run writes nothing (ToolPolicy.ReadOnly disallows Edit/Write), so it
        // never needs acceptEdits; what it DOES need is the read fence — the same "only inside the data
        // folder" the guard applies to Read/Grep/Glob, but also covering a read-only Bash command (cat,
        // head) that names a path outside the working directory, which the CLI otherwise runs without a
        // prompt. permissions.blockReadsOutsideWorkingDirectories (CLI v2.1.257+) makes the file tools AND
        // recognized read-only Bash file-commands refuse such a path in every mode. The guard hook rides
        // along so a plan-phase Bash is checked for egress / inline-eval / shell-launch too, which an
        // unsettinged plan run never was. A read-only run also drops Bash from the allow-list — plan / revise
        // / read-only-job runs have Bash disallowed OUTRIGHT (UnguardedTools, keyed on ToolPolicy), so a
        // read-only Bash cannot read outside the folder, run inline eval, or launch a shell at all.
        var allow = BuiltinTools
            .Where(t => !readOnly || (t is not "Edit" and not "Write" and not "MultiEdit" and not "Bash"))
            .Where(t => !deny.Any(d => string.Equals(d, t, StringComparison.OrdinalIgnoreCase)));
        var allowJson = string.Join(", ", allow.Select(t => $"\"{t}\""));
        // A denied tool must also be in the SET OF TOOLS THE HOOK FIRES FOR, or the DENIED check
        // added to the guard body is unreachable — the exact gap that left WebFetch's guard-side
        // denial decorative. Serialized via JsonSerializer (not manual quoting) because a denied id
        // is user-controlled (site.json) and Regex.Escape can itself introduce backslashes that need
        // JSON-escaping in turn.
        var matcherJson = System.Text.Json.JsonSerializer.Serialize(BuildGuardMatcher(deny));
        var permsExtra = readOnly ? "\n            \"blockReadsOutsideWorkingDirectories\": true," : "";
        var mode = readOnly ? "default" : "acceptEdits";
        var phase = readOnly ? "PLAN (read-only) phase" : "EXECUTE phase";
        // disableSkillShellExecution: a skill's or custom command's !`cmd` runs while the CLI EXPANDS it — prompt
        // preprocessing, not a Bash tool call, so the PreToolUse guard is never asked (measured at 0 tokens: in an execute
        // run's settings a /skill whose SKILL.md held !`node …` ran the command, the guard hook not called). The agent can
        // write .claude/skills/, so a skill it wrote and then invoked in the same run would run its command unguarded. A
        // guard check of the skill's CONTENT was rejected: a scan before the run misses a skill written during it, and a
        // check on Edit/Write misses one a Bash command writes. With this true the command is replaced by a placeholder,
        // and it is a RESTRICTIVE setting (true in any scope wins): a project settings file saying false did not re-enable
        // it. No shipped skill or command uses !`…`.
        // Every name that would take the CLI off the subscription login, blanked. The run reads the data folder's PROJECT
        // .claude/settings.json (it is what loads the knowledge base), and that file's `env` and `apiKeyHelper` are the
        // household's: an apiKeyHelper there RAN at the CLI's start and supplied a key, and an env key or endpoint there
        // was used (measured, CLI 2.1.283, docs/self-managed-llm-runtime.md 2026-09-29). These settings are the
        // command-line scope, which outranks the project scope per key, and the CLI reads each name by truthiness, so an
        // empty value is an absent one: apiKeySource stayed "none", the helper did not run, a project endpoint got no
        // request, and `auth status` still said claude.ai. Rendered from ChildEnvironment's list — the one the process
        // already forgets at launch — so the two cannot drift. The household's file itself is never touched.
        var offSubscriptionEnv = System.Text.Json.JsonSerializer.Serialize(
            ChildEnvironment.OffSubscriptionVariables.ToDictionary(n => n, _ => ""));
        return $$"""
        {
          "$comment": "Generated by Gatherlight at startup — do not edit (changes are overwritten). Isolated Claude Code settings for the chat {{phase}}, passed via `claude --settings`. Pre-grants permissions so the headless run never stalls on a prompt; the real safety is (1) the PreToolUse scope-guard hook below and (2) the human plan+diff gates in the server.",
          "disableAllHooks": false,
          "disableSkillShellExecution": true,
          "apiKeyHelper": "",
          "env": {{offSubscriptionEnv}},
          "permissions": {{{permsExtra}}
            "defaultMode": "{{mode}}",
            "allow": [{{allowJson}}]
          },
          "hooks": {
            "PreToolUse": [
              {
                "matcher": {{matcherJson}},
                "hooks": [
                  {
                    "type": "command",
                    "command": "{{guardCommand}}"
                  }
                ]
              }
            ]
          }
        }
        """;
    }

    /// <summary>GuardMatchedTools plus any capabilities.deny id not already in that set, each
    /// regex-escaped (deny ids come from a user-edited site.json and may contain regex metacharacters
    /// like `.` or `(`), joined into the alternation the PreToolUse hook's "matcher" expects. With
    /// deny: [] this is byte-identical to the pre-deny hardcoded matcher — no regression for a site
    /// that denies nothing.</summary>
    private static string BuildGuardMatcher(IReadOnlyList<string> deny)
    {
        var extra = deny
            .Where(d => !GuardMatchedTools.Contains(d, StringComparer.OrdinalIgnoreCase))
            .Distinct(StringComparer.OrdinalIgnoreCase);
        return string.Join("|", GuardMatchedTools.Concat(extra).Select(System.Text.RegularExpressions.Regex.Escape));
    }

    private const string ScopeGuardMjs = """
        #!/usr/bin/env node
        /**
         * PreToolUse scope guard (v3) for Gatherlight headless PLANNER runs — cwd = the data folder.
         * The FILE lives at {data}/state/agent/scope-guard.mjs (app state, gitignored, regenerated every
         * boot), referenced by ABSOLUTE path from the generated --settings. state/ is still INSIDE the data
         * folder: it is carved out of this guard's CHECKS, not out of the filesystem. So the guard's integrity
         * rests on three legs — (1) Edit/Write/Read/Grep/Glob cannot reach state/ (solid: every such call
         * passes through this check); (2) the Bash path-token scan refuses a token naming state/ (best
         * effort); (3) no nested shell (best effort). A constructed token (`$PWD/state/agent/…`) or a nested
         * shell that slips past (2)/(3) can overwrite this file and neuter it until the next boot, and can
         * READ state/ (the database, the TLS key) in an execute run where a Bash exists (Git Bash present) —
         * the declared residual "code inside an agent-authored script needs an OS sandbox", which was declined.
         *
         * Enforced boundaries (best-effort where noted; also load-bearing: PowerShell/Monitor removed from
         * every run, and read-only runs have no Bash at all):
         *   WRITE (Edit/Write/MultiEdit/NotebookEdit)  -> under WRITE_DIRS EXCEPT the PROTECTED set, and
         *                                                under ui/ only a flat .json page (WRITE_EXTS)
         *   READ  (Read/Grep/Glob)                     -> inside the data folder, never state/ (token,
         *                                                TLS key, database)
         *   BASH                                       -> not: git-history / delete, network egress,
         *                                                inline code-eval, launching another shell, fs crawl,
         *                                                or any path outside the folder / into state/ / at a
         *                                                PROTECTED app-managed path or a folder holding one
         *                                                (best-effort token scan)
         *
         * Kept identical to guard/system-scope-guard.mjs except WRITE_DIRS + WRITE_EXTS + PROTECTED +
         * BASH_PROTECTED + READ_DENY; e2e-p24 runs both. GUARD_VERSION lets the server re-issue newer logic.
         */
        // GUARD_VERSION: 11
        import path from 'node:path';

        const WRITE_DIRS = __WRITE_DIRS__;
        const WRITE_EXTS = __WRITE_EXTS__;
        // PROTECTED overrides WRITE_DIRS: the agent may not neuter its own guard / settings, nor the MCP config.
        const PROTECTED = ['.claude/hooks', '.claude/settings.json', '.claude/settings.local.json', '.mcp.json'];
        // Bash writes were jail-scoped, not write-scoped: a `cp`/`echo >`/`rm`/`tee` could reach state/ (the
        // access token, the TLS pfx, the database), site.json (the manifest the guard renders its scope FROM),
        // .git, or the PROTECTED app-managed files — none of which Edit/Write may touch. Deny any path-like
        // Bash token that resolves under this set OR under state/. Best-effort: a token scan is fooled by a
        // variable, a $(...) or a constructed string — DEFENCE IN DEPTH, one of the three legs in the header,
        // never the guarantee.
        const BASH_PROTECTED = ['.claude/hooks', '.claude/settings.json', '.claude/settings.local.json', '.mcp.json', 'site.json', '.git'];
        // Reads never see state/ (app state — token / TLS key / DB) though it sits inside the jail.
        const READ_DENY = ['state'];
        const DENIED = __DENIED_TOOLS__;

        const HISTORY = [
          /\bgit\s+(commit|add|push|reset|restore|checkout|clean|rebase|stash|rm)\b/,
          /\brm\s+-[rf]/, /\bRemove-Item\b/i, /\bdel\s+\/[a-z]/i,
        ];
        const NETWORK = [
          /\bcurl\b/, /\bwget\b/, /\bInvoke-WebRequest\b/i, /(^|[\s;&|(])iwr(\s|$)/i,
          /\bInvoke-RestMethod\b/i, /(^|[\s;&|(])nc(\s|$)/, /\bncat\b/, /\btelnet\b/, /\bssh\b/, /\bscp\b/,
          /\bsftp\b/, /\brsync\b/, /\baria2c?\b/, /(^|[\s;&|(])ftp(\s|$)/,
          /\bgit\s+(clone|fetch|pull|ls-remote|remote)\b/,
          /\bpython3?\b[^;&|\n]*-m\s+(http\.server|SimpleHTTPServer|urllib|webbrowser)\b/i,
        ];
        const EVALS = [
          /\bnode\b[^;&|\n]*?\s-(?:e|-eval)\b/, /\b(python3?|py)\s+-c\b/, /\bperl\s+-e\b/, /\bruby\s+-e\b/,
          /\b(powershell|pwsh)\b[\s\S]*\s-(e|enc|encodedcommand|command)\b/i, /(^|[\s;&|(])eval(\s|$)/,
          /\b(?:ba|z|k|da)?sh\s+-c\b/, /[|]\s*(?:ba|z|k|da)?sh\b/,   // inline shell eval / pipe-to-shell
        ];
        // Launching ANOTHER shell or interpreter is inline-eval by a second door: whatever runs inside
        // powershell / cmd / a nested bash never reaches this guard's Bash checks (egress, eval, crawl,
        // path-escape). On Windows the PowerShell tool is default-on, and acceptEdits auto-approves its
        // writes. Deny the launch ITSELF, whatever its arguments (so `bash x.sh`, not only `bash -c`).
        // BEST-EFFORT defence in depth — leg (3) in the header; the closure that does not depend on parsing
        // is PowerShell/Monitor removed from every run. Matched against each pipeline segment's COMMAND WORD (the
        // leading token, past `env`/`command`/`sudo`/`VAR=val` wrappers, path and .exe stripped) so a shell
        // NAME used as an argument (`command -v sh`) is not caught.
        const SHELLS = new Set([
          'pwsh', 'powershell', 'powershell_ise', 'cmd', 'wscript', 'cscript', 'mshta',
          'bash', 'sh', 'zsh', 'ksh', 'dash', 'ash', 'csh', 'tcsh', 'fish',
          'source', '.', 'wsl', 'rundll32', 'regsvr32',   // run a file in / as another interpreter
        ]);
        // Wrappers that run their REMAINING words as a command — look PAST them for the real leading word.
        const PREFIX_WORDS = new Set([
          'env', 'command', 'exec', 'builtin', 'nice', 'nohup', 'time', 'xargs', 'sudo', 'doas',
          'stdbuf', 'timeout', 'setsid', 'ionice', 'chrt', 'setarch',
        ]);
        // A wrapper's own arguments come BEFORE the command it runs (`timeout 5 bash`, `nice -n 10 bash`,
        // `stdbuf -oL bash`, `setarch x86_64 bash`), so after a wrapper skip its options, the values of the
        // options that take one, numeric durations/priorities, and — for `setarch` — its one leading
        // positional. `env -S` / `--split-string` is deliberately NOT a value option: its value IS a command
        // line, so it is read as the next command word. `command -v` / `-V` only DESCRIBE a command.
        const WRAPPER_VALUE_OPTS = {
          timeout: ['-s', '--signal', '-k', '--kill-after'],
          nice: ['-n', '--adjustment'],
          ionice: ['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid'],
          sudo: ['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host',
            '-p', '--prompt', '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout'],
          doas: ['-u', '-C'],
          env: ['-u', '--unset', '-C', '--chdir'],
          exec: ['-a'],
          time: ['-f', '--format', '-o', '--output'],
          xargs: ['-a', '--arg-file', '-d', '--delimiter', '-E', '-e', '--eof', '-I', '-i', '--replace',
            '-L', '-l', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars'],
          stdbuf: ['-i', '--input', '-o', '--output', '-e', '--error'],
        };
        const WRAPPER_POSITIONALS = { setarch: 1 };
        const NUMERIC_ARG = /^[+-]?\d+(\.\d+)?[smhd]?$/i;   // a duration (`5`, `5s`, `0.5m`) or a priority
        function firstRealWord(seg) {
          const toks = seg.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']+|["']+$/g, ''));
          let wrapper = null, positionals = 0, takeValue = false;
          for (const w of toks) {
            if (!w) continue;
            if (takeValue) { takeValue = false; continue; }                  // the value of `-n 10`, `-u root`…
            if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;                // VAR=value prefix
            if (wrapper !== null) {
              if (wrapper === 'command' && /^-[vV]$/.test(w)) return '';     // `command -v sh` describes, runs nothing
              if (w.startsWith('-')) {
                const flag = w.replace(/=.*/, '');
                if (!w.includes('=') && (WRAPPER_VALUE_OPTS[wrapper] ?? []).includes(flag)) takeValue = true;
                continue;                                                    // an option of the wrapper
              }
              if (NUMERIC_ARG.test(w)) continue;                            // `timeout 5`, `chrt 10`
              if (positionals > 0) { positionals--; continue; }             // `setarch x86_64`
            }
            const base = w.replace(/.*[\/\\]/, '').replace(/\.exe$/i, '').toLowerCase();
            if (PREFIX_WORDS.has(base)) { wrapper = base; positionals = WRAPPER_POSITIONALS[base] ?? 0; continue; }
            return base;                                                     // the real command word
          }
          return '';
        }
        function launchesShell(command) {
          if (/\bStart-Process\b/i.test(command)) return true;               // a PowerShell cmdlet, not a leading word
          // A git subcommand that runs an arbitrary program via config: -c alias.x=!cmd, or an executed key.
          if (/\bgit\b[\s\S]*?\s-c\s+(alias\.[^=\s]+\s*=\s*!|core\.(pager|editor|sshcommand|fsmonitor|hookspath)\s*=|sequence\.editor\s*=|(?:credential|filter|diff|merge)\.[^=]*\.(?:helper|process|command|textconv|driver)\s*=)/i.test(command))
            return true;
          // Split on every pipeline / grouping / substitution / redirect boundary so a shell hidden in
          // `{ … }`, a backtick, or after `<` is still the leading word of its segment.
          for (const seg of String(command).split(/[;|&\n(){}`<>]+/)) {
            const base = firstRealWord(seg);
            if (base && SHELLS.has(base)) return true;
          }
          return false;
        }
        const CRAWL = [
          /(^|[\s;&|(])find\s/, /(^|[\s;&|(])ls\s+-[a-zA-Z]*[Rr]/, /(^|[\s;&|(])dir\b[\s\S]*\/s/i,
          /(^|[\s;&|(])grep\b[^;&|\n]*\s-[a-zA-Z]*[rR]/, /(^|[\s;&|(])(rg|tree)(\s|$)/,
          /\bGet-ChildItem\b[^;&|\n]*-[Rr]ecurse/i, /(^|[\s;&|(])gci\b[^;&|\n]*-[a-zA-Z]*[Rr]\b/i,
        ];
        const HOME = /(\$\{?(HOME|USERPROFILE|LOCALAPPDATA|APPDATA|HOMEPATH)\b|\$env:|%(USERPROFILE|LOCALAPPDATA|APPDATA|HOMEPATH|HOME)%)/i;

        function deny(reason) {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
          }));
          process.exit(0);
        }
        const allow = () => process.exit(0);

        // Normalize a path (relative -> resolved against `root`) to a lowercased, drive-aware slash form so
        // containment is a string-prefix test. Git-bash `/c/x` and Windows `C:\x` both fold to `c:/x`.
        function norm(p, root) {
          let s = String(p).replace(/\\/g, '/').replace(/^\/([A-Za-z])(?=\/|$)/, (_, d) => `${d}:`);
          const abs = /^[A-Za-z]:/.test(s) || s.startsWith('/');
          if (!abs) s = `${String(root).replace(/\\/g, '/')}/${s}`;
          const out = [];
          for (let seg of s.split('/')) {
            if (seg === '' || seg === '.') continue;
            if (seg === '..') { out.pop(); continue; }
            // Windows strips trailing dots and spaces from each path SEGMENT, so `settings.json.`,
            // `settings.json ` and `hooks.` name the same entry as `settings.json` / `hooks`. Fold them
            // before any compare, or a PROTECTED prefix test is bypassed by a trailing dot/space.
            seg = seg.replace(/[. ]+$/, '');
            if (seg.length) out.push(seg);
          }
          return out.join('/').toLowerCase();
        }
        function relTo(p, root) {
          const r = norm('.', root);
          const n = norm(p, root);
          if (n === r) return '';
          if (n.startsWith(r + '/')) return n.slice(r.length + 1);
          return null;
        }
        const inside = (p, root) => relTo(p, root) !== null;
        const underAny = (rel, dirs) => dirs.some((d) => d === '' || rel === d || rel.startsWith(d + '/'));
        // A path that CONTAINS a protected entry (the entry lies under it): moving `.claude` out, rewriting settings.json
        // and moving it back was an escape one level up from every "under" test. The root ('') is exempt — it contains
        // everything, `ls .` must keep working, and the destructive root operations are refused elsewhere (`rm -r` by
        // HISTORY, `..` as outside the folder).
        const containsAny = (rel, dirs) => rel !== '' && dirs.some((d) => d !== '' && d.startsWith(rel + '/'));
        // A path segment Windows would resolve to something a string compare cannot see: an 8.3 short name
        // (`STATE~1`, `SETTIN~1.JSO` — the long name it abbreviates may be PROTECTED or state/), an alternate
        // data stream (`x.md:evil`, a colon past the drive letter), or a device name (CON, NUL, COM1…). Refused
        // outright rather than resolved, since resolving needs the file to exist.
        const DEVICES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
        function oddSegment(p, devices = true) {
          const s = String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/^\/[A-Za-z](?=\/|$)/, '');
          for (const seg of s.split('/')) {
            if (!seg || seg === '.' || seg === '..') continue;
            if (/~\d/.test(seg)) return 'an 8.3 short name';
            if (seg.includes(':')) return 'an alternate data stream';
            if (devices && DEVICES.test(seg.replace(/[. ]+$/, ''))) return 'a device name';
          }
          return null;
        }

        // Best-effort: a refusal reason when a path-like Bash token points outside the jail, into state/, or
        // at a PROTECTED app-managed path or a folder holding one — else null. DEFENCE IN DEPTH, leg (2) in the header: a token scan is
        // fooled by a variable, a $(...) or a constructed string, and such a token can write this guard's file.
        // The `` ` `` splitter also catches a token inside a backtick substitution.
        function bashDenyReason(command, root) {
          if (HOME.test(command)) return 'a home / profile path';
          // Resolve EVERY non-flag, non-URL token against the root — a bare `site.json` / `.mcp.json` / `state`
          // (no slash) is a path at the data root and must be checked too. A command word (`cp`, `cat`) resolves
          // to a harmless in-root name; only a token that escapes the root or lands on state/ / a PROTECTED path
          // is refused.
          for (let t of command.split(/[\s;|&()<>`{}]+/)) {
            t = t.replace(/^["']+|["']+$/g, '');
            if (!t || t.startsWith('-')) continue;                    // a flag, not a path
            if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) continue;         // URL — network already denied
            if (t.startsWith('~')) return 'a home / profile path';
            // Only a PATH-LIKE token (a slash) is checked for short names / streams — a bare `HEAD~1` or
            // `a:b` is a git revision or plain text, not a file. Devices are harmless as a Bash target (`> NUL`).
            if (/[\/\\]/.test(t)) {
              // `HEAD~2:plans/x.md` is a git revision:path — check only the path after the revision. A colon
              // BEFORE any slash that is not a drive letter marks it; an ADS colon comes after the last slash.
              const rev = /^([^\/\\:]+):(?![\/\\])(.*)$/.exec(t);
              const odd = oddSegment(rev && !/^[A-Za-z]$/.test(rev[1]) ? rev[2] : t, false);
              if (odd) return `a path with ${odd}`;
            } else if (t.includes(':')) {
              // No slash but a colon: text (`a:b`, `key:value`), not a path — unless it is a bare drive (`C:`).
              if (/^[A-Za-z]:$/.test(t)) return 'a path outside the data folder';
              continue;
            }
            const rel = relTo(t, root);
            if (rel === null) return 'a path outside the data folder';   // absolute-outside or `..`-escape
            if (underAny(rel, READ_DENY)) return 'state/ (app state — the access token, the TLS key, the database)';
            if (underAny(rel, BASH_PROTECTED)) return 'a protected, app-managed path (the guard / settings / .mcp.json / site.json / .git)';
            if (containsAny(rel, BASH_PROTECTED)) return 'a folder holding protected, app-managed files (the guard / settings) — move or change the files inside it one by one';
          }
          return null;
        }

        const chunks = [];
        for await (const c of process.stdin) chunks.push(c);
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { allow(); }

        const toolName = payload.tool_name ?? '';
        if (DENIED.includes(toolName))
          deny(`Blocked: ${toolName} is not available in this site (denied in site.json).`);
        const toolInput = payload.tool_input ?? {};
        const projectDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

        if (toolName === 'Bash') {
          const command = String(toolInput.command ?? '');
          if (HISTORY.some((re) => re.test(command)))
            deny('Blocked: no git-history / destructive commands — the server commits only after you approve the diff.');
          if (NETWORK.some((re) => re.test(command)))
            deny('Blocked: no direct network access from the shell. Use WebFetch / WebSearch, or a server MCP tool for out-of-boundary fetches.');
          if (EVALS.some((re) => re.test(command)))
            deny('Blocked: no inline code-eval (node -e / python -c / sh -c / pipe-to-shell / powershell -Command). Run a committed skill file or use an MCP tool.');
          if (launchesShell(command))
            deny('Blocked: do not launch another shell or interpreter (powershell / pwsh / cmd / wscript / cscript / mshta / bash / sh / source / wsl / rundll32 / regsvr32 / Start-Process, or git -c of a command-running key) — it runs commands this guard cannot see. To move, rename or delete a file use the MCP file tools; to inspect one use file_info; otherwise run a committed skill file.');
          if (CRAWL.some((re) => re.test(command)))
            deny('Blocked: use Read / Glob / Grep to explore — not Bash crawling (find / ls -R / dir /s).');
          const bashReason = bashDenyReason(command, projectDir);
          if (bashReason)
            deny(`Blocked: this command references ${bashReason}. The agent is jailed to the data folder; use an MCP tool for anything out-of-boundary. (Path-token matching is best-effort.)`);
          allow();
        }

        if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
          // The named path — and the LITERAL HEAD of a Glob `pattern` / Grep `glob` (the part before the
          // first glob metacharacter, so `state/**` heads at `state/`) — must be inside the jail and never
          // inside state/. A recursive `**` with no leading dir is a residual the guard cannot fully evaluate.
          const head = (s) => String(s).split(/[*?\[{]/)[0];
          const cands = [];
          if (toolInput.file_path) cands.push([String(toolInput.file_path), true]);
          if (toolInput.path) cands.push([String(toolInput.path), true]);
          if (toolInput.pattern) cands.push([head(toolInput.pattern), false]);
          if (toolInput.glob) cands.push([head(toolInput.glob), false]);
          for (const [p, jailCheck] of cands) {
            if (!p) continue;
            const odd = oddSegment(p);
            if (odd) deny(`Blocked: "${p}" names ${odd} — use the file's plain name.`);
            const rel = relTo(p, projectDir);
            if (rel === null) {
              if (jailCheck)
                deny(`Blocked: reads are limited to the data folder — "${p}" is outside it. Use an MCP tool for out-of-boundary data.`);
              continue;
            }
            if (underAny(rel, READ_DENY))
              deny(`Blocked: state/ holds app state (the access token, the TLS key, the database) — off-limits. Use an MCP tool for anything the app exposes.`);
          }
          allow();
        }

        if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
          const filePath = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path ?? '';
          if (!filePath) allow();
          const odd = oddSegment(filePath);
          if (odd) deny(`Blocked: "${filePath}" names ${odd} — use the file's plain name.`);
          const rel = relTo(filePath, projectDir);
          if (rel === null) deny(`Blocked: ${filePath} is outside the data folder.`);
          if (!underAny(rel, WRITE_DIRS))
            deny(`Blocked: the agent may only edit ${WRITE_DIRS.join(', ')} — not "${rel}".`);
          for (const [dir, exts] of Object.entries(WRITE_EXTS)) {
            if (rel !== dir && !rel.startsWith(dir + '/')) continue;
            const rest = rel.slice(dir.length + 1);
            if (rest.includes('/'))
              deny(`Blocked: ${dir}/ is flat — put "${rel}" directly in ${dir}/.`);
            if (!exts.some((e) => rest.toLowerCase().endsWith(e)))
              deny(`Blocked: only ${exts.join('/')} files may be written under ${dir}/ — not "${rel}".`);
          }
          if (underAny(rel, PROTECTED))
            deny(`Blocked: "${rel}" is a protected, app-managed path (the guard / settings) — not editable.`);
          allow();
        }

        allow();
        """;

    /// <summary>The block vocabulary the agent writes against. Every row below is enforced by
    /// <c>Platform/Agent/Ui</c> — the component list is the registered <c>IUiNodeSchema</c> set, the
    /// props are those schemas' <c>Props</c>, the two verbs are <c>UiActionValidator</c>'s, and the
    /// limits are <c>UiTreeValidator.MaxDepth</c>/<c>MaxNodes</c>. A contract that drifts from the
    /// validator is worse than none: the agent follows it and the household gets a fallback card.</summary>
    private const string ToolSpecTemplate = """
        <!-- TOOL_CONTRACT_VERSION: 2 — generated by Gatherlight. App-managed: edits are replaced. -->
        # 自建工具 · Writing your own tool

        When a task needs a REUSABLE capability that does not exist, you can write one instead of
        working around its absence. You author it as ordinary files; a human approves it; then you
        can call it like any other tool.

        You do NOT write an MCP server. You write a small script, and the app runs it for you inside
        a sandbox. That is deliberate: an MCP server would run with the household's full privileges,
        while what you write here is contained — see 沙箱 below.

        ## 1. Write two files

        `.claude/tool-drafts/<id>/tool.json` — `<id>` is lower-case letters, digits and `_`:

        ```json
        {
          "name": "flight_delay_stats",
          "title": "航班准点率 · Flight delay stats",
          "description": "What this does, in one line — the household reads this on the approval card.",
          "grant": { "id": "flight_delay_stats", "fs": { "read": ["plans"], "write": ["cache"] }, "net": false },
          "command": { "args": ["main.mjs"] }
        }
        ```

        `.claude/tool-drafts/<id>/main.mjs` — the entry script named by `command.args`:

        ```js
        // Arguments arrive as ONE json object on stdin. Write ONE json object to stdout.
        let input = '';
        for await (const chunk of process.stdin) input += chunk;
        const args = JSON.parse(input || '{}');

        // …do the work…

        process.stdout.write(JSON.stringify({ ok: true, answer: args.q ?? null }));
        ```

        Then end your message with the marker and STOP:

        ```
        TOOL_DRAFT: flight_delay_stats
        ```

        **A draft does nothing until a human approves it.** Do not call it, and do not say you used
        it — until then it is a file, not a tool.

        ## 2. 沙箱 · What the sandbox refuses

        Your script runs under Node's permission model plus a platform preload. These are REFUSALS,
        not conventions — code that tries them throws:

        - **Network, unless you asked for it.** With `"net": false` these modules throw on import:
          __BLOCKED_MODULES__ — and `fetch`, `WebSocket`, `EventSource` are removed outright.
          Set `"net": true` if the tool genuinely needs the internet; the household sees that on the
          card and may say no.
        - **Other programs — always.** `child_process`, `worker_threads` and native addons are denied
          on every launch, whatever the grant says. Do not shell out.
        - **Files — only what the grant lists.** `fs.read` and `fs.write` name directories in this
          site's own vocabulary: __RECORD_DIRS__. Never an absolute path, never `state/` (settings,
          database, tokens), never outside the site. `write` defaults to `cache` alone.
        - **The environment — only what Node needs.** `process.env` holds __SANDBOX_ENV__ when the
          household has them, and nothing else from their machine: no tokens, no settings, no
          `NODE_OPTIONS`. With `"net": true` it also holds their proxy settings: __SANDBOX_NET_ENV__.
          Take everything the tool needs from its input instead.

        Ask for the LEAST that works. The grant is printed on the approval card in plain language, and
        a household reading "reach the internet" for a tool that sorts dates will simply decline.

        ## 3. Getting it right first time

        - One job per tool. A tool that "does everything about flights" is one nobody can approve.
        - Fail loudly: write `{ "error": "…" }` to stdout and exit non-zero. Silence reads as success.
        - No dependencies to install — plain Node only. There is no npm install on the household's
          machine.
        - Keep it deterministic. If it needs the network, it needs `net: true` and a good reason.
        - After approval you can call it immediately, by its `name`, like any other tool.
        """;

    private const string UiSpecTemplate = """
        <!-- UI_CONTRACT_VERSION: 3 — generated by Gatherlight. App-managed: edits are replaced. -->
        # 界面块 · UI blocks

        You can render real UI, not just text. Write normal prose, and drop ```ui fenced blocks into
        it. Each block holds ONE component tree as JSON.

        ```ui
        { "type": "Card", "title": "Day 1", "children": [
            { "type": "Text", "text": "Morning at the museum" },
            { "type": "Table", "columns": ["Item", "Cost"], "rows": [["Entry", "1200"]] } ] }
        ```

        Rules:
        - `type` and `children` are reserved. Every other key is a prop, written flat.
        - A bare string inside `children` is shorthand for a `Text` node.
        - Only the components below exist. Anything else is shown to the user as "content this app
          cannot display" — so do not invent component names, props or prop values.
        - There is no HTML and no script. If you cannot express it with these components, say so in
          prose.

        ## Components

        | Type | Children | Props |
        |---|---|---|
        | `Stack` | yes | `gap`: none·sm·md·lg |
        | `Row` | yes | `gap`: none·sm·md·lg; `align`: start·center·end·baseline; `wrap`: true/false |
        | `Card` | yes | `title`, `subtitle` |
        | `Divider` | no | — |
        | `Heading` | no | `text` (required), `level`: 2·3·4 |
        | `Text` | no | `text` (required), `weight`: normal·bold, `tone`: default·muted·positive·warning |
        | `List` | no | `items` (required, strings), `ordered`: true/false |
        | `Badge` | no | `text` (required), `tone`: default·muted·positive·warning |
        | `Image` | no | `src` (required — a file path inside the site, or an https URL), `alt`, `caption` |
        | `Table` | no | `columns` (required, strings), `rows` (required, array of string arrays), `caption`, `bind` |
        | `Chart` | no | `labels` (required, strings), `values` (required, numbers — same length as `labels`), `kind`: bar·line, `unit`, `caption`, `bind` |
        | `Map` | no | `cities`: [names] — or `points`: [{name,lat,lng}] with numeric lat/lng; `connect`: true/false, `title` |
        | `Link` | no | `href` (required, http/https), `text` (required) |
        | `FileRef` | no | `path` (required, inside the site), `label` |
        | `Button` | no | `label` (required), `action` (required) |

        Only `Stack`, `Row` and `Card` take `children` — giving any other component children fails.
        A `Map` with `cities` draws those cities; `points` is used only when `cities` is absent.

        ## Button actions

        A button does one of exactly three things:

        - `{ "send": "text" }` — puts that text in as the person's next message.
        - `{ "openRecord": "plans/some-file.md" }` — opens a file from the site.
        - `{ "runCapability": "budget_scan" }` — runs a capability that was ALREADY approved. You
          name the id; you never supply code.

        Nothing else is accepted. A button cannot approve anything, open a URL, or run code you wrote
        into the page — every real decision still goes through its own confirmation.

        ## 页面 · Pages

        You can also SAVE a tree as a page of this site. Write it to `ui/<name>.json`:

        ```json
        { "title": "Trip dashboard",
          "nav": { "label": "行程", "order": 1 },
          "root": { "type": "Stack", "children": [] } }
        ```

        - `ui/` is FLAT and holds only `.json` page files — no subdirectories, no other file types.
        - `<name>` is letters, digits, `-` and `_` only.
        - `nav` is optional: `label` (defaults to the title), `order` (lower sorts first),
          `hidden` (keeps it out of the menu but still reachable by link).
        - Writing the file publishes it. There is no separate list to update.
        - The person reviews your page by LOOKING at it, rendered, before it is committed. A page
          that fails validation cannot be committed at all — so use only the components above.

        A `Button` on a page can also run a capability you already had approved:
        `{ "label": "重算预算", "action": { "runCapability": "budget_scan" } }`. The app shows the
        person what that capability may do before it runs.

        ## 实时数据 · Live data on a page

        A page you write today is read next month. If you paste the numbers in, the page keeps showing
        today's numbers forever and quietly becomes wrong. Instead, `bind` a `Table` or a `Chart` to a
        named query, and the app fills it in fresh every time someone opens the page:

        ```json
        { "type": "Table", "columns": ["标题", "更新", "路径"],
          "bind": { "query": "records", "params": { "kind": "trips", "limit": 10 } } }
        ```

        - Use `bind` INSTEAD of `rows` (or, for a `Chart`, instead of `labels`+`values`). Giving both
          fails — the page would have two answers for the same cells.
        - `query` must be one of the queries below. You cannot write a query, a filter or a condition;
          you pick a name and fill in the parameters it declares.
        - A `Chart` binding uses the query's FIRST column as the label and its SECOND as the value, so
          bind a chart only to a query whose second column is a number.
        - Bindings work on **pages**, not in a ```ui block. In chat you already have the data — put it
          in directly.

        __QUERIES__

        If the data cannot be read when the page is opened, that spot shows a plain warning and the
        rest of the page still renders. Long results are cut off and say so.

        ## 自定义组件 · Your own components

        When the same shape repeats on a page, define it once. A file in `ui/` with `define` instead
        of `root` is a component definition, not a page:

        ```json
        { "define": "DayCard",
          "params": { "day": "string", "note": "string" },
          "body": { "type": "Card", "title": "{{day}}",
                    "children": [ { "type": "Text", "text": "{{note}}" } ] } }
        ```

        Then use it anywhere a component goes: `{ "type": "DayCard", "day": "Day 1", "note": "美术馆" }`.

        - A placeholder must be the WHOLE value. `"{{day}}"` works; `"Day {{day}}"` is an error.
        - A definition may only use built-in components — not another definition.
        - It must not be named after a built-in (`define: "Table"` is refused).
        - Pass everything it needs as `params`; a definition does not take `children`.
        - Editing a definition changes every page that uses it, so the person reviewing sees those
          pages too, not just the definition.

        Limits: at most 12 levels deep and 500 nodes per tree, counted AFTER your components are
        expanded.
        """;
}
