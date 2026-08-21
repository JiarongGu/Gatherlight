#!/usr/bin/env node
// e2e P50 — the claude CLI is a PROVISIONED resource, not an assumed one.
//
// The bug this suite exists to prevent: the CLI was the last runtime dependency we simply assumed the
// machine had. On a fresh install it did not, so the first chat spawned a `claude` that wasn't there and
// died at spawn in 17ms. All the household saw was "计划阶段未能完成(CLI 报告错误),请重试" — a sentence
// naming neither the cause nor a fix, telling them to retry something that could never succeed.
//
// It is the git failure of p49 with one deliberate difference, and the cases below pin that difference
// down: git is BOOT-essential, so it downloads inline and a failure gates the app; the CLI is
// PRODUCT-essential but not boot-essential, so the app must come up ANYWAY — otherwise a ~265 MB download
// would sit in front of the 资源 panel that installs it, which is exactly how the git failure sealed the
// door to its own fix.
//
//   A  no CLI anywhere            → boots ANYWAY (not gated), warns, panel reachable, row present
//   B  no CLI                     → a chat turn names the CLI, not "(CLI 报告错误)" and not raw Win32
//   C  CLI present but signed out → says LOGIN, which is a different fix from "install it"
//   D  CLI present and signed in  → no warning, no nagging, panel shows the account
//   E  installed mid-life         → picked up with no restart (the p49 case-C lesson, re-checked here)
//   F  download: tampered refused on sha256, and the SAME fixture with the right sum installs
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { dataDirFor, makeReporter, startServer, until, makeClient } from './_e2e-common.mjs';

const { ok, fail, done } = makeReporter('p50');

// Free ports — p49 took the range up to 5505.
const PORT_MISSING = 5506;
const PORT_SIGNED_OUT = 5507;
const PORT_SIGNED_IN = 5508;
const PORT_PROVISION = 5509;

const RAW_WIN32 = /系统找不到指定的文件|An error occurred trying to start process/;
const GENERIC = /CLI 报告错误/;

// A machine with no claude: every PATH entry carrying one, removed. Same fixture shape as p49's gitless —
// the failure was never about the data folder, only about what the host happens to have installed.
const claudelessPath = (process.env.PATH || '').split(';').filter((p) => {
  if (!p) return false;
  try { return !fs.existsSync(path.join(p, 'claude.exe')) && !fs.existsSync(path.join(p, 'claude.cmd')); }
  catch { return true; }
}).join(';');
// BOTH casings (Windows hands back `Path`), and every env seam the resolver honours blanked — an empty
// string is ignored by the resolver, so this is "no override" rather than "override with nothing".
const claudeless = {
  PATH: claudelessPath, Path: claudelessPath,
  GATHERLIGHT_CLAUDE_CMD: '', CLAUDE_CMD: '', LYNTAI_PROVIDER_CMD: '',
};

const freshDir = (suffix) => {
  const dir = dataDirFor(`p50-${suffix}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** A stand-in CLI: answers `auth status --json` like the real one, and fails every actual run — which is
 *  what a signed-out or broken CLI does, and what the diagnosis has to survive. */
const writeAuthStub = (dir, { loggedIn }) => {
  const file = path.join(dir, 'auth-stub.mjs');
  fs.writeFileSync(file, `
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify(${JSON.stringify(
    loggedIn
      ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'household@example.com', subscriptionType: 'max' }
      : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' })}));
  process.exit(${loggedIn ? 0 : 1});
}
// Any real run fails: this stub has no agent in it. Case C needs a failed turn to diagnose.
process.exit(1);
`);
  return `node ${file}`;
};

const settled = (base) => until(async () => {
  const r = await fetch(`${base}/api/migration/status`);
  if (!r.ok) return null;
  const s = await r.json();
  return s.phase === 'running' ? null : s;
});

const claudeRow = async (base) => {
  const { getJson } = makeClient(base);
  const rows = (await getJson('/api/manage/resources')).resources ?? [];
  return rows.find((r) => r.id === 'claude');
};

/** Serve a fake release channel: /latest, /<v>/manifest.json, /<v>/win32-x64/claude.exe.
 *  The checksum is read per REQUEST (`sum()`), so one channel can publish a wrong sum and then the right
 *  one. That is what lets the denial and its positive control share a server — and it avoids restarting
 *  the app on the same port, which raced under fleet load: `settled()` and the provision POST landed on
 *  the still-dying first server while the new one bound the port and only ever saw the GET polling. */
const serveRelease = (version, payload, sum) => new Promise((resolve) => {
  const srv = http.createServer((req, res) => {
    const send = (body, type) => {
      res.writeHead(200, { 'content-type': type, 'content-length': body.length });
      res.end(body);
    };
    if (req.url === '/latest') return send(Buffer.from(version), 'text/plain');
    if (req.url === `/${version}/manifest.json`)
      return send(Buffer.from(JSON.stringify({ platforms: { 'win32-x64': { checksum: sum() }, 'win32-arm64': { checksum: sum() } } })), 'application/json');
    if (req.url === `/${version}/win32-x64/claude.exe` || req.url === `/${version}/win32-arm64/claude.exe`)
      return send(payload, 'application/octet-stream');
    res.writeHead(404); res.end('no');
  });
  srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`,
    close: () => { try { srv.close(); } catch { /* best effort */ } },
  }));
});

