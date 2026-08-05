#!/usr/bin/env node
// e2e P43 — conversation history. Every turn is already stored in lyntai_message; this suite proves
// the chat can read it back, and that it SURVIVES A RESTART — the whole point of the sub-project,
// since the SSE stream only replays a session still in the server's memory.
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p43');
const { ok, fail, done } = makeReporter('p43');
makeTestData(dataDir);

// Free port — checked against every startServer({ port }) in devtools/scripts/e2e/*.mjs
// (p41 is the closest neighbour at 5482).
const PORT = 5484;

let server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const base = server.base ?? `http://127.0.0.1:${PORT}`;
const { j, post, waitPhase } = makeClient(base);

// Drive one plan turn to a terminal phase and give back its session id.
const runTurn = async (message) => {
  const started = await post('/api/chat', { message, mode: 'plan' });
  const id = started.body?.id;
  if (!id) throw new Error(`no session id: ${JSON.stringify(started.body)}`);
  await until(async () => {
    const p = (await j(`/api/chat/${id}`)).body?.phase;
    return p && p !== 'idle' && p !== 'planning';
  }, 60000);
  return id;
};

// Release the agent lease so the next turn can start (a session parked at a gate still holds it).
const finishUp = async (id) => {
  await post(`/api/chat/${id}/cancel`);
  await until(async () => {
    const p = (await j(`/api/chat/${id}`)).body?.phase;
    return ['cancelled', 'rejected', 'committed', 'error'].includes(p);
  }, 45000);
};

// Events are persisted off the phase flip (ChatSession.PersistChain), so a count read the instant a
// turn goes terminal can still grow. Settle on two equal reads before comparing across a restart —
// otherwise a late flush reads as "the restart lost events".
const settledEventCount = async (conversationId) => {
  let prev = -1;
  let cur = 0;
  await until(async () => {
    prev = cur;
    cur = ((await j(`/api/chat/history/${conversationId}`)).body?.events ?? []).length;
    return cur > 0 && cur === prev;
  }, 45000, 300);
  return cur;
};

