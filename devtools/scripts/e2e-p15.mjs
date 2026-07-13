#!/usr/bin/env node
// e2e P15 — chat ranking + eval observability. Drive a chat (claude stub) to committed, rank it,
// then read the management observability surface (stats / conversations / transcript / JSONL export).
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p15-data');
const PORT = 5397;
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

try {
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));

  // drive a chat to committed
  const start = await post('/api/chat', { message: '给明天建一个日计划,这次提交' });
  const id = start.body.id;
  await waitPhase(id, 'awaiting-plan-approval');
  await post(`/api/chat/${id}/plan/approve`);
  await waitPhase(id, 'awaiting-diff-approval');
  await post(`/api/chat/${id}/diff/approve`);
  await waitPhase(id, 'committed');
  ok('drove a chat to committed', true);

  // rank it
  const rate = await post(`/api/chat/${id}/feedback`, { rating: 5, note: '正是我要的计划' });
  ok('POST feedback 200', rate.status === 200 && rate.body.ok === true, JSON.stringify(rate.body));
  const bad = await post(`/api/chat/${id}/feedback`, { rating: 9 });
  ok('rating out of 1..5 → 400', bad.status === 400, String(bad.status));

  // stats
  const stats = (await j('/api/manage/stats')).body;
  ok('stats: total >= 1', stats.total >= 1, String(stats.total));
  ok('stats: rated 1, avg 5', stats.rated === 1 && stats.avgRating === 5, JSON.stringify({ r: stats.rated, a: stats.avgRating }));
  ok('stats: distribution has a 5★ bucket', (stats.distribution ?? []).some((d) => d.rating === 5 && d.count === 1));

  // conversations
  const convs = (await j('/api/manage/conversations')).body.conversations;
  const row = convs.find((c) => c.id === id);
  ok('conversation listed with rating + note', row && row.rating === 5 && row.note === '正是我要的计划', JSON.stringify(row?.rating));
  ok('conversation carries the user message', !!row?.userMessage && row.userMessage.includes('日计划'));

  // transcript
  const t = (await j(`/api/manage/conversation/${id}`)).body;
  ok('transcript: session + events', t.session?.id === id && Array.isArray(t.events) && t.events.length > 0,
    JSON.stringify({ s: t.session?.id === id, e: t.events?.length }));
  ok('transcript carries the rating', t.session?.rating === 5);

  // eval export (JSONL)
  const exportRes = await fetch(`${base}/api/manage/eval/export`);
  ok('eval export 200 + jsonl attachment', exportRes.status === 200
    && (exportRes.headers.get('content-disposition') ?? '').includes('.jsonl'), String(exportRes.status));
  const lines = (await exportRes.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  ok('export has the rated record (input + rating)', lines.length === 1 && lines[0].rating === 5 && !!lines[0].input,
    JSON.stringify({ n: lines.length, r: lines[0]?.rating }));

  // re-rank (upsert, not duplicate)
  await post(`/api/chat/${id}/feedback`, { rating: 3, note: '改主意了' });
  const stats2 = (await j('/api/manage/stats')).body;
  ok('re-rank upserts (still 1 rated, avg now 3)', stats2.rated === 1 && stats2.avgRating === 3, JSON.stringify({ r: stats2.rated, a: stats2.avgRating }));
} catch (err) {
  console.error('e2e-p15 fatal:', err.message);
  console.error(serverLog.slice(-3000));
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? '\ne2e-p15 PASS' : `\ne2e-p15 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
