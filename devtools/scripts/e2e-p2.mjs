#!/usr/bin/env node
// e2e P2 — two-gate chat flow against the claude stub: plan -> (refine) -> approve ->
// diff -> reject/restore, then a second run committing; busy 409; cancel mid-run; SSE replay.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p2-data');
const PORT = 5392;
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
const post = (p, body) => j(p, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});
const until = async (fn, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fn(); if (r) return r; } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 250));
  }
};
const waitPhase = (id, phase) =>
  until(async () => {
    const s = await j(`/api/chat/${id}`);
    if (['error'].includes(s.body?.phase) && s.body?.phase !== phase)
      throw new Error(`session errored: ${s.body?.error}`);
    return s.body?.phase === phase ? s.body : null;
  });
const gitLog = () =>
  execFileSync('git', ['-C', dataDir, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const fileExists = (rel) => {
  try { execFileSync('git', ['-C', dataDir, 'ls-files', '--error-unmatch', rel]); return true; }
  catch { return false; }
};
import fs from 'node:fs';
const onDisk = (rel) => fs.existsSync(path.join(dataDir, rel));

try {
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));
  console.log('server up');

  // --- run 1: plan -> refine -> approve -> diff -> REJECT ---------------------------------
  const start = await post('/api/chat', { message: '给明天建一个日计划' });
  ok('start chat 200', start.status === 200 && !!start.body.id);
  const id1 = start.body.id;

  const busy = await post('/api/chat', { message: 'another' });
  ok('second chat 409 BUSY', busy.status === 409);

  let snap = await waitPhase(id1, 'awaiting-plan-approval');
  ok('plan produced', (snap.plan ?? '').includes('计划(stub)'));

  const refine = await post(`/api/chat/${id1}/plan/refine`, { message: '加上晨跑' });
  ok('plan refine acked', refine.status === 200);
  snap = await waitPhase(id1, 'awaiting-plan-approval');
  ok('revised plan produced', (snap.plan ?? '').includes('修订后的计划'));

  const approve1 = await post(`/api/chat/${id1}/plan/approve`);
  ok('plan approve acked', approve1.status === 200);
  snap = await waitPhase(id1, 'awaiting-diff-approval');
  const file1 = snap.review?.files?.[0];
  ok('diff presented', snap.review?.files?.length === 1);
  ok('diff is added file with content',
    file1?.status === 'added' && file1?.path === 'plans/daily/2026-07-14.md' && file1?.diff.includes('written-by-stub'));
  ok('diff not claude infra', file1?.isClaudeInfra === false && snap.review?.hasClaudeInfra === false);

  const commitsBefore = gitLog().length;
  const reject = await post(`/api/chat/${id1}/diff/reject`);
  ok('diff reject acked', reject.status === 200);
  await waitPhase(id1, 'rejected');
  ok('rejected file removed from disk', !onDisk('plans/daily/2026-07-14.md'));
  ok('no commit on reject', gitLog().length === commitsBefore);

  // --- run 2: plan -> approve -> diff -> APPROVE (commit) ---------------------------------
  const start2 = await post('/api/chat', { message: '再来一次,这次提交' });
  const id2 = start2.body.id;
  await waitPhase(id2, 'awaiting-plan-approval');
  await post(`/api/chat/${id2}/plan/approve`);
  await waitPhase(id2, 'awaiting-diff-approval');
  await post(`/api/chat/${id2}/diff/approve`);
  const committed = await waitPhase(id2, 'committed');
  ok('committed with sha', !!committed.commitSha);
  ok('commit in data repo log', gitLog().length === commitsBefore + 1);
  ok('file tracked after commit', fileExists('plans/daily/2026-07-14.md'));
  const head = execFileSync('git', ['-C', dataDir, 'log', '-1', '--pretty=%B'], { encoding: 'utf8' });
  ok('commit message has gate provenance', head.includes('Human-approved (plan + diff gates)'));

  // --- SSE replay --------------------------------------------------------------------------
  const sse = await fetch(`${base}/api/chat/${id2}/stream`);
  const reader = sse.body.getReader();
  let sseText = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 3000 && !sseText.includes('"done"')) {
    const race = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(null), 500))]);
    if (!race || race.done) break;
    sseText += Buffer.from(race.value).toString('utf8');
  }
  reader.cancel().catch(() => {});
  ok('SSE replays phase events', sseText.includes('"kind":"phase"'));
  ok('SSE replays committed done', sseText.includes('"phase":"committed"'));

  // --- cancel mid-run ----------------------------------------------------------------------
  const start3 = await post('/api/chat', { message: 'SLOW 一个慢任务' });
  const id3 = start3.body.id;
  await new Promise((r) => setTimeout(r, 1200)); // stub is sleeping 8s
  const cancel = await post(`/api/chat/${id3}/cancel`);
  ok('cancel acked', cancel.status === 200);
  const cancelled = await waitPhase(id3, 'cancelled');
  ok('cancelled phase reached', cancelled.phase === 'cancelled');

  // --- fs op blocked while busy -------------------------------------------------------------
  const start4 = await post('/api/chat', { message: 'SLOW 又一个慢任务' });
  const id4 = start4.body.id;
  await new Promise((r) => setTimeout(r, 800));
  const fsOp = await post('/api/fs/retitle', { path: 'plans/trips/2026-08-kyoto.md', title: 'x' });
  ok('fs op 409 while chat busy', fsOp.status === 409);
  await post(`/api/chat/${id4}/cancel`);
  await waitPhase(id4, 'cancelled');
} catch (err) {
  console.error('e2e-p2 fatal:', err.message);
  console.error(serverLog.slice(-4000));
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? '\ne2e-p2 PASS' : `\ne2e-p2 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
