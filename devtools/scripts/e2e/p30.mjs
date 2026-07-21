#!/usr/bin/env node
// e2e P30 — differential auto-update. A mock "GitHub" serves a release zip WITH HTTP Range support and
// counts what it serves. Scenario 1 (delta): an installed manifest matching all-but-one file → only the
// changed file's ranges are fetched (never the whole zip), staged correctly, ready.json written.
// Scenario 2 (fallback): the mock refuses Range → the updater falls back to the full download.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { repo, dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, until } from './_e2e-common.mjs';

const dataDir = dataDirFor('p30');
const installDir = path.join(repo, 'devtools', '_e2e-p30-install');
// Name the src folder "Gatherlight" so Compress-Archive of the FOLDER wraps entries under Gatherlight/
// — exercising RemoteZip.StripSingleRoot exactly like the production bundle.
const src = path.join(repo, 'devtools', '_e2e-p30-src', 'Gatherlight');
const zipPath = path.join(repo, 'devtools', '_e2e-p30-update.zip');
const PORT = 5455, FAKE = 5456;
const { ok, fail, done } = makeReporter('p30');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// --- build a release bundle: app.txt (will change) + big.bin (unchanged, must NOT be refetched) + res/deep.txt (unchanged) ---
fs.rmSync(path.dirname(src), { recursive: true, force: true });
fs.mkdirSync(path.join(src, 'res'), { recursive: true });
const appNew = 'app v9.9.9 new';
// INCOMPRESSIBLE + larger than RemoteZip's ~64 KB central-directory tail read, so a delta that fetches
// only app.txt transfers far less than the whole zip. (alloc-with-a-constant deflates to ~nothing, which
// makes the zip sub-64KB and the tail read grab the whole thing — masking the saving.)
const big = crypto.randomBytes(300 * 1024);
const deep = 'nested-unchanged';
fs.writeFileSync(path.join(src, 'app.txt'), appNew);
fs.writeFileSync(path.join(src, 'big.bin'), big);
fs.writeFileSync(path.join(src, 'res', 'deep.txt'), deep);
const newManifest = {
  product: 'Gatherlight', version: '9.9.9', rid: 'win-x64',
  files: [
    { path: 'app.txt', sha256: sha256(Buffer.from(appNew)), size: appNew.length },
    { path: 'big.bin', sha256: sha256(big), size: big.length },
    { path: 'res/deep.txt', sha256: sha256(Buffer.from(deep)), size: deep.length },
  ],
};
fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify(newManifest, null, 2));
fs.rmSync(zipPath, { force: true });
spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  `Compress-Archive -Path '${src}' -DestinationPath '${zipPath}' -Force`], { stdio: 'ignore' });
const zipBytes = fs.readFileSync(zipPath);
const manifestBytes = Buffer.from(JSON.stringify(newManifest));

// --- mock GitHub: release JSON + manifest + zip (Range-aware, counting) ---
let supportRange = true;
let fullZipServes = 0;      // count of whole-zip (non-range) responses
let rangeBytes = 0;         // total bytes served via range
const mock = http.createServer((req, res) => {
  if (req.url.startsWith('/releases/latest')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      tag_name: 'v9.9.9', name: 'Gatherlight 9.9.9', body: 'delta test',
      html_url: 'http://example/9.9.9', published_at: '2026-07-22T00:00:00Z',
      assets: [
        { name: 'Gatherlight-9.9.9-win-x64.zip', browser_download_url: `http://127.0.0.1:${FAKE}/update.zip` },
        { name: 'manifest.json', browser_download_url: `http://127.0.0.1:${FAKE}/manifest.json` },
      ],
    }));
  } else if (req.url === '/manifest.json') {
    res.setHeader('content-type', 'application/json'); res.end(manifestBytes);
  } else if (req.url === '/update.zip') {
    const range = supportRange ? req.headers.range : undefined;
    if (range && /^bytes=\d+-\d+$/.test(range)) {
      const [s, e] = range.slice(6).split('-').map(Number);
      const slice = zipBytes.subarray(s, e + 1);
      rangeBytes += slice.length;
      res.statusCode = 206;
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('content-range', `bytes ${s}-${e}/${zipBytes.length}`);
      res.setHeader('content-length', slice.length);
      res.end(slice);
    } else {
      fullZipServes++;
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-length', zipBytes.length);
      res.end(zipBytes);
    }
  } else { res.statusCode = 404; res.end(); }
});
await new Promise((r) => mock.listen(FAKE, r));

