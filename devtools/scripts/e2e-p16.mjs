#!/usr/bin/env node
// e2e P16 — cortex tuning surface. Read the prompt-template + model-routing registry, override
// with placeholder validation, prove a runtime override reaches the spawned CLI, and reset.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p16-data');
const PORT = 5398;
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
};

spawnSync('node', [path.join(repo, 'devtools', 'scripts', 'make-test-data.mjs'), dataDir], { stdio: 'inherit' });

const server = spawn('dotnet', ['run', '--project', 'src/server/Gatherlight.Server', '--no-build'], {
  cwd: repo,
  env: {
    ...process.env,
    GATHERLIGHT_DATA: dataDir,
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
const post = (p, body) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const put = (p, body) => j(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const del = (p) => j(p, { method: 'DELETE' });
const until = async (fn, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fn(); if (r) return r; } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 250));
  }
};
const waitPhase = (id, phase) => until(async () => {
  const s = await j(`/api/chat/${id}`);
  if (s.body?.phase === 'error' && phase !== 'error') throw new Error('session errored: ' + s.body?.error);
  return s.body?.phase === phase ? s.body : null;
});
const getCortex = async () => (await j('/api/manage/cortex')).body;
const prompt = (c, name) => c.prompts.find((p) => p.name === name);
const model = (c, consumer) => c.models.find((m) => m.consumer === consumer);

try {
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));

  // --- registry shape ---
  let c = await getCortex();
  ok('cortex: prompt catalog present (>= 6)', Array.isArray(c.prompts) && c.prompts.length >= 6, String(c.prompts?.length));
  ok('cortex: model catalog has chat + extract', !!model(c, 'chat') && !!model(c, 'extract'));
  const plan = prompt(c, 'plan');
  ok('plan prompt: default carries {userMessage}', plan?.default.includes('{userMessage}'));
  ok('plan prompt: placeholder contract lists userMessage', plan?.placeholders.includes('userMessage'), JSON.stringify(plan?.placeholders));
  ok('plan prompt: not overridden initially, effective == default', plan?.overridden === false && plan?.effective === plan?.default);

  // --- placeholder validation on override ---
  const bad = await put('/api/manage/cortex/prompt/plan', { value: 'no placeholders here at all' });
  ok('override missing placeholders → 400 + missing list', bad.status === 400 && (bad.body.missing ?? []).includes('userMessage'), JSON.stringify(bad.body));

  // --- valid override, proven to reach the spawned CLI ---
  const overridden = plan.default + '\n\nCORTEX_ECHO:MARK16\n';
  const set = await put('/api/manage/cortex/prompt/plan', { value: overridden });
  ok('valid override (keeps placeholders) → 200', set.status === 200 && set.body.ok === true, JSON.stringify(set.body));
  c = await getCortex();
  ok('override now reflected (overridden + effective)', prompt(c, 'plan').overridden === true && prompt(c, 'plan').effective === overridden);

  const start = await post('/api/chat', { message: '给明天建一个日计划' });
  const id = start.body.id;
  const planned = await waitPhase(id, 'awaiting-plan-approval');
  ok('runtime override reached the CLI (plan text carries echo)', (planned.plan ?? '').includes('[echo:MARK16]'), (planned.plan ?? '').slice(0, 60));
  await post(`/api/chat/${id}/cancel`);

  // --- reset restores default ---
  const reset = await del('/api/manage/cortex/prompt/plan');
  ok('reset prompt → 200', reset.status === 200);
  c = await getCortex();
  ok('after reset: not overridden, effective == default', prompt(c, 'plan').overridden === false && prompt(c, 'plan').effective === prompt(c, 'plan').default);

  // --- setting value == default clears the override (no stored copy) ---
  await put('/api/manage/cortex/prompt/plan', { value: prompt(c, 'plan').default });
  c = await getCortex();
  ok('override equal to default is not stored', prompt(c, 'plan').overridden === false);

  // --- model routing round-trip ---
  let m = await put('/api/manage/cortex/model/chat', { value: 'haiku' });
  ok('set model chat=haiku → 200', m.status === 200);
  c = await getCortex();
  ok('chat model overridden to haiku', model(c, 'chat').override === 'haiku' && model(c, 'chat').effective === 'haiku' && model(c, 'chat').overridden === true);
  // extract keeps its own default (sonnet) untouched
  ok('extract model default is sonnet (untouched)', model(c, 'extract').default === 'sonnet' && model(c, 'extract').overridden === false);

  // empty value clears the override (falls back to default)
  await put('/api/manage/cortex/model/chat', { value: '' });
  c = await getCortex();
  ok('empty model value clears override', model(c, 'chat').overridden === false && model(c, 'chat').override === null);

  // --- unknown targets 404 ---
  const un1 = await put('/api/manage/cortex/prompt/nope', { value: 'x {y}' });
  ok('unknown prompt name → 404', un1.status === 404, String(un1.status));
  const un2 = await put('/api/manage/cortex/model/nope', { value: 'haiku' });
  ok('unknown model consumer → 404', un2.status === 404, String(un2.status));

  // --- override survives across a fresh registry read (persisted in app_config) ---
  await put('/api/manage/cortex/model/extract', { value: 'opus' });
  c = await getCortex();
  ok('extract override persisted (opus)', model(c, 'extract').effective === 'opus' && model(c, 'extract').overridden === true);
} catch (err) {
  console.error('e2e-p16 fatal:', err.message);
  console.error(serverLog.slice(-3000));
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? '\ne2e-p16 PASS' : `\ne2e-p16 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
