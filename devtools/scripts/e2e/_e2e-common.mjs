// Shared e2e harness (lives with the suites in devtools/scripts/e2e/). Leading `_` → the runner
// (dev.mjs, `^p\d+\.mjs$`) never picks this up as a suite. Each suite imports what it needs; the
// boilerplate (reporter, server spawn, http/chat/git helpers) lives here once so a fix (or a new
// assertion helper) lands in one place.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// this file is devtools/scripts/e2e/_e2e-common.mjs → three levels up is the repo root.
export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const claudeStubCmd = `node ${path.join(repo, 'devtools', 'scripts', 'claude-stub.mjs')}`;
export const dataDirFor = (suite) => path.join(repo, 'devtools', `_e2e-${suite}-data`);

/** Assert reporter. `ok(name, cond, extra?)` logs + counts; `done()` prints the PASS/FAIL line the
 *  runner greps for and exits with the right code. `fail()` bumps the counter for a caught fatal. */
export function makeReporter(suite) {
  let failures = 0;
  const ok = (name, cond, extra = '') => {
    console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
    if (!cond) failures++;
  };
  const fail = (msg) => { if (msg) console.error(msg); failures++; };
  const done = () => {
    // fs.writeSync, NOT console.log: on Windows a piped stdout is ASYNCHRONOUS, so console.log
    // leaves the line in a buffer that process.exit() does not wait for — and if the process then
    // dies in teardown (the libuv UV_HANDLE_CLOSING abort, exit 0xC0000409, which undici's pool
    // reliably provokes), the buffered line is lost with it. The runner tolerates that abort by
    // trusting this marker, so a marker that vanishes in the very crash it exists to survive made
    // the tolerance useless: a random suite was reported failed on roughly every other full run.
    // Writing it synchronously puts it in the pipe before anything can abort.
    fs.writeSync(1, failures === 0 ? `\ne2e-${suite} PASS\n` : `\ne2e-${suite} FAIL (${failures})\n`);
    process.exit(failures === 0 ? 0 : 1);
  };
  return { ok, fail, done };
}

/** Skip a suite gracefully (exit 0, counts as PASS) when an env-only prerequisite is absent — the
 *  same "no failures" convention e2e-p19 uses for the MSVC-less case. Keeps `e2e all` green on a
 *  fresh box / CI that hasn't provisioned the heavy, download-at-setup pieces. */
export function skipSuite(suite, reason) {
  console.log(`  · ${reason} — skipping ${suite} (no failures).`);
  console.log(`\ne2e-${suite} PASS (skipped)`);
  process.exit(0);
}

/** Skip unless a Node module is installed under a repo subdir (e.g. the pdf-form leaf's deps). */
export function skipUnlessNodeModule(subdir, moduleName, suite) {
  if (!fs.existsSync(path.join(repo, subdir, 'node_modules', moduleName)))
    skipSuite(suite, `${moduleName} not installed in ${subdir} (run \`npm ci\` there)`);
}

/** Skip unless a real browser (chromium) is available to the scraper tools — it's download-at-setup
 *  (the 资源 panel / `dev.mjs fetch-tools`), not in the lean bundle, so CI / a fresh box won't have it.
 *  A "Chromium 未安装" error means the browser isn't provisioned → skip.
 *
 *  Probes a *scraper-port* tool (`flight_schedule`), NOT `scrape`: the `scrape` tool runs the SSRF
 *  guard before it ever launches the browser, so a loopback probe URL comes back 403 and the
 *  "未安装" signal never surfaces (that regression is exactly what made e2e-p11 stop skipping on a
 *  chromium-less box). Scraper ports are SSRF-exempt — they build URLs from operator-configured
 *  bases — and hit GetBrowserAsync directly, so a missing browser surfaces as "未安装". When the
 *  browser IS present the probe returns normally (navigating to whatever base the suite configured,
 *  a local fixture for the callers here) and the suite runs. */
