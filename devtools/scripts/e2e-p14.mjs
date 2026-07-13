#!/usr/bin/env node
// e2e P14 — portable memory transfer. Export the DB knowledge (library + learned facts) from one
// install, then (a) re-import it (idempotent) and (b) SEED A FRESH install from the same bundle at
// startup via GATHERLIGHT_SEED_MEMORY. Two server instances, no claude/browser.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataA = path.join(repo, 'devtools', '_e2e-p14a-data');
const dataB = path.join(repo, 'devtools', '_e2e-p14b-data');
const bundlePath = path.join(repo, 'devtools', '_e2e-p14-bundle.json');
const PA = 5395, PB = 5396;

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
};

const boot = (dataDir, port, extraEnv = {}) => spawn('dotnet',
  ['run', '--project', 'src/server/Gatherlight.Server', '--no-build'],
  { cwd: repo, env: { ...process.env, GATHERLIGHT_DATA: dataDir, GATHERLIGHT_PORT: String(port), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });

const until = async (fn, ms = 40000) => {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fn(); if (r) return r; } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 400));
  }
};
const call = async (base, name, args) => {
  const res = await fetch(`${base}/api/tools/call`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
  });
  const b = await res.json().catch(() => null);
  return b?.result ? JSON.parse(b.result) : b;
};
const getJson = async (base, p) => (await (await fetch(`${base}${p}`)).json());

spawnSync('node', [path.join(repo, 'devtools', 'scripts', 'make-test-data.mjs'), dataA], { stdio: 'inherit' });
spawnSync('node', [path.join(repo, 'devtools', 'scripts', 'make-test-data.mjs'), dataB], { stdio: 'inherit' });

let a = null, b = null;
let logA = '', logB = '';
try {
  // --- install A: put some memory in, export it ---
  a = boot(dataA, PA);
  a.stdout.on('data', (d) => (logA += d)); a.stderr.on('data', (d) => (logA += d));
  const baseA = `http://127.0.0.1:${PA}`;
  await until(() => fetch(`${baseA}/api/health`).then((r) => r.ok));

  await call(baseA, 'library_upsert', { kind: 'attraction', key: 'export-temple', name: 'Export Temple', nameLocal: '导出寺', region: 'Testville', summary: 'A temple that travels well.', lat: 35.01, lng: 135.7, confidence: 0.9 });
  await call(baseA, 'library_upsert', { kind: 'restaurant', key: 'export-diner', name: 'Export Diner', region: 'Testville', confidence: 0.8 });
  await call(baseA, 'remember_fact', { kind: 'venue-url', topic: 'Export Temple official', content: 'https://example.org/temple verified', source: 'https://example.org/temple', confidence: 0.95 });
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
  const aLibAfter = await getJson(baseA, '/api/library');
  ok('re-import does not duplicate', aLibAfter.items.filter((i) => i.key === 'export-temple').length === 1);

  a.kill(); a = null;
  await new Promise((r) => setTimeout(r, 1500));

  // --- install B: FRESH data folder, seeded from the bundle at STARTUP ---
  b = boot(dataB, PB, { GATHERLIGHT_SEED_MEMORY: bundlePath });
  b.stdout.on('data', (d) => (logB += d)); b.stderr.on('data', (d) => (logB += d));
  const baseB = `http://127.0.0.1:${PB}`;
  await until(() => fetch(`${baseB}/api/health`).then((r) => r.ok));

  const bLib = await getJson(baseB, '/api/library');
  ok('fresh install seeded: library present', bLib.items.length >= 2, String(bLib.items.length));
  ok('seeded item survived transfer (nameLocal + coords)', bLib.items.some((i) => i.key === 'export-temple' && i.nameLocal === '导出寺'));
  ok('seed log line emitted', /Seeded memory from/.test(logB), logB.split('\n').filter((l) => l.includes('Seeded')).slice(0, 1).join(''));

  const recalled = await call(baseB, 'recall_facts', { query: 'Export Temple' });
  ok('seeded knowledge fact recallable on B', (recalled.facts ?? []).some((f) => f.topic.includes('Export Temple')),
    JSON.stringify((recalled.facts ?? []).length));

  const bCortex = await getJson(baseB, '/api/manage/cortex');
  ok('seeded cortex override survived transfer', bCortex.models.find((m) => m.consumer === 'extract')?.effective === 'opus',
    JSON.stringify(bCortex.models?.find((m) => m.consumer === 'extract')));
} catch (err) {
  console.error('e2e-p14 fatal:', err.message);
  console.error((logA + logB).slice(-3000));
  failures++;
} finally {
  a?.kill(); b?.kill();
  try { fs.rmSync(bundlePath, { force: true }); } catch {}
}

console.log(failures === 0 ? '\ne2e-p14 PASS' : `\ne2e-p14 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
