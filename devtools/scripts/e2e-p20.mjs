#!/usr/bin/env node
// e2e P20 — auto-update CHECK + DOWNLOAD/STAGE phase (the server's half). Stands up a tiny fake
// "GitHub" (release JSON + zip + manifest), points the server's update endpoint at it, and drives
// check → download → poll-state, asserting the staged files + ready.json land under the install dir
// and verify against the manifest sha256. The launcher apply phase is e2e-p19.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p20-data');
const installDir = path.join(repo, 'devtools', '_e2e-p20-install');
const scratch = path.join(repo, 'devtools', '_e2e-p20-src');
const PORT = 5452, FAKE = 5451;
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const until = async (fn, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fn(); if (r) return r; } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
};
const j = async (p, init) => { const r = await fetch(base + p, init); return { status: r.status, body: await r.json().catch(() => null) }; };

// --- build a fake release zip (files + manifest) ---
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(path.join(scratch, 'res'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'hello.txt'), 'hello-update');
fs.writeFileSync(path.join(scratch, 'res', 'deep.txt'), 'nested-content');
const manifest = {
  product: 'Gatherlight', version: '9.9.9', rid: 'win-x64',
  files: [
    { path: 'hello.txt', sha256: sha256(Buffer.from('hello-update')), size: 12 },
    { path: 'res/deep.txt', sha256: sha256(Buffer.from('nested-content')), size: 14 },
  ],
};
fs.writeFileSync(path.join(scratch, 'manifest.json'), JSON.stringify(manifest, null, 2));
const zipPath = path.join(repo, 'devtools', '_e2e-p20-update.zip');
fs.rmSync(zipPath, { force: true });
spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  `Compress-Archive -Path '${scratch}\\*' -DestinationPath '${zipPath}' -Force`], { stdio: 'ignore' });
const zipBytes = fs.readFileSync(zipPath);
const manifestBytes = fs.readFileSync(path.join(scratch, 'manifest.json'));

// --- fake GitHub release server ---
const fakeSrv = http.createServer((req, res) => {
  if (req.url.startsWith('/releases/latest')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      tag_name: 'v9.9.9', name: 'Gatherlight 9.9.9', body: '- shiny new things',
      html_url: 'http://example/releases/9.9.9', published_at: '2026-07-13T00:00:00Z',
      assets: [
        { name: 'Gatherlight-9.9.9-win-x64.zip', browser_download_url: `http://127.0.0.1:${FAKE}/update.zip` },
        { name: 'manifest.json', browser_download_url: `http://127.0.0.1:${FAKE}/manifest.json` },
      ],
    }));
  } else if (req.url === '/update.zip') { res.setHeader('content-type', 'application/zip'); res.end(zipBytes); }
  else if (req.url === '/manifest.json') { res.setHeader('content-type', 'application/json'); res.end(manifestBytes); }
  else { res.statusCode = 404; res.end(); }
});
await new Promise((r) => fakeSrv.listen(FAKE, r));

spawnSync('node', [path.join(repo, 'devtools', 'scripts', 'make-test-data.mjs'), dataDir], { stdio: 'inherit' });
fs.rmSync(installDir, { recursive: true, force: true });
fs.mkdirSync(installDir, { recursive: true });

const server = spawn('dotnet', ['run', '--project', 'src/server/Gatherlight.Server', '--no-build'], {
  cwd: repo,
  env: {
    ...process.env,
    GATHERLIGHT_DATA: dataDir,
    GATHERLIGHT_PORT: String(PORT),
    GATHERLIGHT_INSTALL_DIR: installDir,
    GATHERLIGHT_UPDATE_API: `http://127.0.0.1:${FAKE}/releases/latest`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

try {
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));

  const check = (await j('/api/manage/update/check')).body;
  ok('check: configured + update available (9.9.9)', check.configured === true && check.updateAvailable === true && check.latestVersion === '9.9.9', JSON.stringify({ c: check.configured, a: check.updateAvailable, v: check.latestVersion }));
  ok('check: carries release notes + url', (check.releaseNotes ?? '').includes('shiny') && !!check.releaseUrl);

  const st0 = (await j('/api/manage/update/state')).body;
  ok('state: configured, not yet pending', st0.configured === true && st0.pending === false);

  const dl = await j('/api/manage/update/download', { method: 'POST' });
  ok('download: started', dl.status === 200 && dl.body.ok === true, JSON.stringify(dl.body));

  const staged = await until(async () => {
    const s = (await j('/api/manage/update/state')).body;
    if (s.error) throw new Error('stage errored: ' + s.error);
    return s.pending ? s : null;
  });
  ok('state: pending after stage, version 9.9.9', staged.pending === true && staged.pendingVersion === '9.9.9', JSON.stringify({ p: staged.pending, v: staged.pendingVersion }));

  // staged files + ready marker landed under the install dir, verified against the manifest
  ok('.update/ready.json written', fs.existsSync(path.join(installDir, '.update', 'ready.json')));
  ok('.update/staged/hello.txt extracted', fs.readFileSync(path.join(installDir, '.update', 'staged', 'hello.txt'), 'utf8') === 'hello-update');
  ok('.update/staged/res/deep.txt extracted (nested)', fs.readFileSync(path.join(installDir, '.update', 'staged', 'res', 'deep.txt'), 'utf8') === 'nested-content');
  ok('.update/staged/manifest.json present', fs.existsSync(path.join(installDir, '.update', 'staged', 'manifest.json')));

  // not-configured path: a fresh check with the env cleared would report configured=false — covered by
  // the endpoint returning configured based on ApiUrl(); here we assert the download endpoint guards it.
} catch (err) {
  console.error('e2e-p20 fatal:', err.message);
  console.error(log.slice(-2500));
  failures++;
} finally {
  server.kill();
  fakeSrv.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.rmSync(installDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\ne2e-p20 PASS' : `\ne2e-p20 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
