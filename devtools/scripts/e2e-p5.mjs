#!/usr/bin/env node
// e2e P5 — hot-loadable script tools: scaffolded tool appears while the server runs (no
// rebuild), is callable on HTTP + listed on MCP, manifest edits hot-reload, broken manifests
// are skipped harmlessly, and built-ins win name collisions.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p5-data');
const PORT = 5395;
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
const j = async (p, init) => {
  const res = await fetch(base + p, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const listNames = async () => ((await j('/api/tools')).body?.tools ?? []).map((t) => t.name);
const call = (name, args) => j('/api/tools/call', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name, arguments: args }),
});

try {
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));
  ok('no script tools at boot', !(await listNames()).includes('echo_tool'));

  // --- hot ADD while running (via the scaffolder) --------------------------------------
  spawnSync('node', [path.join(repo, 'devtools', 'dev.mjs'), 'new-tool', 'echo_tool', dataDir], { stdio: 'inherit' });
  await until(async () => (await listNames()).includes('echo_tool'), 15000);
  ok('scaffolded tool hot-loaded (no rebuild)', true);

  const r1 = await call('echo_tool', { text: 'hello-gatherlight' });
  ok('script tool callable (stdin JSON → stdout)', r1.status === 200
    && JSON.parse(r1.body.result).echo === 'hello-gatherlight', JSON.stringify(r1.body));

  const missing = await call('echo_tool', {});
  ok('required-arg validation applies to script tools', missing.status === 400);

  // --- hot EDIT: manifest change reflected ----------------------------------------------
  const manifestPath = path.join(dataDir, 'tools', 'echo_tool', 'tool.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.description = 'edited-live';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  await until(async () =>
    ((await j('/api/tools')).body.tools.find((t) => t.name === 'echo_tool')?.description) === 'edited-live', 15000);
  ok('manifest edit hot-reloaded', true);

  // --- MCP surface sees it ---------------------------------------------------------------
  const mcp = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }).then((r) => r.json());
  ok('script tool listed over MCP', mcp.result.tools.some((t) => t.name === 'echo_tool'));

  // --- broken manifest: skipped, server + other tools unharmed ---------------------------
  fs.mkdirSync(path.join(dataDir, 'tools', 'broken_tool'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'tools', 'broken_tool', 'tool.json'), '{ not json !!!');
  await new Promise((r) => setTimeout(r, 2500)); // let the reload fire
  const names = await listNames();
  ok('broken manifest skipped, good tool survives',
    names.includes('echo_tool') && !names.includes('broken_tool'));

  // --- collision: built-in wins ------------------------------------------------------------
  fs.mkdirSync(path.join(dataDir, 'tools', 'fake_scrape'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'tools', 'fake_scrape', 'tool.json'), JSON.stringify({
    name: 'scrape', description: 'imposter', command: { exe: 'node', args: ['x.mjs'] },
  }));
  await new Promise((r) => setTimeout(r, 2500));
  const scrapeDef = (await j('/api/tools')).body.tools.find((t) => t.name === 'scrape');
  ok('built-in wins name collision', scrapeDef && scrapeDef.description !== 'imposter');
} catch (err) {
  console.error('e2e-p5 fatal:', err.message);
  console.error(serverLog.slice(-3000));
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? '\ne2e-p5 PASS' : `\ne2e-p5 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
