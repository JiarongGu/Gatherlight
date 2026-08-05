#!/usr/bin/env node
// e2e P41 — the declarative UI protocol (S3a). Two mounts, one validator: a page spec read from
// {data}/ui/ and a ```ui fence inside a streamed chat turn both go through UiTreeValidator, and
// every rejection here sits beside a positive control so a blanket-reject bug cannot pass.
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p41');
const { ok, fail, done } = makeReporter('p41');
makeTestData(dataDir);

// Free port — checked against every startServer({ port }) in devtools/scripts/e2e/*.mjs
// (p40 is the closest neighbour at 5480).
const PORT = 5482;

const uiDir = path.join(dataDir, 'ui');
fs.mkdirSync(uiDir, { recursive: true });

const writePage = (name, body) =>
  fs.writeFileSync(path.join(uiDir, `${name}.json`), typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf8');

// A page that must render …
writePage('good', {
  title: 'Good page',
  root: {
    type: 'Stack', gap: 'md', children: [
      { type: 'Heading', text: 'Hello', level: 2 },
      { type: 'Table', columns: ['Item', 'Cost'], rows: [['Flights', '82000']] },
      { type: 'Button', label: 'Ask', action: { send: 'tell me more' } },
    ],
  },
});
// … and three that must not, each failing for a different reason.
writePage('unknown', { title: 'Unknown', root: { type: 'Gantt', text: 'nope' } });
writePage('badprop', { title: 'Bad prop', root: { type: 'Text', text: 'hi', colour: 'red' } });
writePage('broken', '{ "title": "Broken", "root": { ');

// startServer returns a handle carrying `.base` + `.stop()`; makeClient exposes
// { j, post, waitPhase, getJson } where j(path) → { status, body }. Match the harness — there is
// no `api.get`.
let server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const base = server.base ?? `http://127.0.0.1:${PORT}`;
const { j, post } = makeClient(base);   // `post` is used by the chat rows added in Task 4

try {
  await waitHealthy(base);

  // --- the registry -----------------------------------------------------------------------
  const registry = (await j('/api/ui/registry')).body ?? [];
  ok('registry lists 14 components', registry.length === 14, `got ${registry.length}`);
  ok('registry carries Button.action as an Action prop',
    registry.find((c) => c.type === 'Button')?.props?.action === 'Action');

  // --- the page mount ---------------------------------------------------------------------
  const good = (await j('/api/ui/pages/good')).body;
  ok('good page is ready', good?.status === 'ready', good?.reason ?? '');
  ok('good page keeps its title', good?.title === 'Good page');
  ok('good page root is the Stack', good?.root?.type === 'Stack');
  ok('good page children survive validation', good?.root?.children?.length === 3);
  // The wire shape is FLAT — props sit beside `type`, never nested under `props`.
  ok('the node is serialized flat', good?.root?.gap === 'md' && good?.root?.props === undefined,
    JSON.stringify(good?.root)?.slice(0, 120));

  const unknown = (await j('/api/ui/pages/unknown')).body;
  ok('unknown component is invalid', unknown?.status === 'invalid');
  ok('unknown component reason names the type', /Gantt/.test(unknown?.reason ?? ''), unknown?.reason ?? '');

  const badprop = (await j('/api/ui/pages/badprop')).body;
  ok('unknown prop is invalid', badprop?.status === 'invalid');
  ok('unknown prop reason names the prop', /colour/.test(badprop?.reason ?? ''), badprop?.reason ?? '');

  const broken = (await j('/api/ui/pages/broken')).body;
  ok('malformed page is invalid, not a 500', broken?.status === 'invalid');
  ok('malformed page reason names the parse failure', /JSON/i.test(broken?.reason ?? ''), broken?.reason ?? '');

  const listed = (await j('/api/ui/pages')).body ?? [];
  ok('page list includes the seeded welcome page', listed.some((p) => p.name === 'welcome'),
    listed.map((p) => p.name).join(','));

  ok('a missing page is 404', (await j('/api/ui/pages/nope')).status === 404);
  const escaped = await j('/api/ui/pages/..%2F..%2Fsite');
  ok('a traversing page name is refused', escaped.status === 404 || escaped.status === 400, String(escaped.status));

  // --- legacy map compatibility -----------------------------------------------------------
  // A plan document written before S3a embeds its map as raw HTML. It must still be readable —
  // the remark shim converts it at parse time, which is why the raw-HTML rehype stage could go.
  const legacyDoc = path.join(dataDir, 'plans', 'legacy-map-demo.md');
  fs.mkdirSync(path.dirname(legacyDoc), { recursive: true });
  fs.writeFileSync(legacyDoc,
    '# Legacy\n\n<div class="city-map" data-points="35.71,139.79|Asakusa" data-connect="1"></div>\n', 'utf8');
  // GET /api/plans/content?path=… returns { path, content } straight off disk for any .md under
  // the site root — no index round-trip, so no watcher wait is needed here.
  const doc = (await j('/api/plans/content?path=plans/legacy-map-demo.md')).body;
  ok('legacy map document is still served intact', /city-map/.test(doc?.content ?? ''),
    (doc?.content ?? '(no content)').slice(0, 80));

  // --- the image route is narrow ----------------------------------------------------------
  const dbGrab = await fetch(`${base}/api/ui/asset/state/gatherlight.db`);
  ok('the asset route refuses a non-image path', dbGrab.status === 404, String(dbGrab.status));
  fs.mkdirSync(path.join(dataDir, 'plans'), { recursive: true });
  // 1x1 transparent PNG — a real image, so the positive control proves the route works at all.
  fs.writeFileSync(path.join(dataDir, 'plans', 'pixel.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'));
  const pixel = await fetch(`${base}/api/ui/asset/plans/pixel.png`);
  ok('the asset route serves a record image', pixel.status === 200, String(pixel.status));
  ok('the asset route sets an image content type',
    (pixel.headers.get('content-type') ?? '').startsWith('image/'), pixel.headers.get('content-type') ?? '');

  // --- the chat mount ---------------------------------------------------------------------
  // GET /api/chat/{id} returns a SNAPSHOT (phase, plan, cards) and NOT the event log, so the block
  // events have to come off the SSE stream — which replays everything buffered on connect. Same
  // reader shape e2e-p28/p39/p40 use; reading the wire also proves the events actually ship.
  const streamEvents = async (id, ms = 4000) => {
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
    const events = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      try { events.push(JSON.parse(t.slice(5).trim())); } catch { /* keep-alive / partial frame */ }
    }
    return events;
  };

  // The agent lease is app-wide and a session parked at awaiting-plan-approval STILL holds it, so a
  // case that isn't released turns the next POST /api/chat into a 409 BUSY. Same shape as p40.
  const finishUp = (id) => post(`/api/chat/${id}/cancel`).then(() => until(async () => {
    const s = (await j(`/api/chat/${id}`)).body;
    return ['committed', 'rejected', 'cancelled', 'error'].includes(s?.phase) ? s : null;
  }, 45000));

  const blocksFor = async (uiCase) => {
    const started = await post('/api/chat', { message: `UI_CASE:${uiCase}`, mode: 'plan' });
    const id = started.body?.id;
    if (!id) throw new Error(`no session id for ${uiCase}: ${JSON.stringify(started.body)}`);
    // Wait for the run to REACH a gate. A bare `phase !== 'planning'` passes instantly — a
    // just-created session is still 'idle' until the background run flips it.
    await until(async () => {
      const p = (await j(`/api/chat/${id}`)).body?.phase;
      return p && p !== 'idle' && p !== 'planning' ? p : null;
    }, 60000);
    const events = await streamEvents(id);
    await finishUp(id);
    return {
      blocks: events.filter((e) => e.kind === 'ui-block').map((e) => e.data),
      prose: events.filter((e) => e.kind === 'text-delta').map((e) => e.text ?? '').join(''),
      deltas: events.filter((e) => e.kind === 'text-delta'),
    };
  };

  const valid = await blocksFor('VALID');
  ok('valid fence yields exactly one block', valid.blocks.filter((b) => b.status !== 'partial').length === 1,
    JSON.stringify(valid.blocks.map((b) => b.status)));
  const ready = valid.blocks.find((b) => b.status === 'ready');
  ok('valid fence is ready', Boolean(ready), JSON.stringify(valid.blocks));
  ok('ready block carries the tree', ready?.node?.type === 'Card');
  ok('ready block keeps its children', ready?.node?.children?.length === 2);
  ok('the fence payload never leaks into prose', !/"type"\s*:/.test(valid.prose), valid.prose.slice(0, 200));
  ok('prose around the block survives', /Here is the plan/.test(valid.prose) && /Anything else/.test(valid.prose));
  // Three segments in index order: prose · block · prose. This is what lets the client interleave
  // them without guessing where the block belonged.
  const segments = [
    ...valid.deltas.map((e) => ({ index: e.data?.segment ?? 0, kind: 'prose' })),
    ...valid.blocks.filter((b) => b.status !== 'partial').map((b) => ({ index: b.segment, kind: 'block' })),
  ];
  const distinct = [...new Set(segments.map((s) => s.index))].sort((a, b) => a - b);
  ok('the turn splits into three segments', distinct.length === 3, JSON.stringify(segments));
  ok('the block sits between the two prose segments',
    segments.find((s) => s.kind === 'block')?.index === distinct[1], JSON.stringify(segments));

  const rejects = [
    ['UNKNOWN_TYPE', /Gantt/],
    ['BAD_JSON', /JSON/i],
    ['BAD_PROP', /colour/],
    ['BAD_ACTION', /openRecord|outside the site/],
    ['EVIL_IMAGE', /record path|https/],
    ['TOO_BIG', /500|nodes/],
    ['UNTERMINATED', /unterminated/i],
  ];
  for (const [name, pattern] of rejects) {
    const r = await blocksFor(name);
    const bad = r.blocks.find((b) => b.status === 'invalid');
    ok(`${name}: block is invalid`, Boolean(bad), JSON.stringify(r.blocks.map((b) => b.status)));
    ok(`${name}: reason names the cause`, pattern.test(bad?.reason ?? ''), bad?.reason ?? '');
    ok(`${name}: no ready block slipped through`, !r.blocks.some((b) => b.status === 'ready'));
  }

  // The positive control for the image rule: https is ALLOWED, matching markdown and the CSP.
  const remote = await blocksFor('REMOTE_IMAGE');
  ok('REMOTE_IMAGE: an https image is allowed',
    remote.blocks.some((b) => b.status === 'ready'), JSON.stringify(remote.blocks));

  // The contract only does anything if the agent is TOLD to read it. Everything else in this suite
  // would stay green with that pointer deleted — the file would still be seeded, versioned and
  // correct, and the agent would simply never emit a block. The stub reports what the server
  // actually sent it.
  const pointer = await blocksFor('CONTRACT_POINTER');
  ok('the prompt points the agent at .claude/ui-spec.md',
    /CONTRACT_POINTER_PRESENT/.test(pointer.prose), pointer.prose.slice(0, 120));

  // --- the UI contract is app-managed -------------------------------------------------------
  // LAST in the try on purpose: the version-gate row restarts the server, and every row above
  // expects the first one.
  const uiSpec = path.join(dataDir, '.claude', 'ui-spec.md');
  ok('the UI contract is seeded into the data folder', fs.existsSync(uiSpec));
  const specBody = fs.existsSync(uiSpec) ? fs.readFileSync(uiSpec, 'utf8') : '';
  ok('the contract carries a version', /UI_CONTRACT_VERSION:\s*\d+/.test(specBody));
  ok('the contract documents every component',
    ['Stack', 'Row', 'Card', 'Divider', 'Heading', 'Text', 'List', 'Badge', 'Image', 'Table', 'Map', 'Link', 'FileRef', 'Button']
      .every((c) => specBody.includes(`\`${c}\``)),
    'a component is missing from the contract the agent reads');
  // The contract must name the SAME limits the validator enforces (UiTreeValidator.MaxDepth/MaxNodes)
  // and the SAME two action verbs (UiActionValidator) — a contract that drifts is worse than none.
  ok('the contract states the enforced limits', /12 levels/.test(specBody) && /500 nodes/.test(specBody));
  ok('the contract names both action verbs and no third',
    specBody.includes('"send"') && specBody.includes('"openRecord"'));
  // CJK survives the C# raw-string → File.WriteAllText → disk round trip (BOM-less UTF-8 both ends).
  ok('the contract is not mojibake', specBody.includes('界面块'), specBody.split('\n')[1] ?? '');

  // A stale contract must be REPLACED (unlike knowledge-base content, which is never overwritten).
  fs.writeFileSync(uiSpec, '<!-- UI_CONTRACT_VERSION: 0 -->\nstale\n', 'utf8');
  server.stop();
  await new Promise((r) => setTimeout(r, 800));   // let the port free before rebinding it
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  await waitHealthy(base);
  const after = fs.readFileSync(uiSpec, 'utf8');
  ok('a stale contract is re-issued', /UI_CONTRACT_VERSION:\s*1/.test(after) && after.includes('`Button`'),
    after.slice(0, 80));
} catch (e) {
  fail(e?.stack || String(e));
  console.error(server.log().slice(-3000));
} finally {
  server.stop();
}

done();
