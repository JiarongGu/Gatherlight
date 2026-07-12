#!/usr/bin/env node
// e2e P4 — knowledge-base seeder: fresh empty data folder scaffolds fully (seed commit),
// user-modified files survive upgrades, template changes upgrade untouched files.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p4-data');
const PORT = 5394;
const base = `http://127.0.0.1:${PORT}`;
const binTemplate = path.join(repo, 'src', 'server', 'Gatherlight.Server', 'bin', 'Debug', 'net10.0', 'Assets', 'DataTemplate');

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
};

const bootServer = () => spawn('dotnet', ['run', '--project', 'src/server/Gatherlight.Server', '--no-build'], {
  cwd: repo,
  env: {
    ...process.env,
    GATHERLIGHT_DATA: dataDir,
    GATHERLIGHT_PORT: String(PORT),
    GATHERLIGHT_CLAUDE_CMD: `node ${path.join(repo, 'devtools', 'scripts', 'claude-stub.mjs')}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const until = async (fn, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fn(); if (r) return r; } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
};
const j = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const stop = (server) => new Promise((r) => { server.on('exit', r); server.kill(); });
const gitLog = () =>
  execFileSync('git', ['-C', dataDir, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);

// pick a template rule file to play with
const ruleRel = '.claude/rules/absolute-dates.md';
const binRuleAbs = path.join(binTemplate, ...ruleRel.split('/'));
const dataRuleAbs = path.join(dataDir, ...ruleRel.split('/'));
let savedTemplateBytes = null;

let server = null;
try {
  if (!fs.existsSync(binTemplate)) throw new Error(`template not in build output: ${binTemplate} — run dotnet build`);

  // --- boot 1: brand-new EMPTY data folder --------------------------------------------
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  server = bootServer();
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));

  ok('CLAUDE.md scaffolded', fs.existsSync(path.join(dataDir, 'CLAUDE.md')));
  ok('rules scaffolded', fs.existsSync(dataRuleAbs));
  const status1 = await j('/api/zhiku/status');
  ok('status reports seeded files', status1.body?.seeded?.length > 10, JSON.stringify(status1.body)?.slice(0, 200));
  ok('no skips on fresh folder', (status1.body?.skipped?.length ?? 0) === 0);
  ok('seed commit in data repo', gitLog().some((l) => l.includes('zhiku: seed')));
  const plans1 = await j('/api/plans');
  ok('seeded zhiku indexed', plans1.body.files.some((f) => f.category === 'Rules'));
  await stop(server); server = null;

  // --- boot 2: user modifies a seeded rule → never overwritten -------------------------
  fs.appendFileSync(dataRuleAbs, '\n<!-- user customization -->\n');
  server = bootServer();
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));
  const status2 = await j('/api/zhiku/status');
  ok('modified rule reported skipped', status2.body?.skipped?.includes(ruleRel), JSON.stringify(status2.body?.skipped));
  ok('modified rule content intact', fs.readFileSync(dataRuleAbs, 'utf8').includes('user customization'));
  await stop(server); server = null;

  // --- boot 3: template ships an update → untouched files upgrade, modified stay -------
  savedTemplateBytes = fs.readFileSync(binRuleAbs);
  const claudeMdBin = path.join(binTemplate, 'CLAUDE.md');
  const savedClaudeMd = fs.readFileSync(claudeMdBin);
  fs.appendFileSync(binRuleAbs, '\n<!-- template v2 -->\n');       // modified locally → must NOT apply
  fs.appendFileSync(claudeMdBin, '\n<!-- template v2 -->\n');      // untouched locally → must apply
  server = bootServer();
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));
  const status3 = await j('/api/zhiku/status');
  ok('untouched file upgraded', status3.body?.upgraded?.includes('CLAUDE.md'), JSON.stringify(status3.body));
  ok('modified file still skipped', status3.body?.skipped?.includes(ruleRel));
  ok('upgrade landed on disk', fs.readFileSync(path.join(dataDir, 'CLAUDE.md'), 'utf8').includes('template v2'));
  ok('user file untouched by upgrade', !fs.readFileSync(dataRuleAbs, 'utf8').includes('template v2'));
  await stop(server); server = null;
  fs.writeFileSync(binRuleAbs, savedTemplateBytes); savedTemplateBytes = null;
  fs.writeFileSync(claudeMdBin, savedClaudeMd);
} catch (err) {
  console.error('e2e-p4 fatal:', err.message);
  failures++;
} finally {
  if (server) server.kill();
  if (savedTemplateBytes) fs.writeFileSync(binRuleAbs, savedTemplateBytes);
}

console.log(failures === 0 ? '\ne2e-p4 PASS' : `\ne2e-p4 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