makeTestData(dataDir);
fs.rmSync(installDir, { recursive: true, force: true });
fs.mkdirSync(installDir, { recursive: true });
// Installed manifest: big.bin + res/deep.txt already match the new release; app.txt has the OLD hash.
const installedManifest = {
  product: 'Gatherlight', version: '9.9.8', rid: 'win-x64',
  files: [
    { path: 'app.txt', sha256: sha256(Buffer.from('app v9.9.8 OLD')), size: 13 },
    { path: 'big.bin', sha256: sha256(big), size: big.length },
    { path: 'res/deep.txt', sha256: sha256(Buffer.from(deep)), size: deep.length },
  ],
};
fs.writeFileSync(path.join(installDir, 'manifest.json'), JSON.stringify(installedManifest));

const srv = startServer({
  dataDir, port: PORT,
  env: { GATHERLIGHT_INSTALL_DIR: installDir, GATHERLIGHT_UPDATE_API: `http://127.0.0.1:${FAKE}/releases/latest` },
});
const { j } = makeClient(srv.base);

const stagedDir = path.join(installDir, '.update', 'staged');
const triggerDownload = async () => {
  await j('/api/manage/update/download', { method: 'POST' });
  return until(async () => {
    const s = (await j('/api/manage/update/state')).body;
    if (s.error) throw new Error('stage errored: ' + s.error);
    return s.pending ? s : null;
  });
};

try {
  await waitHealthy(srv.base);

  // --- Scenario 1: DELTA — only app.txt should transfer ------------------------------------
  const st1 = await triggerDownload();
  ok('delta: pending 9.9.9', st1.pending === true && st1.pendingVersion === '9.9.9', JSON.stringify(st1));
  ok('delta: whole zip never served', fullZipServes === 0, `fullZipServes=${fullZipServes}`);
  // The delta transfers app.txt's small entry + RemoteZip's ~64 KB central-directory tail read — far less
  // than the ~300 KB+ incompressible zip. (Threshold at half the zip: a genuine saving, not the whole thing.)
  ok('delta: bytes served << full zip', rangeBytes < zipBytes.length / 2, `rangeBytes=${rangeBytes} zip=${zipBytes.length}`);
  ok('delta: app.txt staged with new content', fs.existsSync(path.join(stagedDir, 'app.txt')) && fs.readFileSync(path.join(stagedDir, 'app.txt'), 'utf8') === appNew);
  ok('delta: big.bin NOT staged (unchanged)', !fs.existsSync(path.join(stagedDir, 'big.bin')));
  ok('delta: res/deep.txt NOT staged (unchanged)', !fs.existsSync(path.join(stagedDir, 'res', 'deep.txt')));
  ok('delta: new manifest staged', fs.existsSync(path.join(stagedDir, 'manifest.json')));
  ok('delta: ready.json written', fs.existsSync(path.join(installDir, '.update', 'ready.json')));

  // --- Scenario 2: FALLBACK — mock refuses Range → full download stages everything -----------
  fs.rmSync(path.join(installDir, '.update'), { recursive: true, force: true });
  supportRange = false; fullZipServes = 0; rangeBytes = 0;
  const st2 = await triggerDownload();
  ok('fallback: pending 9.9.9', st2.pending === true && st2.pendingVersion === '9.9.9');
  ok('fallback: whole zip served once', fullZipServes >= 1, `fullZipServes=${fullZipServes}`);
  ok('fallback: all files staged', ['app.txt', 'big.bin', 'res/deep.txt'].every((p) => fs.existsSync(path.join(stagedDir, p.replace('/', path.sep)))));
  ok('fallback: manifest staged + ready.json', fs.existsSync(path.join(stagedDir, 'manifest.json')) && fs.existsSync(path.join(installDir, '.update', 'ready.json')));
} catch (err) {
  fail('e2e-p30 fatal: ' + err.message);
  console.error(srv.log().slice(-2500));
} finally {
  srv.stop();
  mock.close();
  fs.rmSync(path.dirname(src), { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.rmSync(installDir, { recursive: true, force: true });
}
done();
