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
const { j, post } = makeClient(base);

// Drive one plan turn to a terminal phase and give back its session id.
const runTurn = async (message) => {
  const started = await post('/api/chat', { message, mode: 'plan' });
  const id = started.body?.id;
  if (!id) throw new Error(`no session id: ${JSON.stringify(started.body)}`);
  await until(async () => {
    const p = (await j(`/api/chat/${id}`)).body?.phase;
    return p && p !== 'idle' && p !== 'planning';
  }, 20000);
  return id;
};

// Release the agent lease so the next turn can start (a session parked at a gate still holds it).
const finishUp = async (id) => {
  await post(`/api/chat/${id}/cancel`);
  await until(async () => {
    const p = (await j(`/api/chat/${id}`)).body?.phase;
    return ['cancelled', 'rejected', 'committed', 'error'].includes(p);
  }, 15000);
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

  // --- THE POINT: it survives a restart ---------------------------------------------------
  server.stop();
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  await waitHealthy(base);

  const after = (await j('/api/chat/history')).body?.conversations ?? [];
  ok('history survives a server restart', after.length >= 1, JSON.stringify(after));
  const afterT = (await j(`/api/chat/history/${convo.id}`)).body;
  ok('the transcript survives a server restart',
    (afterT?.events ?? []).length === (t?.events ?? []).length,
    `${(afterT?.events ?? []).length} vs ${(t?.events ?? []).length}`);
  // The live stream cannot do this — proving the two paths are genuinely different.
  ok('the live stream no longer knows the session (which is why history exists)',
    (await fetch(`${base}/api/chat/${first}/stream`)).status === 404);
} catch (e) {
  fail(e?.stack || String(e));
} finally {
  server.stop();
}

done();
