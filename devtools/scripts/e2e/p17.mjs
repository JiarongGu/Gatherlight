#!/usr/bin/env node
// e2e P17 — remote-access hardening. Three boots:
//   A) no token           → auth disabled, API open (loopback-only binding keeps it safe)
//   B) token + trustLoopback=0 (simulates a same-host proxy) → token wall enforced even on 127.0.0.1:
//      status/login open, /api + /mcp gated, header + cookie both let you in, wrong token 401
//   C) bind 0.0.0.0 WITHOUT a token → server refuses to start (fail closed)
//
// The auth gate is the product here, so the gated requests stay bespoke `fetch` calls — we need to
// control (or omit) the token header and assert on raw status codes. Only the harness boilerplate
// (reporter / server spawn / poll) is shared.
import net from 'node:net';
import { dataDirFor, makeReporter, makeTestData, startServer, until, waitHealthy } from './_e2e-common.mjs';

const dataDir = dataDirFor('p17');
const PA = 5401, PB = 5402, PC = 5403;

// Cases C and D bind the WILDCARD address, and a wildcard bind fails if ANY socket on the box holds
// that port on ANY interface — including an unrelated program's outbound connection that happened to
// be assigned it as a local port. Measured: netstat showed `192.168.50.175:5404 -> …:443 CLOSE_WAIT`
// owned by another process, so 0.0.0.0:5404 was refused while 127.0.0.1:5404 bound fine. The server
// was right to fail; the TEST was wrong to assume a fixed wildcard port is free. So probe for one.
const wildcardFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
});
// Range stops well short of 5468, where the other suites' ports begin — the runner keeps suites
// port-disjoint by scanning each file for literal 5xxx, and it cannot see a port chosen at runtime.
const pickWildcardPort = async (from, span = 30) => {
  for (let p = from; p < from + span; p++) if (await wildcardFree(p)) return p;
  throw new Error(`no wildcard-bindable port free in ${from}..${from + span - 1}`);
};
const PD = await pickWildcardPort(5404);
const TOKEN = 'e2e-secret-42';

const { ok, fail, done } = makeReporter('p17');
makeTestData(dataDir);

const status = (res) => res.status;

let a = null, b = null, c = null, d = null;
try {
  // ---------- A) no token: auth disabled, API open ----------
  a = startServer({ dataDir, port: PA });
  const baseA = a.base;
  await waitHealthy(baseA);
  const stA = await (await fetch(`${baseA}/api/auth/status`)).json();
  ok('A: no token → auth not required', stA.required === false && stA.authed === true, JSON.stringify(stA));
  ok('A: API open without a token', status(await fetch(`${baseA}/api/plans`)) === 200);

  // defense-in-depth response headers (verified not to break rendering via a headless CSP render)
  const hdr = await fetch(`${baseA}/`);
  const csp = hdr.headers.get('content-security-policy') ?? '';
  ok("A: CSP present (script-src 'self' + frame-ancestors 'none')", /script-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp), csp.slice(0, 48));
  ok('A: nosniff + frame-deny + referrer + permissions headers', hdr.headers.get('x-content-type-options') === 'nosniff'
    && hdr.headers.get('x-frame-options') === 'DENY' && !!hdr.headers.get('referrer-policy') && !!hdr.headers.get('permissions-policy'));
  // Every remote image now routes through /api/img, so the browser cannot be pointed at an arbitrary
  // host by something the household is merely reading — the remote-image residual. `https:` here
  // would re-open it, which is why this asserts its ABSENCE rather than the directive's presence.
  ok('A: img-src is same-origin only (no https:)', /img-src 'self' data: blob:;/.test(csp) && !/img-src[^;]*https:/.test(csp),
    csp.match(/img-src[^;]*/)?.[0] ?? '(none)');
  // The tile route takes three integers and pins the upstream host, so nothing a page or a plan
  // writes reaches the outbound URL. Out-of-range coordinates are refused rather than forwarded.
  ok('A: a tile outside the zoom range is refused', (await fetch(`${baseA}/api/img/tile/40/0/0`)).status === 404);
  ok('A: a tile outside the coordinate range is refused', (await fetch(`${baseA}/api/img/tile/1/9/0`)).status === 404);
  a.stop(); a = null;
  await new Promise((r) => setTimeout(r, 1200));

  // ---------- B) token + no loopback trust: the wall is up ----------
  b = startServer({ dataDir, port: PB, env: { GATHERLIGHT_ACCESS_TOKEN: TOKEN, GATHERLIGHT_TRUST_LOOPBACK: '0' } });
  const baseB = b.base;
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
  b.stop(); b = null;
  await new Promise((r) => setTimeout(r, 1200));

  // ---------- C) 0.0.0.0 without a token → refuse to start ----------
  c = startServer({ dataDir, port: PC, env: { GATHERLIGHT_BIND: '0.0.0.0' } });
  let started = false;
  try { await until(() => fetch(`http://127.0.0.1:${PC}/api/auth/status`).then((r) => r.ok), 8000); started = true; } catch {}
  ok('C: refuses to serve when bound 0.0.0.0 without a token', started === false);
  ok('C: logs the refusal reason', /Refusing to bind/.test(c.log()), c.log().split('\n').find((l) => l.includes('Refusing'))?.slice(0, 80) ?? '(no reason logged)');
  c.stop(); c = null;
  await new Promise((r) => setTimeout(r, 1200));

  // ---------- D) the OPT-IN actually opts in (the positive control C was missing) ----------
  // Without this row, C passes whether the refusal is conditional or unconditional — which is how a
  // headless entry point that never read allowLanWithoutToken shipped: the desktop host honoured the
  // setting, `dev.mjs server` refused to start quoting the very setting the household had set.
  d = startServer({ dataDir, port: PD, env: { GATHERLIGHT_BIND: '0.0.0.0', GATHERLIGHT_ALLOW_LAN: '1' } });
  let lanUp = false;
  try { await until(() => fetch(`http://127.0.0.1:${PD}/api/auth/status`).then((r) => r.ok), 30000); lanUp = true; } catch {}
  ok('D: allowLanWithoutToken lets it serve on 0.0.0.0', lanUp,
    d.log().split('\n').find((l) => l.includes('Refusing'))?.slice(0, 100) ?? d.log().slice(-200));
  ok('D: and says so loudly in the log', /trusted private network|unauthenticated/i.test(d.log()),
    d.log().split('\n').filter((l) => /LAN|unauthenticated|private/i.test(l))[0]?.slice(0, 120) ?? '(no warning logged)');
} catch (err) {
  fail('e2e-p17 fatal: ' + err.message);
  console.error([a, b, c, d].map((s) => s?.log() ?? '').join('').slice(-2000));
} finally {
  a?.stop(); b?.stop(); c?.stop(); d?.stop();
}
done();
