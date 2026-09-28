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
//
// The round-6 whole-branch review added four things this suite now drives:
//   C1  `.claude` ITSELF resolved as writable (PROTECTED was checked for a path UNDER an entry, never one CONTAINING
//       it), so fs_move/fs_delete could move or delete it whole — out, rewrite settings.json, back in; and a project
//       settings file the agent was never allowed to write survived Reject. Now a path containing a protected entry
//       and a write-dir root are refused, and the project config files the CLI loads on its own (.claude/settings*.json,
//       .mcp.json) are moved out of the data folder at boot and around every agent run there.
//   I1  the diff gate is file-level, so the tools are FILE-ONLY.
//   I2  runs that hold no agent lease (extract over HTTP, the playground, the migrator) share the run scope, so a
//       read-only run overlapping an execute run could refuse its writes, or leave writes allowed at rest.
//   minors: a plain tilde is a name (only `~` + digit is an 8.3 short name), and a target is checked for a symlinked
//       parent even when it does not exist yet.
import fs from 'node:fs';
import path from 'node:path';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, gitLog, tracked, onDisk, until } from './_e2e-common.mjs';

const dataDir = dataDirFor('p54');
const { ok, fail, done } = makeReporter('p54');
// A 5xxx literal on purpose: the runner keeps suites port-disjoint by scanning each file for 5xxx literals, and
// checks them against Windows' reserved ranges before a run. The 6194 this suite first used was invisible to both.
const PORT = 5623;
// Outside the data folder: a junction under plans/ points here, so a write through it would land outside the jail.
const outside = `${dataDir}-outside`;
fs.rmSync(outside, { recursive: true, force: true });
makeTestData(dataDir);
fs.mkdirSync(outside, { recursive: true });

const fsopsLog = `${dataDir}-fsops.jsonl`;
const argsLog = `${dataDir}-args.jsonl`;
const overlapMark = `${dataDir}-overlap`;
for (const f of [fsopsLog, argsLog, `${overlapMark}.started`, `${overlapMark}.response`]) { try { fs.rmSync(f); } catch {} }

// C1, the boot half: project config files an earlier run (or anything else) left in the data folder, untracked. The
// CLI would load both on the next agent run — so the startup re-issue moves them out, before any run.
const plantedAtBoot = {
  '.mcp.json': '{"_e2e":"planted-before-boot","mcpServers":{}}\n',
  '.claude/settings.local.json': '{"_e2e":"planted-before-boot","permissions":{}}\n',
};
for (const [rel, text] of Object.entries(plantedAtBoot)) fs.writeFileSync(path.join(dataDir, rel), text, 'utf8');
// The upload the overlapping read-only run (extract) reads.
fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'uploads', 'overlap.pdf'), '%PDF-1.4 overlap fixture');
// plans/linkout → outside the data folder. Not a real plan directory; nothing writes it but the refused row.
fs.symlinkSync(outside, path.join(dataDir, 'plans', 'linkout'), 'junction');

const srv = startServer({
  dataDir, port: PORT,
  env: {
    GATHERLIGHT_CLAUDE_CMD: claudeStubCmd, GATHERLIGHT_STUB_FSOPS_LOG: fsopsLog, GATHERLIGHT_STUB_ARGS_LOG: argsLog,
    GATHERLIGHT_STUB_OVERLAP_MARK: overlapMark, GATHERLIGHT_STUB_HTTP_BASE: `http://127.0.0.1:${PORT}`,
  },
});
const { j, post, waitPhase } = makeClient(srv.base);

const readLog = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const quarantined = (rel) => {
  // state/quarantine/<stamp>/<rel> — the sweep keeps what it moved, so a household's own file is recoverable.
  const q = path.join(dataDir, 'state', 'quarantine');
  try { return fs.readdirSync(q).some((stamp) => fs.existsSync(path.join(q, stamp, rel))); } catch { return false; }
};

