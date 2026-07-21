#!/usr/bin/env node
// e2e P29 — startup migration runner: gated serving phase, status feed, self-heal, essential-fail + retry.
import fs from 'node:fs';
import path from 'node:path';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, claudeStubCmd, until } from './_e2e-common.mjs';

const dataDir = dataDirFor('p29');
const { ok, fail, done } = makeReporter('p29');
makeTestData(dataDir);
const baseEnv = { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd };
const PORT = 5429;
const base = `http://127.0.0.1:${PORT}`;
const health = async () => { try { const r = await fetch(`${base}/api/health`); return { ok: r.ok, j: await r.json().catch(() => ({})) }; } catch { return { ok: false, j: {} }; } };
const status = async () => { const r = await fetch(`${base}/api/migration/status`); return r.json(); };
const settle = () => new Promise((r) => setTimeout(r, 800));

let srv;
try {
  // --- Boot A: fresh, with a delay so the gated window is observable ----------------------
  srv = startServer({ dataDir, port: PORT, env: { ...baseEnv, GATHERLIGHT_MIGRATION_TEST_DELAY: '2500' } });
  try {
    // health answers early (during migration) with migrating:true
    const up = await until(async () => { const h = await health(); return h.ok ? h : null; }, 20000);
    ok('A: health up during migration', up.ok === true);
    ok('A: health reports migrating:true', up.j.migrating === true, JSON.stringify(up.j));
    // a normal /api is gated 503 while migrating
    const gated = await fetch(`${base}/api/plans`);
    ok('A: normal /api gated 503 while migrating', gated.status === 503, `status=${gated.status}`);
    // status feed shows the phase + steps
    const st = await status();
    ok('A: status running with steps', st.phase === 'running' && Array.isArray(st.steps) && st.steps.length >= 5, JSON.stringify({ p: st.phase, n: st.steps?.length }));
    // waitHealthy now waits for migrating:false → then normal /api works
    await waitHealthy(base);
    const done1 = await status();
    ok('A: completed with all essential steps ok', done1.phase === 'completed' && done1.steps.every((s) => s.status === 'ok' || (!s.essential)), JSON.stringify(done1.steps?.map((s) => [s.id, s.status])));
    const plans = await fetch(`${base}/api/plans`);
    ok('A: /api serves after migration', plans.ok, `status=${plans.status}`);
  } finally { srv.stop(); await settle(); }

  // --- Boot B: restart with a tampered repo (stale lock + a dirty file) → self-heal --------
  fs.writeFileSync(path.join(dataDir, '.git', 'index.lock'), '', 'utf8');
  fs.mkdirSync(path.join(dataDir, 'plans', 'daily'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'plans', 'daily', '_leftover.md'), '# leftover from an interrupted task\n', 'utf8');
  srv = startServer({ dataDir, port: PORT, env: baseEnv });
  try {
    await waitHealthy(base);
    const st = await status();
    ok('B: stale index.lock removed', !fs.existsSync(path.join(dataDir, '.git', 'index.lock')));
    const warns = (st.warnings ?? []).join(' | ');
    ok('B: lock cleanup surfaced', warns.includes('index.lock'), warns);
    ok('B: dirty tree surfaced', warns.includes('未提交'), warns);
  } finally { srv.stop(); await settle(); }
  // tidy the leftover so a re-run of the suite is clean
  try { fs.rmSync(path.join(dataDir, 'plans', 'daily', '_leftover.md')); } catch {}

  // --- Boot C: force an essential step to fail → gate stays closed, retry re-runs ----------
  srv = startServer({ dataDir, port: PORT, env: { ...baseEnv, GATHERLIGHT_MIGRATION_TEST_FAIL: 'data-repo' } });
  try {
    // migration never lifts — poll the status feed for phase==='failed' (NOT waitHealthy).
    const failed = await until(async () => { const s = await status().catch(() => null); return s && s.phase === 'failed' ? s : null; }, 20000);
    ok('C: essential failure → phase failed', failed.phase === 'failed');
    ok('C: failed step recorded', failed.steps.some((s) => s.id === 'data-repo' && s.status === 'failed'), JSON.stringify(failed.steps?.map((s) => [s.id, s.status])));
    const h = await health();
    ok('C: still migrating (gate closed)', h.j.migrating === true, JSON.stringify(h.j));
    const gated = await fetch(`${base}/api/plans`);
    ok('C: /api still gated 503', gated.status === 503, `status=${gated.status}`);
    const retry = await fetch(`${base}/api/migration/retry`, { method: 'POST' });
    ok('C: retry accepted (200)', retry.status === 200, `status=${retry.status}`);
  } finally { srv.stop(); await settle(); }
} catch (err) {
  fail('e2e-p29 fatal: ' + err.message);
  console.error(srv?.log?.().slice(-3000) ?? '');
} finally {
  try { srv?.stop(); } catch {}
}
done();
