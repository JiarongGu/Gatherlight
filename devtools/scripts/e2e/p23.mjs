#!/usr/bin/env node
// e2e P23 — prompt/agent playground (eval harness). POST a scenario set to /api/manage/eval/run: the
// server runs a DRY plan per scenario (read-only, no commit) and auto-scores the output on the
// quality dimensions WITHOUT persisting. Asserts per-scenario scores + aggregate, and that nothing
// was written to the scores table.
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd } from './_e2e-common.mjs';

const dataDir = dataDirFor('p23');
const { ok, fail, done } = makeReporter('p23');
makeTestData(dataDir);
const srv = startServer({ dataDir, port: 5472, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { j } = makeClient(srv.base);

try {
  await waitHealthy(srv.base);

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
  fail('e2e-p23 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
