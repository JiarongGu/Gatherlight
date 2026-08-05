#!/usr/bin/env node
// e2e P39 — the draft-approval gate (S2b, Task 7): a drafted tool sitting in .claude/tool-drafts/
// is INERT — absent from BOTH tool surfaces, not merely "not callable" — until a human approves it.
// THE LOAD-BEARING ASSERTION: the approval card's can/cannot clauses are derived from the draft's
// OWN grant, never the agent's words — proven by contrast, not just presence. A net:false draft's
// card must say the internet is blocked; a net:true draft's card must NOT — a card that merely
// appeared, with text that ignored the grant, would pass a weaker suite while promising something
// nothing backs. Also: approval promotes the grant UNCHANGED into site.json and makes the tool
// listed; rejection discards the draft without touching site.json; a marker naming a draft that was
// never authored must not park the gate; and promotion refuses to silently replace an
// already-enabled capability of the same id.
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p39');
const { ok, fail, done } = makeReporter('p39');
makeTestData(dataDir);

// Free port — not used by any other suite (checked against every `startServer({ port: ... })` /
// `const PORT = ...` in devtools/scripts/e2e/*.mjs; p36/p37/p38 are the closest neighbours at
// 5473 / 5464-65 / 5466-69).
const PORT = 5478;

const draftsRoot = path.join(dataDir, '.claude', 'tool-drafts');
const manifestPath = path.join(dataDir, 'site.json');

// --- fixture drafts: written directly under .claude/tool-drafts/<id>/, the same shape the execute
// prompt tells a real agent to author (tool.json + entry script) — mirrors e2e-p38's convention of
// hand-authoring script-tool fixtures straight into the data folder rather than inventing a separate
// fixtures directory. ------------------------------------------------------------------------------
function writeDraft(id, { title, description, grant }) {
  const dir = path.join(draftsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tool.json'), JSON.stringify({
    name: id,
    title,
    description,
    grant: { id, ...grant },
    command: { exe: 'node', args: ['run.mjs'] },
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'run.mjs'),
    "#!/usr/bin/env node\nlet input = ''; for await (const c of process.stdin) input += c;\nprocess.stdout.write(JSON.stringify({ ok: true }));\n",
    'utf8');
}

writeDraft('draft_a', {
  title: '示例草稿工具 A · Draft tool A',
  description: 'e2e fixture — reads plans, writes cache, no network',
  grant: { fs: { read: ['plans'], write: ['cache'] }, net: false },
});
writeDraft('draft_b', {
  title: '示例草稿工具 B · Draft tool B',
  description: 'e2e fixture — reads household, writes cache, WITH network',
  grant: { fs: { read: ['household'], write: ['cache'] }, net: true },
});

const readManifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const patchManifest = (mutate) => {
  const m = readManifest();
  mutate(m);
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n', 'utf8');
};
const enabledIdsOf = (manifest) => (manifest.capabilities?.enabled ?? []).map((g) => (typeof g === 'string' ? g : g.id));

// Read the buffered SSE replay for a session and return the `data` of the first matching phase
// event — the same technique e2e-p28 uses to prove a card's fields ride the wire, not just the
// REST snapshot (which is computed by the exact same server-side view function, so reading BOTH
// is redundant for correctness but the SSE read is what the task asks this suite to prove).
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

const mentionsInternet = (clauses) => (clauses ?? []).some((c) => c.includes('网络') || c.toLowerCase().includes('internet'));

const srv = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { j, post, waitPhase } = makeClient(srv.base);

