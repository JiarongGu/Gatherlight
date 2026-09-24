#!/usr/bin/env node
// e2e P16 — cortex tuning surface. Read the prompt-template + model-routing registry, override
// with placeholder validation, prove a runtime override reaches the spawned CLI, and reset. Ends with a
// real 智库 validation pass, asserting the validate row's model reaches THAT spawn's argv.
import fs from 'node:fs';
import path from 'node:path';
import { dataDirFor, claudeStubCmd, makeReporter, makeTestData, startServer, waitHealthy, makeClient } from './_e2e-common.mjs';

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
    return { review, spawns };
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
} catch (err) {
  fail('e2e-p16 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
