#!/usr/bin/env node
// Real-claude smoke — the one path the stubbed e2e suites can't cover: drive the full two-gate
// chat loop (plan → approve → execute → diff → approve → commit) against the ACTUAL authenticated
// `claude` CLI, spawning real LLM turns. Runs on an isolated throwaway data folder — NEVER local/.
//
//   node devtools/dev.mjs smoke        (or: node devtools/scripts/smoke-real-claude.mjs)
//
// Opt-in + manual: it costs tokens, is non-deterministic, and needs an authenticated CLI, so it is
// deliberately excluded from `e2e all`. Exit 0 = the real product loop worked end to end.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_smoke-real-data');
const PORT = 5399;
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
};
const log = (m) => console.log(`[smoke] ${m}`);

// Fresh isolated data folder every run (the seeder scaffolds .claude on boot).
fs.rmSync(dataDir, { recursive: true, force: true });
spawnSync('node', [path.join(repo, 'devtools', 'scripts', 'make-test-data.mjs'), dataDir], { stdio: 'inherit' });

// Real claude — strip any stub / fixture overrides an outer shell may have set.
const env = { ...process.env, GATHERLIGHT_DATA: dataDir, GATHERLIGHT_PORT: String(PORT) };
for (const k of ['GATHERLIGHT_CLAUDE_CMD', 'GATHERLIGHT_FIXTURE_ORIGIN',
  'GATHERLIGHT_BASE_FLIGHTAWARE', 'GATHERLIGHT_BASE_FLIGHTSTATS', 'GATHERLIGHT_BASE_MOFA',
  'GATHERLIGHT_BASE_DDG', 'GATHERLIGHT_BASE_KAYAK', 'GATHERLIGHT_BASE_BOOKING']) delete env[k];

const server = spawn('dotnet', ['run', '--project', 'src/server/Gatherlight.Server', '--no-build'],
  { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (url, opts) => {
  const res = await fetch(url, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const until = async (fn, ms) => {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fn(); if (r) return r; } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await sleep(400);
  }
};

// Poll the snapshot until the phase is one we're waiting for (or a terminal error).
const TERMINAL_BAD = new Set(['error', 'cancelled']);
async function waitPhase(id, targets, timeoutMs) {
  const t0 = Date.now();
  let last = '';
  for (;;) {
    const { body } = await getJson(`${base}/api/chat/${id}`);
    const phase = body?.phase ?? '';
    if (phase !== last) { log(`phase → ${phase}`); last = phase; }
    if (targets.includes(phase)) return body;
    if (TERMINAL_BAD.has(phase)) throw new Error(`terminal ${phase}: ${body?.error ?? ''}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for [${targets}] (stuck at ${phase})`);
    await sleep(2000);
  }
}
const post = (p) => getJson(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' } });

try {
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok), 40000);
  log('server up (real claude, no stub)');

  // MCP surface probe (informational) — the agent reaches native tools over this.
  try {
    const mcp = await getJson(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(10000),
    });
    const toolCount = mcp.body?.result?.tools?.length ?? 0;
    ok('MCP /mcp tools/list responds', toolCount > 0, `${toolCount} tools`);
  } catch (e) { ok('MCP /mcp tools/list responds', false, e.message); }

  const before = spawnSync('git', ['-C', dataDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

  // Gate 0 — start a task that forces exactly one small write under plans/.
  const message =
    '请在数据目录中新建一个日计划文件 plans/daily/smoke-test.md,标题为「Smoke Test Day」,' +
    '正文只写一个清单项:- [ ] buy groceries。不要改动其他任何文件,保持最小改动。';
  const start = await getJson(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  ok('POST /api/chat accepted', start.status === 200 && !!start.body?.id, JSON.stringify(start.body));
  const id = start.body.id;

  // Gate 1 — real planning turn.
  await waitPhase(id, ['awaiting-plan-approval'], 180000);
  const planned = (await getJson(`${base}/api/chat/${id}`)).body;
  ok('gate 1: real plan produced', (planned?.plan ?? '').length > 0, `plan chars=${(planned?.plan ?? '').length}`);
  await post(`/api/chat/${id}/plan/approve`);

  // Gate 2 — real execute turn produced a real file change.
  const reviewed = await waitPhase(id, ['awaiting-diff-approval', 'rejected'], 240000);
  ok('gate 2: execute produced a reviewable diff', reviewed.phase === 'awaiting-diff-approval',
    reviewed.phase === 'rejected' ? '无实际改动 (agent wrote nothing)' : reviewed.phase);
  if (reviewed.phase !== 'awaiting-diff-approval') throw new Error('no diff to approve');

  await post(`/api/chat/${id}/diff/approve`);
  const done = await waitPhase(id, ['committed'], 60000);
  ok('gate 2 approve → committed with sha', !!done.commitSha, done.commitSha ?? '(none)');

  // The commit really landed in the data repo, and it changed the tree.
  const after = spawnSync('git', ['-C', dataDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  ok('data repo HEAD advanced', before && after && before !== after, `${before?.slice(0, 7)} → ${after?.slice(0, 7)}`);
  const stat = spawnSync('git', ['-C', dataDir, 'show', '--stat', '--oneline', 'HEAD'], { encoding: 'utf8' }).stdout;
  ok('commit touched a plans/ file', /plans\//.test(stat), stat.split('\n').slice(0, 6).join(' | '));
  log('commit:\n' + stat.split('\n').slice(0, 8).map((l) => '    ' + l).join('\n'));
} catch (err) {
  console.error('smoke fatal:', err.message);
  console.error(serverLog.slice(-3000));
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? '\nsmoke-real-claude PASS' : `\nsmoke-real-claude FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
