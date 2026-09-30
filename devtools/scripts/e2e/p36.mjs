#!/usr/bin/env node
// e2e P36 — hosted judge tools (Lyntai 1.1.0 AddMcpToolHost). The LLM-judge scorers run through the
// one-shot ITextClient path, which is the ONLY path Lyntai's ICliToolProvisioner reaches; on each scorer
// call it stands up an ephemeral loopback MCP server exposing the app's read-only judge tools
// (Platform/Ops/Scoring/JudgeTools) and passes the CLI an mcp-config carrying a per-host bearer token.
//
// The claude stub plays the judge: when the user message carries JUDGE_TOOLS_PROBE it drives that MCP
// server for real (initialize → tools/list → tools/call) and reports what it saw in the verdict's
// `reason`, which surfaces on /api/manage/scores/{id}. So this suite asserts the whole chain end to
// end — host starts, dialect wrote usable args, token gates it, tools execute — and, most importantly,
// that the READ JAIL holds: plans/ household/ .claude/ only, never state/ (access token, TLS pfx, DB)
// and never a path that climbs out of the data folder.
//
// And that ONLY the scorers get it (Lyntai 3.4, D190: McpToolHostOptions.ToolsByConsumer). Through 3.2 the
// provisioner ran on EVERY ClaudeCliProvider call, so the CLI 判断's annotation and verification and 语义's
// rephrasing each stood up the host and were handed the file-read tools too. The stub's args log shows which
// spawn was handed an --mcp-config; the scorer spawns are the positive control in the same run.
import fs from 'node:fs';
import path from 'node:path';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until } from './_e2e-common.mjs';

const dataDir = dataDirFor('p36');
const { ok, fail, done } = makeReporter('p36');
makeTestData(dataDir);
const argsLog = path.join(dataDir, 'state', 'stub-args.jsonl');
const srv = startServer({ dataDir, port: 25473,
  env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd, GATHERLIGHT_STUB_ARGS_LOG: argsLog } });
const { j, post, call, waitPhase } = makeClient(srv.base);
const spawns = () => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8') : '')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const hosted = (x) => x.args.includes('--mcp-config');

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

  // --- ONLY the scorers get the host: the memory CLI calls and 语义's rephrasing get none --------------
  // A fresh install binds 判断 to the Claude CLI with enrichment on, so a write is annotated and a recall
  // verified — each a one-shot ClaudeCliProvider call tagged `memory`. Binding 语义 to the CLI arm makes the
  // next write rephrase too, untagged (`default`). Each kind is asserted PRESENT before it is asserted
  // unhosted, or a suite that never made the call would pass the absence for free.
  const remember = (topic, content) => call('remember_fact',
    { kind: 'schedule', topic, content, source: `https://example.test/${encodeURIComponent(topic)}`, confidence: 0.8 });
  const w1 = await remember('harbour ferry timetable', 'The harbour ferry leaves pier three every forty minutes.');
  await remember('harbour ferry fares', 'A harbour ferry crossing costs 350 for an adult ticket.');
  ok('(setup) remember_fact stores a fact', w1.status === 200 && w1.result?.ok === true, JSON.stringify(w1.result));
  const recalled = await call('recall_facts', { query: 'harbour ferry', limit: 5 });
  ok('(setup) recall_facts returns the facts', (recalled.result?.facts ?? []).length >= 2, JSON.stringify(recalled.result));
  const bind = await post('/api/manage/memory/layer/semantic', { source: 'claude-cli', model: 'haiku' });
  ok('(setup) 语义 binds to the CLI rephrasing arm', bind.status === 200, JSON.stringify(bind.body));
  await remember('harbour ferry luggage', 'Bicycles ride the harbour ferry free outside the rush hour.');

  const log = spawns();
  const summary = JSON.stringify(log.map((x) => `${x.kind}:${hosted(x) ? 'mcp' : '-'}`));
  const scorers = log.filter((x) => x.kind === 'scorer');
  ok('(positive control) every scorer spawn is handed the judge-tools --mcp-config',
    scorers.length >= 2 && scorers.every(hosted), summary);
  for (const kind of ['annotation', 'verification', 'rephrase']) {
    const xs = log.filter((x) => x.kind === kind);
    ok(`(fixture) at least one ${kind} spawn happened`, xs.length >= 1, summary);
    ok(`THE POINT: no ${kind} spawn is handed an --mcp-config`, xs.length >= 1 && !xs.some(hosted), summary);
  }

  // THE SETTINGS A SCORER RUNS UNDER (Lyntai 3.5.2). Every one-shot call is handed the app's one-shot settings
  // (ClaudeCompletionOptions.SettingsPath: the blanked key paths, disableSkillShellExecution, the read fence) — and a
  // scorer is then handed the judge-tools host's OWN --settings after it (its tools' allow-list). The CLI applies only
  // the LAST --settings (measured, claude 2.1.285), so the host's file silently replaced the app's: the one consumer that
  // grades agent-written text ran with no fence and no blanks. The host's file now carries both — merged by Lyntai since
  // 3.5.3 (its D190); through 3.5.2 the app's own wrapper did it, and this row fails on 3.5.2 without that wrapper.
  // The stub records the file it would APPLY (claude-stub.mjs, effectiveSettings).
  const effective = scorers.map((x) => x.settings ?? {});
  const unmerged = effective.filter((s) => !(s.disableSkillShellExecution === true && s.apiKeyHelper === ''
    && s.env?.ANTHROPIC_API_KEY === '' && s.permissions?.blockReadsOutsideWorkingDirectories === true));
  ok('THE POINT: every scorer spawn APPLIES the app\'s one-shot settings — the last --settings carries the blanks and the fence',
    scorers.length >= 2 && unmerged.length === 0, JSON.stringify(unmerged.slice(0, 1)).slice(0, 300));
  const unapproved = scorers.filter((x) => !(x.settings?.permissions?.allow ?? []).some((a) => /^mcp__.+__\*$/.test(a))
    || !x.args.some((a) => /^mcp__.+__\*$/.test(a)));
  ok('…while its judge tools stay pre-approved — in the applied settings and in --allowedTools (the positive control)',
    scorers.length >= 2 && unapproved.length === 0, JSON.stringify(scorers.map((x) => x.settings?.permissions?.allow)).slice(0, 300));
} catch (err) {
  fail('e2e-p36 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
