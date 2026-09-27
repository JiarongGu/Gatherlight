#!/usr/bin/env node
// e2e-p54 — the scoped agent file tools (fs_move / fs_delete / file_info).
//
// They exist because a household with no Git Bash has no shell (PowerShell + Monitor are removed from
// every run), so moving/renaming/deleting a plan file needs a TOOL — one whose scope is the guard's own
// write scope, whose changes land at the diff gate, and which works ONLY in the execute phase.
//
// The stub drives the loopback MCP endpoint directly (a fake CLI does not honour --allowedTools), so what
// this asserts is the ENFORCEMENT: the tool's own run-scope check bounces a mutation in the read-only plan
// phase and permits it in the execute phase; the write scope refuses an out-of-scope target; an existing
// target is not overwritten; and the successful move/delete reach the diff gate and commit.
import fs from 'node:fs';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, gitLog, tracked, onDisk } from './_e2e-common.mjs';

const dataDir = dataDirFor('p54');
const { ok, fail, done } = makeReporter('p54');
makeTestData(dataDir);

const fsopsLog = `${dataDir}-fsops.jsonl`;
const argsLog = `${dataDir}-args.jsonl`;
for (const f of [fsopsLog, argsLog]) { try { fs.rmSync(f); } catch {} }

const srv = startServer({
  dataDir, port: 6194,
  env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd, GATHERLIGHT_STUB_FSOPS_LOG: fsopsLog, GATHERLIGHT_STUB_ARGS_LOG: argsLog },
});
const { post, waitPhase } = makeClient(srv.base);

const readLog = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

try {
  await waitHealthy(srv.base);
  console.log('server up');

  ok('fixture trip file is tracked at boot', tracked(dataDir, 'plans/trips/2026-08-kyoto.md'));

  // --- plan -> execute -----------------------------------------------------------------------
  const start = await post('/api/chat', { message: 'FSOPSTEST 整理一下计划文件' });
  ok('chat start 200', start.status === 200 && !!start.body.id);
  const id = start.body.id;

  await waitPhase(id, 'awaiting-plan-approval');

  // The plan-phase call to fs_move must be REFUSED — read-only run, the run scope forbids writes.
  const planRows = readLog(fsopsLog).find((e) => e.phase === 'plan')?.rows ?? [];
  const planMove = planRows.find((r) => r.op === 'move-in-plan');
  ok('plan-phase fs_move refused (run-scope)',
    !!planMove && (planMove.isError === true || planMove.status === 403),
    JSON.stringify(planMove));
  ok('plan-phase refusal names the execute phase',
    !!planMove && /执行/.test(planMove.text ?? ''), planMove?.text);
  ok('plan-phase left the file in place', tracked(dataDir, 'plans/trips/2026-08-kyoto.md') && onDisk(dataDir, 'plans/trips/2026-08-kyoto.md'));

  // AllowedTools per policy: the plan spawn must NOT pre-approve the write-scoped tools (defence in depth).
  const spawns = readLog(argsLog);
  const planSpawn = spawns.find((s) => s.kind === 'plan');
  const planArgs = (planSpawn?.args ?? []).join(' ');
  ok('plan spawn excludes fs_move from --allowedTools', !planArgs.includes('mcp__planner-tools__fs_move'), planArgs.slice(0, 200));
  ok('plan spawn still lists a read tool', planArgs.includes('mcp__planner-tools__file_info') || planArgs.includes('mcp__planner-tools__scrape'), planArgs.slice(0, 200));

  await post(`/api/chat/${id}/plan/approve`);
  const diff = await waitPhase(id, 'awaiting-diff-approval');

  // Execute-phase file-op results.
  const execRows = readLog(fsopsLog).find((e) => e.phase === 'execute')?.rows ?? [];
  const row = (op) => execRows.find((r) => r.op === op);
  ok('execute fs_move succeeded', row('move-ok') && !row('move-ok').isError && row('move-ok').status === 200, JSON.stringify(row('move-ok')));
  ok('execute fs_delete succeeded', row('delete-ok') && !row('delete-ok').isError, JSON.stringify(row('delete-ok')));
  ok('execute file_info read size/mtime', row('info-ok') && /bytes/.test(row('info-ok').text ?? ''), row('info-ok')?.text);
  ok('out-of-scope target refused', row('move-out-of-scope') && (row('move-out-of-scope').isError === true || row('move-out-of-scope').status >= 400), JSON.stringify(row('move-out-of-scope')));
  ok('existing target not overwritten', row('move-overwrite-refused') && (row('move-overwrite-refused').isError === true || row('move-overwrite-refused').status === 409), JSON.stringify(row('move-overwrite-refused')));

  // The execute spawn DID pre-approve the write tools. Re-read the args log — the execute spawn was
  // written after the plan-phase read above.
  const execArgs = (readLog(argsLog).find((s) => s.kind === 'execute')?.args ?? []).join(' ');
  ok('execute spawn includes fs_move in --allowedTools', execArgs.includes('mcp__planner-tools__fs_move'), execArgs.slice(0, 200));

  // The move + delete reach the diff gate as working-tree changes.
  const paths = (diff.review?.files ?? []).map((f) => f.path);
  ok('diff gate shows the moved-in path (added)', paths.includes('plans/trips/2026-08-kyoto-moved.md'), JSON.stringify(paths));
  ok('diff gate shows the moved-out path (deleted)', paths.includes('plans/trips/2026-08-kyoto.md'), JSON.stringify(paths));
  ok('diff gate shows the deleted budget (deleted)', paths.includes('plans/budgets/2026-08-kyoto.md'), JSON.stringify(paths));

  // --- approve -> commit ---------------------------------------------------------------------
  const before = gitLog(dataDir).length;
  await post(`/api/chat/${id}/diff/approve`);
  const committed = await waitPhase(id, 'committed');
  ok('committed with sha', !!committed.commitSha);
  ok('one commit added', gitLog(dataDir).length === before + 1);
  ok('moved file tracked at new path', tracked(dataDir, 'plans/trips/2026-08-kyoto-moved.md'));
  ok('old path gone from disk + index', !onDisk(dataDir, 'plans/trips/2026-08-kyoto.md') && !tracked(dataDir, 'plans/trips/2026-08-kyoto.md'));
  ok('deleted budget gone from disk + index', !onDisk(dataDir, 'plans/budgets/2026-08-kyoto.md') && !tracked(dataDir, 'plans/budgets/2026-08-kyoto.md'));
} catch (err) {
  fail('e2e-p54 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
