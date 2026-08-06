#!/usr/bin/env node
// e2e P46 — a parked decision survives a restart (S6). A session that was MID-RUN still fails: its
// child process is gone. A session PARKED ON A HUMAN DECISION is the opposite case — nothing in
// flight, state already durable — so it comes back, with working buttons rather than a replayed card.
// This matters because auto-update restarts the server: approving an update must not throw away the
// plan sitting at the diff gate.
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until, gitLog,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p46');
const { ok, fail, done } = makeReporter('p46');
makeTestData(dataDir);

const PORT = 5492;
let server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const base = server.base ?? `http://127.0.0.1:${PORT}`;
const { j, post } = makeClient(base);

// Same pause p41 uses: let the old process release the port (and finish its last write) before the
// replacement binds it. Without it the "restart" races its own predecessor and the failure looks
// like a lost session rather than a lost port.
const restart = async (between = async () => {}) => {
  server.stop();
  await new Promise((r) => setTimeout(r, 1200));
  await between();
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  await waitHealthy(base);
};
const snap = async (id) => (await j(`/api/chat/${id}`)).body;
const phaseIs = (id, want, ms = 60000) =>
  until(async () => ((await snap(id))?.phase === want ? true : null), ms);

try {
  await waitHealthy(base);

  // --- a plan gate survives, and its buttons still work --------------------------------------
  const started = await post('/api/chat', { message: '给明天建一个日计划,这次提交' });
  const id = started.body?.id;
  ok('chat started', !!id);
  await phaseIs(id, 'awaiting-plan-approval');
  const planBefore = (await snap(id))?.plan ?? '';
  ok('a plan is parked for approval', planBefore.length > 0);

  await restart();

  const afterPlan = await snap(id);
  ok('the parked plan gate survives a restart', afterPlan?.phase === 'awaiting-plan-approval',
    `${afterPlan?.phase} / ${afterPlan?.error ?? ''}`);
  ok('and it is not marked as an interrupted run', !afterPlan?.error, String(afterPlan?.error));
  ok('the plan text came back with it', afterPlan?.plan === planBefore, String(afterPlan?.plan).slice(0, 80));

  // The lease is re-taken: a restored gate still owns the data tree, or restoring it would quietly
  // remove the single-writer guarantee the gate depends on.
  const busy = await post('/api/chat', { message: '另一个请求' });
  ok('a new chat is refused while the restored session is parked', busy.status >= 400, String(busy.status));

  // THE POINT: this is a real gate, not a replayed card. Approving it runs the agent.
  const approved = await post(`/api/chat/${id}/plan/approve`);
  ok('the restored plan gate accepts approval', approved.status === 200, String(approved.status));
  await phaseIs(id, 'awaiting-diff-approval');
  ok('approving a restored plan drove the run to the diff gate', true);

  // --- the diff gate survives, and is rebuilt from the WORKING TREE --------------------------
  const filesBefore = ((await snap(id))?.review?.files ?? []).map((f) => f.path);
  ok('the diff gate lists the edited file', filesBefore.includes('plans/daily/2026-07-14.md'),
    JSON.stringify(filesBefore));

  // Change the file while the server is down. A restored gate that showed a REMEMBERED diff would
  // commit something other than what the reviewer was shown — the one thing a review surface must
  // never do — so the restore re-reads the tree.
  const target = path.join(dataDir, 'plans', 'daily', '2026-07-14.md');
  await restart(async () => {
    fs.writeFileSync(target, '# 2026-07-14 计划(fixture)\n\n- written-by-stub\n- edited-while-down\n', 'utf8');
  });

  const afterDiff = await snap(id);
  ok('the parked diff gate survives a restart', afterDiff?.phase === 'awaiting-diff-approval',
    `${afterDiff?.phase} / ${afterDiff?.error ?? ''}`);
  const filesAfter = (afterDiff?.review?.files ?? []).map((f) => f.path);
  ok('its file list was rebuilt, not remembered', filesAfter.includes('plans/daily/2026-07-14.md'),
    JSON.stringify(filesAfter));
  const diffText = JSON.stringify(afterDiff?.review?.files ?? []);
  ok('the rebuilt diff shows what is on disk NOW', /edited-while-down/.test(diffText), diffText.slice(0, 200));

  // --- approving a restored diff commits what was shown --------------------------------------
  const commit = await post(`/api/chat/${id}/diff/approve`);
  ok('the restored diff gate accepts approval', commit.status === 200, String(commit.status));
  await phaseIs(id, 'committed');
  const committed = fs.readFileSync(target, 'utf8');
  ok('the committed file is the one that was reviewed', /edited-while-down/.test(committed));
  ok('the data repo has the commit', gitLog(dataDir).length >= 1, gitLog(dataDir).slice(0, 2).join(' | '));

  // --- a terminal session is NOT restored ----------------------------------------------------
  // The lease has to come back with it, so this also proves the restore released nothing it should
  // have held — and held nothing it should have released.
  await restart();
  // NOT in memory is the correct outcome — restore is for outstanding decisions, and this one is
  // decided. The record of it still stands, in the history the household can read back.
  ok('a committed session is not restored into memory', (await j(`/api/chat/${id}`)).status === 404,
    String((await j(`/api/chat/${id}`)).status));
  const hist = (await j('/api/chat/history')).body?.conversations ?? [];
  ok('and it is still recorded as committed', hist.some((c) => c.phase === 'committed'), JSON.stringify(hist));
  const fresh = await post('/api/chat', { message: '重启后可以开新对话' });
  ok('a new chat can start after a terminal session', fresh.status === 200, String(fresh.status));
  const freshId = fresh.body?.id;
  await phaseIs(freshId, 'awaiting-plan-approval');
  ok('the follow-up conversation parks normally', true);

  // --- an input gate comes back WITH its question and its buttons ----------------------------
  // awaiting-input carries the question and the OPTION: choices only on the phase event — the
  // snapshot endpoint does not project them. Without re-emitting the stored card, a restored input
  // gate would ask the household to answer a question it no longer shows.
  await post(`/api/chat/${freshId}/cancel`);
  await until(async () => (['cancelled', 'rejected'].includes((await snap(freshId))?.phase) ? true : null), 30000);

  const ask = await post('/api/chat', { message: 'NEEDINPUTTEST 帮我改一下计划' });
  const askId = ask.body?.id;
  await phaseIs(askId, 'awaiting-plan-approval');
  await post(`/api/chat/${askId}/plan/approve`);
  await phaseIs(askId, 'awaiting-input');

  await restart();
  ok('a parked input gate survives a restart', (await snap(askId))?.phase === 'awaiting-input',
    `${(await snap(askId))?.phase} / ${(await snap(askId))?.error ?? ''}`);

  const sse = await fetch(`${base}/api/chat/${askId}/stream`);
  const reader = sse.body.getReader();
  let sseText = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 2500) {
    const race = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(null), 400))]);
    if (!race || race.done) break;
    sseText += Buffer.from(race.value).toString('utf8');
  }
  reader.cancel().catch(() => {});
  let restoredOptions = null;
  let restoredQuestion = '';
  for (const line of sseText.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    try {
      const ev = JSON.parse(t.slice(5).trim());
      if (ev.kind === 'phase' && ev.phase === 'awaiting-input') {
        restoredOptions = ev.data?.options ?? restoredOptions;
        restoredQuestion = ev.data?.question ?? restoredQuestion;
      }
    } catch { /* keep-alive / partial frame */ }
  }
  ok('the restored input gate re-emits its question', restoredQuestion.length > 0, restoredQuestion);
  ok('and its option buttons come back', Array.isArray(restoredOptions) && restoredOptions.length === 2,
    JSON.stringify(restoredOptions));

  // And it is still answerable — the whole point of restoring it.
  const replied = await post(`/api/chat/${askId}/input`, { message: (restoredOptions ?? ['是'])[0] });
  ok('a restored input gate accepts the answer', replied.status === 200, String(replied.status));

  // A CANCELLED session is terminal — restore must not resurrect it, or a household that walked away
  // from a decision would find it waiting again after every update. (freshId was cancelled above.)
  ok('a cancelled session is not resurrected', (await j(`/api/chat/${freshId}`)).status === 404,
    String((await j(`/api/chat/${freshId}`)).status));
} catch (err) {
  fail('e2e-p46 fatal: ' + err.message);
  console.error(server.log().slice(-3000));
} finally {
  server.stop();
}
done();
