#!/usr/bin/env node
// e2e P28 — commit robustness + "pause for your reply" (awaiting-input), against the claude stub.
//   1. PHANTOM: the agent announces a Write to a file that never lands on disk, alongside a real one.
//      The diff must show ONLY the real file and the commit must SUCCEED (regression guard for the
//      `git add … did not match any files` (128) crash that aborted the whole commit).
//   2. NEEDS_INPUT: the agent ends execute with a `NEEDS_INPUT:` marker → the flow PAUSES at
//      awaiting-input; the human replies via POST /input → the session resumes and commits.
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, gitLog, tracked, onDisk } from './_e2e-common.mjs';

const dataDir = dataDirFor('p28');
const { ok, fail, done } = makeReporter('p28');
makeTestData(dataDir);
const srv = startServer({ dataDir, port: 5428, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { post, waitPhase } = makeClient(srv.base);

try {
  await waitHealthy(srv.base);
  console.log('server up');

  // --- 1) PHANTOM path: announced-but-unwritten file must not break the commit -----------
  const p1 = await post('/api/chat', { message: 'PHANTOMTEST 建后天的日计划' });
  ok('phantom: start 200', p1.status === 200 && !!p1.body.id);
  const id1 = p1.body.id;

  await waitPhase(id1, 'awaiting-plan-approval');
  await post(`/api/chat/${id1}/plan/approve`);
  const rev1 = await waitPhase(id1, 'awaiting-diff-approval');
  const files1 = rev1.review?.files ?? [];
  ok('phantom: diff shows only the REAL file', files1.length === 1, `got ${files1.length}: ${files1.map((f) => f.path).join(', ')}`);
  ok('phantom: real file is the 07-15 plan', files1[0]?.path === 'plans/daily/2026-07-15.md');
  ok('phantom: ghost file absent from diff', !files1.some((f) => f.path.includes('ghost')));

  const commitsBefore = gitLog(dataDir).length;
  await post(`/api/chat/${id1}/diff/approve`);
  const committed1 = await waitPhase(id1, 'committed'); // would throw on the old 128 crash (phase=error)
  ok('phantom: commit succeeded (no git-add 128)', !!committed1.commitSha);
  ok('phantom: exactly one new commit', gitLog(dataDir).length === commitsBefore + 1);
  ok('phantom: real file tracked', tracked(dataDir, 'plans/daily/2026-07-15.md'));
  ok('phantom: ghost never written to disk', !onDisk(dataDir, '.claude/skills/ghost/SKILL.md'));
  ok('phantom: ghost not tracked', !tracked(dataDir, '.claude/skills/ghost/SKILL.md'));

  // --- 2) NEEDS_INPUT: agent pauses, human replies, session resumes + commits ------------
  const p2 = await post('/api/chat', { message: 'NEEDINPUTTEST 建明天的日计划' });
  const id2 = p2.body.id;
  await waitPhase(id2, 'awaiting-plan-approval');
  await post(`/api/chat/${id2}/plan/approve`);
  const paused = await waitPhase(id2, 'awaiting-input');
  ok('needs-input: paused at awaiting-input', paused.phase === 'awaiting-input');

  // The agent's OPTION: choices ride in the awaiting-input phase event (SSE) so the UI can render
  // click-to-select buttons. Read the replayed stream, parse the data frames (JSON decodes the
  // \uXXXX-escaped CJK), and confirm both option labels reached the wire in the phase event's data.
  const sse = await fetch(`${srv.base}/api/chat/${id2}/stream`);
  const reader = sse.body.getReader();
  let sseText = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 2500) {
    const race = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(null), 400))]);
    if (!race || race.done) break;
    sseText += Buffer.from(race.value).toString('utf8');
  }
  reader.cancel().catch(() => {});
  let wireOptions = [];
  for (const line of sseText.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    try {
      const ev = JSON.parse(t.slice(5).trim());
      if (ev.kind === 'phase' && ev.phase === 'awaiting-input' && Array.isArray(ev.data?.options)) wireOptions = ev.data.options;
    } catch { /* keep-alive / partial frame */ }
  }
  ok('needs-input: options on the awaiting-input wire',
    wireOptions.includes('是,一起改') && wireOptions.includes('否,保持不变'), JSON.stringify(wireOptions));

  // empty reply is rejected; selecting an option (sent as its label) resumes.
  const empty = await post(`/api/chat/${id2}/input`, { message: '' });
  ok('needs-input: empty reply 400', empty.status === 400);

  const reply = await post(`/api/chat/${id2}/input`, { message: '否,保持不变' });
  ok('needs-input: option-select reply acked', reply.status === 200);
  const rev2 = await waitPhase(id2, 'awaiting-diff-approval');
  ok('needs-input: resumed to diff review', (rev2.review?.files ?? []).some((f) => f.path === 'plans/daily/2026-07-14.md'));

  const before2 = gitLog(dataDir).length;
  await post(`/api/chat/${id2}/diff/approve`);
  const committed2 = await waitPhase(id2, 'committed');
  ok('needs-input: committed after reply', !!committed2.commitSha && gitLog(dataDir).length === before2 + 1);

  // --- 3) responding on a session that isn't paused is a 409 ------------------------------
  const badPhase = await post(`/api/chat/${id2}/input`, { message: '晚了' });
  ok('needs-input: /input on terminal session 409', badPhase.status === 409);
} catch (err) {
  fail('e2e-p28 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
