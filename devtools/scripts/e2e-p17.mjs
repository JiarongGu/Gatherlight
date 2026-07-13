#!/usr/bin/env node
// e2e P17 — remote-access hardening. Three boots:
//   A) no token           → auth disabled, API open (loopback-only binding keeps it safe)
//   B) token + trustLoopback=0 (simulates a same-host proxy) → token wall enforced even on 127.0.0.1:
//      status/login open, /api + /mcp gated, header + cookie both let you in, wrong token 401
//   C) bind 0.0.0.0 WITHOUT a token → server refuses to start (fail closed)
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p17-data');
const PA = 5401, PB = 5402, PC = 5403;
const TOKEN = 'e2e-secret-42';

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
};

spawnSync('node', [path.join(repo, 'devtools', 'scripts', 'make-test-data.mjs'), dataDir], { stdio: 'inherit' });

const boot = (port, extraEnv = {}) => spawn('dotnet',
  ['run', '--project', 'src/server/Gatherlight.Server', '--no-build'],
  { cwd: repo, env: { ...process.env, GATHERLIGHT_DATA: dataDir, GATHERLIGHT_PORT: String(port), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });

const until = async (fn, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fn(); if (r) return r; } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
};
const status = (res) => res.status;

let a = null, b = null, c = null, logC = '';
try {
  // ---------- A) no token: auth disabled, API open ----------
  a = boot(PA);
  const baseA = `http://127.0.0.1:${PA}`;
  await until(() => fetch(`${baseA}/api/health`).then((r) => r.ok));
  const stA = await (await fetch(`${baseA}/api/auth/status`)).json();
  ok('A: no token → auth not required', stA.required === false && stA.authed === true, JSON.stringify(stA));
  ok('A: API open without a token', status(await fetch(`${baseA}/api/plans`)) === 200);

  // defense-in-depth response headers (verified not to break rendering via a headless CSP render)
  const hdr = await fetch(`${baseA}/`);
  const csp = hdr.headers.get('content-security-policy') ?? '';
  ok("A: CSP present (script-src 'self' + frame-ancestors 'none')", /script-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp), csp.slice(0, 48));
  ok('A: nosniff + frame-deny + referrer + permissions headers', hdr.headers.get('x-content-type-options') === 'nosniff'
    && hdr.headers.get('x-frame-options') === 'DENY' && !!hdr.headers.get('referrer-policy') && !!hdr.headers.get('permissions-policy'));
  a.kill(); a = null;
  await new Promise((r) => setTimeout(r, 1200));

  // ---------- B) token + no loopback trust: the wall is up ----------
  b = boot(PB, { GATHERLIGHT_ACCESS_TOKEN: TOKEN, GATHERLIGHT_TRUST_LOOPBACK: '0' });
  const baseB = `http://127.0.0.1:${PB}`;
  // health is under /api, so it's gated now — wait on the (open) auth status endpoint instead.
  await until(() => fetch(`${baseB}/api/auth/status`).then((r) => r.ok));

  const stB = await (await fetch(`${baseB}/api/auth/status`)).json();
  ok('B: token set + loopback not trusted → required, not authed', stB.required === true && stB.authed === false, JSON.stringify(stB));

  ok('B: /api gated without token → 401', status(await fetch(`${baseB}/api/plans`)) === 401);
  ok('B: /api with WRONG token → 401', status(await fetch(`${baseB}/api/plans`, { headers: { 'X-Gatherlight-Token': 'nope' } })) === 401);
  ok('B: /api with correct header token → 200', status(await fetch(`${baseB}/api/plans`, { headers: { 'X-Gatherlight-Token': TOKEN } })) === 200);
  ok('B: /api with Bearer token → 200', status(await fetch(`${baseB}/api/plans`, { headers: { Authorization: `Bearer ${TOKEN}` } })) === 200);
  ok('B: /mcp gated without token → 401', status(await fetch(`${baseB}/mcp`, { method: 'POST' })) === 401);
  ok('B: SPA / stays open (not gated)', status(await fetch(`${baseB}/`)) !== 401);
  ok('B: health is gated (behind /api) → 401', status(await fetch(`${baseB}/api/health`)) === 401);

  // login flow: wrong token 401, correct token sets a cookie that authenticates
  const badLogin = await fetch(`${baseB}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }) });
  ok('B: login wrong token → 401', status(badLogin) === 401);
  const goodLogin = await fetch(`${baseB}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
  const setCookie = goodLogin.headers.get('set-cookie') ?? '';
  ok('B: login correct token → 200 + gl_auth cookie', status(goodLogin) === 200 && /gl_auth=/.test(setCookie), setCookie.slice(0, 40));
  const cookie = (setCookie.match(/gl_auth=[^;]+/) ?? [''])[0];
  ok('B: cookie authenticates /api → 200', status(await fetch(`${baseB}/api/plans`, { headers: { cookie } })) === 200);
  const stAuthed = await (await fetch(`${baseB}/api/auth/status`, { headers: { cookie } })).json();
  ok('B: status with cookie → authed', stAuthed.authed === true);

  // brute-force throttle: the good login above cleared the counter; 5 wrong attempts lock the IP,
  // and once locked even the CORRECT token is refused (429) until the cooldown.
  let lastWrong;
  for (let i = 0; i < 5; i++) {
    lastWrong = await fetch(`${baseB}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: `guess-${i}` }) });
  }
  ok('B: 5th wrong login is still 401 (lock arms on it)', status(lastWrong) === 401, String(status(lastWrong)));
  const locked = await fetch(`${baseB}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
  ok('B: locked out → 429 + Retry-After even with the correct token', status(locked) === 429 && !!locked.headers.get('retry-after'),
    `${status(locked)} retry-after=${locked.headers.get('retry-after')}`);
  // an already-authenticated cookie is unaffected by the login lockout
  ok('B: existing cookie still works during lockout', status(await fetch(`${baseB}/api/plans`, { headers: { cookie } })) === 200);
  b.kill(); b = null;
  await new Promise((r) => setTimeout(r, 1200));

  // ---------- C) 0.0.0.0 without a token → refuse to start ----------
  c = boot(PC, { GATHERLIGHT_BIND: '0.0.0.0' });
  c.stdout.on('data', (d) => (logC += d)); c.stderr.on('data', (d) => (logC += d));
  let started = false;
  try { await until(() => fetch(`http://127.0.0.1:${PC}/api/auth/status`).then((r) => r.ok), 8000); started = true; } catch {}
  ok('C: refuses to serve when bound 0.0.0.0 without a token', started === false);
  ok('C: logs the refusal reason', /Refusing to bind/.test(logC), logC.split('\n').find((l) => l.includes('Refusing'))?.slice(0, 80) ?? '(no reason logged)');
} catch (err) {
  console.error('e2e-p17 fatal:', err.message);
  console.error(logC.slice(-2000));
  failures++;
} finally {
  a?.kill(); b?.kill(); c?.kill();
}

console.log(failures === 0 ? '\ne2e-p17 PASS' : `\ne2e-p17 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
