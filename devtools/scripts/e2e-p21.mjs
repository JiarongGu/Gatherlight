#!/usr/bin/env node
// e2e P21 — automated scorers (Mastra-style). Drive a chat to committed, then assert the conversation
// is auto-scored on every applicable dimension: deterministic (scope-adherence / plan-structure /
// outcome / citations) computed in code, and LLM (answer-relevancy / faithfulness) from the stub
// judge. Then check the aggregate + manual re-run + run-all endpoints.
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until } from './_e2e-common.mjs';

const dataDir = dataDirFor('p21');
const { ok, fail, done } = makeReporter('p21');
makeTestData(dataDir);
const srv = startServer({ dataDir, port: 5461, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { j, post, waitPhase } = makeClient(srv.base);

const scoreOf = (scores, id) => scores.find((s) => s.scorerId === id);

try {
  await waitHealthy(srv.base);

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

  // run trace (Mastra observability) — the committed conversation has phases + a Write tool + usage
  const trace = (await j(`/api/manage/trace/${id}`)).body;
  ok('trace: phase timeline incl. committed', trace.steps.some((s) => s.kind === 'phase' && s.label === 'committed'));
  ok('trace: tool call recorded with a duration field', trace.toolCalls >= 1 && trace.steps.some((s) => s.kind === 'tool' && 'durationMs' in s), `tools=${trace.toolCalls}`);
  ok('trace: usage rolled up into token totals', trace.steps.some((s) => s.kind === 'usage') && (trace.inputTokens > 0 || trace.outputTokens > 0), JSON.stringify({ i: trace.inputTokens, o: trace.outputTokens }));
  ok('trace: total duration computed', typeof trace.totalDurationMs === 'number' && trace.totalDurationMs >= 0);
} catch (err) {
  fail('e2e-p21 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
