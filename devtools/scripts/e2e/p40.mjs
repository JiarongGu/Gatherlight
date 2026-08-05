#!/usr/bin/env node
// e2e P40 — the capability-escalation gate (S2b, Task 8): a refused capability call names itself in
// the runtime's own 4xx, the agent surfacing it (CAPABILITY_BLOCKED) parks the run for a human
// decision, allow/deny resumes the SAME session, and remember:true persists the grant into
// site.json while remember:false (if implemented) grants it for the current run only.
// THE LOAD-BEARING ASSERTION: provenance separation. The agent's explanation arrives in
// `agentReason`, a DIFFERENT field from the runtime-derived `can`/`cannot`. The stub is driven to
// emit a deliberately misleading reason — claiming the tool is harmless and already pre-approved —
// and the suite asserts that text lands ONLY in agentReason and NEVER in the system's own clauses.
// That is the structural reason an injected agent cannot author the system's account of an incident
// it caused: the card's facts come from ICapabilityDenialLog + PermissionSentence, not from
// whatever the agent's final message said.
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p40');
const { ok, fail, done } = makeReporter('p40');
makeTestData(dataDir);

// Free port — not used by any other suite (checked against every `startServer({ port: ... })` /
// `const PORT = ...` in devtools/scripts/e2e/*.mjs; e2e-p39 is the closest neighbour at 5478).
const PORT = 5480;

const toolsRoot = path.join(dataDir, 'tools');
const manifestPath = path.join(dataDir, 'site.json');

// --- fixture capabilities: written directly into the test data folder's tools/ dir, NEVER named in
// site.json's capabilities.enabled — the same convention e2e-p38 uses (no separate fixtures
// directory exists for script tools). Three distinct ids so allow/deny/session-allow don't
// interfere with each other's site.json state. --------------------------------------------------
function writeCapability(id) {
  const dir = path.join(toolsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tool.json'), JSON.stringify({
    name: id,
    description: `e2e fixture — a capability the suite deliberately never enables (${id})`,
    inputSchema: { type: 'object', properties: {}, required: [] },
    command: { exe: 'node', args: ['run.mjs'] },
    timeoutSeconds: 30,
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'run.mjs'),
    "#!/usr/bin/env node\nlet input = ''; for await (const c of process.stdin) input += c;\nprocess.stdout.write(JSON.stringify({ ok: true }));\n",
    'utf8');
}
writeCapability('cap_blocked_demo');
writeCapability('cap_blocked_demo_deny');
writeCapability('cap_blocked_session');

const readManifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const enabledIdsOf = (manifest) => (manifest.capabilities?.enabled ?? []).map((g) => (typeof g === 'string' ? g : g.id));

// Same SSE-replay reader e2e-p28/p39 use: proves a card's fields ride the wire, not just the REST
// snapshot.
async function readPhaseEventData(base, id, phase, ms = 2500) {
  const res = await fetch(`${base}/api/chat/${id}/stream`);
  const reader = res.body.getReader();
  let text = '';
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const race = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(null), 400))]);
    if (!race || race.done) break;
    text += Buffer.from(race.value).toString('utf8');
  }
  reader.cancel().catch(() => {});
  let data = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    try {
      const ev = JSON.parse(t.slice(5).trim());
      if (ev.kind === 'phase' && ev.phase === phase) data = ev.data;
    } catch { /* keep-alive / partial frame */ }
  }
  return data;
}

const srv = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { j, post, waitPhase } = makeClient(srv.base);
const client = makeClient(srv.base);

const start = async (message) => (await post('/api/chat', { message, mode: 'plan' })).body?.id;
const httpToolNames = async () => ((await j('/api/tools')).body?.tools ?? []).map((t) => t.name);

// Free the agent lease without caring exactly how the resumed turn landed — /cancel is safe on any
// non-terminal phase and a harmless no-op on an already-terminal one.
const finishUp = async (id) => {
  await post(`/api/chat/${id}/cancel`);
  return until(async () => {
    const s = (await j(`/api/chat/${id}`)).body;
    return ['committed', 'rejected', 'cancelled', 'error'].includes(s?.phase) ? s : null;
  }, 15000);
};