let srv;
try {
  // ---- A · no CLI anywhere: the app must still COME UP ------------------------------------------
  const dirA = freshDir('a');
  srv = startServer({ dataDir: dirA, port: PORT_MISSING, env: { ...claudeless } });
  let snap = await settled(srv.base);
  const stepA = snap.steps.find((s) => s.id === 'claude-runtime');
  ok('a claude-runtime step exists', !!stepA, JSON.stringify(snap.steps.map((s) => s.id)));
  // THE load-bearing assertion of this suite. If a missing CLI ever gates the boot, the panel that
  // installs it becomes unreachable and the install is unrecoverable — the p49 failure, reintroduced.
  ok('with NO claude on the machine the app still boots', snap.phase === 'completed', snap.error ?? '');
  ok('and the household is told, rather than left to find out mid-chat',
    /Claude CLI/i.test(JSON.stringify(snap.warnings ?? [])), JSON.stringify(snap.warnings));
  ok('the warning says what to do, not just what broke',
    /资源|安装|下载/.test(JSON.stringify(snap.warnings ?? [])), JSON.stringify(snap.warnings));
  ok('the api is serving, not gated',
    (await (await fetch(`${srv.base}/api/health`)).json()).migrating === false);
  const rowA = await claudeRow(srv.base);
  ok('the resources catalog carries a claude entry', !!rowA, 'no claude row');
  ok('reported not installed, and saying what it is for',
    rowA?.installed === false && /引擎|聊天/.test(String(rowA?.neededFor ?? '')), JSON.stringify(rowA));
  ok('and the row states it is unusable rather than staying silent',
    /未安装|无法运行/.test(String(rowA?.detail ?? '')), String(rowA?.detail));

  // ---- B · the failure a household actually hits: a chat turn with no CLI ------------------------
  const { post, waitPhase } = makeClient(srv.base);
  const startB = await post('/api/chat', { message: '给明天建一个日计划' });
  const idB = startB.body?.id ?? startB.body?.sessionId;
  ok('(setup) a chat turn starts', !!idB, JSON.stringify(startB.body));
  if (idB) {
    const errSnap = await waitPhase(idB, 'error');
    const msg = String(errSnap?.error ?? '');
    ok('the turn fails, as it must with no CLI', msg.length > 0, JSON.stringify(errSnap));
    ok('and the message NAMES the missing CLI', /Claude CLI/i.test(msg), msg);
    ok('it is not the old generic "(CLI 报告错误)"', !GENERIC.test(msg), msg);
    // The Win32 text is LOCALIZED, so matching it in product code works on one machine and silently
    // stops working on the next. Asserting its absence keeps the diagnosis on the probe, not the string.
    ok('and not the raw localized Win32 error', !RAW_WIN32.test(msg), msg);
  }
  srv.stop(); srv = undefined;

  // ---- C · a CLI that is present but signed out: a DIFFERENT problem with a different fix ---------
  const dirC = freshDir('c');
  srv = startServer({
    dataDir: dirC, port: PORT_SIGNED_OUT,
    env: { ...claudeless, GATHERLIGHT_CLAUDE_CMD: writeAuthStub(dirC, { loggedIn: false }) },
  });
  snap = await settled(srv.base);
  ok('a signed-out CLI still lets the app boot', snap.phase === 'completed', snap.error ?? '');
  ok('the warning says LOGIN, not "install"',
    /登录/.test(JSON.stringify(snap.warnings ?? [])), JSON.stringify(snap.warnings));
  const rowC = await claudeRow(srv.base);
  ok('the panel distinguishes signed-out from missing',
    /未登录/.test(String(rowC?.detail ?? '')), String(rowC?.detail));
  const cC = makeClient(srv.base);
  const startC = await cC.post('/api/chat', { message: '给明天建一个日计划' });
  const idC = startC.body?.id ?? startC.body?.sessionId;
  if (idC) {
    const msgC = String((await cC.waitPhase(idC, 'error'))?.error ?? '');
    ok('and a failed turn tells the household to log in', /登录/.test(msgC), msgC);
    ok('naming the actual command to run', /auth login/.test(msgC), msgC);
  }
  srv.stop(); srv = undefined;

  // ---- D · the happy path: present and signed in. No warning, no nagging -------------------------
  const dirD = freshDir('d');
  srv = startServer({
    dataDir: dirD, port: PORT_SIGNED_IN,
    env: { ...claudeless, GATHERLIGHT_CLAUDE_CMD: writeAuthStub(dirD, { loggedIn: true }) },
  });
  snap = await settled(srv.base);
  ok('a signed-in CLI boots clean', snap.phase === 'completed', snap.error ?? '');
  ok('with NO claude warning at all',
    !/Claude CLI/i.test(JSON.stringify(snap.warnings ?? [])), JSON.stringify(snap.warnings));
  const rowD = await claudeRow(srv.base);
  ok('and the panel shows the account it is signed in as',
    /已登录/.test(String(rowD?.detail ?? '')) && /household@example\.com/.test(String(rowD?.detail ?? '')),
    String(rowD?.detail));
  // A household that already has a working CLI must never be offered an "update" for a version we did
  // not install — the button would silently replace their own install.
  ok('and is not nagged to update something we never installed',
    !rowD?.version, JSON.stringify({ version: rowD?.version, available: rowD?.available }));
  srv.stop(); srv = undefined;

  // ---- E+F · the real provisioning path, against a fake release channel --------------------------
  // One fixture, used twice: the same bytes are refused under a wrong checksum and installed under the
  // right one. A denial without its positive control is half a test.
  const payload = Buffer.from('#!/fake claude cli payload\n' + 'x'.repeat(4096));
  const realSum = crypto.createHash('sha256').update(payload).digest('hex');
  const wrongSum = crypto.createHash('sha256').update('something else').digest('hex');

  const dirF = freshDir('f');
  // One channel, one app instance. `published` is what the manifest currently claims the sha256 is.
  let published = wrongSum;
  const release = await serveRelease('9.9.9', payload, () => published);
  srv = startServer({
    dataDir: dirF, port: PORT_PROVISION,
    env: { ...claudeless, GATHERLIGHT_CLAUDE_URL: release.url },
  });
  await settled(srv.base);
  const cF = makeClient(srv.base);
  const waitTerminal = () => until(async () => {
    const r = await claudeRow(srv.base);
    return r && (r.state === 'error' || r.state === 'ready') ? r : null;
  });

  let prov = await cF.post('/api/manage/resources/claude/provision');
  ok('(setup) provisioning starts', prov.status === 202, String(prov.status));
  let row = await waitTerminal();
  ok('a download whose bytes are wrong is refused', row.state === 'error', JSON.stringify(row));
  ok('and says so by the CHECKSUM, not by some later symptom', /sha256/i.test(String(row.message)), row.message);
  ok('nothing was installed from it',
    !fs.existsSync(path.join(dirF, 'state', 'resources', 'claude', 'claude.exe')));

  // Same bytes, now published with the checksum they actually hash to → installs. The positive control
  // for the denial above, and the real first-install path end to end.
  const rejected = String(row.message ?? '');
  published = realSum;
  prov = await cF.post('/api/manage/resources/claude/provision');
  ok('(setup) a retry against the corrected manifest starts', prov.status === 202, String(prov.status));
  row = await until(async () => {
    const r = await claudeRow(srv.base);
    if (!r) return null;
    if (r.state === 'ready') return r;
    // The row still reads 'error' from the rejected attempt until the retry replaces it, so waiting for
    // "any terminal state" would return the stale one immediately. Wait for the positive outcome — but
    // treat a DIFFERENT error as terminal too, so a real regression reports its reason instead of
    // burning the full 180s timeout on a suite that looks merely slow.
    return r.state === 'error' && String(r.message ?? '') !== rejected ? r : null;
  });
  release.close();
  ok('the verified download installs', row.state === 'ready', JSON.stringify(row));
  ok('into the DATA folder, so it survives app updates',
    fs.existsSync(path.join(dirF, 'state', 'resources', 'claude', 'claude.exe')));
  ok('and records the version it installed',
    fs.readFileSync(path.join(dirF, 'state', 'resources', 'claude', 'version.txt'), 'utf8').trim() === '9.9.9');
  // E · the p49 case-C lesson, re-checked on this resolver: a CLI that arrives AFTER startup (which is
  // every panel install, since the step ran long before) must be picked up with no restart. The env seam
  // is what makes that possible — a path captured at DI registration could not change here.
  ok('a CLI installed mid-life is adopted with no restart',
    /Agent CLI: using the provisioned claude at .*state.resources.claude.claude\.exe/.test(srv.log()),
    (srv.log().match(/Agent CLI: .*/) ?? ['(never logged)'])[0]);
  const rowE = await claudeRow(srv.base);
  ok('and the panel reports it installed, with its version',
    rowE?.installed === true && rowE?.version === '9.9.9', JSON.stringify(rowE));
  srv.stop(); srv = undefined;
} catch (err) {
  fail('e2e-p50 fatal: ' + err.message);
  console.error(srv?.log?.().slice(-3000) ?? '');
} finally {
  try { srv?.stop(); } catch { /* best effort */ }
}
done();
