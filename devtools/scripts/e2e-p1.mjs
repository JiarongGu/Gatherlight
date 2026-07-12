#!/usr/bin/env node
// e2e P1 — read side: plan index, content, search, assets, fs ops (retitle/rename/delete),
// data-repo auto-commits, traversal + scope guards. Self-hosts the server on an isolated
// fixture data folder; exits 0/1.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p1-data');
const PORT = 5391;
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
};

// --- fixture + server ---------------------------------------------------------------
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
    await new Promise((r) => setTimeout(r, 300));
  }
};

const j = async (p, init) => {
  const res = await fetch(base + p, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const gitLog = () =>
  execFileSync('git', ['-C', dataDir, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);

try {
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));
  console.log('server up');

  // --- index ---
  const plans = await j('/api/plans');
  ok('GET /api/plans 200', plans.status === 200);
  const trip = plans.body.files.find((f) => f.path === 'plans/trips/2026-08-kyoto.md');
  ok('trip indexed', !!trip);
  ok('trip category/subgroup', trip?.category === 'Trips' && trip?.subgroup === 'kyoto');
  ok('trip title from H1', (trip?.title ?? '').includes('京都'));
  ok('trip planDate', trip?.planDate === '2026-08');
  const tmpl = plans.body.files.find((f) => f.path === '.claude/templates/trip.md');
  ok('zhiku template indexed', tmpl?.category === 'Templates');
  const asset = plans.body.assets.find((a) => a.path === 'plans/visa/2026-08-kyoto/applicant-data.json');
  ok('visa asset indexed', asset?.slug === '2026-08-kyoto' && asset?.kind === 'json');

  // --- content + asset + search ---
  const content = await j('/api/plans/content?path=plans/trips/2026-08-kyoto.md');
  ok('content fetch', content.status === 200 && content.body.content.includes('Hotel Fixture Kyoto'));
  const assetRes = await fetch(`${base}${asset.url}`);
  ok('asset fetch', assetRes.status === 200 && (await assetRes.json()).applicationDate.year === '2026');
  const search = await j('/api/plans/search?q=' + encodeURIComponent('京都'));
  ok('search hits', search.status === 200 && search.body.results.length >= 2);

  // --- guards ---
  const traversal = await j('/api/plans/content?path=../CLAUDE.md');
  ok('traversal guarded', traversal.status === 404 || traversal.status === 400);
  const scope = await j('/api/fs/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: ['.claude/templates/trip.md'] }),
  });
  ok('fs scope guard (.claude blocked)', scope.status === 400);

  // --- fs ops + auto-commit ---
  const commitsBefore = gitLog().length;
  const retitle = await j('/api/fs/retitle', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'plans/trips/2026-08-kyoto.md', title: '京都 5 天 v2(fixture)' }),
  });
  ok('retitle 200 + sha', retitle.status === 200 && !!retitle.body.sha);
  ok('retitle committed', gitLog().length === commitsBefore + 1);
  const afterRetitle = await j('/api/plans');
  const tripV2 = afterRetitle.body.files.find((f) => f.path === 'plans/trips/2026-08-kyoto.md');
  ok('index reflects new title', (tripV2?.title ?? '').includes('v2'));

  const rename = await j('/api/fs/rename', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ renames: [{ from: 'plans/budgets/2026-08-kyoto.md', to: 'plans/budgets/2026-09-kyoto.md' }] }),
  });
  ok('rename 200', rename.status === 200 && !!rename.body.sha);
  const afterRename = await j('/api/plans');
  ok('index reflects rename',
    !afterRename.body.files.some((f) => f.path === 'plans/budgets/2026-08-kyoto.md') &&
    afterRename.body.files.some((f) => f.path === 'plans/budgets/2026-09-kyoto.md'));

  const del = await j('/api/fs/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: ['plans/budgets/2026-09-kyoto.md'] }),
  });
  ok('delete 200', del.status === 200 && !!del.body.sha);
  const afterDelete = await j('/api/plans');
  ok('index reflects delete', !afterDelete.body.files.some((f) => f.path.startsWith('plans/budgets/')));
} catch (err) {
  console.error('e2e-p1 fatal:', err.message);
  console.error(serverLog.slice(-3000));
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? '\ne2e-p1 PASS' : `\ne2e-p1 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