try {
  await waitHealthy(base);

  const first = await runTurn('UI_CASE:VALID 请给东京行程做一个表格');
  await finishUp(first);

  const list = (await j('/api/chat/history')).body?.conversations ?? [];
  ok('history lists the conversation', list.length >= 1, JSON.stringify(list));
  const convo = list[0];
  ok('title is the user message, not the id',
    /东京行程/.test(convo?.title ?? '') && convo?.title !== convo?.id, convo?.title ?? '');
  ok('the row carries a phase', typeof convo?.phase === 'string' && convo.phase.length > 0, convo?.phase ?? '');

  const t = (await j(`/api/chat/history/${convo.id}`)).body;
  ok('transcript comes back', Array.isArray(t?.events) && t.events.length > 0, JSON.stringify(t)?.slice(0, 160));
  ok('events are in the SSE wire shape (every one has a kind)',
    (t?.events ?? []).every((e) => typeof e.kind === 'string'));
  // S3a made a turn's content richer — the block must survive the round trip, tree intact.
  const block = (t?.events ?? []).find((e) => e.kind === 'ui-block' && e.data?.status === 'ready');
  ok('a stored ui-block round-trips with its tree', block?.data?.node?.type === 'Card',
    JSON.stringify(block?.data ?? null)?.slice(0, 160));

  ok('an unknown conversation is 404', (await j('/api/chat/history/nope')).status === 404);
  const clamped = (await j('/api/chat/history?limit=99999')).body?.conversations ?? [];
  ok('an oversized limit is clamped, not an error', Array.isArray(clamped));

  // --- turns group into ONE conversation ---------------------------------------------------
  // Two consecutive turns share a working context (nothing committed, no idle gap), so they must
  // list as one conversation — otherwise history is a list of turns and the user cannot tell which
  // belonged together. This one is driven to a COMMIT on purpose: a committed turn is exactly what
  // clears the live chat_turn window, which is the state the resumed turn below has to survive.
  const second = await runTurn('再补充一个预算表');
  await post(`/api/chat/${second}/plan/approve`);
  await waitPhase(second, 'awaiting-diff-approval');
  await post(`/api/chat/${second}/diff/approve`);
  await waitPhase(second, 'committed');

  const grouped = (await j('/api/chat/history')).body?.conversations ?? [];
  ok('consecutive turns group into one conversation', grouped.length === 1,
    JSON.stringify(grouped.map((c) => ({ id: c.id, turns: c.turns }))));
  ok('the conversation counts both turns', grouped[0]?.turns === 2, String(grouped[0]?.turns));
  ok('the title stays the FIRST turn message', /东京行程/.test(grouped[0]?.title ?? ''), grouped[0]?.title ?? '');
  // The group key is an assigned conversation id, not one of the turns' own thread ids.
  ok('the conversation is keyed by its own id, not a turn id',
    Boolean(grouped[0]?.id) && grouped[0].id !== first && grouped[0].id !== second, grouped[0]?.id ?? '');

  const both = (await j(`/api/chat/history/${grouped[0].id}`)).body;
  ok('the transcript spans both turns',
    (both?.events ?? []).length > (t?.events ?? []).length,
    `${(both?.events ?? []).length} vs ${(t?.events ?? []).length}`);

  // --- continuing an OLD conversation carries its context ----------------------------------
  // The live chat_turn window was cleared by the commit above, so a resumed conversation must have
  // its context rebuilt from stored turns. Without that the id is assigned and the agent still
  // starts blank — everything else here would stay green while the feature does nothing.
  const resumed = await post('/api/chat', {
    message: 'CONTEXT_ECHO 继续刚才的事',
    mode: 'plan',
    continuesConversationId: grouped[0].id,
  });
  const resumedId = resumed.body?.id;
  ok('a resumed turn starts', Boolean(resumedId), JSON.stringify(resumed.body));
  if (resumedId) {
    await until(async () => {
      const p = (await j(`/api/chat/${resumedId}`)).body?.phase;
      return p && p !== 'idle' && p !== 'planning';
    }, 60000);
    const plan = (await j(`/api/chat/${resumedId}`)).body?.plan ?? '';
    // The stub echoes back whether the prompt carried thread context (the real
    // "RECENT REQUESTS IN THIS CONVERSATION" block PromptHarness writes).
    ok('the resumed turn was given the conversation context',
      /CONTEXT_PRESENT/.test(plan), plan.slice(0, 160));
    const afterResume = (await j('/api/chat/history')).body?.conversations ?? [];
    ok('the resumed turn joins the same conversation',
      afterResume.length === 1 && afterResume[0]?.turns === 3,
      JSON.stringify(afterResume.map((c) => ({ id: c.id, turns: c.turns }))));
    await finishUp(resumedId);
  }

  // --- THE POINT: it survives a restart ---------------------------------------------------
  const beforeRestart = await settledEventCount(grouped[0].id);
  server.stop();
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  await waitHealthy(base);

  const after = (await j('/api/chat/history')).body?.conversations ?? [];
  ok('history survives a server restart', after.length >= 1, JSON.stringify(after));
  const afterT = (await j(`/api/chat/history/${grouped[0].id}`)).body;
  ok('the transcript survives a server restart',
    (afterT?.events ?? []).length === beforeRestart,
    `${(afterT?.events ?? []).length} vs ${beforeRestart}`);
  // The live stream cannot do this — proving the two paths are genuinely different.
  ok('the live stream no longer knows the session (which is why history exists)',
    (await fetch(`${base}/api/chat/${first}/stream`)).status === 404);

  // The conversation a new turn joins is read from the STORE, not from memory — so a restart does
  // not silently split a conversation the user is still in the middle of.
  const afterRestartTurn = await runTurn('重启之后再问一句');
  const stillGrouped = (await j('/api/chat/history')).body?.conversations ?? [];
  ok('a turn started after a restart joins the stored conversation',
    stillGrouped.length === 1 && stillGrouped[0]?.turns === 4,
    JSON.stringify(stillGrouped.map((c) => ({ id: c.id, turns: c.turns }))));
  await finishUp(afterRestartTurn);
} catch (e) {
  fail(e?.stack || String(e));
} finally {
  server.stop();
}

done();
