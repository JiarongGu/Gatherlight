#!/usr/bin/env node
// e2e P16 — cortex tuning surface. Read the prompt-template + model-routing registry, override
// with placeholder validation, prove a runtime override reaches the spawned CLI, and reset. Ends with a
// real 智库 validation pass, asserting the validate row's model reaches THAT spawn's argv, and a real
// SCORING pass asserting the same of the scorer row.
//
// The scorer row is the one cortex row Lyntai's router resolves, so since Lyntai 3.3 it is stored as a live
// ROUTE (llm.route.scorer = claude-cli:<model>), not a bare llm.model.scorer — which nothing reads any more, so a
// row still writing it would be a control that changes nothing, silently (S1 confirmed to fail that way). Clearing
// it must DELETE the route: a bare `claude-cli` would run the scorers on the CLI's own default model instead of
// the consumer default, haiku (S2 confirmed to fail that way — the spawn then carries no --model at all). S4: a model
// with a COMMA is refused (400) and nothing is stored — a route is a comma-separated fallback list, so `haiku,
// llamacpp:x` would have routed to a backend nobody chose (confirmed to fail with both refusals removed).
//
// M cases — the STARTUP MIGRATION of what an install stored before the routes (LiveRouteMigrationStep). Nothing
// reads llm.model.scorer / llm.model.memory any more and Lyntai warns only of ITS old namespace, so a key the step
// missed is a model silently back on its default. Each case plants the old keys into a stopped install's database
// and boots it: M1 (nothing bound) — both become claude-cli routes, and the next scorer and annotation spawns carry
// the migrated models end to end; M2 (a chat GGUF saved, its runtime absent) — the judge's key is derived with the
// SAVED binding's provider, llamacpp, and then DROPPED as a fallback's leftover, which no router here would read, so
// the CLI it fell back to is asked for its own model and the log carries no per-call router warning; M3 (a retired
// backend saved) — dropped, and a route already present beside an old key is kept; M4 (the CLI saved with a model)
// — the stored model, not the saved one, becomes the route and reaches the annotation; M5 (a RERANKER saved, its
// runtime absent) — its tagging is the CLI's, so the route is claude-cli:… and KEPT; M6 — a second boot changes and
// logs nothing. Confirmed to fail: M1 with the step unregistered; M2 with the provider taken as the CLI's instead of
// the saved binding's (the CLI is then asked for the GGUF), and its no-warning assertion with the stale-route drop
// removed; M5 with a reranker's provider taken as llama.cpp's (its route is then dropped as stale).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDirFor, claudeStubCmd, makeReporter, makeTestData, startServer, waitHealthy, makeClient, until } from './_e2e-common.mjs';

const dataDir = dataDirFor('p16');
const { ok, fail, done } = makeReporter('p16');
makeTestData(dataDir);
// Every stub spawn appends {args, kind, tail} here (claude-stub.mjs) — the only place a suite can see the
// --model a spawned CLI actually received. Under state/, after makeTestData, so the agent's workspace
// never lists it.
const argsLog = path.join(dataDir, 'state', 'stub-args.jsonl');
const srv = startServer({
  dataDir, port: 5398,
  env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd, GATHERLIGHT_STUB_ARGS_LOG: argsLog },
});
// The M cases' servers: M1 reboots this suite's own folder, M2–M6 a second one (booted once to create its database).
// Each boot on a port of its own — reusing one inside a suite is its own trap. The gaps no other suite's literal port
// fills in the suites' own block, outside p17's runtime wildcard probe and every Windows-excluded range seen on
// 2026-09-26. (A block just past the excluded range was tried first; a VS Code process on this machine listens in it.
// No port is spelled out here: the runner reads every 5xxx literal in a file, comments included, as its footprint.)
const migDir = dataDirFor('p16-migrate');
makeTestData(migDir);
const migArgsLog = path.join(migDir, 'state', 'stub-args.jsonl');
const M1_PORT = 5400, MIG_PRE_PORT = 5444, M2_PORT = 5445, M3_PORT = 5449, M4_PORT = 5453, M5_PORT = 5454, M6_PORT = 5457;
const extra = [];
const { j, post, put, del, waitPhase } = makeClient(srv.base);

const getCortex = async () => (await j('/api/manage/cortex')).body;
const prompt = (c, name) => c.prompts.find((p) => p.name === name);
const model = (c, consumer) => c.models.find((m) => m.consumer === consumer);

