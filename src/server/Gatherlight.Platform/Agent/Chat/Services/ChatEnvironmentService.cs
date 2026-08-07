using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Site.Services;

namespace Gatherlight.Server.Platform.Agent.Chat.Services;

/// <summary>
/// Generates the runtime files the spawned claude needs inside the data folder:
/// <c>state/settings.chat.json</c> (acceptEdits + the PreToolUse scope-guard hook, passed via
/// --settings on the execute phase — regenerated every boot, it's app state) and
/// <c>.claude/hooks/scope-guard.mjs</c> — the agent's SECURITY jail (reads confined to the data
/// folder, writes to plans/ household/ .claude/, Bash denied git-history/network/inline-eval/crawl/
/// path-escape). Because it's a security boundary (not editable knowledge-base content), it's
/// re-issued whenever its <c>GUARD_VERSION</c> is missing or older than the shipped one, so hardening
/// reaches folders seeded by an earlier build. Out-of-boundary work must route through an MCP tool.
/// <para><c>.claude/ui-spec.md</c> — the block vocabulary — rides the same version gate
/// (<c>UI_CONTRACT_VERSION</c>) for the same reason: it is a protocol contract, not knowledge-base
/// content, and the seeder deliberately never overwrites a file the household edited. A stale
/// vocabulary means the agent emits trees the validator rejects and the household sees fallback
/// cards instead of a plan.</para>
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
    public string ScopeGuardPath => Path.Combine(_site.ZhikuPath, "hooks", "scope-guard.mjs");
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
        File.WriteAllText(SettingsPath, BuildChatSettings(PlannerGuardCommand, deny));
        // 系统模式 settings: same acceptEdits shape, but the PreToolUse hook is the code repo's tracked
        // system scope guard (deny-list: whole repo except guard/, src/server, settings, .git), referenced
        // absolutely since the run's $CLAUDE_PROJECT_DIR is the code repo. Built from the SAME template with
        // a different guard command — NOT a string.Replace that could silently no-op (and leave system mode
        // running the PLANNER scope) if the settings JSON is ever reformatted.
        var systemGuard = Path.Combine(_options.CodeRootPath, "guard", "system-scope-guard.mjs")
            .Replace('\\', '/');
        File.WriteAllText(SystemSettingsPath, BuildChatSettings($"node \\\"{systemGuard}\\\"", deny));
        RemoveStaleMcpConfig();

        var created = new List<string>();
        if (ShouldReissueGuard(ScopeGuardPath))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ScopeGuardPath)!);
            File.WriteAllText(ScopeGuardPath, RenderScopeGuard());
            created.Add(".claude/hooks/scope-guard.mjs");
        }
        if (ShouldReissueUiSpec(UiSpecPath))
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

    // The scope guard is a SECURITY boundary, not user content: (re)issue it when missing OR when an
    // older GUARD_VERSION is on disk, so a hardened guard reaches data folders seeded by an earlier
    // build (and a weakened/tampered copy is replaced). Same-version files are left as-is — no
    // spurious data-repo commit. A newer on-disk version (dev ahead of server) is also left alone.
    private static readonly int ShippedGuardVersion = ReadGuardVersion(ScopeGuardMjs);

    private static bool ShouldReissueGuard(string guardPath)
    {
        if (!File.Exists(guardPath)) return true;
        try { return ReadGuardVersion(File.ReadAllText(guardPath)) < ShippedGuardVersion; }
        catch { return true; }
    }

    private static int ReadGuardVersion(string body)
    {
        var m = System.Text.RegularExpressions.Regex.Match(body, @"GUARD_VERSION:\s*(\d+)");
        return m.Success && int.TryParse(m.Groups[1].Value, out var v) ? v : 0;
    }

    // The UI contract is app-managed, not knowledge-base content: an agent working from a stale
    // vocabulary emits trees that fail validation and the household sees fallback cards. Same
    // version-gated re-issue as the scope guard — a newer on-disk version is left alone.
    private static readonly int ShippedUiContractVersion = ReadContractVersion(UiSpecTemplate);

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

    private static bool ShouldReissueUiSpec(string path)
    {
        if (!File.Exists(path)) return true;
        try { return ReadContractVersion(File.ReadAllText(path)) < ShippedUiContractVersion; }
        catch { return true; }
    }

    private static int ReadContractVersion(string body)
    {
        var m = System.Text.RegularExpressions.Regex.Match(body, @"UI_CONTRACT_VERSION:\s*(\d+)");
        return m.Success && int.TryParse(m.Groups[1].Value, out var v) ? v : 0;
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

        return ToolSpecTemplate
            .Replace("__RECORD_DIRS__", readDirs, StringComparison.Ordinal)
            .Replace("__BLOCKED_MODULES__", blocked, StringComparison.Ordinal);
    }

    // The chat (planner) and 系统模式 settings share ONE template; only the PreToolUse guard command
    // differs. Building both from BuildChatSettings — rather than deriving one from the other via
    // string.Replace — means a reformat can't silently drop the substitution and mis-scope a run.
    private const string PlannerGuardCommand = "node \\\"$CLAUDE_PROJECT_DIR/.claude/hooks/scope-guard.mjs\\\"";

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
    private static string BuildChatSettings(string guardCommand, IReadOnlyList<string> deny)
    {
        var allow = BuiltinTools.Where(t => !deny.Any(d => string.Equals(d, t, StringComparison.OrdinalIgnoreCase)));
        var allowJson = string.Join(", ", allow.Select(t => $"\"{t}\""));
        // A denied tool must also be in the SET OF TOOLS THE HOOK FIRES FOR, or the DENIED check
        // added to the guard body is unreachable — the exact gap that left WebFetch's guard-side
        // denial decorative. Serialized via JsonSerializer (not manual quoting) because a denied id
        // is user-controlled (site.json) and Regex.Escape can itself introduce backslashes that need
        // JSON-escaping in turn.
        var matcherJson = System.Text.Json.JsonSerializer.Serialize(BuildGuardMatcher(deny));
        return $$"""
        {
          "$comment": "Generated by Gatherlight at startup — do not edit (changes are overwritten). Isolated Claude Code settings for the chat EXECUTE phase, passed via `claude --settings`. Pre-grants permissions so the headless run never stalls on a prompt; the real safety is (1) the PreToolUse scope-guard hook below and (2) the human plan+diff gates in the server.",
          "permissions": {
            "defaultMode": "acceptEdits",
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
         * PreToolUse scope guard (v2) for Gatherlight headless PLANNER runs — cwd = the data folder.
         * Registered in state/settings.chat.json.
         *
         * The spawned agent is JAILED to the data folder. Enforced boundaries:
         *   WRITE (Edit/Write/MultiEdit/NotebookEdit)  -> under plans/ household/ .claude/ ui/ EXCEPT
         *                                                the PROTECTED set (.claude/hooks/, .claude/settings*.json),
         *                                                and under ui/ only a flat .json page (WRITE_EXTS)
         *   READ  (Read/Grep/Glob)                     -> only inside the data folder
         *   BASH                                       -> not: git-history / delete, network egress,
         *                                                inline code-eval, filesystem crawl, or any
         *                                                path outside the folder (args or redirects)
         *
         * Anything genuinely out-of-boundary (fetch a URL, run a scraper, read a shared resource) MUST
         * go through a server MCP tool -- mediated + auditable -- never raw Bash. Else: silent exit 0.
         *
         * Kept identical to guard/system-scope-guard.mjs except WRITE_DIRS + WRITE_EXTS + PROTECTED;
         * e2e suite p24 runs both. GUARD_VERSION is the upgrade key: the server re-issues newer logic
         * into an existing data folder (ChatEnvironmentService.EnsureFiles), so hardening reaches old
         * installs.
         *
         * DENIED (v6) closes the exfiltration residual this file used to admit to: WebFetch is granted
         * in state/settings.chat.json but this guard's matcher never intercepted it. A site.json
         * capabilities.deny entry now removes the tool from BOTH the generated allow-list
         * (ChatEnvironmentService.BuildChatSettings) AND here — denying a CLI built-in, not just an
         * MCP tool the guard never saw in the first place.
         */
        // GUARD_VERSION: 7
        import path from 'node:path';

        const WRITE_DIRS = __WRITE_DIRS__;
        // Dirs whose file TYPE is restricted. ui/ holds the site's pages: a path the agent may write
        // there must be exactly a page, so nothing else can end up in the directory the app renders.
        // Flat by rule too -- SitePageStore lists the top level only and a page name is a bare stem,
        // so a file in a subdirectory would be writable and permanently invisible.
        const WRITE_EXTS = __WRITE_EXTS__;
        const PROTECTED = ['.claude/hooks', '.claude/settings.json', '.claude/settings.local.json'];
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
        const CRAWL = [
          /(^|[\s;&|(])find\s/, /(^|[\s;&|(])ls\s+-[a-zA-Z]*[Rr]/, /(^|[\s;&|(])dir\b[\s\S]*\/s/i,
          /(^|[\s;&|(])grep\b[^;&|\n]*\s-[a-zA-Z]*[rR]/, /(^|[\s;&|(])(rg|tree)(\s|$)/,
          /\bGet-ChildItem\b[^;&|\n]*-[Rr]ecurse/i, /(^|[\s;&|(])gci\b[^;&|\n]*-[a-zA-Z]*[Rr]\b/i,
        ];
        // Sensitive home/profile vars, braced (${HOME}) or bare ($HOME). `~` is caught in bashEscapes.
        const HOME = /(\$\{?(HOME|USERPROFILE|LOCALAPPDATA|APPDATA|HOMEPATH)\b|\$env:|%(USERPROFILE|LOCALAPPDATA|APPDATA|HOMEPATH|HOME)%)/i;

        function deny(reason) {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
          }));
          process.exit(0);
        }
        const allow = () => process.exit(0);

        // Normalize a path (relative -> resolved against `root`) to a lowercased, drive-aware slash form
        // so containment is a string-prefix test. Git-bash `/c/x` and Windows `C:\x` both fold to `c:/x`.
        function norm(p, root) {
          let s = String(p).replace(/\\/g, '/').replace(/^\/([A-Za-z])(?=\/|$)/, (_, d) => `${d}:`);
          const abs = /^[A-Za-z]:/.test(s) || s.startsWith('/');
          if (!abs) s = `${String(root).replace(/\\/g, '/')}/${s}`;
          const out = [];
          for (const seg of s.split('/')) {
            if (seg === '' || seg === '.') continue;
            if (seg === '..') out.pop(); else out.push(seg);
          }
          return out.join('/').toLowerCase();
        }
        // Relative path of `p` inside `root`, or null when `p` escapes it.
        function relTo(p, root) {
          const r = norm('.', root);
          const n = norm(p, root);
          if (n === r) return '';
          if (n.startsWith(r + '/')) return n.slice(r.length + 1);
          return null;
        }
        const inside = (p, root) => relTo(p, root) !== null;
        // rel is under any entry of `dirs`. A '' entry means the whole jail; other entries match the
        // dir/file itself or anything beneath it. Shared by the WRITE_DIRS allow-list + PROTECTED deny-list.
        const underAny = (rel, dirs) => dirs.some((d) => d === '' || rel === d || rel.startsWith(d + '/'));

        // Best-effort: does any path-like token in a Bash command point outside the jail? The robust
        // controls are the network/eval denials above + the read/write jail at the tool layer; this
        // catches the common cat/cp/mv/redirect-to-outside cases. An OS-level sandbox is the belt-and-
        // suspenders upgrade, and also what would contain code executed inside an agent-authored script.
        function bashEscapes(command, root) {
          if (HOME.test(command)) return true;
          for (let t of command.split(/[\s;|&()<>]+/)) {
            t = t.replace(/^["']+|["']+$/g, '');
            if (!t || t.startsWith('-')) continue;                    // a flag, not a path
            if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) continue;         // URL -- network already denied
            if (t.startsWith('~')) return true;                       // home dir
            if (t === '..') return true;                              // bare `cd ..` climbing out
            if (!/[\/\\]/.test(t) && !/^[A-Za-z]:$/.test(t)) continue; // not path-like
            if (!inside(t, root)) return true;
          }
          return false;
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
          if (CRAWL.some((re) => re.test(command)))
            deny('Blocked: use Read / Glob / Grep to explore — not Bash crawling (find / ls -R / dir /s).');
          if (bashEscapes(command, projectDir))
            deny('Blocked: this command references a path outside the data folder. The agent is jailed here; use an MCP tool for anything out-of-boundary.');
          allow();
        }

        if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
          const p = toolInput.file_path ?? toolInput.path ?? '';     // Grep/Glob path optional (absent = cwd, in jail)
          if (p && !inside(String(p), projectDir))
            deny(`Blocked: reads are limited to the data folder — "${p}" is outside it. Use an MCP tool for out-of-boundary data.`);
          allow();
        }

        if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
          const filePath = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path ?? '';
          if (!filePath) allow();
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
        <!-- TOOL_CONTRACT_VERSION: 1 — generated by Gatherlight. App-managed: edits are replaced. -->
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
