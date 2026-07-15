#!/usr/bin/env node
// e2e-p25 — error-continuity memory. When a chat run FAILS, the turn is recorded to our durable thread
// memory (chat_turn) with a "⚠️ 未完成(出错)" outcome, so the NEXT chat's plan prompt carries that
// context and the agent knows a prior attempt failed (instead of starting blind). This is OUR DB
// memory injected into the prompt — NOT the claude CLI's temp `--resume` session. The stub echoes
// [saw-prior-failure] into its plan text when it sees the failed-turn marker in the prompt.
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd } from './_e2e-common.mjs';

const dataDir = dataDirFor('p25');
const { ok, fail, done } = makeReporter('p25');
makeTestData(dataDir);
const srv = startServer({ dataDir, port: 5395, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { post, waitPhase } = makeClient(srv.base);

try {
  await waitHealthy(srv.base);
  console.log('server up');

  // 1) a chat that fails — the stub returns an empty result → the server's plan phase Fails.
  const c1 = await post('/api/chat', { message: 'FORCE_ERROR 帮我规划明天' });
  ok('start errored chat 200', c1.status === 200 && !!c1.body.id);
  const errored = await waitPhase(c1.body.id, 'error');
  ok('first chat reached error phase', errored.phase === 'error');

  // Let the failed-turn write settle (RecordOutcome persists async on the session's chain; a real user's
  // next message is seconds later). Then the next chat's thread context should carry the failure.
  await new Promise((r) => setTimeout(r, 900));

  // 2) the NEXT chat — its plan prompt should include the "⚠️ 未完成(出错)" turn, which the stub echoes.
  const c2 = await post('/api/chat', { message: '继续刚才没做完的' });
  ok('start follow-up chat 200', c2.status === 200 && !!c2.body.id);
  const snap = await waitPhase(c2.body.id, 'awaiting-plan-approval');
  ok('next chat sees the prior failure in its context',
    (snap.plan ?? '').includes('saw-prior-failure'), (snap.plan ?? '').slice(0, 90));
} catch (err) {
  fail('e2e-p25 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
