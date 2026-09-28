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
//       and a write-dir root are refused. The CLI's own project config (.claude/settings*.json, .mcp.json) is the
//       HOUSEHOLD's — their interactive claude writes settings.local.json — so the app leaves what is there alone:
//       its runs do not read the local scope or .mcp.json (--setting-sources project --strict-mcp-config), and a run
//       that CREATED or CHANGED one of the three is undone when it ends (ProjectConfigBackstop). A first version
//       moved all three out of the folder at boot and around every run — the household's own config, repeatedly.
//   I1  the diff gate is file-level, so the tools are FILE-ONLY.
//   I2  runs that hold no agent lease (extract over HTTP, the playground, the migrator) share the run scope, so a
//       read-only run overlapping an execute run could refuse its writes, or leave writes allowed at rest.
//   minors: a plain tilde is a name (only `~` + digit is an 8.3 short name), and a target is checked for a symlinked
//       parent even when it does not exist yet.
import { spawn } from 'node:child_process';
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

// The household's OWN interactive claude config, there before boot: Claude Code saves a permission they approve into
// .claude/settings.local.json (a hook of theirs beside it), and a project .mcp.json names a server of theirs. The app
// must leave both exactly as they are, and its runs must read neither. Obviously fake content.
const householdConfig = {
  '.claude/settings.local.json': '{"_e2e":"household-own-interactive","permissions":{"allow":["Bash(rm:*)"]},'
    + '"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo e2e-household-local-hook"}]}]}}\n',
  '.mcp.json': '{"_e2e":"household-own","mcpServers":{"e2e-household-srv":{"type":"stdio","command":"node","args":["e2e-household-srv.mjs"]}}}\n',
};
for (const [rel, text] of Object.entries(householdConfig)) fs.writeFileSync(path.join(dataDir, rel), text, 'utf8');
const loadsLog = `${dataDir}-loads.jsonl`;
try { fs.rmSync(loadsLog); } catch {}
// The upload the overlapping read-only run (extract) reads.
fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'uploads', 'overlap.pdf'), '%PDF-1.4 overlap fixture');
// plans/linkout → outside the data folder. Not a real plan directory; nothing writes it but the refused row.
fs.symlinkSync(outside, path.join(dataDir, 'plans', 'linkout'), 'junction');

const srv = startServer({
  dataDir, port: PORT,
  env: {
    GATHERLIGHT_CLAUDE_CMD: claudeStubCmd, GATHERLIGHT_STUB_FSOPS_LOG: fsopsLog, GATHERLIGHT_STUB_ARGS_LOG: argsLog,
    GATHERLIGHT_STUB_LOADS_LOG: loadsLog,
    GATHERLIGHT_STUB_OVERLAP_MARK: overlapMark, GATHERLIGHT_STUB_HTTP_BASE: `http://127.0.0.1:${PORT}`,
  },
});
const { j, post, waitPhase } = makeClient(srv.base);

const readLog = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const quarantineDir = path.join(dataDir, 'state', 'quarantine');
const stamps = () => { try { return fs.readdirSync(quarantineDir); } catch { return []; } };
// state/quarantine/<stamp>/<rel> — the backstop keeps what a run wrote, so nothing is destroyed. `since` names the
// stamps that already existed, so a later undo is not credited with what an earlier one kept. `text`, when given, is
// what the kept copy must hold.
const quarantined = (rel, since = [], text = undefined) =>
  stamps().some((stamp) => !since.includes(stamp) && fs.existsSync(path.join(quarantineDir, stamp, rel))
    && (text === undefined || fs.readFileSync(path.join(quarantineDir, stamp, rel), 'utf8') === text));
const readText = (rel) => { try { return fs.readFileSync(path.join(dataDir, rel), 'utf8'); } catch { return null; } };
const untouched = () => Object.entries(householdConfig).filter(([rel, text]) => readText(rel) !== text).map(([rel]) => rel);
// Every claude run Lyntai starts carries the isolation flags (ClaudeCliRuntime.IsolationArgs), wherever they sit.
const isolated = (args = []) => args.includes('--strict-mcp-config') && args[args.indexOf('--setting-sources') + 1] === 'project';
// The PowerShell process holding settings.local.json in the held-file case, killed in `finally` so a throwing wait
// cannot leave it holding the file into the next run.
let holder;