try {
  await waitHealthy(srv.base);
  console.log('server up');

  ok('fixture trip file is tracked at boot', tracked(dataDir, 'plans/trips/2026-08-kyoto.md'));
  ok('C1: an untracked .mcp.json left in the data folder is gone after boot', !onDisk(dataDir, '.mcp.json'));
  ok('C1: an untracked .claude/settings.local.json is gone after boot', !onDisk(dataDir, '.claude/settings.local.json'));
  ok('C1: both were kept in state/quarantine, not destroyed',
    quarantined('.mcp.json') && quarantined('.claude/settings.local.json'));

  // I2 (the HTTP half): the mutating tools are MCP-only, so the HTTP surface neither lists nor runs them.
  const httpTools = ((await j('/api/tools')).body?.tools ?? []).map((t) => t.name);
  ok('I2: /api/tools lists neither fs_move nor fs_delete (MCP-only)',
    !httpTools.includes('fs_move') && !httpTools.includes('fs_delete') && httpTools.includes('file_info'),
    JSON.stringify(httpTools.filter((n) => n.startsWith('f'))));

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

  // Item 5 — a plan (read-only) run is CONFINED to the data folder: it passes the read-only settings
  // file, which sets permissions.blockReadsOutsideWorkingDirectories and registers the guard hook.
  ok('plan spawn passes the read-only settings', planArgs.includes('settings.chat.readonly.json'), planArgs.slice(0, 260));
  const roSettingsRaw = (() => { try { return fs.readFileSync(`${dataDir}/state/settings.chat.readonly.json`, 'utf8'); } catch { return ''; } })();
  const roSettings = (() => { try { return JSON.parse(roSettingsRaw); } catch { return {}; } })();
  ok('read-only settings block reads outside the working dir',
    roSettings.permissions?.blockReadsOutsideWorkingDirectories === true, roSettingsRaw.slice(0, 200));
  ok('read-only settings register the guard hook and do not acceptEdits',
    roSettings.permissions?.defaultMode === 'default' && JSON.stringify(roSettings.hooks ?? {}).includes('scope-guard'),
    roSettingsRaw.slice(0, 300));

  // Security review (2026-09-28) — the plan (read-only) regression: a read-only run pre-approved Bash, so
  // a plan-phase Bash could read outside the folder / run inline eval / launch a shell. Bash is now removed
  // OUTRIGHT from a read-only run (UnguardedTools, --disallowed-tools) AND dropped from the allow-list.
  const planDisallowed = (planArgs.match(/--disallowed-tools\s+(\S+)/)?.[1] ?? '').split(',');
  ok('plan spawn disallows Bash outright', planDisallowed.includes('Bash'), planDisallowed.join(','));
  ok('read-only settings allow-list omits Bash',
    !(roSettings.permissions?.allow ?? []).includes('Bash'), JSON.stringify(roSettings.permissions?.allow));
  ok('read-only settings top-level disableAllHooks:false (a project settings cannot disable our hook)',
    roSettings.disableAllHooks === false, roSettingsRaw.slice(0, 120));

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

  // Security review (2026-09-28) — SiteWriteScope C2/C3 normalization: a trailing-dot / case-fold target
  // still reaches the PROTECTED file, and an alternate-data-stream colon is a CLEAN refusal (not a 500).
  ok('C2: fs_move to trailing-dot settings refused as protected', row('move-c2-trailing-dot')
    && row('move-c2-trailing-dot').isError && /受保护/.test(row('move-c2-trailing-dot').text ?? ''),
    JSON.stringify(row('move-c2-trailing-dot')));
  ok('C3: fs_move to case-folded .claude/Settings.json refused as protected', row('move-c3-case-fold')
    && row('move-c3-case-fold').isError && /受保护/.test(row('move-c3-case-fold').text ?? ''),
    JSON.stringify(row('move-c3-case-fold')));
  ok('C2: fs_move to an ADS colon path is a clean refusal (not a 500)', row('move-ads-colon')
    && row('move-ads-colon').isError && /非法字符|越界|短名|设备/.test(row('move-ads-colon').text ?? ''),
    JSON.stringify(row('move-ads-colon')));
  ok('the refused C2/C3/ADS moves left their sources in place (and wrote no protected file)',
    onDisk(dataDir, 'household/README.md') && onDisk(dataDir, 'household/people.md')
      && onDisk(dataDir, 'plans/visa/2026-08-kyoto/applicant-data.json') && !onDisk(dataDir, '.claude/settings.json'));

  // I1 — file-only: a folder is refused as either operand, by name of the rule.
  const FILE_ONLY = /一次只能移动或删除一个文件/;
  for (const op of ['move-dir-refused', 'delete-dir-refused'])
    ok(`I1: ${op} — a folder operand is refused with the file-only sentence`,
      row(op) && row(op).isError && FILE_ONLY.test(row(op).text ?? ''), JSON.stringify(row(op)));
  ok('I1: the refused folder is still where it was, whole',
    onDisk(dataDir, 'plans/dirtest/a.md') && !onDisk(dataDir, 'plans/dirtest-moved'));

  // C1 — a path CONTAINING a protected entry, and a write-dir root, are refused as operands.
  ok('C1: fs_delete of a write-dir ROOT (household) is refused, naming the root',
    row('delete-c1-root') && row('delete-c1-root').isError && /根目录/.test(row('delete-c1-root').text ?? ''),
    JSON.stringify(row('delete-c1-root')));
  for (const op of ['move-c1-into-claude', 'move-c1-claude-from', 'delete-c1-claude'])
    ok(`C1: ${op} — .claude as an operand is refused as containing protected files`,
      row(op) && row(op).isError && /受保护/.test(row(op).text ?? ''), JSON.stringify(row(op)));
  ok('C1: .claude is still in place with its knowledge base, and no settings.json appeared in it',
    onDisk(dataDir, '.claude/ui-spec.md') && !onDisk(dataDir, 'plans/kb') && !onDisk(dataDir, '.claude/settings.json'));
  ok('C1: household/ is still in place', onDisk(dataDir, 'household/people.md'));

  // Minors.
  ok('minor: a plain tilde is a name — plans/newsub/a~b.md is movable (a new parent folder too)',
    row('move-tilde-ok') && !row('move-tilde-ok').isError && onDisk(dataDir, 'plans/newsub/a~b.md'),
    JSON.stringify(row('move-tilde-ok')));
  ok('minor: a tilde + digit is still an 8.3 short name and refused',
    row('move-shortname-refused') && row('move-shortname-refused').isError && /短名/.test(row('move-shortname-refused').text ?? ''),
    JSON.stringify(row('move-shortname-refused')));
  ok('minor: a target whose PARENT is a symlink is refused even though the target does not exist',
    row('move-via-symlinked-parent') && row('move-via-symlinked-parent').isError
      && /符号链接/.test(row('move-via-symlinked-parent').text ?? ''), JSON.stringify(row('move-via-symlinked-parent')));
  ok('minor: nothing was written outside the data folder through the junction',
    !fs.existsSync(path.join(outside, 'escaped.md')) && onDisk(dataDir, 'plans/symlink-src.md'));

  // I2 — the execute run's fs_move made WHILE a read-only run was in flight.
  const overlap = readLog(fsopsLog).find((e) => e.phase === 'overlap')?.rows?.[0];
  ok('I2 (setup): the read-only run had started when the execute run moved the file',
    overlap?.readOnlyRunStarted === true, JSON.stringify(overlap));
  ok('I2: an execute run\'s fs_move is ALLOWED while an overlapping read-only run is in flight',
    overlap && !overlap.isError && onDisk(dataDir, 'plans/overlap-dst.md'), JSON.stringify(overlap));

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

  // I2 — AT REST. The execute run ended while the read-only run was still in flight; once that one ends too, no
  // run is in flight and nothing may write. The old flag restored the read-only run's saved "write" at its exit,
  // so writes stayed allowed at rest — reachable over HTTP, where the tool was also listed. Both are closed now.
  const response = await until(() => fs.existsSync(`${overlapMark}.response`) && fs.readFileSync(`${overlapMark}.response`, 'utf8'), 60000);
  ok('I2 (setup): the overlapping read-only run (extract over HTTP) completed', /^200$/.test(String(response)), String(response));
  const atRest = await post('/api/tools/call', { name: 'fs_move', arguments: { from: 'plans/rest-src.md', to: 'plans/rest-dst.md' } });
  ok('I2: at rest, an fs_move over HTTP is refused', atRest.status >= 400, `${atRest.status} ${JSON.stringify(atRest.body).slice(0, 160)}`);
  ok('I2: and the file did not move', onDisk(dataDir, 'plans/rest-src.md') && !onDisk(dataDir, 'plans/rest-dst.md'));

  // --- C1: a project config file an execute run left behind is gone before any human decision ---------------
  // The stub writes .claude/settings.json, settings.local.json and .mcp.json directly (as a slipped Bash token
  // could) plus one plan edit. The tracker knows none of the three, so Reject's restore could never reach them;
  // and a validate pass — an agent run in the data folder — would have loaded their hooks before the gate.
  const plant = await post('/api/chat', { message: 'FSPLANTTEST 写一个计划文件' });
  ok('plant chat start 200', plant.status === 200 && !!plant.body.id);
  await waitPhase(plant.body.id, 'awaiting-plan-approval');
  await post(`/api/chat/${plant.body.id}/plan/approve`);
  const plantDiff = await waitPhase(plant.body.id, 'awaiting-diff-approval');
  const PLANTED = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json'];
  ok('C1: at the diff gate, none of the planted config files is in the data folder',
    PLANTED.every((rel) => !onDisk(dataDir, rel)), PLANTED.filter((rel) => onDisk(dataDir, rel)).join(', '));
  ok('C1: each was kept in state/quarantine', PLANTED.every(quarantined), PLANTED.filter((r) => !quarantined(r)).join(', '));
  const plantPaths = (plantDiff.review?.files ?? []).map((f) => f.path);
  ok('C1: the review shows the plan edit and none of the config files',
    plantPaths.includes('plans/trips/plant-review.md') && !plantPaths.some((p) => PLANTED.includes(p)), JSON.stringify(plantPaths));
  await post(`/api/chat/${plant.body.id}/diff/reject`);
  await waitPhase(plant.body.id, 'rejected');
  ok('C1: after Reject no planted file is left, and the plan edit is undone',
    PLANTED.every((rel) => !onDisk(dataDir, rel)) && !onDisk(dataDir, 'plans/trips/plant-review.md'),
    PLANTED.concat('plans/trips/plant-review.md').filter((rel) => onDisk(dataDir, rel)).join(', '));
} catch (err) {
  fail('e2e-p54 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
  // The junction itself, never its target (make-test-data's recursive rm would also unlink it next run).
  try { fs.rmdirSync(path.join(dataDir, 'plans', 'linkout')); } catch { try { fs.unlinkSync(path.join(dataDir, 'plans', 'linkout')); } catch {} }
}
done();
