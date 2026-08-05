#!/usr/bin/env node
// e2e P41 — the declarative UI protocol (S3a). Two mounts, one validator: a page spec read from
// {data}/ui/ and a ```ui fence inside a streamed chat turn both go through UiTreeValidator, and
// every rejection here sits beside a positive control so a blanket-reject bug cannot pass.
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd,
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
} catch (e) {
  fail(e?.stack || String(e));
  console.error(server.log().slice(-3000));
} finally {
  server.stop();
}

done();
