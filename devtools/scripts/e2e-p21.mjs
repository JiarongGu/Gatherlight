#!/usr/bin/env node
// e2e P21 — automated scorers (Mastra-style). Drive a chat to committed, then assert the conversation
// is auto-scored on every applicable dimension: deterministic (scope-adherence / plan-structure /
// outcome / citations) computed in code, and LLM (answer-relevancy / faithfulness) from the stub
// judge. Then check the aggregate + manual re-run + run-all endpoints.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p21-data');
const PORT = 5461;
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
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

const j = async (p, init) => { const r = await fetch(base + p, init); return { status: r.status, body: await r.json().catch(() => null) }; };
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
const scoreOf = (scores, id) => scores.find((s) => s.scorerId === id);

try {
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));

  // scorer registry
  const scorers = (await j('/api/manage/scores/scorers')).body.scorers;
  const ids = scorers.map((s) => s.id);
  ok('scorer registry lists the dimensions', ['scope-adherence', 'plan-structure', 'outcome', 'citations', 'answer-relevancy', 'faithfulness'].every((i) => ids.includes(i)), ids.join(','));
  ok('scorers tagged deterministic vs LLM', scorers.find((s) => s.id === 'outcome').isLlm === false && scorers.find((s) => s.id === 'answer-relevancy').isLlm === true);

  // drive a chat to committed
  const start = await post('/api/chat', { message: '给明天建一个日计划,这次提交' });
  const id = start.body.id;
  await waitPhase(id, 'awaiting-plan-approval');
  await post(`/api/chat/${id}/plan/approve`);
  await waitPhase(id, 'awaiting-diff-approval');
  await post(`/api/chat/${id}/diff/approve`);
  await waitPhase(id, 'committed');
  ok('drove a chat to committed', true);

  // auto-scoring fires off the request path — wait for the 6 scores to land
  const scores = await until(async () => {
    const s = (await j(`/api/manage/scores/${id}`)).body.scores;
    return s.length >= 6 ? s : null;
  });
  ok('conversation auto-scored on all 6 dimensions', scores.length === 6, `${scores.length} scores`);
  ok('scope-adherence = 1 (edit landed in plans/)', scoreOf(scores, 'scope-adherence')?.score === 1);
  ok('outcome = 1 (committed)', scoreOf(scores, 'outcome')?.score === 1);
  ok('plan-structure partial (stub plan lacks "Key facts")', Math.abs((scoreOf(scores, 'plan-structure')?.score ?? 0) - 0.75) < 0.01, String(scoreOf(scores, 'plan-structure')?.score));
  ok('citations = 1 (no time-sensitive claims)', scoreOf(scores, 'citations')?.score === 1);
  ok('answer-relevancy from LLM judge (stub 0.8, flagged llm)', scoreOf(scores, 'answer-relevancy')?.score === 0.8 && scoreOf(scores, 'answer-relevancy')?.isLlm === true, JSON.stringify(scoreOf(scores, 'answer-relevancy')));
  ok('faithfulness from LLM judge (stub 0.8)', scoreOf(scores, 'faithfulness')?.score === 0.8);

  // aggregate
  const agg = (await j('/api/manage/scores/aggregate')).body.scorers;
  ok('aggregate has per-scorer averages', agg.length === 6 && agg.find((a) => a.scorerId === 'outcome')?.avgScore === 1 && agg.find((a) => a.scorerId === 'outcome')?.count === 1, JSON.stringify(agg.length));

  // manual re-run (upsert, not duplicate)
  const rerun = await post(`/api/manage/scores/run/${id}`);
  ok('manual re-run scores + returns them', rerun.status === 200 && rerun.body.scored === 6 && rerun.body.scores.length === 6, JSON.stringify(rerun.body.scored));

  // run-all (background)
  const all = await post('/api/manage/scores/run-all');
  ok('run-all starts a batch', all.status === 200 && all.body.started === true);
} catch (err) {
  console.error('e2e-p21 fatal:', err.message);
  console.error(log.slice(-3000));
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? '\ne2e-p21 PASS' : `\ne2e-p21 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
