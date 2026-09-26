#!/usr/bin/env node
// e2e P14 — portable memory transfer. Export the DB knowledge (library + learned facts) from one
// install, then (a) re-import it (idempotent) and (b) SEED A FRESH install from the same bundle at
// startup via GATHERLIGHT_SEED_MEMORY. Two server instances, no claude/browser.
//
// The scorer's model travels as its LIVE ROUTE since Lyntai 3.3 (llm.route.scorer = claude-cli:<model>), and an
// older bundle's bare llm.model.scorer imports AS that route — the key a route reader never looks at, so importing
// it verbatim would leave the scorer on haiku without a word. Both halves confirmed to fail: the export with the
// scorer's stored key taken as llm.model.scorer (the route is not carried), and the import with the old key written
// raw (no route, and the pre-route key sitting in app_config). The judge's route never travels, like its old key.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  // `validate` (智库校验) is tunable now too (round 2) — unlike `memory`, nothing binds it to a
  // backend the bundle doesn't carry, so a plain llm.model.<consumer> key should travel exactly like
  // `extract`'s.
  await fetch(`${baseA}/api/manage/cortex/model/validate`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'haiku' }) });
  // The scorer is the one cortex row stored as a live ROUTE — it must travel as one.
  await fetch(`${baseA}/api/manage/cortex/model/scorer`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'sonnet' }) });
  // The judge's model is BOUND with its backend (settings.json), which a memory bundle does not carry — so
  // the route must not travel alone. Binding the CLI judge writes llm.route.memory = claude-cli:sonnet on A.
  const judgeBind = await fetch(`${baseA}/api/manage/memory/layer/judge`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'claude-cli', model: 'sonnet' }),
  });
  ok('(fixture) the judge bind on A succeeds', judgeBind.status === 200, `${judgeBind.status} ${await judgeBind.text()}`);
  // Positive control for the assertion below: read A's OWN app_config, not the export, so a bind that
  // silently no-opped (400/409 swallowed) can't make "the bundle does not carry it" pass vacuously.
  const keyOn = (dir, key) => {
    const d = new DatabaseSync(path.join(dir, 'state', 'gatherlight.db'), { readOnly: true });
    try { return d.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value; }
    finally { d.close(); }
  };
  ok('(fixture) A\'s live llm.route.memory is claude-cli:sonnet before export',
    keyOn(dataA, 'llm.route.memory') === 'claude-cli:sonnet', `llm.route.memory=${JSON.stringify(keyOn(dataA, 'llm.route.memory'))}`);
  ok('(fixture) A\'s scorer row is stored as its route', keyOn(dataA, 'llm.route.scorer') === 'claude-cli:sonnet',
    `llm.route.scorer=${JSON.stringify(keyOn(dataA, 'llm.route.scorer'))}`);

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
  ok('bundle carries the validate model too (tunable since round 2)', bundle.cortex && bundle.cortex['llm.model.validate'] === 'haiku', JSON.stringify(bundle.cortex));
  ok('THE POINT: the bundle does NOT carry the judge\'s model — it belongs to a binding the bundle lacks',
    !Object.prototype.hasOwnProperty.call(bundle.cortex ?? {}, 'llm.model.memory')
      && !Object.prototype.hasOwnProperty.call(bundle.cortex ?? {}, 'llm.route.memory'), JSON.stringify(bundle.cortex));
  ok('THE POINT: the scorer travels as its ROUTE, the key a route reader reads — not the bare pre-route key',
    bundle.cortex?.['llm.route.scorer'] === 'claude-cli:sonnet'
      && !Object.prototype.hasOwnProperty.call(bundle.cortex ?? {}, 'llm.model.scorer'), JSON.stringify(bundle.cortex));

  // idempotent re-import into A
  const reimport = await (await fetch(`${baseA}/api/memory/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: bundleText,
  })).json();
  ok('POST /api/memory/import merges (idempotent)', reimport.ok === true && reimport.imported.library >= 2, JSON.stringify(reimport.imported));
  ok('re-import reports cortex count', reimport.imported.cortex >= 1, JSON.stringify(reimport.imported));
  const aLibAfter = await getJsonA('/api/library');
  ok('re-import does not duplicate', aLibAfter.items.filter((i) => i.key === 'export-temple').length === 1);

  // AN IMPORT'S FACTS ARE INDEXED WITHOUT A RESTART. The import writes through LearnAsync and never indexes: a NEW fact
  // has no graph ref, and an EDITED one (same kind + topic) has its ref cleared — the graph dedups by content hash, so
  // the old ref names a node holding the previous text. Until the next start's back-fill those were found by keyword
  // only. The endpoint now starts that back-fill itself, detached (DetachedFactBackfill), so poll: the response does
  // not wait for it.
  const factRow = (dataDir, topic) => {
    const d = new DatabaseSync(path.join(dataDir, 'state', 'gatherlight.db'), { readOnly: true });
    try {
      const row = d.prepare("SELECT content, COALESCE(graph_ref, '') AS ref FROM knowledge WHERE topic = ?").get(topic);
      if (!row) return null;
      const id = Number(String(row.ref).split('#').pop());
      const node = row.ref
        ? d.prepare("SELECT content FROM lyntai_memory_node WHERE engine = 'facts/graph' AND id = ?").get(id)?.content ?? null
        : null;
      return { content: row.content, ref: row.ref, node };
    } finally { d.close(); }
  };
  const templeBefore = factRow(dataA, 'Export Temple official');
  ok('(fixture) the fact written through the tool was indexed on the way in', !!templeBefore?.ref, JSON.stringify(templeBefore));
  const templeV2 = 'https://example.org/temple verified again, now open until 18:00';
  const editImport = await fetch(`${baseA}/api/memory/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gatherlightMemory: 1, knowledge: [
      { kind: 'venue-url', topic: 'Export Temple official', content: templeV2, source: 'https://example.org/temple', confidence: 0.95 },
      { kind: 'venue-url', topic: 'Import Shrine official', content: 'https://example.org/shrine verified', source: 'https://example.org/shrine', confidence: 0.9 },
    ] }),
  });
  ok('(fixture) the import of an edit and a new fact succeeds', editImport.status === 200, `${editImport.status}`);
  let templeAfter = null, shrineAfter = null;
  try {
    await until(() => {
      templeAfter = factRow(dataA, 'Export Temple official');
      shrineAfter = factRow(dataA, 'Import Shrine official');
      return templeAfter?.node === templeV2 && shrineAfter?.node === 'https://example.org/shrine verified';
    }, 60000, 500);
  } catch { /* reported below */ }
  ok('THE POINT: an EDITED fact from an import is indexed with its NEW content, in the same life — no restart',
    !!templeAfter?.ref && templeAfter.ref !== templeBefore?.ref && templeAfter.node === templeV2,
    JSON.stringify({ before: templeBefore, after: templeAfter }));
  ok('…and so is a NEW fact from the import', !!shrineAfter?.ref && shrineAfter.node === 'https://example.org/shrine verified',
    JSON.stringify(shrineAfter));

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
  // …and INDEXED in this life. The seed step runs after the startup back-fill (FactIndexStep), so a seeded fact used to
  // wait for the NEXT start to leave keyword-only recall; the step now starts the same detached back-fill as the import.
  let seededRow = null;
  try {
    await until(() => (seededRow = factRow(dataB, 'Export Temple official'))?.node === 'https://example.org/temple verified', 60000, 500);
  } catch { /* reported below */ }
  ok('THE POINT: a SEEDED fact is indexed in the life that seeded it — no second start needed',
    !!seededRow?.ref && seededRow.node === 'https://example.org/temple verified', JSON.stringify(seededRow));

  const bCortex = await getJsonB('/api/manage/cortex');
  ok('seeded cortex override survived transfer', bCortex.models.find((m) => m.consumer === 'extract')?.effective === 'opus',
    JSON.stringify(bCortex.models?.find((m) => m.consumer === 'extract')));
  ok('seeded validate model override survived transfer too', bCortex.models.find((m) => m.consumer === 'validate')?.effective === 'haiku',
    JSON.stringify(bCortex.models?.find((m) => m.consumer === 'validate')));
  ok('…and so did the scorer\'s route, which cortex reads back as its model', bCortex.models.find((m) => m.consumer === 'scorer')?.effective === 'sonnet'
      && keyOn(dataB, 'llm.route.scorer') === 'claude-cli:sonnet',
    `${JSON.stringify(bCortex.models?.find((m) => m.consumer === 'scorer'))} llm.route.scorer=${JSON.stringify(keyOn(dataB, 'llm.route.scorer'))}`);

  // AN OLDER BUNDLE's scorer: every bundle before the routes carried llm.model.scorer, a bare model. Nothing reads
  // that key any more, so importing it as written would leave the scorer on haiku; it has to land as the route.
  const older = await (await fetch(`${baseB}/api/memory/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gatherlightMemory: 1, cortex: { 'llm.model.scorer': 'opus' } }),
  })).json();
  ok('(fixture) an older bundle carrying llm.model.scorer imports it', older.ok === true && older.imported?.cortex === 1,
    JSON.stringify(older.imported));
  ok('THE POINT: an older bundle\'s llm.model.scorer lands as the route llm.route.scorer = claude-cli:opus',
    keyOn(dataB, 'llm.route.scorer') === 'claude-cli:opus' && keyOn(dataB, 'llm.model.scorer') === undefined,
    `llm.route.scorer=${JSON.stringify(keyOn(dataB, 'llm.route.scorer'))} llm.model.scorer=${JSON.stringify(keyOn(dataB, 'llm.model.scorer'))}`);
  // …and a route cortex could not have written — another provider, or no model at all (which would run the scorer
  // on the backend's default rather than haiku) — is refused, not stored verbatim.
  const oddRoutes = await (await fetch(`${baseB}/api/memory/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gatherlightMemory: 1, cortex: { 'llm.route.scorer': 'claude-cli' } }),
  })).json();
  const oddRoutes2 = await (await fetch(`${baseB}/api/memory/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gatherlightMemory: 1, cortex: { 'llm.route.scorer': 'llamacpp:zzforeign-chat' } }),
  })).json();
  ok('…and a scorer route cortex could not write (a bare provider, another backend) is refused, not stored',
    oddRoutes.imported?.cortex === 0 && oddRoutes2.imported?.cortex === 0 && keyOn(dataB, 'llm.route.scorer') === 'claude-cli:opus',
    `${JSON.stringify(oddRoutes.imported)} ${JSON.stringify(oddRoutes2.imported)} llm.route.scorer=${JSON.stringify(keyOn(dataB, 'llm.route.scorer'))}`);

  // An older (1.3.0-era) bundle exported before this fix DID carry llm.model.memory — hand-edit one back in
  // and confirm import refuses to write it: a model key travels only if cortex can set it, and cortex cannot
  // set `memory` (it binds together with a backend the bundle does not carry). Its route likewise.
  const foreign = { ...bundle, cortex: { ...bundle.cortex, 'llm.model.memory': 'zzforeign-chat.gguf',
    'llm.route.memory': 'llamacpp:zzforeign-chat.gguf' } };
  const imp = await (await fetch(`${baseB}/api/memory/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(foreign),
  })).json();
  // Proves the loop actually RAN over the foreign bundle's cortex keys and skipped exactly one — the
  // count alone (imported.cortex >= 1, as the earlier re-import assertion checks) can't distinguish
  // "skipped the foreign key" from "silently dropped everything".
  const expectedCortexCount = Object.keys(foreign.cortex).length - 2; // every key but the two foreign ones
  ok('…and the import count shows the loop skipped exactly the foreign keys, nothing else',
    imp.imported?.cortex === expectedCortexCount, `cortex=${imp.imported?.cortex} expected=${expectedCortexCount}`);
  const memKey = keyOn(dataB, 'llm.model.memory');
  const memRoute = keyOn(dataB, 'llm.route.memory');
  ok('…and an older bundle that DOES carry it cannot write it (import skips a key cortex cannot set)',
    imp.ok === true && memKey === undefined && memRoute === undefined,
    `llm.model.memory=${JSON.stringify(memKey)} llm.route.memory=${JSON.stringify(memRoute)}`);
} catch (err) {
  fail('e2e-p14 fatal: ' + err.message);
  console.error(((srv?.log() ?? '') + (srv2?.log() ?? '')).slice(-3000));
} finally {
  srv?.stop(); srv2?.stop();
  try { fs.rmSync(bundlePath, { force: true }); } catch {}
}
done();
