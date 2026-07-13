#!/usr/bin/env node
// e2e P18 — TLS / HTTPS. Boots Kestrel with TLS on (self-signed by default), verifies the HTTPS
// handshake works, the cert is the self-signed Gatherlight one, it's persisted + reused across
// reboots, the Secure cookie flag flips under HTTPS, plaintext HTTP is refused on the TLS port, and
// a configured PFX (security.tls.certPath) is honored.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // accept the self-signed cert in the test client
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p18-data');
const pfxPath = path.join(dataDir, 'state', 'gatherlight-tls.pfx');
const P1 = 5404, P2 = 5405, P3 = 5406;
const TOKEN = 'tls-secret-9';

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
};

spawnSync('node', [path.join(repo, 'devtools', 'scripts', 'make-test-data.mjs'), dataDir], { stdio: 'inherit' });

const boot = (port, extraEnv = {}) => spawn('dotnet',
  ['run', '--project', 'src/server/Gatherlight.Server', '--no-build'],
  { cwd: repo, env: { ...process.env, GATHERLIGHT_DATA: dataDir, GATHERLIGHT_PORT: String(port), GATHERLIGHT_TLS: '1', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });

const until = async (fn, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fn(); if (r) return r; } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
};
const status = (res) => res.status;
const peerCert = (host, port) => new Promise((resolve, reject) => {
  const s = tls.connect({ host, port, rejectUnauthorized: false, servername: host }, () => {
    const c = s.getPeerCertificate();
    s.end();
    resolve(c);
  });
  s.on('error', reject);
  s.setTimeout(4000, () => { s.destroy(); reject(new Error('tls timeout')); });
});

let a = null, b = null, c = null, logs = '';
try {
  // ---------- Boot 1: TLS + token + no loopback trust ----------
  a = boot(P1, { GATHERLIGHT_ACCESS_TOKEN: TOKEN, GATHERLIGHT_TRUST_LOOPBACK: '0' });
  a.stdout.on('data', (d) => (logs += d)); a.stderr.on('data', (d) => (logs += d));
  const baseA = `https://127.0.0.1:${P1}`;
  await until(() => fetch(`${baseA}/api/auth/status`).then((r) => r.ok));
  ok('1: HTTPS handshake works (auth/status over TLS)', status(await fetch(`${baseA}/api/auth/status`)) === 200);
  ok('1: startup log shows https scheme', /https:\/\//.test(logs), logs.split('\n').find((l) => l.includes('Gatherlight server on'))?.slice(0, 70) ?? '');

  const cert1 = await peerCert('127.0.0.1', P1);
  ok('1: served cert is the self-signed Gatherlight cert', cert1?.subject?.CN === 'Gatherlight' && cert1?.issuer?.CN === 'Gatherlight', JSON.stringify(cert1?.subject));
  ok('1: self-signed PFX persisted to state/', fs.existsSync(pfxPath));

  // plaintext HTTP on the TLS port must fail
  let httpFailed = false;
  try { await fetch(`http://127.0.0.1:${P1}/api/auth/status`); } catch { httpFailed = true; }
  ok('1: plaintext HTTP refused on the TLS port', httpFailed);

  // Secure cookie flag under HTTPS
  const login = await fetch(`${baseA}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
  const setCookie = login.headers.get('set-cookie') ?? '';
  ok('1: login over HTTPS sets a Secure cookie', status(login) === 200 && /gl_auth=/.test(setCookie) && /secure/i.test(setCookie), setCookie.slice(0, 60));

  ok('1: /api gated without token → 401 (over TLS)', status(await fetch(`${baseA}/api/plans`)) === 401);
  ok('1: /api with token → 200 (over TLS)', status(await fetch(`${baseA}/api/plans`, { headers: { 'X-Gatherlight-Token': TOKEN } })) === 200);
  const fp1 = cert1.fingerprint256;
  a.kill(); a = null;
  await new Promise((r) => setTimeout(r, 1500));

  // ---------- Boot 2: same self-signed cert is reused ----------
  b = boot(P2, { GATHERLIGHT_ACCESS_TOKEN: TOKEN, GATHERLIGHT_TRUST_LOOPBACK: '0' });
  const baseB = `https://127.0.0.1:${P2}`;
  await until(() => fetch(`${baseB}/api/auth/status`).then((r) => r.ok));
  const cert2 = await peerCert('127.0.0.1', P2);
  ok('2: reboot reuses the persisted cert (same fingerprint)', cert2.fingerprint256 === fp1, `${fp1?.slice(0, 12)} vs ${cert2.fingerprint256?.slice(0, 12)}`);
  b.kill(); b = null;
  await new Promise((r) => setTimeout(r, 1500));

  // ---------- Boot 3: a configured PFX (certPath) is honored ----------
  c = boot(P3, { GATHERLIGHT_TLS_CERT: pfxPath });   // no token → loopback trusted (default)
  const baseC = `https://127.0.0.1:${P3}`;
  await until(() => fetch(`${baseC}/api/health`).then((r) => r.ok));
  ok('3: configured PFX serves HTTPS + health open on loopback', status(await fetch(`${baseC}/api/health`)) === 200);
  const cert3 = await peerCert('127.0.0.1', P3);
  ok('3: configured cert is the one we pointed at', cert3?.subject?.CN === 'Gatherlight' && cert3.fingerprint256 === fp1);
} catch (err) {
  console.error('e2e-p18 fatal:', err.message);
  console.error(logs.slice(-2500));
  failures++;
} finally {
  a?.kill(); b?.kill(); c?.kill();
}

console.log(failures === 0 ? '\ne2e-p18 PASS' : `\ne2e-p18 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