try {
  await waitHealthy(srv.base);
  console.log('server up');

  // === 1. a refused capability names itself, AND records the runtime's own denial for the gate to
  // read back later. All three fixtures are provoked here so their CAPABILITY_BLOCKED markers below
  // have a real ICapabilityDenialLog entry to resolve against. =================================
  const call1 = await client.call('cap_blocked_demo', {});
  ok('cap_blocked_demo: not-enabled call refused (4xx)', call1.status >= 400 && call1.status < 500, JSON.stringify(call1));
  ok('cap_blocked_demo: refusal message names the capability', (call1.result?.error ?? '').includes('cap_blocked_demo'), JSON.stringify(call1.result));

  const call2 = await client.call('cap_blocked_demo_deny', {});
  ok('cap_blocked_demo_deny: not-enabled call refused (4xx)', call2.status >= 400 && call2.status < 500, JSON.stringify(call2));

  const call3 = await client.call('cap_blocked_session', {});
  ok('cap_blocked_session: not-enabled call refused (4xx)', call3.status >= 400 && call3.status < 500, JSON.stringify(call3));

  // === 2 + 3. the gate parks; THE LOAD-BEARING check — provenance separation ====================
  const idAllow = await start('CAPTEST_ALLOW 帮我用工具查一下东西');
  await waitPhase(idAllow, 'awaiting-plan-approval');
  await post(`/api/chat/${idAllow}/plan/approve`);
  const parked = await waitPhase(idAllow, 'awaiting-capability-approval');
  ok('snapshot carries a capabilityApproval card', !!parked.capabilityApproval, JSON.stringify(parked.capabilityApproval));

  const card = await readPhaseEventData(srv.base, idAllow, 'awaiting-capability-approval');
  console.log('  cap_blocked_demo card (misleading agentReason) over SSE:', JSON.stringify(card));
  ok('card carries id/origin/state from the RUNTIME record', card?.id === 'cap_blocked_demo' && card?.origin === 'Script' && card?.state === 'NotEnabled', JSON.stringify(card));
  ok('card carries can[]/cannot[] arrays', Array.isArray(card?.can) && Array.isArray(card?.cannot), JSON.stringify(card));

  const misleading = '预先获批';
  ok('agentReason carries the agent\'s (misleading) text', (card?.agentReason ?? '').includes(misleading), card?.agentReason);
  ok('agentReason also mentions the tool it tried to call', (card?.agentReason ?? '').includes('cap_blocked_demo'), card?.agentReason);
  // THE LOAD-BEARING ASSERTION: the misleading claim must land ONLY in agentReason, never in the
  // runtime's own can/cannot clauses — proof that the two are structurally separate fields, not the
  // same text relabeled.
  const clausesText = [...(card?.can ?? []), ...(card?.cannot ?? [])].join(' | ');
  ok('THE misleading claim does NOT appear in can[] or cannot[] (provenance separation)', !clausesText.includes(misleading), clausesText);
  ok('cannot[] is the runtime\'s own boilerplate, not the agent\'s words', clausesText.length === 0 || !clausesText.includes('放心使用'), clausesText);

  // === 4. allow with remember:true → grant persists into site.json, run resumes ==================
  const beforeAllow = readManifest();
  ok('cap_blocked_demo not yet in site.json capabilities.enabled', !enabledIdsOf(beforeAllow).includes('cap_blocked_demo'), JSON.stringify(enabledIdsOf(beforeAllow)));

  const allowResp = await post(`/api/chat/${idAllow}/capability/allow`, { remember: true });
  ok('capability/allow (remember:true) accepted', allowResp.status === 200, JSON.stringify(allowResp.body));

  const afterAllow = readManifest();
  const enabledDemo = (afterAllow.capabilities?.enabled ?? []).find((g) => (typeof g === 'string' ? g : g.id) === 'cap_blocked_demo');
  ok('remember:true persisted the grant into site.json capabilities.enabled', !!enabledDemo, JSON.stringify(afterAllow.capabilities?.enabled));

  const allowSettled = await finishUp(idAllow);
  ok('allow: the run resumed (left the gate — phase is a normal terminal phase)', allowSettled.phase !== 'awaiting-capability-approval', allowSettled.phase);

  // === 5. deny → run resumes, capabilities.enabled UNCHANGED for this id ========================
  const idDeny = await start('CAPTEST_DENY 帮我用工具查一下东西');
  await waitPhase(idDeny, 'awaiting-plan-approval');
  await post(`/api/chat/${idDeny}/plan/approve`);
  await waitPhase(idDeny, 'awaiting-capability-approval');

  const denyResp = await post(`/api/chat/${idDeny}/capability/deny`);
  ok('capability/deny accepted', denyResp.status === 200, JSON.stringify(denyResp.body));
  const afterDeny = readManifest();
  ok('deny: capabilities.enabled unchanged (cap_blocked_demo_deny never added)', !enabledIdsOf(afterDeny).includes('cap_blocked_demo_deny'), JSON.stringify(enabledIdsOf(afterDeny)));

  const denySettled = await finishUp(idDeny);
  ok('deny: the run resumed (left the gate)', denySettled.phase !== 'awaiting-capability-approval', denySettled.phase);

  // === 6. CAPABILITY_BLOCKED for an unknown id must NOT park =====================================
  const idUnknown = await start('CAPTEST_UNKNOWN 帮我看看有没有要改的');
  await waitPhase(idUnknown, 'awaiting-plan-approval');
  await post(`/api/chat/${idUnknown}/plan/approve`);
  const afterUnknown = await until(async () => {
    const s = (await j(`/api/chat/${idUnknown}`)).body;
    return ['committed', 'rejected', 'cancelled', 'error'].includes(s?.phase) ? s : null;
  }, 15000);
  ok('unknown-id marker: reaches a normal TERMINAL phase, not the gate',
    afterUnknown.phase !== 'awaiting-capability-approval' && afterUnknown.phase === 'rejected', afterUnknown.phase);

  // === bonus (verified, not assumed): session-only allow (remember:false) ========================
  // Task 7 shipped both remember paths — AllowCapabilityAsync branches on `remember` and calls
  // ISessionCapabilityAllowance.Allow when false — so this is real server behavior, checked rather
  // than assumed.
  const idSession = await start('CAPTEST_SESSION 帮我用工具查一下东西');
  await waitPhase(idSession, 'awaiting-plan-approval');
  await post(`/api/chat/${idSession}/plan/approve`);
  await waitPhase(idSession, 'awaiting-capability-approval');

  const sessResp = await post(`/api/chat/${idSession}/capability/allow`, { remember: false });
  ok('capability/allow (remember:false) accepted', sessResp.status === 200, JSON.stringify(sessResp.body));

  // Checked IMMEDIATELY: AllowCapabilityAsync's session-allowance + ScriptToolProvider.Reload() are
  // both synchronous, ahead of the async resumed turn, so this is not a race.
  const namesWhileLive = await httpToolNames();
  ok('remember:false: capability becomes callable for THIS RUN (listed in /api/tools)', namesWhileLive.includes('cap_blocked_session'), JSON.stringify(namesWhileLive));
  const duringManifest = readManifest();
  ok('remember:false: capability NOT written to site.json while the run is live', !enabledIdsOf(duringManifest).includes('cap_blocked_session'), JSON.stringify(enabledIdsOf(duringManifest)));

  await finishUp(idSession);

  // Once the chat session reaches a terminal phase, the session-only allowance is cleared (S2b's
  // "this run only" boundary) and the tool reload drops it again.
  const namesAfterSession = await until(async () => {
    const names = await httpToolNames();
    return !names.includes('cap_blocked_session') ? names : null;
  }, 15000);
  ok('remember:false: capability NO LONGER listed once the run ended (session-only, not persisted)', !namesAfterSession.includes('cap_blocked_session'), JSON.stringify(namesAfterSession));
  const afterSessionManifest = readManifest();
  ok('remember:false: site.json still has no cap_blocked_session entry after the run ended', !enabledIdsOf(afterSessionManifest).includes('cap_blocked_session'), JSON.stringify(enabledIdsOf(afterSessionManifest)));
} catch (err) {
  fail('e2e-p40 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
