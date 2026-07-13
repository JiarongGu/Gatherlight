#!/usr/bin/env node
// e2e P9 — zero-LLM budget scan: declared caps/totals surfaced, excluded/rejected lines flagged,
// per-currency mention counts, honest (no fabricated net total); budget_scan tool on both surfaces.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p9-data');
const PORT = 5399;
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
};

spawnSync('node', [path.join(repo, 'devtools', 'scripts', 'make-test-data.mjs'), dataDir], { stdio: 'inherit' });

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
    await new Promise((r) => setTimeout(r, 300));
  }
};
const j = async (p, init) => {
  const res = await fetch(base + p, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};

try {
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));

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
  const call = await j('/api/tools/call', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'budget_scan', arguments: { path: 'plans/budgets/2026-08-kyoto.md' } }),
  });
  const parsed = JSON.parse(call.body.result);
  ok('budget_scan tool runs', call.status === 200 && parsed.totalMentions === 6, `mentions ${parsed?.totalMentions}`);
  ok('budget_scan carries honesty note', typeof parsed.note === 'string' && parsed.note.includes('不是净额合计'));
  const mcp = await (await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })).json();
  ok('budget_scan on MCP', mcp.result.tools.some((t) => t.name === 'budget_scan'));
} catch (err) {
  console.error('e2e-p9 fatal:', err.message);
  console.error(serverLog.slice(-3000));
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? '\ne2e-p9 PASS' : `\ne2e-p9 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
