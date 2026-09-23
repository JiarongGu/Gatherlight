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
import { spawn } from 'node:child_process';
import { dataDirFor, makeReporter, startServer, until, makeClient } from './_e2e-common.mjs';

const { ok, fail, done } = makeReporter('p50');

// Free ports — p49 took the range up to 5505.
const PORT_MISSING = 5506;
const PORT_SIGNED_OUT = 5507;
const PORT_SIGNED_IN = 5508;
const PORT_PROVISION = 5509;
const PORT_LOGIN = 5511;

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
/** POST returning status + parsed body — these endpoints answer with a sentence, and the assertions read
 *  it, so a helper that threw away the body would make every failure say only "409". */
const cliPost = async (base, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

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
 *  Everything is read per REQUEST (`version()`, `payload()`, `sum()`), so one channel can publish a wrong
 *  sum and then the right one, and later move to a NEWER version. That is what lets the denial, its
 *  positive control and the update share a server — and it avoids restarting the app on the same port,
 *  which raced under fleet load: `settled()` and the provision POST landed on the still-dying first server
 *  while the new one bound the port and only ever saw the GET polling. It also has to be ONE channel for a
 *  second reason: the app reads GATHERLIGHT_CLAUDE_URL from its own environment, fixed at start. */
const serveRelease = (versionOf, payloadOf, sum) => new Promise((resolve) => {
  const srv = http.createServer((req, res) => {
    const send = (body, type) => {
      res.writeHead(200, { 'content-type': type, 'content-length': body.length });
      res.end(body);
    };
    const version = versionOf();
    const payload = payloadOf();
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

  // THE LOGIN ROUTE IS NOT DRIVEN FROM HERE, and that is a decision rather than an omission.
  //
  // POST /api/manage/resources/claude/login spawns `auth login` on the RESOLVED binary — which is the whole
  // point of it, because the advice it replaces ("run `claude auth login` in a terminal") is unactionable
  // for a CLI installed through 资源: that copy lives in {data}/state/resources/claude/ and the directory is
  // never added to PATH. But a call that succeeds opens an interactive console waiting for a human in a
  // browser, and a suite must not open windows on the machine running it.
  //
  // Nor can the refusal half be driven safely: `Locate()` falls through to PATH, so on a developer machine
  // with its own claude even this CLI-LESS fixture resolves one and the call spawns. Attempting it here did
  // exactly that, twice, before the attempt was removed. What IS asserted instead — below and in case C —
  // is every observable that does not spawn: the row's own line names the button, and a failed turn names
  // where to log in rather than a command that may not resolve. The spawn itself was verified by hand
  // (2026-08-22: resolved binary starts, probe cache dropped, the row's line flips on completion).
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
  // …and the row's own line points at the button too, so the panel and the failed-turn message agree.
  ok('and the row names the button rather than a terminal command',
    /登录/.test(String(rowC?.detail ?? '')) && !/auth login/.test(String(rowC?.detail ?? '')),
    String(rowC?.detail));
  // ---- WHOSE LOGIN the app uses ------------------------------------------------------------------
  // The CLI keeps credentials in a config directory, so every process started as the same OS user shares
  // one session: the app was signed in as whoever the household is signed in as in their own terminal.
  // Fine when those are the same account, wrong when they are not. CLAUDE_CONFIG_DIR isolates it —
  // verified by hand 2026-08-22, the same binary reporting loggedIn:false against a fresh directory while
  // the machine session stayed signed in.
  //
  // What the fixture CAN check is the choice itself: its default, that it round-trips, that a bad value is
  // refused, and that logout respects whose credential it is. It cannot check the isolation, because the
  // auth stub answers from a canned JSON regardless of which directory it is pointed at — asserting that
  // would be asserting our own stub.
  const sess = async () =>
    (await (await fetch(`${srv.base}/api/manage/resources`)).json()).claudeSession;
  const s0 = await sess();
  ok('the app shares the machine login by DEFAULT — nothing set, nothing changed',
    s0?.mode === 'machine', JSON.stringify(s0));
  ok('and it reports where its own credentials would live, before they exist',
    typeof s0?.home === 'string' && s0.home.length > 0, JSON.stringify(s0));

  // LOGOUT IS REFUSED while the app shares the machine's login. That credential belongs to the household's
  // own terminal; ending it from our panel is the overreach this codebase already unlearned once with
  // somebody else's model daemon. The refusal is the assertion — and it names the way to get a separate one.
  const logoutShared = await cliPost(srv.base, '/api/manage/resources/claude/logout');
  ok('signing out is refused while the app shares the machine login',
    logoutShared.status === 409 && /自己终端|切到/.test(String(logoutShared.body?.error ?? '')),
    `${logoutShared.status} ${JSON.stringify(logoutShared.body?.error ?? '')}`);

  const bad = await cliPost(srv.base, '/api/manage/resources/claude/session', { mode: 'sideways' });
  ok('an unknown session mode is refused rather than defaulted', bad.status === 400, String(bad.status));

  const toApp = await cliPost(srv.base, '/api/manage/resources/claude/session', { mode: 'app' });
  ok('switching to the app\'s own session succeeds', toApp.status === 200, String(toApp.status));
  ok('…and the panel reports the new mode without a restart',
    (await sess())?.mode === 'app', JSON.stringify(await sess()));
  // Now it IS ours to end, so the refusal must stop: whether the CLI succeeds is its business, but a 409
  // here would mean the app was still calling somebody else's login its own.
  const logoutOwn = await cliPost(srv.base, '/api/manage/resources/claude/logout');
  ok('…and signing out is no longer refused, because that session is ours',
    logoutOwn.status !== 409, String(logoutOwn.status));

  await cliPost(srv.base, '/api/manage/resources/claude/session', { mode: 'machine' });
  ok('switching back leaves the shared login in place', (await sess())?.mode === 'machine');

  const cC = makeClient(srv.base);
  const startC = await cC.post('/api/chat', { message: '给明天建一个日计划' });
  const idC = startC.body?.id ?? startC.body?.sessionId;
  if (idC) {
    const msgC = String((await cC.waitPhase(idC, 'error'))?.error ?? '');
    ok('and a failed turn tells the household to log in', /登录/.test(msgC), msgC);
    // WAS `/auth login/`. That assertion pinned advice which could not be followed for a CLI we
    // installed — its directory is never on PATH — so the message now names the panel and the button that
    // spawns the resolved binary. Updated deliberately: the old assertion was right about the old text.
    ok('naming WHERE to log in, rather than a command that may not resolve',
      /资源|登录/.test(msgC) && !/auth login/.test(msgC), msgC);
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
  let channelVersion = '9.9.9';
  let channelPayload = payload;
  const release = await serveRelease(() => channelVersion, () => channelPayload, () => published);
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

  // THE `app` ORIGIN BRANCH — recorded in p51 as an uncovered gap, and covered HERE instead.
  //
  // p51 cannot reach it: every suite must point GATHERLIGHT_CLAUDE_CMD at a stub, and an explicit override
  // outranks the provisioned copy, so a planted file loses to the override by design. This case is the one
  // place the condition arises without arranging it — it runs claudeless, and has just downloaded a real
  // file to exactly where the provisioner installs. `Locate()` therefore returns the provisioned path and
  // RuntimeOriginFrom compares it against that same path.
  //
  // Worth asserting because answering `household` unconditionally would pass every other origin check in
  // the suite. Telling "we installed this" apart from "you did" is the entire point of the axis, and their
  // conflation is what let a provisioned runtime read as a manual prerequisite for months.
  const { getJson: getF } = makeClient(srv.base);
  const memF = await getF('/api/manage/memory');
  const claudeOrigin = (memF.layers ?? [])
    .flatMap((l) => l.groups ?? [])
    .flatMap((g) => g.sources ?? [])
    .find((x) => x.id === 'claude-cli')?.origin;
  // The KIND alone would be vacuous here, and nearly shipped that way. `Locate()` returning NULL also
  // answers `app` \u2014 phrased as an offer, "\u5e94\u7528\u53ef\u4ee5\u4e0b\u8f7d\u5e76\u8fd0\u884c" \u2014 so a broken path comparison on a machine
  // where nothing resolved would satisfy `kind === 'app'` for entirely the wrong reason. The two branches
  // are only distinguishable by their TEXT, so that is what separates "we found our copy" from "we found
  // nothing and would download one".
  ok('a CLI at the provisioned path reports origin=app, not the household\u2019s',
    claudeOrigin?.kind === 'app', JSON.stringify(claudeOrigin));
  ok('\u2026by having FOUND our copy, not by offering to download one',
    /\u4e0d\u9700\u8981\u4f60\u81ea\u5df1\u88c5/.test(String(claudeOrigin?.text ?? '')), JSON.stringify(claudeOrigin));

  // ---- H · an UPDATE lands while the installed CLI is RUNNING -------------------------------------
  //
  // The vendor moves the CLI, so a copy we installed must follow — and an update is exactly when a copy
  // may be mid-chat. Windows will not OVERWRITE a loaded image; it will RENAME one, which is what
  // ReplaceBinaryAsync falls back to. Until this case existed, nothing drove an update at all (only a first
  // install), and the fallback was dead code: overwriting a running exe raises UnauthorizedAccessException,
  // which is not an IOException, so the rename never ran and the update failed with "access denied".
  //
  // The running image has to be REAL, so the installed file is swapped for a copy of this very node.exe
  // and started. The marker still says 9.9.9, which is all the update decision reads.
  const claudeExe = path.join(dirF, 'state', 'resources', 'claude', 'claude.exe');
  fs.copyFileSync(process.execPath, claudeExe);
  const running = spawn(claudeExe, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  await until(() => running.pid !== undefined && running.exitCode === null, 10000);

  const payloadV2 = Buffer.from('#!/fake claude cli payload v2\n' + 'y'.repeat(4096));
  channelVersion = '9.9.10';
  channelPayload = payloadV2;
  published = crypto.createHash('sha256').update(payloadV2).digest('hex');

  // Opening the panel is what checks for a newer CLI (detached), so poll the row until it knows.
  const offered = await until(async () => {
    const r = await claudeRow(srv.base);
    return r?.available === '9.9.10' ? r : null;
  }, 30000).catch(() => null);
  ok('the panel OFFERS the update: installed 9.9.9, available 9.9.10',
    offered?.version === '9.9.9' && offered?.available === '9.9.10', JSON.stringify(offered));

  prov = await cF.post('/api/manage/resources/claude/provision');
  ok('(setup) the update starts', prov.status === 202, String(prov.status));
  row = await until(async () => {
    const r = await claudeRow(srv.base);
    if (!r) return null;
    if (r.state === 'ready' && r.version === '9.9.10') return r;
    return r.state === 'error' ? r : null;
  });
  ok('THE POINT: the update installs while the old binary is running',
    row.state === 'ready' && row.version === '9.9.10', JSON.stringify(row));
  ok('the new bytes are in place', fs.existsSync(claudeExe)
    && Buffer.compare(fs.readFileSync(claudeExe), payloadV2) === 0);
  ok('…and the running copy was moved ASIDE rather than killed',
    running.exitCode === null
      && fs.readdirSync(path.dirname(claudeExe)).some((f) => f.startsWith('claude.exe.old-')),
    JSON.stringify({ exit: running.exitCode, files: fs.readdirSync(path.dirname(claudeExe)) }));
  ok('and the panel no longer offers an update', row.available === row.version, JSON.stringify(row));

  // The displaced copy is deleted by the NEXT install's sweep, once nothing holds it. Positive control
  // that the aside file is not simply leaked forever. Asserted BY NAME: that install may legitimately set
  // aside a copy of its own — a freshly written exe is briefly held (an AV scan, the app's own probe), the
  // fallback handles that like any lock, and its sweep is then the next install's job. The property is
  // that THIS copy, the one that was running, does not survive the sweep after it exits.
  const displaced = fs.readdirSync(path.dirname(claudeExe)).filter((f) => f.startsWith('claude.exe.old-'));
  running.kill();
  await until(() => running.exitCode !== null || running.signalCode !== null, 10000);
  prov = await cF.post('/api/manage/resources/claude/provision');
  row = await until(async () => {
    const r = await claudeRow(srv.base);
    return r && r.state !== 'running' ? r : null;
  });
  const left = fs.readdirSync(path.dirname(claudeExe));
  ok('once the old copy exits, the next install sweeps it away',
    row.state === 'ready' && displaced.length > 0 && !displaced.some((f) => left.includes(f)),
    JSON.stringify({ state: row.state, displaced, left }));

  // ---- H2 · the file is HELD (a scanner, or our own probe) while the update replaces it -----------
  // Node opens files with FILE_SHARE_DELETE, so it cannot stand in for the holder; PowerShell's
  // [IO.File]::Open(..., FileShare.Read) denies rename exactly as a scanner does. The marker proves the
  // hold is real before the update starts — without it the case could pass by racing the holder.
  const hold = (ms) => {
    const marker = path.join(dirF, `_hold-${ms}.txt`);
    fs.rmSync(marker, { force: true });
    const ps = `$f=[IO.File]::Open('${claudeExe}','Open','Read','Read'); Set-Content -LiteralPath '${marker}' 'held'; `
      + `Start-Sleep -Milliseconds ${ms}; $f.Close()`;
    const p = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
    return { p, ready: until(() => fs.existsSync(marker), 15000) };
  };
  const payloadV3 = Buffer.from('#!/fake claude cli payload v3\n' + 'z'.repeat(4096));
  channelVersion = '9.9.11';
  channelPayload = payloadV3;
  published = crypto.createHash('sha256').update(payloadV3).digest('hex');
  await until(async () => (await claudeRow(srv.base))?.available === '9.9.11', 30000).catch(() => {});

  const brief = hold(1500);
  await brief.ready;
  prov = await cF.post('/api/manage/resources/claude/provision');
  row = await until(async () => {
    const r = await claudeRow(srv.base);
    return r && (r.state === 'error' || (r.state === 'ready' && r.version === '9.9.11')) ? r : null;
  });
  ok('THE POINT: an update over a briefly HELD file waits it out and lands',
    row.state === 'ready' && row.version === '9.9.11'
      && Buffer.compare(fs.readFileSync(claudeExe), payloadV3) === 0, JSON.stringify(row));
  await until(() => brief.p.exitCode !== null, 15000).catch(() => {});

  const payloadV4 = Buffer.from('#!/fake claude cli payload v4\n' + 'w'.repeat(4096));
  channelVersion = '9.9.12';
  channelPayload = payloadV4;
  published = crypto.createHash('sha256').update(payloadV4).digest('hex');
  await until(async () => (await claudeRow(srv.base))?.available === '9.9.12', 30000).catch(() => {});
  const long = hold(20000);
  await long.ready;
  prov = await cF.post('/api/manage/resources/claude/provision');
  row = await until(async () => {
    const r = await claudeRow(srv.base);
    return r && r.state !== 'running' ? r : null;
  });
  ok('a file held past the retry budget fails with a SENTENCE, not .NET text',
    row.state === 'error' && /占用/.test(row.message ?? '') && !/process cannot access/i.test(row.message ?? ''),
    JSON.stringify(row));
  ok('…and the installed binary is untouched — still v3, still there',
    fs.existsSync(claudeExe) && Buffer.compare(fs.readFileSync(claudeExe), payloadV3) === 0);
  long.p.kill();
  release.close();
  srv.stop(); srv = undefined;

  // --- G · the login button spawns the RESOLVED binary -------------------------------------------
  //
  // Previously recorded as untestable, which was too strong a claim. The objection was that SUCCEEDING
  // opens an interactive console — true of `claude auth login`, which waits for a human in a browser and
  // never returns. It is not true of a stub that records its arguments and exits. The real rule is that a
  // suite must not leave a window waiting for somebody, not that no child process may ever have one.
  //
  // What this proves is the reason the button exists at all: it runs the binary this install RESOLVES to,
  // rather than the bare word `claude` a household following our older advice would have typed — which
  // cannot work for a copy we provisioned, whose directory is never on PATH.
  const dirG = freshDir('g');
  const marker = path.join(dirG, 'spawned.txt');
  const loginStub = path.join(dirG, 'login-stub.cmd');
  // A .cmd rather than the usual `node <file>` stub: StartLogin uses ShellExecute so the login window is
  // the child's own, and ShellExecute takes a FILE, not a command line. That difference is the point — it
  // is why this path needs its own stub instead of reusing writeAuthStub.
  fs.writeFileSync(loginStub, [
    '@echo off',
    `echo %* >> "${marker}"`,
    'if "%1"=="auth" if "%2"=="status" (',
    '  echo {"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",'
      + '"email":"household@example.com","subscriptionType":"max"}',
    '  exit /b 0',
    ')',
    'exit /b 1',
    '',
  ].join('\r\n'));

  srv = startServer({
    dataDir: dirG, port: PORT_LOGIN,
    env: { ...claudeless, GATHERLIGHT_CLAUDE_CMD: loginStub },
  });
  await settled(srv.base);

  const started = await cliPost(srv.base, '/api/manage/resources/claude/login');
  ok('the login button starts the flow rather than refusing', started.status === 202,
    `${started.status} ${JSON.stringify(started.body)}`);

  // Polled: the spawn is detached by design — the endpoint answers before the child has run, which is what
  // keeps a browser flow that waits for a human off the request path.
  let spawned = '';
  for (let i = 0; i < 40; i++) {
    spawned = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    if (/auth login/.test(spawned)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  ok('…and it really ran the resolved binary, with `auth login`',
    /auth login/.test(spawned), JSON.stringify(spawned.trim().split(/\r?\n/).slice(-3)));

  // ANTI-VACUITY. The assertion above would also pass if the endpoint spawned something on its own and the
  // marker happened to exist — so prove the marker is written BY THIS BINARY, by checking the probe's own
  // `auth status` call landed in the same file. Both lines present means the file is this stub's argv log.
  ok('the marker really is this stub\u2019s argv log, not an artefact',
    /auth status/.test(spawned), JSON.stringify(spawned.trim().split(/\r?\n/).slice(0, 2)));

  // REMOTE IS REFUSED. The window opens on the machine running the server, so a remote click would open a
  // window nobody can see and report success — the endpoint checks the peer is loopback. Asserted through
  // a forwarded header because the fixture can only connect over loopback: this proves the check reads the
  // CONNECTION rather than a header any caller could set.
  const spoofRes = await fetch(`${srv.base}/api/manage/resources/claude/login`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': '203.0.113.9' },
  });
  const spoofBody = await spoofRes.json().catch(() => ({}));
  // Asserted on the REASON, not the status. A second call can legitimately be refused by StartLogin's own
  // reentrancy guard if the stub has not finished exiting, and that 409 is indistinguishable from a remote
  // refusal by status alone — which would make this flaky AND misleading. The two carry different messages,
  // so the precise claim is available: whatever happens, it is never the machine-location refusal.
  ok('a spoofed forwarded-for does not turn a loopback click into a remote one',
    spoofRes.status === 202 || !/那台机器/.test(String(spoofBody.error ?? '')),
    `${spoofRes.status} ${JSON.stringify(spoofBody)}`);
  srv.stop(); srv = undefined;

} catch (err) {
  fail('e2e-p50 fatal: ' + err.message);
  console.error(srv?.log?.().slice(-3000) ?? '');
} finally {
  try { srv?.stop(); } catch { /* best effort */ }
}
done();
