#!/usr/bin/env node
// e2e P15 — chat ranking + eval observability. Drive a chat (claude stub) to committed, rank it,
// then read the management observability surface (stats / conversations / transcript / JSONL export).
import { dataDirFor, claudeStubCmd, makeReporter, makeTestData, startServer, waitHealthy, makeClient } from './_e2e-common.mjs';

const dataDir = dataDirFor('p15');
const { ok, fail, done } = makeReporter('p15');
makeTestData(dataDir);
const srv = startServer({ dataDir, port: 5397, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { j, post, waitPhase } = makeClient(srv.base);

try {
  await waitHealthy(srv.base);

  // drive a chat to committed
  const start = await post('/api/chat', { message: '给明天建一个日计划,这次提交' });
  const id = start.body.id;
  await waitPhase(id, 'awaiting-plan-approval');
  await post(`/api/chat/${id}/plan/approve`);
  await waitPhase(id, 'awaiting-diff-approval');
  await post(`/api/chat/${id}/diff/approve`);
  await waitPhase(id, 'committed');
  ok('drove a chat to committed', true);

  // rank it
  const rate = await post(`/api/chat/${id}/feedback`, { rating: 5, note: '正是我要的计划' });
  ok('POST feedback 200', rate.status === 200 && rate.body.ok === true, JSON.stringify(rate.body));
  const bad = await post(`/api/chat/${id}/feedback`, { rating: 9 });
  ok('rating out of 1..5 → 400', bad.status === 400, String(bad.status));

  // stats
  const stats = (await j('/api/manage/stats')).body;
  ok('stats: total >= 1', stats.total >= 1, String(stats.total));
  ok('stats: rated 1, avg 5', stats.rated === 1 && stats.avgRating === 5, JSON.stringify({ r: stats.rated, a: stats.avgRating }));
  ok('stats: distribution has a 5★ bucket', (stats.distribution ?? []).some((d) => d.rating === 5 && d.count === 1));

  // conversations
  const convs = (await j('/api/manage/conversations')).body.conversations;
  const row = convs.find((c) => c.id === id);
  ok('conversation listed with rating + note', row && row.rating === 5 && row.note === '正是我要的计划', JSON.stringify(row?.rating));
  ok('conversation carries the user message', !!row?.userMessage && row.userMessage.includes('日计划'));

  // transcript
  const t = (await j(`/api/manage/conversation/${id}`)).body;
  ok('transcript: session + events', t.session?.id === id && Array.isArray(t.events) && t.events.length > 0,
    JSON.stringify({ s: t.session?.id === id, e: t.events?.length }));
  ok('transcript carries the rating', t.session?.rating === 5);

  // eval export (JSONL)
  const exportRes = await fetch(`${srv.base}/api/manage/eval/export`);
  ok('eval export 200 + jsonl attachment', exportRes.status === 200
    && (exportRes.headers.get('content-disposition') ?? '').includes('.jsonl'), String(exportRes.status));
  const lines = (await exportRes.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  ok('export has the rated record (input + rating)', lines.length === 1 && lines[0].rating === 5 && !!lines[0].input,
    JSON.stringify({ n: lines.length, r: lines[0]?.rating }));

  // re-rank (upsert, not duplicate)
  await post(`/api/chat/${id}/feedback`, { rating: 3, note: '改主意了' });
  const stats2 = (await j('/api/manage/stats')).body;
  ok('re-rank upserts (still 1 rated, avg now 3)', stats2.rated === 1 && stats2.avgRating === 3, JSON.stringify({ r: stats2.rated, a: stats2.avgRating }));
} catch (err) {
  fail('e2e-p15 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
