#!/usr/bin/env node
// e2e P42 — the site authoring loop (S3b). The agent may write pages and only pages; a page change
// is reviewed as a RENDERED page; an invalid page cannot be committed. Every denial here sits beside
// a positive control, the discipline p38/p39/p41 established.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p42');
const { ok, fail, done } = makeReporter('p42');
makeTestData(dataDir);

// Free port — suites use up to 5484 (p43); this one is clear.
const PORT = 5486;

const server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const base = server.base ?? `http://127.0.0.1:${PORT}`;
const { j, post } = makeClient(base);

// Ask the generated scope guard whether a write would be allowed. Mirrors p24's invocation: run the
// hook with a PreToolUse payload on stdin and read its decision.
const guardPath = path.join(dataDir, '.claude', 'hooks', 'scope-guard.mjs');
const wouldAllow = (relPath) => {
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Write',
    tool_input: { file_path: path.join(dataDir, relPath) },
  });
  const r = spawnSync('node', [guardPath], { input: payload, encoding: 'utf8', cwd: dataDir });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  return { allowed: r.status === 0 && !/Blocked/.test(out), out };
};

try {
  await waitHealthy(base);

  ok('the guard was issued into the data folder', fs.existsSync(guardPath));
  const guardBody = fs.existsSync(guardPath) ? fs.readFileSync(guardPath, 'utf8') : '';
  ok('the guard carries the bumped version', /GUARD_VERSION:\s*7/.test(guardBody),
    guardBody.match(/GUARD_VERSION:.*/)?.[0] ?? '(no guard)');
  ok('ui/ is in the write dirs', /WRITE_DIRS = \[[^\]]*'ui'/.test(guardBody),
    guardBody.match(/WRITE_DIRS = .*/)?.[0] ?? '(no guard)');

  // POSITIVE CONTROL first — if this fails, every denial below is meaningless.
  const pageWrite = wouldAllow('ui/tokyo.json');
  ok('a page file is writable', pageWrite.allowed, pageWrite.out.slice(0, 160));
  const md = wouldAllow('ui/notes.md');
  ok('a .md under ui/ is denied', !md.allowed);
  ok('the denial names the extension rule', /\.json/.test(md.out), md.out.slice(0, 160));
  const mjs = wouldAllow('ui/hack.mjs');
  ok('a .mjs under ui/ is denied', !mjs.allowed, mjs.out.slice(0, 160));
  const deep = wouldAllow('ui/sub/deep.json');
  ok('a page in a subdirectory is denied — ui/ is flat', !deep.allowed);
  ok('the flat denial says so', /flat/.test(deep.out), deep.out.slice(0, 160));
  // The other write dirs are untouched by the new rule.
  ok('plans/ is still writable', wouldAllow('plans/trips/x.md').allowed);
  ok('state/ is still denied', !wouldAllow('state/gatherlight.db').allowed);

  // --- navigation ---------------------------------------------------------------------------
  const uiDir = path.join(dataDir, 'ui');
  fs.mkdirSync(uiDir, { recursive: true });
  const page = (name, body) => fs.writeFileSync(path.join(uiDir, `${name}.json`), JSON.stringify(body, null, 2), 'utf8');
  const leaf = (text) => ({ type: 'Text', text });

  page('zzz-ordered', { title: 'Ordered page', nav: { label: '第一', order: 1 }, root: leaf('a') });
  page('aaa-plain', { title: 'Plain page', root: leaf('b') });
  page('secret', { title: 'Hidden page', nav: { hidden: true }, root: leaf('c') });

  const pages = (await j('/api/ui/pages')).body ?? [];
  const named = (n) => pages.find((p) => p.name === n);
  ok('a page with nav.order sorts first despite its name',
    pages.filter((p) => !p.hidden)[0]?.name === 'zzz-ordered', pages.map((p) => p.name).join(','));
  ok('nav.label wins over the title', named('zzz-ordered')?.label === '第一', named('zzz-ordered')?.label ?? '');
  ok('a page with no nav falls back to its title', named('aaa-plain')?.label === 'Plain page');
  ok('a hidden page is marked hidden', named('secret')?.hidden === true);
  ok('a hidden page is still fetchable by name',
    (await j('/api/ui/pages/secret')).body?.status === 'ready');

  // --- runCapability --------------------------------------------------------------------------
  // `budget_scan` is a real registered tool (p9 calls it) — the id is checked against /api/tools
  // below rather than assumed, because a fixture naming a tool that does not exist would make the
  // 404 row pass for the wrong reason.
  const toolNames = ((await j('/api/tools')).body?.tools ?? []).map((t) => t.name);
  ok('budget_scan is a real capability id', toolNames.includes('budget_scan'), toolNames.slice(0, 8).join(','));

  const actionPage = (action) => ({ title: 'act', root: { type: 'Button', label: '跑一下', action } });
  page('act-ok', actionPage({ runCapability: 'budget_scan' }));
  page('act-bad', actionPage({ runCapability: 'Not A Valid Id!' }));
  // Shape, not state: an id that is well-formed but names nothing yet still VALIDATES — a page must
  // not become uncommittable because a capability has not been enabled yet.
  page('act-future', actionPage({ runCapability: 'not_enabled_yet' }));

  ok('a well-formed runCapability validates', (await j('/api/ui/pages/act-ok')).body?.status === 'ready');
  ok('an id for a capability that does not exist still validates',
    (await j('/api/ui/pages/act-future')).body?.status === 'ready',
    (await j('/api/ui/pages/act-future')).body?.reason ?? '');
  const badAct = (await j('/api/ui/pages/act-bad')).body;
  ok('a malformed capability id is refused', badAct?.status === 'invalid');
  ok('the reason names the verb', /runCapability/.test(badAct?.reason ?? ''), badAct?.reason ?? '');

  const cap = await j('/api/ui/capability/budget_scan');
  ok('the confirmation data comes from the server', cap.status === 200, String(cap.status));
  ok('it carries the enforced clauses', Array.isArray(cap.body?.can) && Array.isArray(cap.body?.cannot));
  ok('an unknown capability is 404', (await j('/api/ui/capability/nope_nope')).status === 404);

  // The tree a capability returns is DATA, not a trusted view — it reaches the renderer only through
  // the same validator. Positive control first, then the href a page could never have gotten past.
  const okTree = await post('/api/ui/validate', { type: 'Text', text: 'from a capability' });
  ok('a capability result that IS a tree validates', okTree.body?.status === 'ready', JSON.stringify(okTree.body));
  const evilTree = await post('/api/ui/validate', { type: 'Link', href: 'javascript:alert(1)', text: 'x' });
  ok('a javascript: href in a capability result is refused', evilTree.body?.status === 'invalid',
    JSON.stringify(evilTree.body));

  // --- the preview gate ---------------------------------------------------------------------
  const runToGate = async (message) => {
    const started = await post('/api/chat', { message, mode: 'plan' });
    const id = started.body?.id;
    await until(async () => (await j(`/api/chat/${id}`)).body?.phase === 'awaiting-plan-approval', 60000);
    await post(`/api/chat/${id}/plan/approve`);
    await until(async () => {
      const p = (await j(`/api/chat/${id}`)).body?.phase;
      return p === 'awaiting-diff-approval' || p === 'error' || p === 'rejected';
    }, 60000);
    return id;
  };

  const goodId = await runToGate('PAGE_CASE:GOOD 给行程做个面板');
  const goodReview = (await j(`/api/chat/${goodId}`)).body?.review;
  const goodPage = (goodReview?.pages ?? [])[0];
  ok('a page change carries a page preview', Boolean(goodPage), JSON.stringify(goodReview?.pages ?? null));
  ok('the preview is ready', goodPage?.status === 'ready', goodPage?.reason ?? '');
  ok('the preview carries the validated tree', goodPage?.root?.type === 'Stack');
  ok('the summary is computed, not empty', (goodPage?.summary ?? '').length > 0, goodPage?.summary ?? '');
  ok('a new page says so in the summary', /新页面/.test(goodPage?.summary ?? ''), goodPage?.summary ?? '');
  // POSITIVE CONTROL: a valid page COMMITS.
  await post(`/api/chat/${goodId}/diff/approve`);
  await until(async () => (await j(`/api/chat/${goodId}`)).body?.phase === 'committed', 60000);
  ok('a valid page commits', (await j(`/api/chat/${goodId}`)).body?.phase === 'committed');

  const badId = await runToGate('PAGE_CASE:BAD 再来一个');
  const badPage = ((await j(`/api/chat/${badId}`)).body?.review?.pages ?? [])[0];
  ok('an invalid page is marked invalid', badPage?.status === 'invalid', JSON.stringify(badPage ?? null));
  ok('the reason names the unknown component', /Gantt/.test(badPage?.reason ?? ''), badPage?.reason ?? '');
  await post(`/api/chat/${badId}/diff/approve`);
  const stillAtGate = (await j(`/api/chat/${badId}`)).body?.phase;
  ok('approving an invalid page is REFUSED', stillAtGate === 'awaiting-diff-approval', String(stillAtGate));
  await post(`/api/chat/${badId}/diff/reject`);
  // The agent lease is app-wide and a rejection settles asynchronously — start the next turn before
  // that lands and POST /api/chat comes back 409 BUSY with no id.
  await until(async () => {
    const p = (await j(`/api/chat/${badId}`)).body?.phase;
    return ['rejected', 'cancelled', 'error', 'committed'].includes(p) ? p : null;
  }, 45000);

  // --- the agent is told ----------------------------------------------------------------------
  // S3a's lesson, applied: the contract was once seeded, versioned and CORRECT while the feature did
  // nothing, because nothing told the agent to read it — every other row stayed green. These four
  // rows check the contract's contents, and the two after them check the prompt that points at it.
  const spec = fs.readFileSync(path.join(dataDir, '.claude', 'ui-spec.md'), 'utf8');
  ok('the contract is at version 2', /UI_CONTRACT_VERSION:\s*2/.test(spec),
    spec.split('\n')[0] ?? '(empty)');
  ok('the contract documents pages', /ui\/<name>\.json/.test(spec));
  ok('the contract says ui/ is flat', /FLAT/i.test(spec));
  ok('the contract documents runCapability', /runCapability/.test(spec));

  // The stub reports what the SERVER actually put in the prompt, so deleting the prompt line turns
  // THIS row red and nothing else. Drives one plan turn and reads its plan text (p41 reads the same
  // marker off the SSE stream; the point is the assertion, not the transport).
  const pointerStart = await post('/api/chat', { message: 'UI_CASE:CONTRACT_POINTER', mode: 'plan' });
  const pointerId = pointerStart.body?.id;
  if (!pointerId) throw new Error(`no session id for the pointer turn: ${JSON.stringify(pointerStart.body)}`);
  await until(async () => {
    const p = (await j(`/api/chat/${pointerId}`)).body?.phase;
    return p && p !== 'idle' && p !== 'planning' ? p : null;
  }, 60000);
  const pointerPlan = (await j(`/api/chat/${pointerId}`)).body?.plan ?? '';
  ok('the prompt points the agent at the contract', /CONTRACT_POINTER_PRESENT/.test(pointerPlan),
    pointerPlan.slice(0, 160));
  ok('the prompt tells the agent it can write pages', /PAGES_PRESENT/.test(pointerPlan),
    pointerPlan.slice(0, 160));
  await post(`/api/chat/${pointerId}/cancel`);
} catch (e) {
  fail(e?.stack || String(e));
  console.error(server.log().slice(-3000));
} finally {
  server.stop();
}

done();
