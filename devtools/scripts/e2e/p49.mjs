#!/usr/bin/env node
// e2e P49 — a fresh install on a machine with NO git must boot BY ITSELF.
//
// The bug this suite exists to prevent: the lean bundle ships no git on purpose (download-at-setup,
// like chromium), so on a new PC the essential data-repo step spawned the PATH "git" that wasn't there
// and died with a raw Win32 "系统找不到指定的文件". Being essential it kept the startup gate closed — and
// the one remedy the product documented, the 资源 · Resources panel, is /api, which that same gate 503s.
// The failure locked its own fix away and 重试 could never succeed: the install was unrecoverable.
//
// So git is provisioned automatically now (GitRuntimeStep, immediately before data-repo), and each case
// below is a distinct thing that must hold — every denial paired with a positive control, per the house
// rule that a denial without one is half a test:
//   A  no git, download impossible        → actionable failure, data-repo never even attempted, retryable
//   B  no git, TAMPERED download          → refused on the sha256 pin (never run an unverified binary)
//   C  no git, but a provisioned copy     → boots with NO download, ON that copy (the stale-resolve bug)
//   D  git on PATH                        → boots, and downloads NOTHING (no surprise 37MB)
//   E  no git, real MinGit on loopback    → the actual first-boot path, end to end (needs the cache)
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { dataDirFor, makeReporter, repo, startServer, until, makeClient } from './_e2e-common.mjs';

const { ok, fail, done } = makeReporter('p49');

// Free ports — not used by any other suite (5499 was the previous high-water mark).
const PORT_NO_NET = 5501;
const PORT_TAMPERED = 5502;
const PORT_PROVISIONED = 5503;
const PORT_ON_PATH = 5504;
const PORT_REAL = 5505;
// Nothing binds this one, ever — it is the "there is no network" fixture: a download URL that cannot
// connect. Kept out of the range above so a future suite doesn't take it and quietly make cases pass.
const DEAD_URL = 'http://127.0.0.1:5599/MinGit.zip';

// A machine with no git: every PATH entry that carries one, removed. This is the whole fixture — the
// failure was never about the data folder, only about what the host happens to have installed.
const gitlessPath = (process.env.PATH || '').split(';').filter((p) => {
  if (!p) return false;
  try { return !fs.existsSync(path.join(p, 'git.exe')) && !fs.existsSync(path.join(p, 'git.cmd')); }
  catch { return true; }
}).join(';');
// BOTH casings, deliberately: `{...process.env}` yields whatever casing Windows gave (usually `Path`),
// so setting only `PATH` would leave the child holding two entries and no rule about which one wins.
const gitless = { PATH: gitlessPath, Path: gitlessPath, GATHERLIGHT_GIT: '' };

const freshDir = (suffix) => {
  const dir = dataDirFor(`p49-${suffix}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** Wait for the startup migration to settle (completed or failed) and return the snapshot. */
const settled = (base) => until(async () => {
  const r = await fetch(`${base}/api/migration/status`);
  if (!r.ok) return null;
  const s = await r.json();
  return s.phase === 'running' ? null : s;
});

const step = (snap, id) => snap.steps.find((s) => s.id === id);
const RAW_WIN32 = /系统找不到指定的文件|An error occurred trying to start process/;

/** Serve `body` (or 404 when null) over loopback; returns { url, close }. */
const serve = (body) => new Promise((resolve) => {
  const srv = http.createServer((_req, res) => {
    if (!body) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.length });
    res.end(body);
  });
  srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}/MinGit.zip`,
    close: () => { try { srv.close(); } catch { /* best effort */ } },
  }));
});