const rpc = async (payload) => {
  const res = await fetch(`${srv.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const httpToolNames = async () => ((await j('/api/tools')).body?.tools ?? []).map((t) => t.name);
const mcpToolNames = async () => {
  await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e-p39', version: '1' } } });
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  return (list.body?.result?.tools ?? []).map((t) => t.name);
};

const start = async (message) => (await post('/api/chat', { message, mode: 'plan' })).body?.id;

// Free the agent lease without caring exactly how the resumed turn landed (a real edit, a no-op
// 'rejected', or still live) — /cancel is safe to call on any non-terminal phase and a harmless
// no-op on an already-terminal one, so this always converges without racing the resumed stub.
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

  // === 1. inert before approval: absent from BOTH surfaces, not merely "not callable" ==========
  const httpBefore = await httpToolNames();
  ok('draft_a absent from GET /api/tools before approval', !httpBefore.includes('draft_a'), JSON.stringify(httpBefore));
  ok('draft_b absent from GET /api/tools before approval', !httpBefore.includes('draft_b'), JSON.stringify(httpBefore));
  const mcpBefore = await mcpToolNames();
  ok('draft_a absent from /mcp tools/list before approval', !mcpBefore.includes('draft_a'), JSON.stringify(mcpBefore));
  ok('draft_b absent from /mcp tools/list before approval', !mcpBefore.includes('draft_b'), JSON.stringify(mcpBefore));

  // === 2 + 3. the gate parks, and the card's clauses track the grant (THE load-bearing check) ===
  const idA = await start('DRAFTTEST_A 帮我规划一次采购,需要一个新工具');
  await waitPhase(idA, 'awaiting-plan-approval');
  await post(`/api/chat/${idA}/plan/approve`);
  const parkedA = await waitPhase(idA, 'awaiting-draft-approval');
  ok('draft_a: snapshot carries a draftApproval card', !!parkedA.draftApproval, JSON.stringify(parkedA.draftApproval));

  const cardA = await readPhaseEventData(srv.base, idA, 'awaiting-draft-approval');
  console.log('  draft_a card (net:false) over SSE:', JSON.stringify(cardA));
  ok('draft_a: SSE phase event carries the card', !!cardA, JSON.stringify(cardA));
  ok('draft_a: id/title/description/entrySource present on the wire',
    cardA?.id === 'draft_a' && typeof cardA?.title === 'string' && cardA.title.length > 0
      && typeof cardA?.description === 'string' && cardA.description.length > 0
      && typeof cardA?.entrySource === 'string' && cardA.entrySource.length > 0,
    JSON.stringify(cardA));
  ok('draft_a: can[] mentions plans/', (cardA?.can ?? []).some((c) => c.includes('plans')), JSON.stringify(cardA?.can));
  ok('draft_a: can[] mentions cache/', (cardA?.can ?? []).some((c) => c.includes('cache')), JSON.stringify(cardA?.can));
  ok('draft_a: can[] does NOT claim network (net:false)', !mentionsInternet(cardA?.can), JSON.stringify(cardA?.can));
  // THE LOAD-BEARING ASSERTION, half 1: a net:false draft's card says the internet IS blocked.
  ok('draft_a: cannot[] DOES claim the internet is blocked (net:false)', mentionsInternet(cardA?.cannot), JSON.stringify(cardA?.cannot));

  // === 4. approve draft_a → promoted, listed, site.json grant UNCHANGED, draft folder gone ======
  // Only ONE chat session may be live at a time (the single-agent lease) — idA must reach a
  // terminal phase before idB can even start, or /api/chat 409s BUSY.
  const beforeApprove = readManifest();
  ok('draft_a not yet in site.json capabilities.enabled', !enabledIdsOf(beforeApprove).includes('draft_a'), JSON.stringify(enabledIdsOf(beforeApprove)));

  const appr = await post(`/api/chat/${idA}/draft/approve`);
  ok('draft/approve accepted', appr.status === 200, JSON.stringify(appr.body));
  ok('draft_a folder deleted immediately after promotion (synchronous)', !fs.existsSync(path.join(draftsRoot, 'draft_a')));
  const afterApprove = readManifest();
  const enabledA = (afterApprove.capabilities?.enabled ?? []).find((g) => (typeof g === 'string' ? g : g.id) === 'draft_a');
  ok('draft_a grant appended to site.json capabilities.enabled', !!enabledA, JSON.stringify(afterApprove.capabilities?.enabled));
  ok('draft_a grant is UNCHANGED (fs.read=[plans], fs.write=[cache], net=false)',
    JSON.stringify(enabledA?.fs?.read) === JSON.stringify(['plans'])
      && JSON.stringify(enabledA?.fs?.write) === JSON.stringify(['cache'])
      && enabledA?.net === false,
    JSON.stringify(enabledA));

  // The listing itself lands via a debounced (1s) filesystem-watcher reload — poll for it.
  const namesAfterA = await until(async () => {
    const names = await httpToolNames();
    return names.includes('draft_a') ? names : null;
  }, 15000);
  ok('draft_a listed in GET /api/tools after approval', namesAfterA.includes('draft_a'), JSON.stringify(namesAfterA));

  await finishUp(idA);

  // === draft_b: park, capture the CONTRASTING card, then reject =================================
  const idB = await start('DRAFTTEST_B 帮我规划一次采购,需要一个能上网的新工具');
  await waitPhase(idB, 'awaiting-plan-approval');
  await post(`/api/chat/${idB}/plan/approve`);
  await waitPhase(idB, 'awaiting-draft-approval');
  const cardB = await readPhaseEventData(srv.base, idB, 'awaiting-draft-approval');
  console.log('  draft_b card (net:true) over SSE:', JSON.stringify(cardB));
  ok('draft_b: can[] mentions household/', (cardB?.can ?? []).some((c) => c.includes('household')), JSON.stringify(cardB?.can));
  ok('draft_b: can[] DOES claim network (net:true)', mentionsInternet(cardB?.can), JSON.stringify(cardB?.can));
  // THE LOAD-BEARING ASSERTION, half 2: a net:true draft's card must NOT claim the internet is
  // blocked. The CONTRAST against draft_a is the whole point — a card whose text ignored the grant
  // (e.g. always printing the same boilerplate "cannot reach the internet") would pass half 1 above
  // and fail only here.
  ok('draft_b: cannot[] does NOT claim the internet is blocked (net:true)', !mentionsInternet(cardB?.cannot), JSON.stringify(cardB?.cannot));

  // === 5. reject draft_b → discarded, site.json UNCHANGED (draft_b never added) =================
  const rej = await post(`/api/chat/${idB}/draft/reject`);
  ok('draft/reject accepted', rej.status === 200, JSON.stringify(rej.body));
  ok('draft_b folder deleted immediately after rejection (synchronous)', !fs.existsSync(path.join(draftsRoot, 'draft_b')));
  const afterReject = readManifest();
  ok('reject: capabilities.enabled unaffected (draft_a present from step 4, draft_b absent)',
    enabledIdsOf(afterReject).includes('draft_a') && !enabledIdsOf(afterReject).includes('draft_b'),
    JSON.stringify(enabledIdsOf(afterReject)));

  await finishUp(idB);

  // === 6. TOOL_DRAFT naming a nonexistent draft must NOT park ====================================
  const idM = await start('DRAFTTEST_MISSING 帮我看看有没有要改的');
  await waitPhase(idM, 'awaiting-plan-approval');
  await post(`/api/chat/${idM}/plan/approve`);
  const afterMissing = await until(async () => {
    const s = (await j(`/api/chat/${idM}`)).body;
    return ['committed', 'rejected', 'cancelled', 'error'].includes(s?.phase) ? s : null;
  }, 15000);
  ok('missing-draft marker: reaches a normal TERMINAL phase, not the draft gate',
    afterMissing.phase !== 'awaiting-draft-approval' && afterMissing.phase === 'rejected', afterMissing.phase);

  // === 7. promotion refuses to overwrite an already-enabled capability of the same id ============
  patchManifest((m) => {
    m.capabilities.enabled.push({ id: 'draft_c', fs: { read: [], write: ['cache'] }, net: false });
  });
  writeDraft('draft_c', {
    title: '示例草稿工具 C · Draft tool C',
    description: 'e2e fixture — id collides with an already-enabled capability',
    grant: { fs: { read: ['plans'], write: ['cache'] }, net: false },
  });
  const idC = await start('DRAFTTEST_OVERWRITE 帮我规划一次采购');
  await waitPhase(idC, 'awaiting-plan-approval');
  await post(`/api/chat/${idC}/plan/approve`);
  await waitPhase(idC, 'awaiting-draft-approval');
  await post(`/api/chat/${idC}/draft/approve`);
  const errC = await waitPhase(idC, 'error');
  ok('overwrite: promotion refused, session ends in error (not silently replaced)', !!errC.error, JSON.stringify(errC.error));
  ok('overwrite: error names the reason (already enabled)', (errC.error ?? '').toLowerCase().includes('already enabled'), errC.error);
  ok('overwrite: draft_c folder NOT deleted (promotion never applied)', fs.existsSync(path.join(draftsRoot, 'draft_c')));
  const afterOverwrite = readManifest();
  const draftCEntries = (afterOverwrite.capabilities?.enabled ?? []).filter((g) => (typeof g === 'string' ? g : g.id) === 'draft_c');
  ok('overwrite: capabilities.enabled has exactly ONE draft_c entry (not duplicated)', draftCEntries.length === 1, JSON.stringify(draftCEntries));
} catch (err) {
  fail('e2e-p39 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
