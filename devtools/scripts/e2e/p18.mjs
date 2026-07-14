#!/usr/bin/env node
// e2e P18 — TLS / HTTPS. Boots Kestrel with TLS on (self-signed by default), verifies the HTTPS
// handshake works, the cert is the self-signed Gatherlight one, it's persisted + reused across
// reboots, the Secure cookie flag flips under HTTPS, plaintext HTTP is refused on the TLS port, and
// a configured PFX (security.tls.certPath) is honored.
//
// TLS is the product here: the base URLs are https, the client must accept the self-signed cert, and
// cert identity is inspected over a raw TLS socket. That fetch/socket setup stays bespoke — only the
// harness boilerplate (reporter / server spawn / poll) is shared. GATHERLIGHT_TLS is passed per boot.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // accept the self-signed cert in the test client
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { dataDirFor, makeReporter, makeTestData, startServer, until } from './_e2e-common.mjs';

const dataDir = dataDirFor('p18');
const pfxPath = path.join(dataDir, 'state', 'gatherlight-tls.pfx');
const P1 = 5404, P2 = 5405, P3 = 5406;
const TOKEN = 'tls-secret-9';

const { ok, fail, done } = makeReporter('p18');
makeTestData(dataDir);

const bootTls = (port, extraEnv = {}) => startServer({ dataDir, port, env: { GATHERLIGHT_TLS: '1', ...extraEnv } });

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

let a = null, b = null, c = null;
try {
  // ---------- Boot 1: TLS + token + no loopback trust ----------
  a = bootTls(P1, { GATHERLIGHT_ACCESS_TOKEN: TOKEN, GATHERLIGHT_TRUST_LOOPBACK: '0' });
  const baseA = `https://127.0.0.1:${P1}`;
  await until(() => fetch(`${baseA}/api/auth/status`).then((r) => r.ok));
  ok('1: HTTPS handshake works (auth/status over TLS)', status(await fetch(`${baseA}/api/auth/status`)) === 200);
  ok('1: startup log shows https scheme', /https:\/\//.test(a.log()), a.log().split('\n').find((l) => l.includes('Gatherlight server on'))?.slice(0, 70) ?? '');

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
  a.stop(); a = null;
  await new Promise((r) => setTimeout(r, 1500));

  // ---------- Boot 2: same self-signed cert is reused ----------
  b = bootTls(P2, { GATHERLIGHT_ACCESS_TOKEN: TOKEN, GATHERLIGHT_TRUST_LOOPBACK: '0' });
  const baseB = `https://127.0.0.1:${P2}`;
  await until(() => fetch(`${baseB}/api/auth/status`).then((r) => r.ok));
  const cert2 = await peerCert('127.0.0.1', P2);
  ok('2: reboot reuses the persisted cert (same fingerprint)', cert2.fingerprint256 === fp1, `${fp1?.slice(0, 12)} vs ${cert2.fingerprint256?.slice(0, 12)}`);
  b.stop(); b = null;
  await new Promise((r) => setTimeout(r, 1500));

  // ---------- Boot 3: a configured PFX (certPath) is honored ----------
  c = bootTls(P3, { GATHERLIGHT_TLS_CERT: pfxPath });   // no token → loopback trusted (default)
  const baseC = `https://127.0.0.1:${P3}`;
  await until(() => fetch(`${baseC}/api/health`).then((r) => r.ok));
  ok('3: configured PFX serves HTTPS + health open on loopback', status(await fetch(`${baseC}/api/health`)) === 200);
  const cert3 = await peerCert('127.0.0.1', P3);
  ok('3: configured cert is the one we pointed at', cert3?.subject?.CN === 'Gatherlight' && cert3.fingerprint256 === fp1);
} catch (err) {
  fail('e2e-p18 fatal: ' + err.message);
  console.error([a, b, c].map((s) => s?.log() ?? '').join('').slice(-2500));
} finally {
  a?.stop(); b?.stop(); c?.stop();
}
done();
