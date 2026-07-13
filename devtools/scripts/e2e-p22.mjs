#!/usr/bin/env node
// e2e P22 — full-text search (FTS5 trigram) for the knowledge library + fact store. Verifies
// BM25-ranked matching on Latin + CJK (trigram substring), the <3-char LIKE fallback, and that the
// sync triggers keep the FTS index correct across update + delete.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p22-data');
const PORT = 5471;
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
};

spawnSync('node', [path.join(repo, 'devtools', 'scripts', 'make-test-data.mjs'), dataDir], { stdio: 'inherit' });

const server = spawn('dotnet', ['run', '--project', 'src/server/Gatherlight.Server', '--no-build'], {
  cwd: repo,
  env: { ...process.env, GATHERLIGHT_DATA: dataDir, GATHERLIGHT_PORT: String(PORT), GATHERLIGHT_CLAUDE_CMD: `node ${path.join(repo, 'devtools', 'scripts', 'claude-stub.mjs')}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

const until = async (fn, ms = 30000) => {
  const t0 = Date.now();
  for (;;) { try { const r = await fn(); if (r) return r; } catch {} if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 250)); }
};
const call = async (name, args) => {
  const res = await fetch(`${base}/api/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
  const b = await res.json().catch(() => null);
  return b?.result ? JSON.parse(b.result) : b;
};
const lib = async (q) => (await (await fetch(`${base}/api/library?q=${encodeURIComponent(q)}&limit=50`)).json()).items;
const keys = (items) => items.map((i) => i.key);

try {
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));

  // seed the library (CJK + Latin)
  await call('library_upsert', { kind: 'attraction', key: 'kinkakuji', name: 'Kinkaku-ji', nameLocal: '金阁寺', region: 'Kyoto, Japan', summary: 'The Golden Pavilion, a famous Zen temple.', tags: 'temple,zen', confidence: 0.9 });
  await call('library_upsert', { kind: 'attraction', key: 'fushimi', name: 'Fushimi Inari', nameLocal: '伏见稻荷大社', region: 'Kyoto, Japan', summary: 'Famous for thousands of vermilion torii gates.', tags: 'shrine,torii', confidence: 0.8 });
  await call('library_upsert', { kind: 'restaurant', key: 'diner', name: 'Sushi Diner', region: 'Tokyo, Japan', summary: 'A casual sushi spot.', tags: 'sushi', confidence: 0.7 });

  ok('FTS Latin ≥3: "temple" → kinkakuji (summary match)', keys(await lib('temple')).includes('kinkakuji'));
  ok('FTS Latin ≥3: "torii" → fushimi (summary/tags match)', keys(await lib('torii')).includes('fushimi'));
  ok('FTS CJK trigram ≥3: "金阁寺" → kinkakuji (nameLocal substring)', keys(await lib('金阁寺')).includes('kinkakuji'));
  ok('LIKE fallback <3 chars: "金阁" → kinkakuji', keys(await lib('金阁')).includes('kinkakuji'));
  ok('FTS misses unrelated: "temple" excludes the sushi diner', !keys(await lib('temple')).includes('diner'));

  // update trigger: change the summary so it no longer contains "temple", add "pagoda"
  await call('library_upsert', { kind: 'attraction', key: 'kinkakuji', name: 'Kinkaku-ji', nameLocal: '金阁寺', region: 'Kyoto, Japan', summary: 'The Golden Pavilion, a lakeside gilded pagoda.', tags: 'zen', confidence: 0.9 });
  ok('update trigger: "temple" no longer matches kinkakuji', !keys(await lib('temple')).includes('kinkakuji'));
  ok('update trigger: "pagoda" now matches kinkakuji', keys(await lib('pagoda')).includes('kinkakuji'));

  // delete trigger: removing the diner drops it from the FTS index
  const del = await call('library_delete', { kind: 'restaurant', key: 'diner' });
  ok('library_delete ok', del && del.deleted !== false, JSON.stringify(del));
  ok('delete trigger: "sushi" returns nothing', keys(await lib('sushi')).length === 0);

  // fact store FTS
  await call('remember_fact', { kind: 'venue-url', topic: 'Kinkaku-ji official site', content: 'https://www.shokoku-ji.jp opening hours 09:00-17:00 verified', source: 'https://www.shokoku-ji.jp', confidence: 0.95 });
  await call('remember_fact', { kind: 'policy', topic: '日本签证政策', content: '中国护照赴日需办理短期签证,有效期视类型而定。', source: 'https://mofa.go.jp', confidence: 0.9 });
  const r1 = await call('recall_facts', { query: 'opening hours' });
  ok('facts FTS Latin: "opening hours" recalls the venue fact', (r1.facts ?? []).some((f) => f.topic.includes('Kinkaku-ji')), JSON.stringify((r1.facts ?? []).map((f) => f.topic)));
  const r2 = await call('recall_facts', { query: '签证政策' });
  ok('facts FTS CJK trigram: "签证政策" recalls the visa fact', (r2.facts ?? []).some((f) => f.topic.includes('签证')));
} catch (err) {
  console.error('e2e-p22 fatal:', err.message);
  console.error(log.slice(-3000));
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? '\ne2e-p22 PASS' : `\ne2e-p22 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
