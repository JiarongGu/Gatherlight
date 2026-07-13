#!/usr/bin/env node
// e2e P23 — prompt/agent playground (eval harness). POST a scenario set to /api/manage/eval/run: the
// server runs a DRY plan per scenario (read-only, no commit) and auto-scores the output on the
// quality dimensions WITHOUT persisting. Asserts per-scenario scores + aggregate, and that nothing
// was written to the scores table.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p23-data');
const PORT = 5472;
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
};

spawnSync('node', [path.join(repo, 'devtools', 'scripts', 'make-test-data.mjs'), dataDir], { stdio: 'inherit' });

const server = spawn('dotnet', ['run', '--project', 'src/server/Gatherlight.Server', '--no-build'], {
  cwd: repo,
  env: { ...process.env, GATHERLIGHT_DATA: dataDir, GATHERLIGHT_PORT: String(PORT), GATHERLIGHT_CLAUDE_CMD: `node ${path.join(repo, 'devtools', 'scripts', 'claude-stub.mjs')}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

const j = async (p, init) => { const r = await fetch(base + p, init); return { status: r.status, body: await r.json().catch(() => null) }; };
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { const r = await fn(); if (r) return r; } catch {} if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 250)); } };

try {
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));

  const scenarios = [
    { name: 'weekend', message: '规划一个附近城市的周末两日游' },
    { name: 'daily', message: '给明天安排一个日程' },
  ];
  const res = await j('/api/manage/eval/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenarios }) });
  ok('eval run 200', res.status === 200, String(res.status));
  const run = res.body;
  ok('a result per scenario', run.results.length === 2, `${run.results?.length}`);

  const r0 = run.results[0];
  ok('result carries a plan preview + duration', !!r0.planPreview && typeof r0.durationMs === 'number');
  ok('quality scorers ran (structure/citations/relevancy/faithfulness)',
    ['plan-structure', 'citations', 'answer-relevancy', 'faithfulness'].every((s) => s in r0.scores), JSON.stringify(Object.keys(r0.scores)));
  ok('plan-structure ~0.75 (stub plan lacks "Key facts")', Math.abs(r0.scores['plan-structure'] - 0.75) < 0.01, String(r0.scores['plan-structure']));
  ok('citations = 1 (no time-sensitive claims)', r0.scores['citations'] === 1);
  ok('answer-relevancy = 0.8 (LLM judge stub)', r0.scores['answer-relevancy'] === 0.8);
  ok('faithfulness = 0.8 (LLM judge stub)', r0.scores['faithfulness'] === 0.8);
  ok('dry run did NOT score committed-only dims (no scope/outcome)', !('scope-adherence' in r0.scores) && !('outcome' in r0.scores));

  ok('aggregate has per-scorer means', run.aggregate['answer-relevancy'] === 0.8 && run.aggregate['plan-structure'] > 0, JSON.stringify(run.aggregate));

  // playground must NOT persist scores
  const persisted = (await j('/api/manage/scores/playground')).body.scores;
  ok('playground scores are not persisted', persisted.length === 0, `${persisted.length} rows`);
  const agg = (await j('/api/manage/scores/aggregate')).body.scorers;
  ok('scores table untouched by the dry run', agg.length === 0, `${agg.length} scorers aggregated`);
} catch (err) {
  console.error('e2e-p23 fatal:', err.message);
  console.error(log.slice(-3000));
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? '\ne2e-p23 PASS' : `\ne2e-p23 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
