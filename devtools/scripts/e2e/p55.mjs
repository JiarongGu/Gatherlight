#!/usr/bin/env node
// e2e-p55 — the OFFERED Git Bash for the agent (item 2). A household with no Git Bash has no shell
// (PowerShell + Monitor removed), so 资源 offers PortableGit; once installed, the app hands the CLI its
// bin\bash.exe through CLAUDE_CODE_GIT_BASH_PATH — re-applied per probe so a mid-life install is adopted
// with no restart — and never overrules the household's own Git Bash. MinGit (the data repo's git) ships
// no bash.exe and cannot serve, which is why this is a separate resource.
//
// The dev machine has Git for Windows at the default path, so the "no Git Bash" branch is reached via the
// test seam GATHERLIGHT_ASSUME_NO_GIT_BASH=1 (the fixture hides the machine's install).
import fs from 'node:fs';
import path from 'node:path';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd } from './_e2e-common.mjs';

const { ok, fail, done } = makeReporter('p55');

const lastSpawn = (envLog) => {
  try {
    const rows = fs.readFileSync(envLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => r.kind === 'plan' || r.kind === 'execute' || r.kind === 'other');
    return rows[rows.length - 1] ?? null;
  } catch { return null; }
};

// Drive one agent turn (a plan spawn) so the stub records the env it was handed, and return that record.
const spawnEnv = async (post, waitPhase, envLog) => {
  const before = (() => { try { return fs.readFileSync(envLog, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } })();
  const s = await post('/api/chat', { message: '给明天建一个日计划' });
  await waitPhase(s.body.id, 'awaiting-plan-approval');
  // the newest spawn line after `before`
  const rows = fs.readFileSync(envLog, 'utf8').split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l));
  const env = rows.filter((r) => r.gitBash !== undefined).pop() ?? lastSpawn(envLog);
  // Release the agent lease so the next turn is not 409 BUSY (a parked plan gate holds it).
  await post(`/api/chat/${s.body.id}/plan/reject`);
  await waitPhase(s.body.id, 'rejected');
  return env;
};

// ---------- A: no Git Bash → offered; install adopts it mid-life (no restart) ----------
const dirA = dataDirFor('p55');
makeTestData(dirA);
const envLogA = `${dirA}-env.jsonl`;
try { fs.rmSync(envLogA); } catch {}
const provisionedBash = path.join(dirA, 'state', 'resources', 'git-bash', 'bin', 'bash.exe');

const srvA = startServer({
  dataDir: dirA, port: 6195,
  env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd, GATHERLIGHT_STUB_ENV_LOG: envLogA, GATHERLIGHT_ASSUME_NO_GIT_BASH: '1' },
});
const A = makeClient(srvA.base);

try {
  await waitHealthy(srvA.base);
  console.log('server A up');

  // The offer: a git-bash row, not installed, whose detail says download (and names the file-tool fallback).
  const res1 = await A.j('/api/manage/resources');
  const row = (res1.body.resources ?? []).find((r) => r.id === 'git-bash');
  ok('资源 lists a git-bash row', !!row, JSON.stringify((res1.body.resources ?? []).map((r) => r.id)));
  ok('git-bash not installed on a fresh folder', row && row.installed === false, JSON.stringify(row));
  ok('the offer says download + the file-tool fallback', row && /下载/.test(row.detail ?? '') && /文件工具/.test(row.detail ?? ''), row?.detail);
  // Security review (2026-09-28) — the household never saw 「PowerShell 已移除」 (a dev-facing fact) nor a
  // 「判断」 caveat, so the git-bash row's text carries neither.
  ok('the git-bash row names no PowerShell removal and no 判断', row
    && !/PowerShell/i.test(JSON.stringify(row)) && !/判断/.test(JSON.stringify(row)), JSON.stringify(row));

  // Nothing to set yet: the agent spawn gets no git-bash path.
  const e1 = await spawnEnv(A.post, A.waitPhase, envLogA);
  ok('with none discoverable and none installed, no git-bash var is set', e1 && (e1.gitBash === null), JSON.stringify(e1?.gitBash));

  // Install it (a stub bash.exe stands in for the real PortableGit), then a resources GET re-applies —
  // the mid-life adopt, no restart. The next agent spawn is handed the provisioned path.
  fs.mkdirSync(path.dirname(provisionedBash), { recursive: true });
  fs.writeFileSync(provisionedBash, '@stub bash\n');
  await A.j('/api/manage/resources');   // triggers ClaudeCliRuntime.Apply()
  const res2 = await A.j('/api/manage/resources');
  const row2 = (res2.body.resources ?? []).find((r) => r.id === 'git-bash');
  ok('once installed, the row says the agent uses this Git Bash', row2 && /用这个 Git Bash/.test(row2.detail ?? ''), row2?.detail);

  const e2 = await spawnEnv(A.post, A.waitPhase, envLogA);
  ok('THE POINT: the agent spawn is handed the provisioned Git Bash (adopted mid-life, no restart)',
    e2 && typeof e2.gitBash === 'string' && e2.gitBash.replace(/\\/g, '/').endsWith('git-bash/bin/bash.exe'),
    JSON.stringify(e2?.gitBash));
} catch (err) {
  fail('e2e-p55 A fatal: ' + err.message);
  console.error(srvA.log().slice(-2500));
} finally {
  srvA.stop();
}

// ---------- B: the household's own CLAUDE_CODE_GIT_BASH_PATH wins ----------
const dirB = dataDirFor('p55-household');
makeTestData(dirB);
const envLogB = `${dirB}-env.jsonl`;
try { fs.rmSync(envLogB); } catch {}
// Provision our git-bash too, to prove the household's is preferred even when ours exists.
const ourBash = path.join(dirB, 'state', 'resources', 'git-bash', 'bin', 'bash.exe');
fs.mkdirSync(path.dirname(ourBash), { recursive: true });
fs.writeFileSync(ourBash, '@stub bash\n');
const householdBash = path.join(dirB, 'household-git', 'bin', 'bash.exe');
fs.mkdirSync(path.dirname(householdBash), { recursive: true });
fs.writeFileSync(householdBash, '@household bash\n');

const srvB = startServer({
  dataDir: dirB, port: 6196,
  env: {
    GATHERLIGHT_CLAUDE_CMD: claudeStubCmd, GATHERLIGHT_STUB_ENV_LOG: envLogB,
    GATHERLIGHT_ASSUME_NO_GIT_BASH: '1', CLAUDE_CODE_GIT_BASH_PATH: householdBash,
  },
});
const B = makeClient(srvB.base);
try {
  await waitHealthy(srvB.base);
  console.log('server B up');
  const e = await spawnEnv(B.post, B.waitPhase, envLogB);
  ok('THE POINT: the household\'s own CLAUDE_CODE_GIT_BASH_PATH is left untouched (not our provisioned one)',
    e && e.gitBash === householdBash, `got=${JSON.stringify(e?.gitBash)} want=${householdBash}`);
  const res = await B.j('/api/manage/resources');
  const row = (res.body.resources ?? []).find((r) => r.id === 'git-bash');
  ok('the row says the household already set a Git Bash', row && /已设置了 Git Bash/.test(row.detail ?? ''), row?.detail);
} catch (err) {
  fail('e2e-p55 B fatal: ' + err.message);
  console.error(srvB.log().slice(-2500));
} finally {
  srvB.stop();
}

done();