try {
  await waitHealthy(srv.base);
  console.log('server up');

  ok('fixture trip file is tracked at boot', tracked(dataDir, 'plans/trips/2026-08-kyoto.md'));
  ok('C1: the household\'s own .claude/settings.local.json and .mcp.json are exactly as they were after boot',
    untouched().length === 0, untouched().join(', '));
  ok('C1: nothing was moved into state/quarantine at boot', stamps().length === 0, stamps().join(', '));

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

  // Round-6 re-review — EVERY generated settings file (planner + 系统模式, execute + read-only) carries both:
  //  · disableSkillShellExecution: a skill's !`cmd` runs while the CLI EXPANDS it — no Bash tool call, so the guard is
  //    never asked; measured at 0 tokens, it ran in an execute run and did not with this on, a project `false` beside it;
  //  · the off-subscription names blanked, and apiKeyHelper blanked: the runs read the data folder's PROJECT
  //    .claude/settings.json, whose apiKeyHelper RAN and supplied a key, and whose env key was used; these settings
  //    outrank it per key, and an empty value is an absent one to the CLI (measured, docs/self-managed-llm-runtime.md).
  const SETTINGS_FILES = ['settings.chat.json', 'settings.chat.readonly.json', 'settings.system.json', 'settings.system.readonly.json'];
  const settingsOf = (f) => { try { return JSON.parse(fs.readFileSync(`${dataDir}/state/${f}`, 'utf8')); } catch { return null; } };
  const BLANKED = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_BASE_URL'];
  for (const f of SETTINGS_FILES) {
    const s = settingsOf(f);
    ok(`${f}: disableSkillShellExecution true (a skill's !\`cmd\` never runs unguarded)`, s?.disableSkillShellExecution === true,
      JSON.stringify(s && { disableSkillShellExecution: s.disableSkillShellExecution }));
    ok(`${f}: apiKeyHelper blanked and every off-subscription name blanked in env`,
      s?.apiKeyHelper === '' && BLANKED.every((n) => s?.env?.[n] === '') && Object.values(s?.env ?? {}).every((v) => v === ''),
      JSON.stringify(s && { apiKeyHelper: s.apiKeyHelper, env: s.env }).slice(0, 300));
    // Positive control: the subscription's own token is NOT blanked — a household on `claude setup-token` would be signed out.
    ok(`${f}: …and CLAUDE_CODE_OAUTH_TOKEN is left alone`, !!s && !('CLAUDE_CODE_OAUTH_TOKEN' in (s.env ?? {})), JSON.stringify(s?.env ?? {}).slice(0, 200));
  }

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

  // C1 (design change): the household's own config SURVIVES the app's runs, and none of those runs READS it. The stub
  // records what claude 2.1.283 was measured to load under the argv it was handed (claude-stub.mjs, recordLoads).
  ok('C1: the household\'s settings.local.json and .mcp.json survive a plan and an execute run unchanged',
    untouched().length === 0, untouched().join(', '));
  const spawnArgs = readLog(argsLog);
  ok('C1: every claude run the app started carries --setting-sources project --strict-mcp-config',
    spawnArgs.length >= 2 && spawnArgs.every((sp) => isolated(sp.args)),
    spawnArgs.filter((sp) => !isolated(sp.args)).map((sp) => `${sp.kind}: ${sp.args.slice(0, 6).join(' ')}`).join(' | '));
  const runLoads = readLog(loadsLog).filter((l) => l.kind === 'plan' || l.kind === 'execute');
  ok('C1 (control): the plan and execute runs still load the site\'s knowledge base (the project scope)',
    runLoads.length >= 2 && runLoads.every((l) => l.loaded.includes('CLAUDE.md')), JSON.stringify(runLoads.map((l) => l.loaded)));
  ok('C1: neither run loads the household\'s settings.local.json — its Bash(rm:*) and its hook stay out',
    runLoads.length >= 2 && runLoads.every((l) => !l.loaded.includes('.claude/settings.local.json')), JSON.stringify(runLoads.map((l) => l.loaded)));
  ok('C1: neither run starts the household\'s .mcp.json server',
    runLoads.length >= 2 && runLoads.every((l) => !l.loaded.some((x) => x.startsWith('.mcp.json'))), JSON.stringify(runLoads.map((l) => l.loaded)));

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

  // --- C1: what an execute run did to the project config is undone before any human decision ---------------
  // The stub CREATES .claude/settings.json and REWRITES the household's settings.local.json and .mcp.json directly (as
  // a slipped Bash token could), plus one plan edit. The tracker knows none of the three, so Reject's restore could never
  // reach them; and a validate pass — an agent run in the data folder — would have loaded a project hook before the gate.
  const stampsBeforePlant = stamps();
  const PLANTED_TEXT = {
    '.claude/settings.json': '{"_e2e":"planted-by-claude-stub","hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo e2e-planted"}]}]}}\n',
    '.claude/settings.local.json': '{"_e2e":"planted-by-claude-stub","permissions":{"allow":["Bash"]}}\n',
    '.mcp.json': '{"_e2e":"planted-by-claude-stub","mcpServers":{"e2e-planted-srv":{"type":"stdio","command":"node","args":["e2e-planted.mjs"]}}}\n',
  };
  const plant = await post('/api/chat', { message: 'FSPLANTTEST 写一个计划文件' });
  ok('plant chat start 200', plant.status === 200 && !!plant.body.id);
  await waitPhase(plant.body.id, 'awaiting-plan-approval');
  await post(`/api/chat/${plant.body.id}/plan/approve`);
  const plantDiff = await waitPhase(plant.body.id, 'awaiting-diff-approval');
  const PLANTED = Object.keys(PLANTED_TEXT);
  ok('C1: at the diff gate, the .claude/settings.json the run CREATED is gone', !onDisk(dataDir, '.claude/settings.json'));
  ok('C1: …and the household\'s settings.local.json and .mcp.json the run REWROTE hold their content from before it',
    untouched().length === 0, untouched().join(', '));
  ok('C1: each version the run wrote was kept in state/quarantine by this run\'s undo',
    PLANTED.every((r) => quarantined(r, stampsBeforePlant, PLANTED_TEXT[r])),
    PLANTED.filter((r) => !quarantined(r, stampsBeforePlant, PLANTED_TEXT[r])).join(', '));
  // The run's own stream says what was undone — found in the stored transcript of the conversation.
  const plantNotice = await until(async () => {
    const convo = ((await j('/api/chat/history')).body?.conversations ?? []).find((c) => /FSPLANTTEST/.test(c.title ?? ''));
    if (!convo) return null;
    const events = (await j(`/api/chat/history/${convo.id}`)).body?.events ?? [];
    return events.find((e) => e.kind === 'notice' && /这次运行改动了/.test(e.text ?? '')) ?? null;
  }, 15000, 300).catch(() => null);
  ok('C1: the run\'s stream says it undid the three files', !!plantNotice && PLANTED.every((r) => plantNotice.text.includes(r)),
    plantNotice?.text ?? '(no notice)');
  const plantPaths = (plantDiff.review?.files ?? []).map((f) => f.path);
  ok('C1: the review shows the plan edit and none of the config files',
    plantPaths.includes('plans/trips/plant-review.md') && !plantPaths.some((p) => PLANTED.includes(p)), JSON.stringify(plantPaths));
  await post(`/api/chat/${plant.body.id}/diff/reject`);
  await waitPhase(plant.body.id, 'rejected');
  ok('C1: after Reject the created settings file is still gone, the household\'s two files still theirs, and the plan edit is undone',
    !onDisk(dataDir, '.claude/settings.json') && untouched().length === 0 && !onDisk(dataDir, 'plans/trips/plant-review.md'),
    ['.claude/settings.json', 'plans/trips/plant-review.md'].filter((rel) => onDisk(dataDir, rel)).concat(untouched()).join(', '));

  // --- Re-review: a file HELD OPEN at the snapshot is left alone — never taken for one the run created -----------
  // The household's own interactive claude can hold settings.local.json while an app run starts. The snapshot read it as
  // ABSENT, so once the holder let go the file looked CREATED by the run and was moved out of the folder. PowerShell holds
  // it with no sharing (Node opens files with delete-sharing and cannot stand in); SLOW keeps the plan run in flight 8 s
  // past its spawn, and the stub's own args line proves the spawn — and so the snapshot before it — happened while held.
  const stampsBeforeHold = stamps();
  const heldFile = path.join(dataDir, '.claude', 'settings.local.json');
  const heldMark = `${dataDir}-hold-held`;
  const release = `${dataDir}-hold-release`;
  for (const f of [heldMark, release]) fs.rmSync(f, { force: true });
  holder = spawn('powershell', ['-NoProfile', '-Command',
    `$f=[IO.File]::Open('${heldFile}','Open','Read','None'); Set-Content -LiteralPath '${heldMark}' 'held'; `
    + `$n=0; while (-not (Test-Path -LiteralPath '${release}') -and $n -lt 600) { Start-Sleep -Milliseconds 100; $n++ }; $f.Close()`],
  { stdio: 'ignore' });
  const holderExit = new Promise((r) => holder.on('exit', r));
  await until(() => fs.existsSync(heldMark), 15000);
  const plansBeforeHold = readLog(argsLog).filter((s) => s.kind === 'plan').length;
  const logBeforeHold = srv.log().length;
  const heldChat = await post('/api/chat', { message: 'FSHELDTEST SLOW 看一眼计划' });
  ok('held: chat start 200', heldChat.status === 200 && !!heldChat.body.id);
  await until(() => readLog(argsLog).filter((s) => s.kind === 'plan').length > plansBeforeHold, 30000);
  fs.writeFileSync(release, 'go');
  await holderExit;
  await waitPhase(heldChat.body.id, 'awaiting-plan-approval');
  const heldLog = srv.log().slice(logBeforeHold);
  ok('held (setup): the snapshot found settings.local.json there but unreadable — the hold was real',
    /could not read \.claude\/settings\.local\.json before this run/.test(heldLog), heldLog.slice(-600));
  ok('held: once readable again, the household\'s settings.local.json is still in place with its content',
    untouched().length === 0, untouched().join(', '));
  ok('held: …and nothing of it was moved into state/quarantine', !quarantined('.claude/settings.local.json', stampsBeforeHold),
    stamps().filter((s) => !stampsBeforeHold.includes(s)).join(', '));
} catch (err) {
  fail('e2e-p54 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  try { holder?.kill(); } catch { /* best effort */ }
  srv.stop();
  // The junction itself, never its target (make-test-data's recursive rm would also unlink it next run).
  try { fs.rmdirSync(path.join(dataDir, 'plans', 'linkout')); } catch { try { fs.unlinkSync(path.join(dataDir, 'plans', 'linkout')); } catch {} }
}
done();
