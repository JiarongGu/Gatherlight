// Shared e2e harness. Leading `_` → the runner (dev.mjs, `^e2e-p\d+\.mjs$`) never picks this up as a
// suite. Each suite imports what it needs; the boilerplate (reporter, server spawn, http/chat/git
// helpers) lives here once so a fix (or a new assertion helper) lands in one place.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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
    console.log(failures === 0 ? `\ne2e-${suite} PASS` : `\ne2e-${suite} FAIL (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  };
  return { ok, fail, done };
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
export async function until(fn, ms = 30000, poll = 250) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fn(); if (r) return r; } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, poll));
  }
}

export const waitHealthy = (base, ms = 30000) => until(() => fetch(`${base}/api/health`).then((r) => r.ok), ms);

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
