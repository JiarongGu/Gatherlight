#!/usr/bin/env node
// e2e P14 — portable memory transfer. Export the DB knowledge (library + learned facts) from one
// install, then (a) re-import it (idempotent) and (b) SEED A FRESH install from the same bundle at
// startup via GATHERLIGHT_SEED_MEMORY. Two server instances, no claude/browser.
import fs from 'node:fs';
import path from 'node:path';
import { repo, dataDirFor, makeReporter, makeTestData, startServer, until, waitHealthy, makeClient } from './_e2e-common.mjs';

const dataA = dataDirFor('p14a');
const dataB = dataDirFor('p14b');
const bundlePath = path.join(repo, 'devtools', '_e2e-p14-bundle.json');
const PA = 5395, PB = 5396;

const { ok, fail, done } = makeReporter('p14');

makeTestData(dataA);
makeTestData(dataB);

let srv = null, srv2 = null;
try {
  // --- install A: put some memory in, export it ---
  srv = startServer({ dataDir: dataA, port: PA });
  const baseA = srv.base;
  const { call: callA, getJson: getJsonA } = makeClient(baseA);
  await waitHealthy(baseA);

  await callA('library_upsert', { kind: 'attraction', key: 'export-temple', name: 'Export Temple', nameLocal: '导出寺', region: 'Testville', summary: 'A temple that travels well.', lat: 35.01, lng: 135.7, confidence: 0.9 });
  await callA('library_upsert', { kind: 'restaurant', key: 'export-diner', name: 'Export Diner', region: 'Testville', confidence: 0.8 });
  await callA('remember_fact', { kind: 'venue-url', topic: 'Export Temple official', content: 'https://example.org/temple verified', source: 'https://example.org/temple', confidence: 0.95 });
  // tune the cortex on A — this should travel with the bundle
  await fetch(`${baseA}/api/manage/cortex/model/extract`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'opus' }) });

  const exportRes = await fetch(`${baseA}/api/memory/export`);
  ok('GET /api/memory/export 200 + attachment', exportRes.status === 200 && (exportRes.headers.get('content-disposition') ?? '').includes('.json'),
    `${exportRes.status}`);
  const bundleText = await exportRes.text();
  fs.writeFileSync(bundlePath, bundleText, 'utf8');
  const bundle = JSON.parse(bundleText);
  ok('bundle has version + library + knowledge', bundle.gatherlightMemory === 1 && bundle.library.length >= 2 && bundle.knowledge.length >= 1,
    JSON.stringify({ v: bundle.gatherlightMemory, lib: bundle.library.length, kn: bundle.knowledge.length }));
  ok('bundle preserves lat/nameLocal', bundle.library.some((i) => i.key === 'export-temple' && i.nameLocal === '导出寺' && Math.abs((i.lat ?? 0) - 35.01) < 0.001));
  ok('bundle carries cortex tuning', bundle.cortex && bundle.cortex['llm.model.extract'] === 'opus', JSON.stringify(bundle.cortex));

  // idempotent re-import into A
  const reimport = await (await fetch(`${baseA}/api/memory/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: bundleText,
  })).json();
  ok('POST /api/memory/import merges (idempotent)', reimport.ok === true && reimport.imported.library >= 2, JSON.stringify(reimport.imported));
  ok('re-import reports cortex count', reimport.imported.cortex >= 1, JSON.stringify(reimport.imported));
  const aLibAfter = await getJsonA('/api/library');
  ok('re-import does not duplicate', aLibAfter.items.filter((i) => i.key === 'export-temple').length === 1);

  srv.stop(); srv = null;
  await new Promise((r) => setTimeout(r, 1500));

  // --- install B: FRESH data folder, seeded from the bundle at STARTUP ---
  srv2 = startServer({ dataDir: dataB, port: PB, env: { GATHERLIGHT_SEED_MEMORY: bundlePath } });
  const baseB = srv2.base;
  const { call: callB, getJson: getJsonB } = makeClient(baseB);
  await waitHealthy(baseB);

  const bLib = await getJsonB('/api/library');
  ok('fresh install seeded: library present', bLib.items.length >= 2, String(bLib.items.length));
  ok('seeded item survived transfer (nameLocal + coords)', bLib.items.some((i) => i.key === 'export-temple' && i.nameLocal === '导出寺'));
  ok('seed log line emitted', /Seeded memory from/.test(srv2.log()), srv2.log().split('\n').filter((l) => l.includes('Seeded')).slice(0, 1).join(''));

  const recalled = await callB('recall_facts', { query: 'Export Temple' });
  ok('seeded knowledge fact recallable on B', (recalled.result.facts ?? []).some((f) => f.topic.includes('Export Temple')),
    JSON.stringify((recalled.result.facts ?? []).length));

  const bCortex = await getJsonB('/api/manage/cortex');
  ok('seeded cortex override survived transfer', bCortex.models.find((m) => m.consumer === 'extract')?.effective === 'opus',
    JSON.stringify(bCortex.models?.find((m) => m.consumer === 'extract')));
} catch (err) {
  fail('e2e-p14 fatal: ' + err.message);
  console.error(((srv?.log() ?? '') + (srv2?.log() ?? '')).slice(-3000));
} finally {
  srv?.stop(); srv2?.stop();
  try { fs.rmSync(bundlePath, { force: true }); } catch {}
}
done();
