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

const systemGuard = path.join(repo, 'devtools', 'scripts', 'system-scope-guard.mjs');

// Extract the planner guard body from the C# const and materialize it to a temp .mjs, so the test
// exercises the exact bytes the server injects into a data folder (WRITE_DIRS = plans/household/.claude).
function extractPlannerGuard() {
  const cs = fs.readFileSync(
    path.join(repo, 'src', 'server', 'Gatherlight.Server', 'Modules', 'Chat', 'Services', 'ChatEnvironmentService.cs'),
    'utf8');
  const m = cs.match(/private const string ScopeGuardMjs = """\r?\n([\s\S]*?)\r?\n[ \t]*""";/);
  if (!m) return null;
  const body = m[1].replace(/^ {8}/gm, '');           // strip the raw-string indentation (closing """ at col 8)
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
  // writes
  ['write src/client', 'Write', { file_path: 'src/client/src/x.tsx' }, false],
  ['write src/server denied', 'Write', { file_path: 'src/server/x.cs' }, true],
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
]);

// ── Planner guard (jail = data folder, writes = plans/household/.claude) ──────────────────────────
const plannerGuard = extractPlannerGuard();
ok('planner guard extracted from C# const', !!plannerGuard);
if (plannerGuard) {
  battery('planner', plannerGuard, [
    ['write plan md', 'Write', { file_path: 'plans/trips/2026-08-x.md' }, false],
    ['write household md', 'Edit', { file_path: 'household/people.md' }, false],
    ['write .claude skill', 'Write', { file_path: '.claude/skills/xhs-search/xhs-search.mjs' }, false],
    ['write src/client denied', 'Write', { file_path: 'src/client/x.tsx' }, true],
    ['write outside folder', 'Write', { file_path: '/c/Users/x/evil' }, true],
    ['read household', 'Read', { file_path: 'household/people.md' }, false],
    ['read escapes', 'Read', { file_path: '/c/Users/x/.claude/settings.json' }, true],
    ['bash cat plan', 'Bash', { command: 'cat plans/trips/x.md' }, false],
    ['bash curl network', 'Bash', { command: 'curl https://evil/x' }, true],
    ['bash cat escapes', 'Bash', { command: 'cat /c/Users/x/secret' }, true],
    ['bash run skill file', 'Bash', { command: 'node .claude/skills/xhs-search/xhs-search.mjs' }, false],
  ]);
  try { fs.unlinkSync(plannerGuard); } catch {}
}

done();