let srv;
try {
  // ---- A · no git and no way to get one: fail with a sentence a household can act on ------------
  const dirA = freshDir('a');
  srv = startServer({
    dataDir: dirA, port: PORT_NO_NET,
    env: { ...gitless, GATHERLIGHT_GIT_URL: DEAD_URL },
  });
  let snap = await settled(srv.base);
  const gitStepA = step(snap, 'git-runtime');
  const repoStepA = step(snap, 'data-repo');
  ok('a git-runtime step exists', !!gitStepA, JSON.stringify(snap.steps.map((s) => s.id)));
  ok('and runs BEFORE data-repo', snap.steps.indexOf(gitStepA) < snap.steps.indexOf(repoStepA),
    `${snap.steps.indexOf(gitStepA)} vs ${snap.steps.indexOf(repoStepA)}`);
  ok('with no git and no download, the boot fails there', snap.phase === 'failed' && gitStepA?.status === 'failed',
    `${snap.phase} / ${gitStepA?.status}`);
  ok('data-repo is never even attempted', repoStepA?.status === 'pending', repoStepA?.status);
  ok('the failure names git and what to do about it',
    /Git/i.test(snap.error ?? '') && /重试|网络/.test(snap.error ?? ''), snap.error);
  ok('and is NOT the raw Win32 message the household used to get', !RAW_WIN32.test(snap.error ?? ''), snap.error);
  ok('the download attempt is on the record', /Resource provision failed: git/.test(srv.log()));
  // Retry must be OFFERED and must re-attempt — the old failure's retry could never succeed, because
  // nothing it could reach installed git. This one retries the download itself.
  const retry = await fetch(`${srv.base}/api/migration/retry`, { method: 'POST' });
  ok('retry is accepted (it re-attempts the download)', retry.status === 200, String(retry.status));
  const again = await settled(srv.base);
  ok('and lands on the same actionable failure, not a new mystery',
    again.phase === 'failed' && /Git/i.test(again.error ?? ''), again.error);
  srv.stop(); srv = undefined;

  // ---- B · a tampered download is refused: never RUN an unverified binary we just fetched --------
  const dirB = freshDir('b');
  const junk = await serve(Buffer.alloc(2048, 7));   // not MinGit → sha256 cannot match the pin
  srv = startServer({ dataDir: dirB, port: PORT_TAMPERED, env: { ...gitless, GATHERLIGHT_GIT_URL: junk.url } });
  snap = await settled(srv.base);
  junk.close();
  ok('a download whose bytes are wrong is refused', snap.phase === 'failed', snap.phase);
  ok('and says so by the checksum, not by some later symptom', /sha256/i.test(snap.error ?? ''), snap.error);
  ok('nothing was installed from it',
    !fs.existsSync(path.join(dirB, 'state', 'resources', 'git', 'cmd', 'git.exe')));
  srv.stop(); srv = undefined;

  // ---- C · git appears while the app is RUNNING: the retry must see it, with no restart -----------
  // The regression guarded here, and the reason this case installs git mid-life rather than before the
  // boot: GitCliService used to resolve its executable ONCE in its constructor, which DI builds before
  // any step runs. A git that arrives after that — which is every automatic provision, since the step
  // downloading it runs later — stayed invisible, so the app remained gated with its own remedy already
  // on disk. A fixture that put git in place FIRST would pass against exactly that broken code.
  const dirC = freshDir('c');
  let gitRoot = null;
  try {
    // Every hit, not the first: `where git` lists mingw64\bin\git.exe ahead of cmd\git.exe on a stock
    // Git for Windows, and only the latter's parent tree has the layout the provisioner produces.
    for (const line of execFileSync('where', ['git'], { encoding: 'utf8' }).split('\n')) {
      const hit = line.trim();
      if (!hit) continue;
      const candidate = path.dirname(path.dirname(hit));
      if (fs.existsSync(path.join(candidate, 'cmd', 'git.exe'))) { gitRoot = candidate; break; }
    }
  } catch { /* no git on this box at all — handled below */ }
  if (!gitRoot) {
    console.log('  · no MinGit-shaped git install found to stand in for a provisioned one — skipping case C');
  } else {
    srv = startServer({
      dataDir: dirC, port: PORT_PROVISIONED,
      env: { ...gitless, GATHERLIGHT_GIT_URL: DEAD_URL },   // unreachable ON PURPOSE
    });
    snap = await settled(srv.base);
    ok('(setup) the gitless boot failed as in case A', snap.phase === 'failed', snap.phase);

    const resources = path.join(dirC, 'state', 'resources');
    fs.mkdirSync(resources, { recursive: true });
    // A junction, not a copy: what matters is the LAYOUT a provision produces
    // ({resources}/git/cmd/git.exe), and copying a whole git install per run would cost hundreds of MB.
    const link = spawnSync('cmd', ['/c', 'mklink', '/J', path.join(resources, 'git'), gitRoot], { encoding: 'utf8' });
    if (link.status !== 0) {
      console.log(`  · could not create the junction (${(link.stderr || link.stdout || '').trim()}) — skipping case C`);
    } else {
      const retryC = await fetch(`${srv.base}/api/migration/retry`, { method: 'POST' });
      ok('(setup) retry accepted after git appeared on disk', retryC.status === 200, String(retryC.status));
      // `settled`, not `waitHealthy`: the regression this case guards leaves the gate closed forever, and
      // a 180s harness timeout reports "something hung" where the migration status says exactly what broke.
      snap = await settled(srv.base);
      ok('a git that appears mid-life is picked up with no restart and no PATH',
        snap.phase === 'completed', snap.error ?? '');
      ok('and nothing was downloaded (the unreachable URL was never touched again)',
        (srv.log().match(/provisioning the portable git/g) ?? []).length === 1, 'a second download was attempted');
      ok('the data repo runs on THAT copy',
        /Data repo git: .*state.resources.git.cmd.git\.exe/.test(srv.log()),
        (srv.log().match(/Data repo git: .*/) ?? ['(never logged)'])[0]);
      ok('and the repo was actually initialized', fs.existsSync(path.join(dirC, '.git')));
      // The panel reports it as present — the same catalog entry startup provisions from.
      const { getJson } = makeClient(srv.base);
      const rows = (await getJson('/api/manage/resources')).resources ?? [];
      const gitRow = rows.find((r) => r.id === 'git');
      ok('the resources catalog carries the git entry', !!gitRow, JSON.stringify(rows.map((r) => r.id)));
      ok('reported installed, and saying what it is for',
        gitRow?.installed === true && /数据仓库/.test(String(gitRow?.neededFor ?? '')),
        JSON.stringify(gitRow));
    }
    srv.stop(); srv = undefined;
  }

  // ---- D · a household that already has git must not be handed a surprise download ---------------
  const dirD = freshDir('d');
  srv = startServer({ dataDir: dirD, port: PORT_ON_PATH });   // untouched PATH → git available
  snap = await settled(srv.base);
  ok('with git on PATH the boot completes', snap.phase === 'completed', snap.error ?? '');
  ok('the git step passes without downloading anything',
    step(snap, 'git-runtime')?.status === 'ok' && !/provisioning the portable git/.test(srv.log()));
  ok('and no portable copy is written into the data folder',
    !fs.existsSync(path.join(dirD, 'state', 'resources', 'git')));
  srv.stop(); srv = undefined;

  // ---- E · the real first-boot path, end to end (needs the cached MinGit zip) --------------------
  const cache = path.join(repo, 'devtools', '_cache');
  const cached = fs.existsSync(cache)
    ? fs.readdirSync(cache).find((f) => /^MinGit-.*-64-bit\.zip$/.test(f))
    : undefined;
  if (!cached) {
    console.log('  · devtools/_cache holds no MinGit zip (it is a `publish --offline` artifact) — skipping case E');
  } else {
    const dirE = freshDir('e');
    const real = await serve(fs.readFileSync(path.join(cache, cached)));
    srv = startServer({ dataDir: dirE, port: PORT_REAL, env: { ...gitless, GATHERLIGHT_GIT_URL: real.url } });
    snap = await settled(srv.base);
    real.close();
    ok('a fresh install with NO git anywhere boots on its own', snap.phase === 'completed', snap.error ?? '');
    ok('it installed the portable git into the data folder (survives updates)',
      fs.existsSync(path.join(dirE, 'state', 'resources', 'git', 'cmd', 'git.exe')));
    ok('the data repo exists', fs.existsSync(path.join(dirE, '.git')));
    ok('and the app is serving, not gated',
      (await (await fetch(`${srv.base}/api/health`)).json()).migrating === false);
    ok('the wait was explained while it happened',
      /首次启动已自动安装便携版 Git/.test(JSON.stringify(snap.warnings)), JSON.stringify(snap.warnings));
    srv.stop(); srv = undefined;
  }
} catch (err) {
  fail('e2e-p49 fatal: ' + err.message);
  console.error(srv?.log?.().slice(-3000) ?? '');
} finally {
  try { srv?.stop(); } catch { /* best effort */ }
}
done();
