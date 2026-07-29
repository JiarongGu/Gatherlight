#!/usr/bin/env node
// e2e P36 — hosted judge tools (Lyntai 1.1.0 AddMcpToolHost). The LLM-judge scorers run through the
// one-shot ILlmClient path, which is the ONLY path Lyntai's ICliToolProvisioner reaches; on each such
// call it stands up an ephemeral loopback MCP server exposing the app's read-only judge tools
// (Modules/Scoring/JudgeTools) and passes the CLI an mcp-config carrying a per-host bearer token.
//
// The claude stub plays the judge: when the user message carries JUDGE_TOOLS_PROBE it drives that MCP
// server for real (initialize → tools/list → tools/call) and reports what it saw in the verdict's
// `reason`, which surfaces on /api/manage/scores/{id}. So this suite asserts the whole chain end to
// end — host starts, dialect wrote usable args, token gates it, tools execute — and, most importantly,
// that the READ JAIL holds: plans/ household/ .claude/ only, never state/ (access token, TLS pfx, DB)
// and never a path that climbs out of the data folder.
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until } from './_e2e-common.mjs';

const dataDir = dataDirFor('p36');
const { ok, fail, done } = makeReporter('p36');
makeTestData(dataDir);
const srv = startServer({ dataDir, port: 5473, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { j, post, waitPhase } = makeClient(srv.base);

const denied = (s) => typeof s === 'string' && s.startsWith('ERROR:');

try {
  await waitHealthy(srv.base);

  // Drive a chat to committed. JUDGE_TOOLS_PROBE rides in the user message, which the answer-relevancy
  // judge prompt embeds — that's the stub's cue to exercise the tool host instead of returning canned text.
  const start = await post('/api/chat', { message: 'JUDGE_TOOLS_PROBE 给明天建一个日计划,这次提交' });
  const id = start.body.id;
  await waitPhase(id, 'awaiting-plan-approval');
  await post(`/api/chat/${id}/plan/approve`);
  await waitPhase(id, 'awaiting-diff-approval');
  await post(`/api/chat/${id}/diff/approve`);
  await waitPhase(id, 'committed');
  ok('drove a chat to committed', true);

  const scores = await until(async () => {
    const s = (await j(`/api/manage/scores/${id}`)).body.scores;
    return s.length >= 6 ? s : null;
  });
  const relevancy = scores.find((s) => s.scorerId === 'answer-relevancy');
  ok('answer-relevancy judge ran', relevancy?.score === 0.8, JSON.stringify(relevancy));

  const raw = relevancy?.reason ?? '';
  ok('judge reached the hosted tools (probe ran)', raw.startsWith('PROBE '), raw.slice(0, 200));
  let p = {};
  try { p = JSON.parse(raw.slice('PROBE '.length)); } catch { /* asserted below */ }

  // --- the host itself ---
  ok('MCP tool host started + accepted the bearer token', p.init === 200, JSON.stringify({ init: p.init, err: p.initErr }));
  ok('both judge tools published', Array.isArray(p.tools) && p.tools.join(',') === 'judge_list_files,judge_read_file', JSON.stringify(p.tools));

  // --- the tools do their job ---
  ok('judge_list_files finds plan artifacts', Array.isArray(p.listed) && p.listed.some((f) => f.startsWith('plans/') && f.endsWith('.md')), JSON.stringify(p.listed));
  ok('judge_read_file returns real content', typeof p.read === 'string' && p.read.length > 0 && !denied(p.read) && p.read !== 'NO_MD', JSON.stringify(p.read));

  // --- the jail (the part that matters: this endpoint executes app code) ---
  ok('state/settings.json refused (holds the access token)', denied(p.denyState), JSON.stringify(p.denyState));
  ok('path climbing out of the data folder refused', denied(p.denyEscape), JSON.stringify(p.denyEscape));
  ok('traversal back into state/ refused', denied(p.denyBinary), JSON.stringify(p.denyBinary));
  ok('unauthenticated local caller gets 401', p.unauth === 401, String(p.unauth));

  // --- no regression: the host is per-call, so a second scoring run must work the same ---
  const rerun = await post(`/api/manage/scores/run/${id}`);
  ok('re-scoring stands the host up again cleanly', rerun.status === 200 && rerun.body.scored === 6, JSON.stringify(rerun.body.scores?.map((s) => [s.scorerId, s.score, String(s.reason).slice(0, 80)])));
} catch (err) {
  fail('e2e-p36 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
