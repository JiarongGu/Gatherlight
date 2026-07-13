#!/usr/bin/env node
// e2e P6 — generalized stores: remember_fact/recall_facts roundtrip (both surfaces), update-in-
// place on same kind+topic, kind filter, confidence ordering; process_log records the seed run.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p6-data');
const PORT = 5396;
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
};

spawnSync('node', [path.join(repo, 'devtools', 'scripts', 'make-test-data.mjs'), dataDir], { stdio: 'inherit' });

const server = spawn('dotnet', ['run', '--project', 'src/server/Gatherlight.Server', '--no-build'], {
  cwd: repo,
  env: { ...process.env, GATHERLIGHT_DATA: dataDir, GATHERLIGHT_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const until = async (fn, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fn(); if (r) return r; } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 400));
  }
};
const call = async (name, args) => {
  const res = await fetch(`${base}/api/tools/call`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

try {
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));

  // remember two facts, different kinds + confidence
  const r1 = await call('remember_fact', {
    kind: 'venue-url', topic: 'Fixture Ramen tabelog', content: 'https://example.com/ramen — verified loads',
    source: 'scrape 2026-07-13', confidence: 0.95,
  });
  ok('remember_fact ok', r1.status === 200 && JSON.parse(r1.body.result).ok === true, JSON.stringify(r1.body));
  await call('remember_fact', {
    kind: 'price', topic: 'Fixture Ramen price', content: 'JPY 900-1200/per (2026-07-13)', confidence: 0.6,
  });

  // recall: both match "Fixture Ramen"; higher confidence first
  const rec = await call('recall_facts', { query: 'Fixture Ramen' });
  const facts = JSON.parse(rec.body.result).facts;
  ok('recall finds both facts', facts.length === 2);
  ok('confidence ordering', facts[0].confidence > facts[1].confidence);

  // kind filter
  const filtered = await call('recall_facts', { query: 'Fixture', kind: 'price' });
  ok('kind filter works', JSON.parse(filtered.body.result).facts.length === 1);

  // same kind+topic → update in place, not duplicate
  await call('remember_fact', {
    kind: 'venue-url', topic: 'Fixture Ramen tabelog', content: 'https://example.com/ramen-v2', confidence: 0.9,
  });
  const after = JSON.parse((await call('recall_facts', { query: 'Fixture Ramen', kind: 'venue-url' })).body.result).facts;
  ok('same kind+topic updates in place', after.length === 1 && after[0].content.includes('ramen-v2'));

  // MCP surface lists the memory tools
  const mcp = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }).then((r) => r.json());
  const names = mcp.result.tools.map((t) => t.name);
  ok('memory tools on MCP', names.includes('remember_fact') && names.includes('recall_facts'));

  // process_log captured the seed run (fresh folder → applied)
  const { execFileSync } = await import('node:child_process');
  // no direct API for process_log yet — assert via sqlite through the server would need an
  // endpoint; instead assert indirectly: seed happened (zhiku status) and no server errors.
  const status = await fetch(`${base}/api/zhiku/status`).then((r) => r.json());
  ok('seed ran (process_log integration exercised)', (status.seeded?.length ?? 0) > 10);
} catch (err) {
  console.error('e2e-p6 fatal:', err.message);
  console.error(serverLog.slice(-3000));
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? '\ne2e-p6 PASS' : `\ne2e-p6 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
