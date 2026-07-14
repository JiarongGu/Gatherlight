#!/usr/bin/env node
// e2e P2 — two-gate chat flow against the claude stub: plan -> (refine) -> approve ->
// diff -> reject/restore, then a second run committing; busy 409; cancel mid-run; SSE replay.
import { execFileSync } from 'node:child_process';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, gitLog, tracked, onDisk } from './_e2e-common.mjs';

const dataDir = dataDirFor('p2');
const { ok, fail, done } = makeReporter('p2');
makeTestData(dataDir);
const srv = startServer({ dataDir, port: 5392, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { j, post, waitPhase } = makeClient(srv.base);

try {
  await waitHealthy(srv.base);
  console.log('server up');

  // --- run 1: plan -> refine -> approve -> diff -> REJECT ---------------------------------
  const start = await post('/api/chat', { message: '给明天建一个日计划' });
  ok('start chat 200', start.status === 200 && !!start.body.id);
  const id1 = start.body.id;

  const busy = await post('/api/chat', { message: 'another' });
  ok('second chat 409 BUSY', busy.status === 409);

  let snap = await waitPhase(id1, 'awaiting-plan-approval');
  ok('plan produced', (snap.plan ?? '').includes('计划(stub)'));
  // "给明天…日计划" matches the daily routing category → server pre-routed the discovery.
  ok('discovery pre-routed server-side', (snap.plan ?? '').includes('[pre-routed]'), snap.plan?.slice(0, 60));

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

  const commitsBefore = gitLog(dataDir).length;
  const reject = await post(`/api/chat/${id1}/diff/reject`);
  ok('diff reject acked', reject.status === 200);
  await waitPhase(id1, 'rejected');
  ok('rejected file removed from disk', !onDisk(dataDir, 'plans/daily/2026-07-14.md'));
  ok('no commit on reject', gitLog(dataDir).length === commitsBefore);

  // --- run 2: plan -> approve -> diff -> APPROVE (commit) ---------------------------------
  const start2 = await post('/api/chat', { message: '再来一次,这次提交' });
  const id2 = start2.body.id;
  await waitPhase(id2, 'awaiting-plan-approval');
  await post(`/api/chat/${id2}/plan/approve`);
  await waitPhase(id2, 'awaiting-diff-approval');
  await post(`/api/chat/${id2}/diff/approve`);
  const committed = await waitPhase(id2, 'committed');
  ok('committed with sha', !!committed.commitSha);
  ok('commit in data repo log', gitLog(dataDir).length === commitsBefore + 1);
  ok('file tracked after commit', tracked(dataDir, 'plans/daily/2026-07-14.md'));
  const head = execFileSync('git', ['-C', dataDir, 'log', '-1', '--pretty=%B'], { encoding: 'utf8' });
  ok('commit message has gate provenance', head.includes('Human-approved (plan + diff gates)'));

  // --- SSE replay --------------------------------------------------------------------------
  const sse = await fetch(`${srv.base}/api/chat/${id2}/stream`);
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
  fail('e2e-p2 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
