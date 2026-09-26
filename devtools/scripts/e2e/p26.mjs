#!/usr/bin/env node
// e2e-p26 — background jobs. Exercises the generic scheduler backend end to end via the API + the
// AI tool surface, using the claude stub: create (cron next-run), the four job kinds run on demand
// (tool / notify / report-less agent-commit / agent stage→approve), failure auto-disable, the global
// kill-switch setting, and the notification feed. Scheduler cadence itself isn't waited on — every
// run here is triggered via /run (run-now), which shares the same execution path as the loop — except case 10, where
// the LOOP is the point: it must not tick while the startup migration runs.
import path from 'node:path';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, gitLog, tracked } from './_e2e-common.mjs';

const dataDir = dataDirFor('p26');
const { ok, fail, done } = makeReporter('p26');
makeTestData(dataDir);
const srv = startServer({ dataDir, port: 5396, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { j, post, put, del, getJson, call } = makeClient(srv.base);

const future = '2026-12-01T09:00:00Z';

try {
  await waitHealthy(srv.base);
  console.log('server up');

  // 1) create a recurring (cron) job → next_run_at computed to a future instant.
  const cron = await post('/api/jobs', {
    name: '每周提醒', kind: 'notify', schedule: 'cron', cron: '0 9 * * 1', timezone: 'Asia/Shanghai',
    config: { title: '周计划提醒', body: '该做本周计划了' },
  });
  ok('create cron job 200', cron.status === 200 && !!cron.body.job?.id, JSON.stringify(cron.body));
  ok('cron next_run computed (future)', new Date(cron.body.job?.nextRunAt) > new Date(), cron.body.job?.nextRunAt);

  // 2) AI tool surface — job_schedule via /api/tools/call, then job_list sees it.
  const sched = await call('job_schedule', {
    name: '一次性提醒', kind: 'notify', schedule: 'once', runAt: future, notifyTitle: '记得续签',
  });
  ok('job_schedule tool ok', sched.result?.ok === true && !!sched.result?.id);
  const listed = await call('job_list', {});
  ok('job_list shows the scheduled job', (listed.result?.jobs ?? []).some((x) => x.id === sched.result.id));

  // 3) tool job — deterministic, no LLM. Run now → success.
  const toolJob = await post('/api/jobs', {
    name: '重建索引', kind: 'tool', schedule: 'once', runAt: future, config: { tool: 'index_reindex', args: {} },
  });
  ok('create tool job 200', toolJob.status === 200);
  const toolRun = await post(`/api/jobs/${toolJob.body.job.id}/run`);
  ok('tool job run succeeded', toolRun.body.run?.status === 'success', JSON.stringify(toolRun.body.run));

  // 4) notify job — run now → a notification appears in the feed.
  const notifyJob = await post('/api/jobs', {
    name: '测试通知', kind: 'notify', schedule: 'once', runAt: future, config: { title: '测试通知内容', body: 'hi' },
  });
  await post(`/api/jobs/${notifyJob.body.job.id}/run`);
  const feed1 = await getJson('/api/notifications');
  ok('notify job created a notification', feed1.items.some((n) => n.title === '测试通知内容'));
  ok('unread count > 0', feed1.unreadCount > 0);

  // 5) agent job, auto-commit — run now → the stub writes a plan file → committed to the data repo.
  const before = gitLog(dataDir).length;
  const autoJob = await post('/api/jobs', {
    name: '自动整理', kind: 'agent', schedule: 'once', runAt: future, autoCommit: true,
    config: { instructions: '整理明日计划 JOBMARK:auto' },
  });
  const autoRun = await post(`/api/jobs/${autoJob.body.job.id}/run`);
  ok('agent auto-commit succeeded', autoRun.body.run?.status === 'success', JSON.stringify(autoRun.body.run));
  ok('auto-commit outcome mentions 提交', (autoRun.body.run?.outcome ?? '').includes('提交'));
  ok('data repo grew by a commit', gitLog(dataDir).length === before + 1);

  // 6) agent job, stage-for-review — run now → staged (tree stays clean); approve → committed.
  const stageJob = await post('/api/jobs', {
    name: '起草计划', kind: 'agent', schedule: 'once', runAt: future, autoCommit: false,
    config: { instructions: '起草计划 JOBMARK:stg' },
  });
  const stageRun = await post(`/api/jobs/${stageJob.body.job.id}/run`);
  ok('agent stage produced a staged run', stageRun.body.run?.status === 'staged', JSON.stringify(stageRun.body.run));
  const runId = stageRun.body.run.id;
  const beforeApprove = gitLog(dataDir).length;
  const approve = await post(`/api/jobs/runs/${runId}/approve`);
  ok('approve staged run committed', approve.status === 200 && !!approve.body.sha, JSON.stringify(approve.body));
  ok('approve added a commit', gitLog(dataDir).length === beforeApprove + 1);
  ok('staged file tracked after approve', tracked(dataDir, 'plans/daily/2026-07-14.md'));

  // 7) failure auto-disable — a cron job whose tool doesn't exist; run it 3× → auto-disabled.
  const badJob = await post('/api/jobs', {
    name: '坏任务', kind: 'tool', schedule: 'cron', cron: '0 0 1 1 *', config: { tool: 'no_such_tool', args: {} },
  });
  ok('create failing job 200', badJob.status === 200 && !!badJob.body.job?.id, JSON.stringify(badJob.body));
  const badId = badJob.body.job?.id;
  if (badId) {
    for (let i = 0; i < 3; i++) await post(`/api/jobs/${badId}/run`);
    const badAfter = await j(`/api/jobs/${badId}`);
    ok('job auto-disabled after 3 failures', badAfter.body.job?.enabled === false, `enabled=${badAfter.body.job?.enabled}`);
  }

  // 8) global kill-switch setting round-trips.
  const off = await put('/api/jobs/settings', { enabled: false });
  ok('kill-switch persists', off.body?.enabled === false);
  await put('/api/jobs/settings', { enabled: true });

  // 9) notifications — mark one read → unread count drops.
  const feed2 = await getJson('/api/notifications');
  const unreadBefore = feed2.unreadCount;
  await post(`/api/notifications/${feed2.items[0].id}/read`);
  const feed3 = await getJson('/api/notifications');
  ok('mark-read lowers unread count', feed3.unreadCount === unreadBefore - 1, `${unreadBefore} → ${feed3.unreadCount}`);

  // 10) the scheduler waits for the STARTUP MIGRATION. It used to wait a fixed 5 s, so a startup that took longer — a
  //     layout rebuild or a re-embed of a large corpus — had a due job running beside it (a remember_fact tool job
  //     writing facts while the rebuild cleared and re-indexed every ref). Staged with the runner's delay seam: a job due
  //     at boot, a migration held open 20 s — no run while it is open, one run once it has finished.
  const jobDir = dataDirFor('p26-migrating');
  makeTestData(jobDir);
  const JOB_PORTS = [5614, 5615];
  let boot = startServer({ dataDir: jobDir, port: JOB_PORTS[0], env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  try {
    await waitHealthy(boot.base);
    const created = await makeClient(boot.base).post('/api/jobs', {
      name: '迁移中不运行', kind: 'tool', schedule: 'once', runAt: future, config: { tool: 'index_reindex', args: {} },
    });
    ok('(fixture 10) a tool job is created', created.status === 200 && !!created.body?.job?.id, JSON.stringify(created.body));
    boot.stop();
    await new Promise((r) => setTimeout(r, 1500));
    // Due a minute ago — inside the catch-up grace, so the first tick fires it.
    const { DatabaseSync } = await import('node:sqlite');
    const jobDb = path.join(jobDir, 'state', 'gatherlight.db');
    const due = new Date(Date.now() - 60000).toISOString();
    const runsOf = () => {
      const db = new DatabaseSync(jobDb, { readOnly: true });
      try { return db.prepare('SELECT COUNT(*) n FROM job_run WHERE job_id = ?').get(created.body.job.id).n; }
      finally { db.close(); }
    };
    {
      const db = new DatabaseSync(jobDb);
      try { db.prepare('UPDATE job SET run_at = ?, next_run_at = ? WHERE id = ?').run(due, due, created.body.job.id); }
      finally { db.close(); }
    }
    boot = startServer({ dataDir: jobDir, port: JOB_PORTS[1], env: {
      GATHERLIGHT_CLAUDE_CMD: claudeStubCmd, GATHERLIGHT_MIGRATION_TEST_DELAY: '20000' } });
    let firstAnswer = 0;
    for (let i = 0; i < 240 && !firstAnswer; i++) {
      try { if ((await fetch(`${boot.base}/api/health`)).ok) firstAnswer = Date.now(); } catch { /* not up yet */ }
      if (!firstAnswer) await new Promise((r) => setTimeout(r, 250));
    }
    // Well past the scheduler's old fixed 5 s, well inside the 20 s the migration is held open.
    await new Promise((r) => setTimeout(r, 11000));
    const stillMigrating = (await (await fetch(`${boot.base}/api/health`)).json().catch(() => ({}))).migrating === true;
    const runsDuring = runsOf();
    ok('THE POINT: while the startup migration runs, a due job does NOT run',
      !!firstAnswer && stillMigrating && runsDuring === 0, JSON.stringify({ stillMigrating, runsDuring }));
    await waitHealthy(boot.base);
    let runsAfter = 0;
    for (let i = 0; i < 80 && runsAfter === 0; i++) {
      runsAfter = runsOf();
      if (!runsAfter) await new Promise((r) => setTimeout(r, 250));
    }
    ok('…and once it has finished, the job runs — at the first tick, not a poll later', runsAfter === 1, `runs=${runsAfter}`);
  } finally {
    boot.stop();
  }
} catch (err) {
  fail('e2e-p26 fatal: ' + err.message);
  console.error(srv.log().slice(-4000));
} finally {
  srv.stop();
}
done();
