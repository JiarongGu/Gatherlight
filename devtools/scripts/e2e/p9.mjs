#!/usr/bin/env node
// e2e P9 — zero-LLM budget scan: declared caps/totals surfaced, excluded/rejected lines flagged,
// per-currency mention counts, honest (no fabricated net total); budget_scan tool on both surfaces.
import path from 'node:path';
import fs from 'node:fs';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient } from './_e2e-common.mjs';

const dataDir = dataDirFor('p9');
const { ok, fail, done } = makeReporter('p9');

makeTestData(dataDir);

// Controlled budget fixture: a declared cap, a per-person line (both per + total figures), a
// rejected/excluded option, and a JPY conversion.
fs.writeFileSync(path.join(dataDir, 'plans', 'budgets', '2026-08-kyoto.md'), [
  '# 京都预算(fixture)', '',
  '| Total cap (planning) | AUD 5,000 ← 软上限 |',
  '| 机票 | AUD 700/per × 3 = AUD 2,100 |',
  '| 酒店 | JPY 120,000 (~AUD 1,200) |',
  '| 备选(拒选) | AUD 9,999 |',   // must be flagged excluded, not in declared totals
  '',
].join('\n'));

const srv = startServer({ dataDir, port: 5399 });
const { j, call } = makeClient(srv.base);

try {
  await waitHealthy(srv.base);

  const r = await j('/api/plans/budget?path=plans/budgets/2026-08-kyoto.md');
  ok('budget scan 200', r.status === 200);
  const b = r.body;

  // declared cap surfaced
  ok('declares the cap (AUD 5000)', b.declaredTotals.some((f) => f.currency === 'AUD' && f.amount === 5000));
  // rejected option NOT in declared totals
  ok('rejected option not a declared total', !b.declaredTotals.some((f) => f.amount === 9999));
  // rejected option flagged excluded in the full list
  const rej = b.allFigures.find((f) => f.amount === 9999);
  ok('rejected option flagged excluded', rej?.excluded === true);
  // AUD figures = 5000, 700, 2100, 1200 (conversion), 9999 = 5; JPY = 120000 = 1
  ok('AUD mention count = 5 (incl. conversion)', b.mentionCounts.AUD === 5, `got ${b.mentionCounts.AUD}`);
  ok('JPY mention count = 1', b.mentionCounts.JPY === 1, `got ${b.mentionCounts.JPY}`);
  // honest: no top-level "total"/"net" field fabricated
  ok('no fabricated net total field', b.net === undefined && b.total === undefined);

  // guards
  const none = await j('/api/plans/budget?path=household/people.md');
  ok('no-money plan → 404', none.status === 404);

  // tool surfaces
  const tools = await j('/api/tools');
  ok('budget_scan tool registered (HTTP)', tools.body.tools.some((t) => t.name === 'budget_scan'));
  const scan = await call('budget_scan', { path: 'plans/budgets/2026-08-kyoto.md' });
  ok('budget_scan tool runs', scan.status === 200 && scan.result.totalMentions === 6, `mentions ${scan.result?.totalMentions}`);
  ok('budget_scan carries honesty note', typeof scan.result.note === 'string' && scan.result.note.includes('不是净额合计'));
  const mcp = await (await fetch(`${srv.base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })).json();
  ok('budget_scan on MCP', mcp.result.tools.some((t) => t.name === 'budget_scan'));
} catch (err) {
  fail('e2e-p9 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
