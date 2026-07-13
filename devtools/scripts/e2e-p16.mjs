#!/usr/bin/env node
// e2e P16 — cortex tuning surface. Read the prompt-template + model-routing registry, override
// with placeholder validation, prove a runtime override reaches the spawned CLI, and reset.
import { dataDirFor, claudeStubCmd, makeReporter, makeTestData, startServer, waitHealthy, makeClient } from './_e2e-common.mjs';

const dataDir = dataDirFor('p16');
const { ok, fail, done } = makeReporter('p16');
makeTestData(dataDir);
const srv = startServer({ dataDir, port: 5398, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
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
} catch (err) {
  fail('e2e-p16 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
