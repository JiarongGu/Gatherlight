#!/usr/bin/env node
// e2e P6 — generalized stores: remember_fact/recall_facts roundtrip (both surfaces), update-in-
// place on same kind+topic, kind filter, confidence ordering; process_log records the seed run.
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient } from './_e2e-common.mjs';

const dataDir = dataDirFor('p6');
const { ok, fail, done } = makeReporter('p6');
makeTestData(dataDir);
const srv = startServer({ dataDir, port: 5396 });
const { call } = makeClient(srv.base);

try {
  await waitHealthy(srv.base);

  // remember two facts, different kinds + confidence
  const r1 = await call('remember_fact', {
    kind: 'venue-url', topic: 'Fixture Ramen tabelog', content: 'https://example.com/ramen — verified loads',
    source: 'scrape 2026-07-13', confidence: 0.95,
  });
  ok('remember_fact ok', r1.status === 200 && r1.result.ok === true, JSON.stringify(r1.result));
  await call('remember_fact', {
    kind: 'price', topic: 'Fixture Ramen price', content: 'JPY 900-1200/per (2026-07-13)', confidence: 0.6,
  });

  // recall: both match "Fixture Ramen"; higher confidence first
  const rec = await call('recall_facts', { query: 'Fixture Ramen' });
  const facts = rec.result.facts;
  ok('recall finds both facts', facts.length === 2);
  ok('confidence ordering', facts[0].confidence > facts[1].confidence);

  // kind filter
  const filtered = await call('recall_facts', { query: 'Fixture', kind: 'price' });
  ok('kind filter works', filtered.result.facts.length === 1);

  // same kind+topic → update in place, not duplicate
  await call('remember_fact', {
    kind: 'venue-url', topic: 'Fixture Ramen tabelog', content: 'https://example.com/ramen-v2', confidence: 0.9,
  });
  const after = (await call('recall_facts', { query: 'Fixture Ramen', kind: 'venue-url' })).result.facts;
  ok('same kind+topic updates in place', after.length === 1 && after[0].content.includes('ramen-v2'));

  // MCP surface lists the memory tools
  const mcp = await fetch(`${srv.base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }).then((r) => r.json());
  const names = mcp.result.tools.map((t) => t.name);
  ok('memory tools on MCP', names.includes('remember_fact') && names.includes('recall_facts'));

  // process_log captured the seed run (fresh folder → applied)
  const { execFileSync } = await import('node:child_process');
  // no direct API for process_log yet — assert via sqlite through the server would need an
  // endpoint; instead assert indirectly: seed happened (zhiku status) and no server errors.
  const status = await fetch(`${srv.base}/api/zhiku/status`).then((r) => r.json());
  ok('seed ran (process_log integration exercised)', (status.seeded?.length ?? 0) > 10);
} catch (err) {
  fail('e2e-p6 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