try {
  await waitHealthy(srv.base);

  // --- registry shape ---
  let c = await getCortex();
  ok('cortex: prompt catalog present (>= 6)', Array.isArray(c.prompts) && c.prompts.length >= 6, String(c.prompts?.length));
  ok('cortex: model catalog has chat + extract', !!model(c, 'chat') && !!model(c, 'extract'));
  // `validate` (智库校验 pass) has a settable home now — round 1 left it read but settable nowhere.
  // Default null (CLI default model) and not overridden until something sets it.
  ok('cortex: model catalog has validate, default null, not overridden',
    !!model(c, 'validate') && model(c, 'validate').default === null && model(c, 'validate').overridden === false,
    JSON.stringify(model(c, 'validate')));
  const plan = prompt(c, 'plan');
  ok('plan prompt: default carries {userMessage}', plan?.default.includes('{userMessage}'));
  ok('plan prompt: placeholder contract lists userMessage', plan?.placeholders.includes('userMessage'), JSON.stringify(plan?.placeholders));
  ok('plan prompt: not overridden initially, effective == default', plan?.overridden === false && plan?.effective === plan?.default);

  // --- placeholder validation on override ---
  const bad = await put('/api/manage/cortex/prompt/plan', { value: 'no placeholders here at all' });
  ok('override missing placeholders → 400 + missing list', bad.status === 400 && (bad.body.missing ?? []).includes('userMessage'), JSON.stringify(bad.body));

  // --- valid override, proven to reach the spawned CLI ---
  const overridden = plan.default + '\n\nCORTEX_ECHO:MARK16\n';
  const set = await put('/api/manage/cortex/prompt/plan', { value: overridden });
  ok('valid override (keeps placeholders) → 200', set.status === 200 && set.body.ok === true, JSON.stringify(set.body));
  c = await getCortex();
  ok('override now reflected (overridden + effective)', prompt(c, 'plan').overridden === true && prompt(c, 'plan').effective === overridden);

  const start = await post('/api/chat', { message: '给明天建一个日计划' });
  const id = start.body.id;
  const planned = await waitPhase(id, 'awaiting-plan-approval');
  ok('runtime override reached the CLI (plan text carries echo)', (planned.plan ?? '').includes('[echo:MARK16]'), (planned.plan ?? '').slice(0, 60));
  await post(`/api/chat/${id}/cancel`);

  // --- reset restores default ---
  const reset = await del('/api/manage/cortex/prompt/plan');
  ok('reset prompt → 200', reset.status === 200);
  c = await getCortex();
  ok('after reset: not overridden, effective == default', prompt(c, 'plan').overridden === false && prompt(c, 'plan').effective === prompt(c, 'plan').default);

  // --- setting value == default clears the override (no stored copy) ---
  await put('/api/manage/cortex/prompt/plan', { value: prompt(c, 'plan').default });
  c = await getCortex();
  ok('override equal to default is not stored', prompt(c, 'plan').overridden === false);

  // --- model routing round-trip ---
  let m = await put('/api/manage/cortex/model/chat', { value: 'haiku' });
  ok('set model chat=haiku → 200', m.status === 200);
  c = await getCortex();
  ok('chat model overridden to haiku', model(c, 'chat').override === 'haiku' && model(c, 'chat').effective === 'haiku' && model(c, 'chat').overridden === true);
  // extract keeps its own default (sonnet) untouched
  ok('extract model default is sonnet (untouched)', model(c, 'extract').default === 'sonnet' && model(c, 'extract').overridden === false);

  // empty value clears the override (falls back to default)
  await put('/api/manage/cortex/model/chat', { value: '' });
  c = await getCortex();
  ok('empty model value clears override', model(c, 'chat').overridden === false && model(c, 'chat').override === null);

  // --- unknown targets 404 ---
  const un1 = await put('/api/manage/cortex/prompt/nope', { value: 'x {y}' });
  ok('unknown prompt name → 404', un1.status === 404, String(un1.status));
  const un2 = await put('/api/manage/cortex/model/nope', { value: 'haiku' });
  ok('unknown model consumer → 404', un2.status === 404, String(un2.status));

  // --- override survives across a fresh registry read (persisted in app_config) ---
  await put('/api/manage/cortex/model/extract', { value: 'opus' });
  c = await getCortex();
  ok('extract override persisted (opus)', model(c, 'extract').effective === 'opus' && model(c, 'extract').overridden === true);

  // --- validate model round-trips through PUT + GET, same as any other cortex-settable consumer ---
  const vSet = await put('/api/manage/cortex/model/validate', { value: 'haiku' });
  ok('set model validate=haiku → 200', vSet.status === 200, JSON.stringify(vSet.body));
  c = await getCortex();
  ok('validate model overridden to haiku (reads back)',
    model(c, 'validate')?.override === 'haiku' && model(c, 'validate')?.effective === 'haiku' && model(c, 'validate')?.overridden === true,
    JSON.stringify(model(c, 'validate')));
  await put('/api/manage/cortex/model/validate', { value: '' });
  c = await getCortex();
  ok('empty validate model value clears override', model(c, 'validate')?.overridden === false && model(c, 'validate')?.override === null);

  // --- a real 智库 VALIDATION PASS: the validate row reaches the spawned CLI's --model ---------------
  // The rows above prove the value reaches the KEY; this proves the key reaches the ARGV. The pass runs only
  // when the diff at the gate touches .claude/ (ChatSessionService.PresentDiffAsync), so KBEDITTEST makes the
  // stub's execute turn write a skill file there. The CHAT row is set to a different model on purpose: the
  // plan and execute spawns are then a positive control — they must carry chat's model, never validate's —
  // and the assertions have to name WHICH spawn they read (the stub classifies each by its phase header),
  // because "some spawn carried --model haiku" would be satisfied by the wrong one: V1's commit starts the
  // auto-scorers, which run on haiku too and were seen landing between V2's plan and execute spawns.
  const KB_FILE = '.claude/skills/zz-validate-e2e/SKILL.md';
  const calls = () => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8') : '')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const modelOf = (call) => { const i = call.args.indexOf('--model'); return i >= 0 ? call.args[i + 1] : null; };
  const summary = (xs) => JSON.stringify(xs.map((x) => `${x.kind}:${modelOf(x) ?? '(none)'}`));
  // One whole two-gate turn. Returns the review the gate showed and the turn's OWN two-gate spawns: sliced
  // from where the log stood when the turn began, and filtered by kind, since the auto-scorers of an earlier
  // commit append their own lines concurrently.
  const kbTurn = async (message, decision) => {
    const from = calls().length;
    const started = await post('/api/chat', { message });
    if (started.status !== 200) throw new Error(`chat start ${started.status} ${JSON.stringify(started.body)}`);
    const id = started.body.id;
    await waitPhase(id, 'awaiting-plan-approval');
    await post(`/api/chat/${id}/plan/approve`);
    const review = (await waitPhase(id, 'awaiting-diff-approval')).review;
    const spawns = calls().slice(from).filter((x) => ['plan', 'execute', 'validate'].includes(x.kind));
    await post(`/api/chat/${id}/diff/${decision}`);
    await waitPhase(id, decision === 'approve' ? 'committed' : 'rejected');
    return { id, review, spawns };
  };

  const setChat = await put('/api/manage/cortex/model/chat', { value: 'opus' });
  const setValidate = await put('/api/manage/cortex/model/validate', { value: 'haiku' });
  ok('(fixture) chat=opus and validate=haiku set', setChat.status === 200 && setValidate.status === 200);

  // Case V1 — validate=haiku: the validation spawn receives --model haiku.
  const v1 = await kbTurn('KBEDITTEST 把这条经验写进智库', 'approve');
  ok('V1 (fixture) the diff at the gate touches .claude/, so a validation pass ran',
    v1.review?.hasClaudeInfra === true && (v1.review?.files ?? []).some((f) => f.path === KB_FILE && f.isClaudeInfra),
    JSON.stringify((v1.review?.files ?? []).map((f) => f.path)));
  ok('V1 the server parsed the STUB\'s verdict — ok, and the report names the model that spawn was handed',
    v1.review?.validation?.ok === true && (v1.review?.validation?.report ?? '').includes('model=haiku'),
    JSON.stringify(v1.review?.validation));
  const v1Validate = v1.spawns.filter((x) => x.kind === 'validate');
  ok('V1 exactly one validation spawn, and its diff is the .claude/ file',
    v1Validate.length === 1 && v1Validate[0].tail.includes(KB_FILE), summary(v1.spawns));
  ok('V1 THE POINT: the validation spawn receives --model haiku (the validate row)',
    v1Validate.length === 1 && modelOf(v1Validate[0]) === 'haiku', summary(v1.spawns));
  // The pass runs in the data folder, so it reads the household's project .claude/settings.json: it gets the plan
  // phase's read-only settings — the read fence, the guard hook, and the blanked off-subscription names (round-6
  // re-review: it passed none, so an apiKeyHelper there would have put it on an API key).
  const settingsArg = (call) => { const i = call.args.indexOf('--settings'); return i >= 0 ? call.args[i + 1] : null; };
  ok('V1 the validation spawn passes the read-only settings',
    v1Validate.length === 1 && /settings\.chat\.readonly\.json$/.test(settingsArg(v1Validate[0]) ?? ''),
    String(v1Validate[0] && settingsArg(v1Validate[0])));
  const v1Chat = v1.spawns.filter((x) => x.kind === 'plan' || x.kind === 'execute');
  ok('V1 positive control: the plan and execute spawns carry the CHAT row (opus), not validate\'s',
    v1Chat.some((x) => x.kind === 'plan') && v1Chat.some((x) => x.kind === 'execute')
      && v1Chat.every((x) => modelOf(x) === 'opus'), summary(v1.spawns));

  // Case V2 — the validate row cleared: no --model at all (the CLI's own default), while chat keeps opus.
  // This is also what a validate spawn looks like when the service passes no model, which is why V1's
  // "--model haiku" cannot pass by accident; and the pass must not inherit the chat row in its place.
  const cleared = await put('/api/manage/cortex/model/validate', { value: '' });
  ok('(fixture) validate row cleared', cleared.status === 200);
  const v2 = await kbTurn('KBEDITTEST 再更新一次智库', 'reject');
  const v2Validate = v2.spawns.filter((x) => x.kind === 'validate');
  ok('V2 (fixture) a second validation pass ran', v2Validate.length === 1, summary(v2.spawns));
  ok('V2 THE POINT: with the row cleared the validation spawn gets NO --model (not haiku, not chat\'s opus)',
    v2Validate.length === 1 && !v2Validate[0].args.includes('--model'), summary(v2.spawns));
  ok('V2 …and the parsed report agrees (cli-default)',
    (v2.review?.validation?.report ?? '').includes('model=cli-default'), JSON.stringify(v2.review?.validation));
  ok('V2 positive control: plan and execute still carry opus',
    v2.spawns.filter((x) => x.kind !== 'validate').length >= 2
      && v2.spawns.filter((x) => x.kind !== 'validate').every((x) => modelOf(x) === 'opus'), summary(v2.spawns));
  await put('/api/manage/cortex/model/chat', { value: '' });

  // --- a real SCORING pass: the scorer row reaches the judge spawn's --model, through its ROUTE ------------
  // The scorer is read by Lyntai's router, per call, from llm.route.scorer — so this proves the row writes the
  // key the router reads AND that the router reads it, where the V cases prove a key the app reads itself. A manual
  // re-score of V2's turn (POST /api/manage/scores/run/<id>) runs the two LLM judges synchronously. The route is
  // read at each call, so V1's auto-scorers could only ever land on the new model once it is set — but a spawn
  // STARTED before the write logs its line a moment later, so the log is left to go quiet first.
  const storedKey = (key) => {
    const d = new DatabaseSync(path.join(dataDir, 'state', 'gatherlight.db'), { readOnly: true });
    try { return d.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value; }
    finally { d.close(); }
  };
  const quiet = async () => {
    let n = -1;
    for (let i = 0; i < 40 && calls().length !== n; i++) { n = calls().length; await new Promise((r) => setTimeout(r, 750)); }
  };
  const scorePass = async () => {
    await quiet();
    const from = calls().length;
    const run = await post(`/api/manage/scores/run/${v2.id}`);
    return { run, spawns: calls().slice(from).filter((x) => x.kind === 'scorer') };
  };

  // S1 — scorer=sonnet: stored as the route, shown as its model, and every judge spawn gets --model sonnet.
  const sSet = await put('/api/manage/cortex/model/scorer', { value: 'sonnet' });
  ok('S1 (fixture) set model scorer=sonnet → 200', sSet.status === 200, JSON.stringify(sSet.body));
  ok('S1 the row is stored as the ROUTE llm.route.scorer = claude-cli:sonnet, and not as the pre-route key',
    storedKey('llm.route.scorer') === 'claude-cli:sonnet' && storedKey('llm.model.scorer') === undefined,
    `llm.route.scorer=${JSON.stringify(storedKey('llm.route.scorer'))} llm.model.scorer=${JSON.stringify(storedKey('llm.model.scorer'))}`);
  c = await getCortex();
  ok('S1 …and cortex reads it back as the MODEL half: override sonnet, effective sonnet',
    model(c, 'scorer')?.override === 'sonnet' && model(c, 'scorer')?.effective === 'sonnet' && model(c, 'scorer')?.overridden === true,
    JSON.stringify(model(c, 'scorer')));
  const s1 = await scorePass();
  ok('S1 (fixture) the manual re-score ran and the LLM judges spawned',
    s1.run.status === 200 && s1.spawns.length >= 1, `${s1.run.status} ${summary(s1.spawns)}`);
  ok('S1 THE POINT: every scorer spawn receives --model sonnet (the route, read by Lyntai\'s router)',
    s1.spawns.length >= 1 && s1.spawns.every((x) => modelOf(x) === 'sonnet'), summary(s1.spawns));

  // S2 — the row cleared: the route is DELETED, and the judges fall back to the consumer default — haiku —
  // never to no --model, which is what a bare `claude-cli` route would give (the backend's own default).
  const sClear = await put('/api/manage/cortex/model/scorer', { value: '' });
  ok('S2 (fixture) scorer row cleared → 200', sClear.status === 200, JSON.stringify(sClear.body));
  ok('S2 THE POINT: clearing DELETES the route — no llm.route.scorer at all, not a bare provider',
    storedKey('llm.route.scorer') === undefined, `llm.route.scorer=${JSON.stringify(storedKey('llm.route.scorer'))}`);
  c = await getCortex();
  ok('S2 …and cortex shows the default: not overridden, effective haiku',
    model(c, 'scorer')?.overridden === false && model(c, 'scorer')?.override === null && model(c, 'scorer')?.effective === 'haiku',
    JSON.stringify(model(c, 'scorer')));
  const s2 = await scorePass();
  ok('S2 (fixture) a second re-score spawned the judges', s2.spawns.length >= 1, summary(s2.spawns));
  ok('S2 THE POINT: the scorer spawns get the consumer default, --model haiku — not sonnet, and not no --model',
    s2.spawns.length >= 1 && s2.spawns.every((x) => modelOf(x) === 'haiku'), summary(s2.spawns));

  // S4 — a model with a COMMA is refused, by the endpoint (400, saying why) and so by everything that sets a row: a
  // route is a comma-separated fallback list, and this one would name a backend nobody chose.
  const sComma = await put('/api/manage/cortex/model/scorer', { value: 'haiku, llamacpp:zzcomma' });
  ok('S4 THE POINT: a scorer model with a comma is refused — 400, saying why — and nothing is stored',
    sComma.status === 400 && /逗号/.test(String(sComma.body?.error)) && storedKey('llm.route.scorer') === undefined,
    `${sComma.status} ${JSON.stringify(sComma.body)} llm.route.scorer=${JSON.stringify(storedKey('llm.route.scorer'))}`);

  // S3 — reset (DELETE) of a set row removes the route too.
  await put('/api/manage/cortex/model/scorer', { value: 'opus' });
  ok('S3 (fixture) the row set again is its route — or the reset below would pass on nothing',
    storedKey('llm.route.scorer') === 'claude-cli:opus', `llm.route.scorer=${JSON.stringify(storedKey('llm.route.scorer'))}`);
  const sReset = await del('/api/manage/cortex/model/scorer');
  ok('S3 reset of the scorer row → 200 and the route is gone',
    sReset.status === 200 && storedKey('llm.route.scorer') === undefined,
    `${sReset.status} llm.route.scorer=${JSON.stringify(storedKey('llm.route.scorer'))}`);

  // --- M: the startup migration of pre-route keys ------------------------------------------------------
  await quiet();
  srv.stop();
  await new Promise((r) => setTimeout(r, 1500));
  const plant = (dir, rows) => {
    const d = new DatabaseSync(path.join(dir, 'state', 'gatherlight.db'));
    try {
      for (const [k, v] of Object.entries(rows)) {
        if (v === null) d.prepare('DELETE FROM app_config WHERE key = ?').run(k);
        else d.prepare('INSERT INTO app_config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
      }
    } finally { d.close(); }
  };
  const keyIn = (dir, key) => {
    const d = new DatabaseSync(path.join(dir, 'state', 'gatherlight.db'), { readOnly: true });
    try { return d.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value; }
    finally { d.close(); }
  };
  const boot = async (dir, port, log) => {
    const s = startServer({ dataDir: dir, port, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd, GATHERLIGHT_STUB_ARGS_LOG: log } });
    extra.push(s);
    await waitHealthy(s.base);
    return s;
  };
  const stopAll = async () => { for (const s of extra.splice(0)) s.stop(); await new Promise((r) => setTimeout(r, 1500)); };
  // The fixture's own log files (UTF-8, as the file logger writes them), not stdout, whose encoding is the console's.
  const logOf = (dir) => {
    const d = path.join(dir, 'state', 'logs');
    return fs.existsSync(d) ? fs.readdirSync(d).map((n) => fs.readFileSync(path.join(d, n), 'utf8')).join('\n') : '';
  };
  const callsIn = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

  // M1 — nothing bound (the default CLI judge): an old scorer model and an old judge model, as an install before
  // the routes stored them.
  plant(dataDir, { 'llm.model.scorer': 'opus', 'llm.model.memory': 'sonnet', 'llm.route.scorer': null, 'llm.route.memory': null });
  const m1 = await boot(dataDir, M1_PORT, argsLog);
  ok('M1 THE POINT: llm.model.scorer = opus became the route llm.route.scorer = claude-cli:opus, and the old key is gone',
    keyIn(dataDir, 'llm.route.scorer') === 'claude-cli:opus' && keyIn(dataDir, 'llm.model.scorer') === undefined,
    `route=${JSON.stringify(keyIn(dataDir, 'llm.route.scorer'))} old=${JSON.stringify(keyIn(dataDir, 'llm.model.scorer'))}`);
  ok('M1 THE POINT: with nothing bound, llm.model.memory = sonnet became llm.route.memory = claude-cli:sonnet',
    keyIn(dataDir, 'llm.route.memory') === 'claude-cli:sonnet' && keyIn(dataDir, 'llm.model.memory') === undefined,
    `route=${JSON.stringify(keyIn(dataDir, 'llm.route.memory'))} old=${JSON.stringify(keyIn(dataDir, 'llm.model.memory'))}`);
  ok('M1 …and the migration SAID so (our namespace gets no warning from Lyntai)',
    /live routes: llm\.model\.scorer = opus → llm\.route\.scorer = claude-cli:opus/.test(logOf(dataDir))
      && /live routes: llm\.model\.memory = sonnet → llm\.route\.memory = claude-cli:sonnet/.test(logOf(dataDir)),
    logOf(dataDir).split('\n').filter((l) => l.includes('live routes')).join(' | '));
  const m1c = makeClient(m1.base);
  const m1From = calls().length;
  const m1Run = await m1c.post(`/api/manage/scores/run/${v2.id}`);
  const m1Scorers = calls().slice(m1From).filter((x) => x.kind === 'scorer');
  ok('M1 …and end to end: the next scorer spawns carry --model opus',
    m1Run.status === 200 && m1Scorers.length >= 1 && m1Scorers.every((x) => modelOf(x) === 'opus'), summary(m1Scorers));
  const m1Wrote = await m1c.call('remember_fact', {
    kind: 'household', topic: 'zzmigfact kitchen routine',
    content: 'The zzmigfact kitchen is cleaned every Friday evening.', source: 'https://example.test/zzmig', confidence: 0.8,
  });
  const annotated = async (log, marker) => {
    try { await until(() => callsIn(log).some((x) => x.kind === 'annotation' && x.tail.includes(marker)), 60000); } catch { /* reported below */ }
    return callsIn(log).filter((x) => x.kind === 'annotation' && x.tail.includes(marker));
  };
  const m1Ann = await annotated(argsLog, 'zzmigfact');
  ok('M1 …and the judge\'s annotation of the next fact carries --model sonnet',
    m1Wrote.status === 200 && m1Ann.length >= 1 && m1Ann.every((x) => modelOf(x) === 'sonnet'), summary(m1Ann));
  await stopAll();

  // M2/M3 run on a second install, booted once so its database exists.
  await boot(migDir, MIG_PRE_PORT, migArgsLog);
  await stopAll();
  const settingsOf = (dir, memory) =>
    fs.writeFileSync(path.join(dir, 'state', 'settings.json'), JSON.stringify({ memory }, null, 2), 'utf8');

  // M2 — a chat GGUF is the SAVED binding, but its runtime is not on disk, so 判断 falls back to the CLI. The key
  // was written for the GGUF: it becomes ITS route (llamacpp:…) — never claude-cli:<gguf>, which the fallen-back CLI
  // would read and be asked for a model it has never heard of — and that route is then DROPPED, because no router
  // this process builds holds llamacpp: Lyntai would warn of it on every annotation and every recall, for as long as
  // the fallback lasts. Nothing is lost: when the GGUF runs again, its model is the judge's default.
  settingsOf(migDir, { judgeSource: 'llama-cpp', judgeModel: 'zzmig-chat' });
  plant(migDir, { 'llm.model.memory': 'zzmig-chat' });
  const m2 = await boot(migDir, M2_PORT, migArgsLog);
  ok('M2 THE POINT: the judge\'s key is derived with the SAVED binding\'s provider — llamacpp:zzmig-chat — as the log says',
    /live routes: llm\.model\.memory = zzmig-chat → llm\.route\.memory = llamacpp:zzmig-chat/.test(logOf(migDir)),
    logOf(migDir).split('\n').filter((l) => l.includes('live routes')).join(' | '));
  ok('M2 THE POINT: …and dropped at once as a fallback\'s leftover — no route and no old key remain, and the log says why',
    keyIn(migDir, 'llm.route.memory') === undefined && keyIn(migDir, 'llm.model.memory') === undefined
      && /live routes: dropped llm\.route\.memory = llamacpp:zzmig-chat — 判断 is running on claude-cli/.test(logOf(migDir)),
    `route=${JSON.stringify(keyIn(migDir, 'llm.route.memory'))} old=${JSON.stringify(keyIn(migDir, 'llm.model.memory'))} `
      + logOf(migDir).split('\n').filter((l) => l.includes('live routes')).join(' | '));
  const m2c = makeClient(m2.base);
  const m2Layer = ((await m2c.getJson('/api/manage/memory')).layers ?? []).find((l) => l.id === 'judge') ?? {};
  ok('M2 (fixture) with its runtime absent, 判断 runs on the CLI', m2Layer.activeSource === 'claude-cli',
    JSON.stringify({ source: m2Layer.source, active: m2Layer.activeSource }));
  const m2Wrote = await m2c.call('remember_fact', {
    kind: 'household', topic: 'zzmig2fact garden routine',
    content: 'The zzmig2fact garden hose is stored in the shed.', source: 'https://example.test/zzmig2', confidence: 0.8,
  });
  const m2Ann = await annotated(migArgsLog, 'zzmig2fact');
  ok('M2 …so the CLI is asked for ITS model (haiku), never the GGUF the migrated route names',
    m2Wrote.status === 200 && m2Ann.length >= 1 && m2Ann.every((x) => modelOf(x) === 'haiku'), summary(m2Ann));
  const m2Recall = await m2c.call('recall_facts', { query: 'zzmig2fact garden hose', limit: 5 });
  try { await until(() => callsIn(migArgsLog).some((x) => x.kind === 'verification' && x.tail.includes('zzmig2fact')), 60000); } catch { /* reported below */ }
  const staleWarnings = () => logOf(migDir).split('\n').filter((l) => /live route for consumer memory .*names no registered text provider/.test(l));
  ok('M2 THE POINT: the annotation and the recall\'s verification log NO per-call router warning about the route',
    m2Recall.status === 200 && callsIn(migArgsLog).some((x) => x.kind === 'verification' && x.tail.includes('zzmig2fact'))
      && staleWarnings().length === 0,
    `${m2Recall.status} warnings=${staleWarnings().length} ${staleWarnings().slice(0, 2).join(' | ')}`);
  await stopAll();

  // M3 — a RETIRED backend is saved (ollama): the key was never read, so there is no provider to derive; dropped.
  // And a route already present beside an old key WINS — it was written by this build, the key before it.
  settingsOf(migDir, { judgeSource: 'ollama', judgeModel: 'gemma3:4b' });
  plant(migDir, { 'llm.model.memory': 'gemma3:4b', 'llm.route.memory': null,
    'llm.model.scorer': 'opus', 'llm.route.scorer': 'claude-cli:sonnet' });
  await boot(migDir, M3_PORT, migArgsLog);
  ok('M3 THE POINT: a key written for a retired backend is DROPPED, not turned into a route',
    keyIn(migDir, 'llm.route.memory') === undefined && keyIn(migDir, 'llm.model.memory') === undefined,
    `route=${JSON.stringify(keyIn(migDir, 'llm.route.memory'))} old=${JSON.stringify(keyIn(migDir, 'llm.model.memory'))}`);
  ok('M3 …and says why', /live routes: dropped llm\.model\.memory = gemma3:4b — the saved 判断 backend 'ollama'/.test(logOf(migDir)),
    logOf(migDir).split('\n').filter((l) => l.includes('live routes')).join(' | '));
  ok('M3 …and a route already set is kept over the old key beside it (the route is what this build reads; the old key deleted)',
    keyIn(migDir, 'llm.route.scorer') === 'claude-cli:sonnet' && keyIn(migDir, 'llm.model.scorer') === undefined,
    `route=${JSON.stringify(keyIn(migDir, 'llm.route.scorer'))} old=${JSON.stringify(keyIn(migDir, 'llm.model.scorer'))}`);
  await stopAll();

  // M4 — the CLI is the saved binding, with a model (sonnet), and the stored key names ANOTHER (opus — the old cortex
  // row could leave that). The retired store read the key straight through for a binding on the running client, so
  // the route carries the STORED model on the CLI, and the next annotation asks for it.
  settingsOf(migDir, { judgeSource: 'claude-cli', judgeModel: 'sonnet' });
  plant(migDir, { 'llm.model.memory': 'opus', 'llm.route.memory': null });
  const m4 = await boot(migDir, M4_PORT, migArgsLog);
  ok('M4 THE POINT: a saved CLI binding\'s stored key becomes llm.route.memory = claude-cli:opus, and is kept',
    keyIn(migDir, 'llm.route.memory') === 'claude-cli:opus' && keyIn(migDir, 'llm.model.memory') === undefined,
    `route=${JSON.stringify(keyIn(migDir, 'llm.route.memory'))} old=${JSON.stringify(keyIn(migDir, 'llm.model.memory'))}`);
  const m4Wrote = await makeClient(m4.base).call('remember_fact', {
    kind: 'household', topic: 'zzmig4fact porch routine',
    content: 'The zzmig4fact porch light is on a timer.', source: 'https://example.test/zzmig4', confidence: 0.8,
  });
  const m4Ann = await annotated(migArgsLog, 'zzmig4fact');
  ok('M4 …and the next annotation asks for opus', m4Wrote.status === 200 && m4Ann.length >= 1 && m4Ann.every((x) => modelOf(x) === 'opus'),
    summary(m4Ann));
  await stopAll();

  // M5 — a RERANKER is the saved binding, its runtime absent (so 判断 runs on the CLI). A reranker never tags: its
  // tagging is the CLI's, so its key becomes a claude-cli route — which the running CLI does read, so it is KEPT,
  // where a chat GGUF's (M2) is dropped. The stored model here is sonnet, so the annotation shows the route in force.
  settingsOf(migDir, { judgeSource: 'llama-cpp', judgeModel: 'zzmig-rerank' });
  plant(migDir, { 'llm.model.memory': 'sonnet', 'llm.route.memory': null });
  const m5 = await boot(migDir, M5_PORT, migArgsLog);
  ok('M5 THE POINT: a saved reranker\'s key becomes llm.route.memory = claude-cli:sonnet — its tagging is the CLI\'s — and is kept',
    keyIn(migDir, 'llm.route.memory') === 'claude-cli:sonnet' && keyIn(migDir, 'llm.model.memory') === undefined,
    `route=${JSON.stringify(keyIn(migDir, 'llm.route.memory'))} old=${JSON.stringify(keyIn(migDir, 'llm.model.memory'))}`);
  const m5Wrote = await makeClient(m5.base).call('remember_fact', {
    kind: 'household', topic: 'zzmig5fact attic routine',
    content: 'The zzmig5fact attic fan runs in summer.', source: 'https://example.test/zzmig5', confidence: 0.8,
  });
  const m5Ann = await annotated(migArgsLog, 'zzmig5fact');
  ok('M5 …and the next annotation asks for sonnet', m5Wrote.status === 200 && m5Ann.length >= 1 && m5Ann.every((x) => modelOf(x) === 'sonnet'),
    summary(m5Ann));
  await stopAll();

  // M6 — a SECOND boot of the same install: nothing left to move, nothing stale, so nothing changes and nothing is
  // logged. The step runs every start; it must not re-derive, re-drop or re-announce.
  const migLines = () => logOf(migDir).split('\n').filter((l) => l.includes('live routes:')).length;
  const before = { lines: migLines(), memory: keyIn(migDir, 'llm.route.memory'), scorer: keyIn(migDir, 'llm.route.scorer') };
  await boot(migDir, M6_PORT, migArgsLog);
  const after = { lines: migLines(), memory: keyIn(migDir, 'llm.route.memory'), scorer: keyIn(migDir, 'llm.route.scorer') };
  ok('M6 THE POINT: a second boot is idempotent — the same routes, no old keys, and no new migration line in the log',
    after.lines === before.lines && after.memory === before.memory && after.scorer === before.scorer
      && after.memory === 'claude-cli:sonnet' && keyIn(migDir, 'llm.model.memory') === undefined
      && keyIn(migDir, 'llm.model.scorer') === undefined,
    JSON.stringify({ before, after }));
  await stopAll();
} catch (err) {
  fail('e2e-p16 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
  for (const s of extra) console.error(s.log().slice(-3000));
} finally {
  srv.stop();
  for (const s of extra) s.stop();
}
done();
