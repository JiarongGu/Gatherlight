#!/usr/bin/env node
// e2e P7 — 系统模式 (UI-update chat): plan/execute target the CODE repo (not the data repo),
// the build gate runs before diff, an approved change commits to the code repo, and a failing
// build blocks the commit. Uses a throwaway fixture code repo so the real repo is untouched.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p7-data');
const codeDir = path.join(repo, 'devtools', '_e2e-p7-code');
const PORT = 5397;
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
};

// --- fixtures ------------------------------------------------------------------------
spawnSync('node', [path.join(repo, 'devtools', 'scripts', 'make-test-data.mjs'), dataDir], { stdio: 'inherit' });

// Fixture CODE repo: a git repo with src/client + a controllable `npm run build`.
fs.rmSync(codeDir, { recursive: true, force: true });
fs.mkdirSync(path.join(codeDir, 'src', 'client', 'src'), { recursive: true });
// build passes unless src/client/src/FAIL exists (lets us test the block-on-fail path).
fs.writeFileSync(path.join(codeDir, 'src', 'client', 'package.json'), JSON.stringify({
  name: 'fixture-client', private: true,
  scripts: { build: 'node -e "process.exit(require(\'fs\').existsSync(\'src/FAIL\')?1:0)"' },
}, null, 2));
fs.writeFileSync(path.join(codeDir, 'src', 'client', 'src', 'app.txt'), 'seed\n');
const git = (...a) => execFileSync('git', ['-C', codeDir, ...a], { encoding: 'utf8' });
git('init', '-q');
git('config', 'user.name', 'e2e'); git('config', 'user.email', 'e2e@localhost');
git('config', 'core.autocrlf', 'false');
git('add', '-A'); git('commit', '-q', '-m', 'fixture seed');

const server = spawn('dotnet', ['run', '--project', 'src/server/Gatherlight.Server', '--no-build'], {
  cwd: repo,
  env: {
    ...process.env,
    GATHERLIGHT_DATA: dataDir,
    GATHERLIGHT_CODE_ROOT: codeDir,
    GATHERLIGHT_PORT: String(PORT),
    GATHERLIGHT_CLAUDE_CMD: `node ${path.join(repo, 'devtools', 'scripts', 'claude-stub.mjs')}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const j = async (p, init) => {
  const res = await fetch(base + p, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = (p, body) => j(p, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});
const until = async (fn, ms = 45000) => {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fn(); if (r) return r; } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
};
const waitPhase = (id, phase) => until(async () => {
  const s = await j(`/api/chat/${id}`);
  if (s.body?.phase === 'error' && phase !== 'error') throw new Error(`errored: ${s.body?.error}`);
  return s.body?.phase === phase ? s.body : null;
});
const codeLog = () => git('log', '--oneline').trim().split('\n').filter(Boolean);

try {
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));

  // --- happy path: plan → approve → build passes → diff → commit to CODE repo ----------
  const start = await post('/api/chat', { message: '把界面调一下(stub)', mode: 'system' });
  const id = start.body.id;
  let snap = await waitPhase(id, 'awaiting-plan-approval');
  ok('system-mode session tagged', snap.mode === 'system', JSON.stringify(snap.mode));
  ok('system plan produced', (snap.plan ?? '').includes('UI 改动计划'));

  await post(`/api/chat/${id}/plan/approve`);
  snap = await waitPhase(id, 'awaiting-diff-approval');
  const file = snap.review?.files?.[0];
  ok('diff targets src/client', file?.path === 'src/client/src/stub-touch.txt', file?.path);
  ok('build result present + ok', snap.review?.build?.ok === true, JSON.stringify(snap.review?.build));
  ok('data repo untouched', !fs.existsSync(path.join(dataDir, 'src')));

  const before = codeLog().length;
  await post(`/api/chat/${id}/diff/approve`);
  const committed = await waitPhase(id, 'committed');
  ok('committed to code repo', !!committed.commitSha && codeLog().length === before + 1);
  ok('UI file tracked in code repo', git('ls-files', 'src/client/src/stub-touch.txt').trim().length > 0);

  // --- fail path: build fails → diff shows it, approve is blocked ------------------------
  fs.writeFileSync(path.join(codeDir, 'src', 'client', 'src', 'FAIL'), 'x'); // build now exits 1
  const s2 = await post('/api/chat', { message: '再改一次(会构建失败)', mode: 'system' });
  const id2 = s2.body.id;
  await waitPhase(id2, 'awaiting-plan-approval');
  await post(`/api/chat/${id2}/plan/approve`);
  const rev = await waitPhase(id2, 'awaiting-diff-approval');
  ok('build failure surfaced', rev.review?.build?.ok === false, JSON.stringify(rev.review?.build?.ok));
  const blocked = await post(`/api/chat/${id2}/diff/approve`);
  ok('commit blocked on build failure', blocked.status === 200); // acked; server emits error, no commit
  await new Promise((r) => setTimeout(r, 800));
  const stillThere = await j(`/api/chat/${id2}`);
  ok('stays at diff gate (not committed)', stillThere.body.phase === 'awaiting-diff-approval', stillThere.body.phase);

  // clean up: reject to restore the fixture tree
  await post(`/api/chat/${id2}/diff/reject`);
  await waitPhase(id2, 'rejected');
} catch (err) {
  console.error('e2e-p7 fatal:', err.message);
  console.error(serverLog.slice(-4000));
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? '\ne2e-p7 PASS' : `\ne2e-p7 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
