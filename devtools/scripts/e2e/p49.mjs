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
//   F  GIT_DIR inherited from the launcher → the data repo is still the data folder's, and the repo GIT_DIR names is
//                                            untouched (a SCRATCH repo, never the working one)
//   G  …and a Claude Code session too     → no claude the app spawns (startup probe, agent turn, one-shot call) gets
//                                            either, and the agent's own git finds the data repo; the rest still arrives
//      …and an API key, another endpoint, a provider switch and the app's access token (G2) → none reaches a claude, while
//                                            the subscription login (CLAUDE_CODE_OAUTH_TOKEN) does; no value is logged
//      …and the switches that add a tool past the guard (G3) → none arrives, native file search does; and every agent
//                                            run, plan and execute, removes PowerShell and Monitor (--disallowed-tools)
//      …and a ONE-SHOT call (G4, Lyntai 3.5.2) → removes PowerShell, Monitor and Bash, takes the one-shot settings, loads
//                                            no setting source, and runs — with the startup probe — from a directory the
//                                            process owns, never the shared temp folder
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { dataDirFor, makeReporter, repo, startServer, until, makeClient } from './_e2e-common.mjs';

const { ok, fail, done } = makeReporter('p49');

// Free ports — not used by any other suite (5499 was the previous high-water mark).
const PORT_NO_NET = 5501;
const PORT_TAMPERED = 5502;
const PORT_PROVISIONED = 5503;
const PORT_ON_PATH = 5504;
const PORT_REAL = 5505;
// Case F's. Outside every Windows-excluded tcp range of 2026-09-27 (one of which holds the five above, so this suite
// runs shifted there) and outside p17's wildcard probe window, where a port of ours would have to join p17's list. (No
// range is written out here on purpose: the runner's port scan reads comments too.)
const PORT_INHERITED_GIT = 5381;
// Case G's, beside it for the same reasons.
const PORT_INHERITED_CLI = 5382;
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

      // THE RUNTIME THIS APP PROVISIONS FOR LOCAL MODELS. Asserted here rather than downloaded: p49's own
      // case D exists because a surprise 37 MB is its own defect, and that applies to a suite too. What
      // matters is that the entry is declared, pinned and cheap — the download itself was verified by hand
      // (35 MB zip → 98 MB extracted → `--list-devices` enumerating two GPUs).
      const llama = rows.find((r) => r.id === 'llama-cpp');
      ok('the catalog carries the llama.cpp runtime entry', !!llama,
        JSON.stringify(rows.map((r) => r.id)));
      // Size is the whole argument for choosing it over Ollama — 42× smaller — so a bound is asserted
      // rather than the exact byte count, which moves with every upstream build.
      ok('and it is the SMALL one: under 60 MB, where Ollama is over a gigabyte',
        (llama?.approxBytes ?? 0) > 5_000_000 && (llama?.approxBytes ?? 0) < 60_000_000,
        String(llama?.approxBytes));
      // OLLAMA IS NOT HERE, and this is the assertion that keeps it out. 资源 provisions what Gatherlight
      // manages; Ollama is a HOUSEHOLD runtime we detect and connect to. The spec used to sit right here
      // offering a 1.46 GB download, which is how "a runtime the app installs" and "a prerequisite you
      // install yourself" became indistinguishable — to a household, and then to us, in our own docs.
      //
      // Paired with its positive control on the next line, because a denial alone would also pass on a
      // build that had lost the whole catalog: llama.cpp — the runtime we DO install — must still be here.
      const ids = rows.map((r) => r.id);
      ok('Ollama is NOT offered for download — we connect to it, we do not install it',
        !ids.includes('ollama'), ids.join(','));
      ok('…while the runtime we DO manage is still offered (the control for that denial)',
        ids.includes('llama-cpp'), ids.join(','));

      // THE SHELF. Every GGUF in GgufCatalog becomes a resource, generated rather than hand-written — one
      // list for one set. Asserted as a shape rather than by name so adding a model does not break this,
      // except for the two the product actually recommends, which are named on purpose.
      const ggufs = rows.filter((r) => r.id.startsWith('gguf-'));
      ok('every catalogued GGUF is offerable as a resource', ggufs.length >= 2,
        JSON.stringify(ggufs.map((r) => r.id)));
      ok('and each is sha256-pinnable with a real size, not a placeholder',
        ggufs.every((r) => r.approxBytes > 1_000_000), JSON.stringify(ggufs.map((r) => r.approxBytes)));
      // BOTH capabilities have to be downloadable, and this is the assertion that would have caught the
      // gap this increment closed: 判断 could be BOUND to llama.cpp while no chat model existed to bind
      // it to, so its status pointed at a 资源 row that was not there.
      ok('an EMBEDDING gguf is offered (语义 needs one)',
        ids.includes('gguf-embeddinggemma-300M-Q8_0'), ids.join(','));
      ok('and a CHAT gguf is offered too (判断 needs one, and had none)',
        ids.some((i) => i.startsWith('gguf-gemma-3-')), ids.join(','));

      // WHAT each resource IS, declared by the server. This is pinned because it broke silently TWICE:
      // the console grouped models by a hardcoded list of ids, and both times an id changed shape the
      // list matched nothing and weights quietly reappeared in the runtimes column beside Chromium.
      // Nothing threw either time — the rows just moved. Category comes from the spec now, and this
      // asserts the property rather than the position, so a rename cannot re-break it.
      ok('every model declares itself a model, and every runtime a runtime',
        ggufs.every((r) => r.category === 'model')
          && rows.find((r) => r.id === 'embed-model')?.category === 'model'
          && ['git', 'node', 'llama-cpp', 'claude']
            .every((i) => rows.find((r) => r.id === i)?.category === 'runtime'),
        JSON.stringify(rows.map((r) => `${r.id}:${r.category}`)));
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

  // ---- F · git state INHERITED from whatever launched the app must not choose its repository --------
  // The incident (2026-09-27): a debugging agent ran `git bisect run` from a linked WORKTREE, and bisect run exports
  // GIT_DIR (`.git/worktrees/<name>`) to every child. A fixture server's git commands inherited it — and GIT_DIR skips
  // discovery, so the ceiling that stops a walk-up (GIT_CEILING_DIRECTORIES) never came into it. The data repo's
  // `git init` set core.bare = true on the developer's MAIN repository, the fixture's commits landed on the worktree's
  // HEAD, and DataRepoMaintenance's `reflog expire --expire=now --all` + `gc --prune=now` erased every reflog.
  // ChildEnvironment now strips the repository-selecting variables from every git the app spawns — and, since case G,
  // from the whole process at startup, so F passes on either half (G fails without the second). This is the incident
  // against a SCRATCH repo of the same shape — a main repo with one linked worktree, GIT_DIR naming the worktree's
  // gitdir — NEVER the working repository. Plus a config injection (GIT_CONFIG_PARAMETERS, which `git -c k=v bisect
  // run` exports): the data repo's `git config user.name` probe would read an injected name as already set, and every
  // commit of the audit trail would carry it.
  {
    const scratch = path.join(repo, 'devtools', '_e2e-p49-scratch-repo');
    fs.rmSync(scratch, { recursive: true, force: true });
    const scratchMain = path.join(scratch, 'main');
    const scratchWt = path.join(scratch, 'wt');
    fs.mkdirSync(scratchMain, { recursive: true });
    // Every harness git call on the scratch is pinned to it: the ceiling keeps a missing .git from walking up into
    // the working repository this suite runs inside, and the identity is given per call, never configured.
    const sgit = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=p49', '-c', 'user.email=p49@localhost', ...args],
      { cwd, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch } });
    sgit(scratchMain, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(scratchMain, 'a.txt'), 'one\n');
    sgit(scratchMain, 'add', 'a.txt');
    sgit(scratchMain, 'commit', '-q', '-m', 'scratch one');
    fs.writeFileSync(path.join(scratchMain, 'a.txt'), 'two\n');
    sgit(scratchMain, 'commit', '-q', '-am', 'scratch two');
    sgit(scratchMain, 'worktree', 'add', '-q', '-b', 'side', scratchWt);
    const scratchGit = path.join(scratchMain, '.git');
    const worktreeGitDir = path.join(scratchGit, 'worktrees', 'wt');
    ok('(fixture F) a scratch repo with a linked worktree, whose gitdir is what bisect run exports as GIT_DIR',
      fs.existsSync(path.join(worktreeGitDir, 'HEAD')) && fs.existsSync(path.join(worktreeGitDir, 'commondir')),
      worktreeGitDir);

    // Every file under the scratch's .git, by content — read directly, never through git, so taking the snapshot
    // cannot itself touch what it measures.
    const snapshot = () => {
      const out = new Map();
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else out.set(path.relative(scratchGit, p), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
        }
      };
      walk(scratchGit);
      return out;
    };
    const lines = (rel) => { try { return fs.readFileSync(path.join(scratchGit, rel), 'utf8').split('\n').filter(Boolean).length; } catch { return -1; } };
    const bare = () => (fs.readFileSync(path.join(scratchGit, 'config'), 'utf8').match(/^\s*bare\s*=\s*(\S+)/m) ?? [])[1] ?? '(unset)';
    const before = snapshot();
    const bareBefore = bare();
    const reflogsBefore = { main: lines('logs/HEAD'), side: lines('worktrees/wt/logs/HEAD') };
    const wtHeadBefore = sgit(scratchWt, 'rev-parse', 'HEAD').trim();

    const dirF = freshDir('f');
    srv = startServer({
      dataDir: dirF, port: PORT_INHERITED_GIT,
      env: { GIT_DIR: worktreeGitDir, GIT_CONFIG_PARAMETERS: "'user.name'='zzp49-inherited-author'" },
    });
    snap = await settled(srv.base);
    ok('with GIT_DIR and an injected config inherited, the boot still completes', snap.phase === 'completed', snap.error ?? '');
    const dataGit = path.join(dirF, '.git');
    ok('THE POINT (F): the data repo is created IN the data folder', fs.existsSync(path.join(dataGit, 'HEAD')), dataGit);
    let dataLog = [];
    if (fs.existsSync(path.join(dataGit, 'HEAD'))) {
      try {
        dataLog = execFileSync('git', ['--git-dir', dataGit, 'log', '--format=%an%x1f%s'], { encoding: 'utf8' })
          .split('\n').filter(Boolean).map((l) => l.split('\x1f'));
      } catch { /* an empty repo reads as no log — the assertion below says so */ }
    }
    ok('…and holds the fixture\'s own commits (the initial import at least)',
      dataLog.some(([, s]) => s === 'data: initial import'), JSON.stringify(dataLog));
    // Never the INJECTED name — not "always Gatherlight": EnsureRepoAsync sets that identity only when `git config
    // user.name` answers nothing, and on a machine with a global identity it answers with that one.
    ok('…and none of them is signed with the injected identity',
      dataLog.length > 0 && !dataLog.some(([a]) => a === 'zzp49-inherited-author'),
      `${dataLog.filter(([a]) => a === 'zzp49-inherited-author').length} of ${dataLog.length} commit(s) carry it`);
    srv.stop(); srv = undefined;
    // The server is gone before the scratch is read, so nothing is still writing when it is measured.
    await new Promise((r) => setTimeout(r, 1500));

    const changed = (() => {
      const after = snapshot();
      return [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
    })();
    ok('THE POINT (F): the repo GIT_DIR named is untouched — core.bare as it was', bare() === bareBefore,
      `core.bare ${bareBefore} → ${bare()}`);
    ok('…its worktree\'s HEAD unmoved (no fixture commit landed on it)',
      sgit(scratchWt, 'rev-parse', 'HEAD').trim() === wtHeadBefore, `${wtHeadBefore} → ${sgit(scratchWt, 'rev-parse', 'HEAD').trim()}`);
    ok('…its reflogs intact', lines('logs/HEAD') === reflogsBefore.main && lines('worktrees/wt/logs/HEAD') === reflogsBefore.side,
      JSON.stringify({ before: reflogsBefore, after: { main: lines('logs/HEAD'), side: lines('worktrees/wt/logs/HEAD') } }));
    ok('…and not one file under its .git changed', changed.length === 0, changed.slice(0, 12).join(', '));

    // ---- G · the claude CLI — and the agent's own git — inherit neither the launcher's repository nor its session ----
    // F is the app's OWN git. The claude CLI is another child that runs git in the data folder — its agent's Bash does —
    // and Lyntai builds each CLI run's environment from this process's own, able only to ADD to it: so a launcher's
    // GIT_DIR reached the agent untouched. And a server started from a Claude Code session (the dev loop, every fixture
    // booted from one) handed every CLI it spawned THAT session's markers: its id, its pid, its messaging pipe and token.
    // ChildEnvironment.ForgetLauncherContext drops both from the whole process at startup. The stub records, per spawn,
    // the names it got and what a `git` run from its cwd finds — what the agent's Bash would work on. The control
    // variable proves the environment was narrowed, not wiped; every value here is the fixture's own, never a real one.
    //
    // G2, the same boot: what would take the CLI OFF the subscription login (owner decision 2026-09-28, "never an API
    // key", enforced at spawn) and the app's own secrets. The CLI's docs rank an API key, a provider switch and a gateway
    // bearer above /login, and in -p mode an ANTHROPIC_API_KEY "is always used when present"; ANTHROPIC_BASE_URL would
    // send every prompt to another host. The positive control is CLAUDE_CODE_OAUTH_TOKEN — `claude setup-token`'s
    // subscription token, which the rule allows and which must still arrive. Every value is an obvious fake, and only the
    // stub runs: nothing here reaches a real CLI or a real endpoint.
    const dirG = freshDir('g');
    const envLog = path.join(repo, 'devtools', '_e2e-p49-g-stub-env.jsonl');
    fs.rmSync(envLog, { force: true });
    const TOKEN = 'zzp49-parent-session-token-never-logged';
    const FAKE = {
      ANTHROPIC_API_KEY: 'zzp49-fake-not-an-api-key', ANTHROPIC_BASE_URL: 'http://zzp49-fake-endpoint.invalid',
      CLAUDE_CODE_USE_BEDROCK: '1', GATHERLIGHT_ACCESS_TOKEN: 'zzp49-fake-access-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'zzp49-fake-oauth-token', CLAUDE_EFFORT: 'zzp49-fake-effort',
      TRACEPARENT: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      // G3: the CLI's switches that can add the agent a tool past the scope guard — and one that cannot, kept.
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1', CLAUDE_CODE_USE_COWORK_PLUGINS: '1', CLAUDE_CODE_USE_CCR_V2: '1',
      CLAUDE_CODE_USE_NATIVE_FILE_SEARCH: '1',
    };
    const argsLog = path.join(repo, 'devtools', '_e2e-p49-g-stub-args.jsonl');
    fs.rmSync(argsLog, { force: true });
    srv = startServer({
      dataDir: dirG, port: PORT_INHERITED_CLI,
      env: {
        GIT_DIR: worktreeGitDir, GIT_CONFIG_PARAMETERS: "'user.name'='zzp49-inherited-author'",
        CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'zzp49-parent-session',
        CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\zzp49-parent', CLAUDE_CODE_MESSAGING_TOKEN: TOKEN, CLAUDE_PID: '1',
        ZZE2E_KEPT: 'kept', GATHERLIGHT_STUB_ENV_LOG: envLog, GATHERLIGHT_STUB_ARGS_LOG: argsLog, ...FAKE,
      },
    });
    snap = await settled(srv.base);
    ok('(fixture G) with a repository and a Claude Code session inherited, the boot completes', snap.phase === 'completed', snap.error ?? '');
    const cG = makeClient(srv.base);
    // An agent turn (Lyntai's IAgentSession — chat, jobs, the playground and the validation pass all run there) …
    const startedG = await cG.post('/api/chat', { message: '给明天建一个日计划' });
    await cG.waitPhase(startedG.body?.id, 'awaiting-plan-approval');
    // … and a one-shot call (Lyntai's ClaudeCliProvider — the scorers, the memory judge, 语义's rephrasing): a fact write
    // is annotated by the judge, which is on by default.
    await cG.call('remember_fact', { kind: 'preference', topic: 'zzp49 inherited env', content: 'zzp49 a fact to annotate',
      source: 'https://example.test/zzp49', confidence: 0.9 });
    const readEnvLog = () => (fs.existsSync(envLog)
      ? fs.readFileSync(envLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    await until(() => readEnvLog().some((s) => s.kind === 'annotation'), 60000).catch(() => {});
    const spawns = readEnvLog();
    const kinds = [...new Set(spawns.map((s) => s.kind))];
    ok('(fixture G) the stub recorded the startup probe, an agent turn and a one-shot call',
      ['auth-status', 'plan', 'annotation'].every((k) => kinds.includes(k)), JSON.stringify(kinds));
    const LAUNCHER_CONTEXT = /^(GIT_DIR|GIT_WORK_TREE|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_EXEC_PATH|CLAUDECODE|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|EXECPATH|SSE_PORT)|CLAUDE_PID|CLAUDE_EFFORT|TRACEPARENT|TRACESTATE)$/i;
    const leaked = spawns.filter((s) => s.watched.some((n) => LAUNCHER_CONTEXT.test(n)));
    ok('THE POINT (G): no claude the app spawned inherited the launcher\'s repository or its Claude Code session',
      spawns.length > 0 && leaked.length === 0,
      leaked.slice(0, 3).map((s) => `${s.kind}: ${s.watched.filter((n) => LAUNCHER_CONTEXT.test(n)).join(',')}`).join(' | '));
    const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const agentRuns = spawns.filter((s) => s.kind === 'plan');
    ok('…so the agent\'s own git, run from its working directory, finds the DATA repo — never the one GIT_DIR named',
      agentRuns.length > 0 && agentRuns.every((s) => norm(s.gitDir) === norm(path.join(dirG, '.git'))),
      JSON.stringify(agentRuns.map((s) => s.gitDir)));
    ok('…while everything else the app was started with still reaches it (narrowed, not wiped)',
      spawns.length > 0 && spawns.every((s) => s.kept === 'kept'), JSON.stringify(spawns.map((s) => s.kept)));
    const logsG = (() => {
      const d = path.join(dirG, 'state', 'logs');
      return fs.existsSync(d) ? fs.readdirSync(d).map((x) => fs.readFileSync(path.join(d, x), 'utf8')).join('\n') : '';
    })();
    const droppedLine = (logsG.match(/Child environment: dropped [^\n]*/) ?? [''])[0];
    ok('…the startup log names what it dropped', ['GIT_DIR', 'GIT_CONFIG_PARAMETERS', 'CLAUDECODE', 'CLAUDE_CODE_MESSAGING_TOKEN']
      .every((n) => new RegExp(`\\b${n}\\b`).test(droppedLine)), droppedLine || '(no line)');
    ok('…and never a value: the session token is in no log', !logsG.includes(TOKEN) && !srv.log().includes(TOKEN));

    // ---- G2 · off the subscription, and the app's own secrets --------------------------------------------------------
    const OFF_SUBSCRIPTION = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK'];
    const gotAny = (names) => spawns.filter((s) => s.watched.some((n) => names.some((m) => m.toLowerCase() === n.toLowerCase())));
    const offLeaks = gotAny(OFF_SUBSCRIPTION);
    ok('THE POINT (G2): no claude the app spawned got an API key, another endpoint or a provider switch — the startup probe included',
      spawns.length > 0 && offLeaks.length === 0,
      offLeaks.slice(0, 3).map((s) => `${s.kind}: ${s.watched.filter((n) => OFF_SUBSCRIPTION.includes(n)).join(',')}`).join(' | '));
    const secretLeaks = gotAny(['GATHERLIGHT_ACCESS_TOKEN']);
    ok("THE POINT (G2): …nor the app's own remote-access token", spawns.length > 0 && secretLeaks.length === 0,
      secretLeaks.map((s) => s.kind).join(', '));
    ok('(G2) …while the subscription login, CLAUDE_CODE_OAUTH_TOKEN, still reaches every one — the positive control',
      spawns.length > 0 && spawns.every((s) => s.watched.includes('CLAUDE_CODE_OAUTH_TOKEN')),
      JSON.stringify(spawns.map((s) => [s.kind, s.watched.includes('CLAUDE_CODE_OAUTH_TOKEN')])));
    const ignoredLines = logsG.split('\n').filter((l) => l.includes('Claude CLI: ignored ') && l.includes('never an API key'));
    const ignoredLine = ignoredLines[0] ?? '';
    ok('(G2) …the startup log says once, by name, what the CLI will not see',
      OFF_SUBSCRIPTION.every((n) => ignoredLine.split(/[\s,]+/).includes(n)) && ignoredLines.length === 1,
      ignoredLine || '(no line)');
    const settingsG = (await cG.j('/api/manage/settings')).body ?? {};
    ok('(G2) …and the app itself still knows its token came from the environment: the settings panel says it is overridden',
      (settingsG.envOverrides ?? []).includes('accessToken'), JSON.stringify(settingsG.envOverrides));
    const logText = logsG + srv.log() + (fs.existsSync(envLog) ? fs.readFileSync(envLog, 'utf8') : '');
    const valuesSeen = Object.entries(FAKE).filter(([, v]) => v.length > 4 && logText.includes(v)).map(([k]) => k);
    ok("(G2) …and not one of those values is in any log — the server's, its file log or the stub's",
      valuesSeen.length === 0, valuesSeen.join(', '));

    // ---- G3 · no tool the scope guard cannot see ----------------------------------------------------------------------
    // The guard is a PreToolUse hook whose matcher names Edit|Write|MultiEdit|NotebookEdit|Bash|Read|Grep|Glob, and a
    // built-in outside it never reaches the guard. Two such built-ins run shell commands: PowerShell, which the CLI turns on
    // BY DEFAULT on Windows (so stripping CLAUDE_CODE_USE_POWERSHELL_TOOL alone cannot remove it) and whose Set-Content /
    // Remove-Item acceptEdits auto-approves in the data folder; and Monitor, which "uses the same permission rules as Bash"
    // and so ran under the execute settings' bare Bash allow. Every agent run now names both in --disallowed-tools
    // (UnguardedTools, applied in AgentRunner — the one door every run site uses). And the switches that could add a tool
    // are stripped from the environment, while one documented not to (native file search) still arrives.
    const AGENT_TOOL_SWITCHES = ['CLAUDE_CODE_USE_POWERSHELL_TOOL', 'CLAUDE_CODE_USE_COWORK_PLUGINS', 'CLAUDE_CODE_USE_CCR_V2'];
    const switchLeaks = gotAny(AGENT_TOOL_SWITCHES);
    ok('THE POINT (G3): no claude the app spawned got a switch that could add it a tool past the guard',
      spawns.length > 0 && switchLeaks.length === 0,
      switchLeaks.slice(0, 3).map((s) => `${s.kind}: ${s.watched.filter((n) => AGENT_TOOL_SWITCHES.includes(n)).join(',')}`).join(' | '));
    ok('(G3) …while the one documented to change no tool, CLAUDE_CODE_USE_NATIVE_FILE_SEARCH, still arrives — the control',
      spawns.length > 0 && spawns.every((s) => s.watched.includes('CLAUDE_CODE_USE_NATIVE_FILE_SEARCH')),
      JSON.stringify(spawns.map((s) => [s.kind, s.watched.includes('CLAUDE_CODE_USE_NATIVE_FILE_SEARCH')])));
    const toolsLine = logsG.split('\n').find((l) => l.includes('Claude CLI: ignored ') && l.includes('past the scope guard')) ?? '';
    ok('(G3) …and the startup log names those switches, once',
      AGENT_TOOL_SWITCHES.every((n) => toolsLine.split(/[\s,]+/).includes(n)), toolsLine || '(no line)');
    // The execute run is the one in acceptEdits, where PowerShell's writes were auto-approved: drive the plan through.
    await cG.post(`/api/chat/${startedG.body?.id}/plan/approve`);
    await cG.waitPhase(startedG.body?.id, 'awaiting-diff-approval');
    const readArgsLog = () => (fs.existsSync(argsLog)
      ? fs.readFileSync(argsLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    const disallowedOf = (args) => {
      const i = args.indexOf('--disallowed-tools');
      return i >= 0 ? String(args[i + 1] ?? '').split(',') : [];
    };
    const agentSpawns = readArgsLog().filter((e) => e.kind === 'plan' || e.kind === 'execute');
    const agentKinds = [...new Set(agentSpawns.map((e) => e.kind))];
    ok('(fixture G3) the args log holds the agent turn\'s plan AND execute spawns', ['plan', 'execute'].every((k) => agentKinds.includes(k)),
      JSON.stringify(agentKinds));
    const unfenced = agentSpawns.filter((e) => !['PowerShell', 'Monitor'].every((t) => disallowedOf(e.args).includes(t)));
    ok('THE POINT (G3): every agent run — plan and execute — removes PowerShell and Monitor from the CLI (--disallowed-tools)',
      agentSpawns.length > 0 && unfenced.length === 0,
      unfenced.slice(0, 2).map((e) => `${e.kind}: ${disallowedOf(e.args).join(',') || '(no --disallowed-tools)'}`).join(' | '));

    // ---- G4 · the ONE-SHOT path, since Lyntai 3.5.2 --------------------------------------------------------------------
    // The scorers, the memory judge and 语义's rephrasing are Lyntai's one-shot calls (ClaudeCliProvider), which through
    // 3.5.1 had no seam for any of this: they ran with the CLI's default tools but AskUserQuestion, no settings file, and
    // from the account's SHARED temp folder, whose project .claude/settings.json any program could plant (Lyntai TASKS.md
    // Parts 330 and 333). Now each call is configured per consumer (ClaudeCliBackend.CompletionByConsumer): the agent runs'
    // shell removals and Bash too (a judge reads a prompt and answers it), the one-shot settings file (the blanked key
    // paths, disableSkillShellExecution, the read fence), NO setting source (a CLAUDE.md walks up from any cwd, so only
    // this keeps one out) and no project .mcp.json — from a directory the process owns (Lyntai D196). The startup probe
    // runs from that directory too.
    // The LAST occurrence: the CLI applies only the last --settings it is handed (docs/self-managed-llm-runtime.md 2026-09-30).
    const valueOf = (args, flag) => { const i = args.lastIndexOf(flag); return i >= 0 ? String(args[i + 1] ?? '') : null; };
    const oneShots = readArgsLog().filter((e) => e.kind === 'annotation');
    ok('(fixture G4) the args log holds the fact write\'s one-shot annotation call', oneShots.length > 0, JSON.stringify(readArgsLog().map((e) => e.kind)));
    const unfencedOneShot = oneShots.filter((e) => !['AskUserQuestion', 'PowerShell', 'Monitor', 'Bash'].every((t) => disallowedOf(e.args).includes(t)));
    ok('THE POINT (G4): the one-shot call removes PowerShell, Monitor AND Bash — beside AskUserQuestion, which it always did',
      oneShots.length > 0 && unfencedOneShot.length === 0,
      unfencedOneShot.slice(0, 2).map((e) => disallowedOf(e.args).join(',') || '(no --disallowed-tools)').join(' | '));
    const unsettled = oneShots.filter((e) => !/[\\/]state[\\/]settings\.oneshot\.json$/.test(valueOf(e.args, '--settings') ?? ''));
    ok('(G4) …is handed the one-shot settings file (state/settings.oneshot.json)', oneShots.length > 0 && unsettled.length === 0,
      unsettled.slice(0, 2).map((e) => valueOf(e.args, '--settings') ?? '(no --settings)').join(' | '));
    const sourced = oneShots.filter((e) => valueOf(e.args, '--setting-sources') !== '' || !e.args.includes('--strict-mcp-config'));
    ok('(G4) …loads NO setting source (--setting-sources "") and no project .mcp.json (--strict-mcp-config)',
      oneShots.length > 0 && sourced.length === 0,
      sourced.slice(0, 2).map((e) => `sources=${JSON.stringify(valueOf(e.args, '--setting-sources'))} strict=${e.args.includes('--strict-mcp-config')}`).join(' | '));
    const sharedTemp = norm(process.env.TMP || process.env.TEMP || os.tmpdir());
    const neutralSpawns = readEnvLog().filter((s) => s.kind === 'annotation' || s.kind === 'auth-status');
    const inShared = neutralSpawns.filter((s) => norm(s.cwd) === sharedTemp || norm(path.dirname(s.cwd)) !== sharedTemp
      || !/^lyntai-cli-[0-9a-f]{16}$/.test(path.basename(s.cwd)));
    ok('(G4) …and it and the startup probe run from a directory the process owns UNDER temp — never the shared temp folder itself',
      ['annotation', 'auth-status'].every((k) => neutralSpawns.some((s) => s.kind === k)) && inShared.length === 0,
      JSON.stringify(neutralSpawns.map((s) => [s.kind, s.cwd]).slice(0, 4)) + ` shared=${sharedTemp}`);
    ok('(G4) …the SAME directory for both — Lyntai\'s, which the probe shares (ClaudeCliRuntime.NeutralDirectory)',
      new Set(neutralSpawns.map((s) => norm(s.cwd))).size === 1, JSON.stringify([...new Set(neutralSpawns.map((s) => s.cwd))]));
    srv.stop(); srv = undefined;
    await new Promise((r) => setTimeout(r, 1500));
    const changedG = (() => {
      const after = snapshot();
      return [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
    })();
    ok('…and not one file under the scratch repo\'s .git changed through G either', changedG.length === 0, changedG.slice(0, 12).join(', '));
  }
} catch (err) {
  fail('e2e-p49 fatal: ' + err.message);
  console.error(srv?.log?.().slice(-3000) ?? '');
} finally {
  try { srv?.stop(); } catch { /* best effort */ }
}
done();