export async function skipUnlessChromium(base, suite) {
  try {
    const r = await fetch(base + '/api/tools/call', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'flight_schedule', arguments: { carrierIATA: 'XX', flightNumber: '0' } }),
    });
    const text = JSON.stringify(await r.json().catch(() => ''));
    if (text.includes('未安装') || text.includes('Executable doesn') || text.includes('Chromium 未'))
      skipSuite(suite, 'Chromium not provisioned (download-at-setup; `dev.mjs fetch-tools`)');
  } catch { /* if the probe itself fails weirdly, let the suite run and report normally */ }
}

export const makeTestData = (dataDir) =>
  spawnSync('node', [path.join(repo, 'devtools', 'scripts', 'make-test-data.mjs'), dataDir], { stdio: 'inherit' });

/** Boot the server against an isolated data folder. Returns { server, base, log(), stop() }. */
export function startServer({ dataDir, port, env = {}, cwd = repo }) {
  const server = spawn('dotnet', ['run', '--project', 'src/server/Gatherlight.Server', '--no-build'], {
    cwd,
    env: { ...process.env, GATHERLIGHT_DATA: dataDir, GATHERLIGHT_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logBuf = '';
  server.stdout.on('data', (d) => (logBuf += d));
  server.stderr.on('data', (d) => (logBuf += d));
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    log: () => logBuf,
    stop: () => { try { server.kill(); } catch {} },
  };
}

/** Poll `fn` until it returns truthy (thrown errors are swallowed) or `ms` elapses. */
// The default ceiling is generous ON PURPOSE. The runner runs suites in parallel, so a condition that
// resolves in two seconds alone can take far longer with eight servers booting on the same box — and a
// timeout there is a FALSE failure that costs more to investigate than the seconds it saves. p41 (2026-08-05)
// and p9/p11 (2026-08-06) each failed a full run at the old 30s while passing alone. A genuinely stuck
// condition now takes longer to report, which is the right trade: suites finish in ~20s, so one real hang
// paying 90s once is cheaper than a green suite that cries wolf under load.
export async function until(fn, ms = 90000, poll = 250) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fn(); if (r) return r; } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, poll));
  }
}

// Wait until the server is up AND the startup migration has lifted the gate (health.migrating === false).
// Older behavior (just r.ok) implicitly waited because the port wasn't open until migration finished; the
// migration now runs while listening, so readiness must be checked explicitly.
// Same generous ceiling as `until`, and for a sharper reason: this waits for the STARTUP MIGRATION to
// lift the gate, which is the slowest thing a booting server does and the first to suffer under load.
export const waitHealthy = (base, ms = 90000) => until(async () => {
  const r = await fetch(`${base}/api/health`);
  if (!r.ok) return false;
  const j = await r.json().catch(() => ({}));
  return j.migrating === true ? false : true;
}, ms);

/** HTTP + chat helpers bound to a base URL. */
export function makeClient(base) {
  const j = async (p, init) => {
    const r = await fetch(base + p, init);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const withBody = (method) => (p, body) =>
    j(p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const getJson = async (p) => (await fetch(base + p)).json();
  // POST /api/tools/call, unwrapping the JSON string in body.result → { status, result }.
  const call = async (name, args) => {
    const r = await j('/api/tools/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
    return { status: r.status, result: r.body?.result ? JSON.parse(r.body.result) : r.body };
  };
  const waitPhase = (id, phase) => until(async () => {
    const s = await j(`/api/chat/${id}`);
    if (s.body?.phase === 'error' && phase !== 'error') throw new Error('session errored: ' + s.body?.error);
    return s.body?.phase === phase ? s.body : null;
  });
  return { j, post: withBody('POST'), put: withBody('PUT'), del: (p) => j(p, { method: 'DELETE' }), getJson, call, waitPhase };
}

/** git helpers bound to a working dir. */
export const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
export const gitLog = (dir) => git(dir, 'log', '--oneline').split('\n').filter(Boolean);
export const tracked = (dir, rel) => { try { git(dir, 'ls-files', '--error-unmatch', '--', rel); return true; } catch { return false; } };
export const onDisk = (dir, rel) => fs.existsSync(path.join(dir, rel));
