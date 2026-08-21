#!/usr/bin/env node
// e2e P51 — recall quality is THREE INDEPENDENT SWITCHES, and the claude-CLI one is LIVE.
//
// What this exists to prevent, in order of how much it cost:
//
//   1. A cost nobody chose. The Lyntai 3.0 adoption turned annotation + verification on wholesale, and
//      they have spent a haiku call on every remember_fact and every recall since — with no way to
//      decline short of editing code. The switch is the fix; this suite is what stops it regressing
//      back into a build-time fact.
//   2. A setting in the wrong store. ServerConfig's own doc reserves settings.json for "what must exist
//      before the DB opens" and puts tunable values in app_config. The enrichment's MODEL already lived
//      there (llm.model.memory); its on/off did not, so one feature's controls sat in two stores and one
//      of them needed a restart.
//   3. A promise with nothing behind it. GatherlightApp routes a "memory" consumer and the comment said
//      "llm.model.memory overrides live" — but cortex's catalog never listed it, so SetModel answered
//      "unknown consumer" and the panel never showed it. Case C asserts the promise is now real.
//
//   A  the three switches are reported, and the floor is not optional
//   B  enrichment flips OFF and back ON inside one server lifetime — no restart
//   C  cortex exposes the memory consumer it was already routing to
//   D  the local model refuses to enable/reindex when its prerequisites are absent
import fs from 'node:fs';
import path from 'node:path';
import { dataDirFor, makeReporter, startServer, until, makeClient, claudeStubCmd } from './_e2e-common.mjs';

const { ok, fail, done } = makeReporter('p51');
const PORT = 5510;

const dir = dataDirFor('p51');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'state'), { recursive: true });

let srv;
try {
  srv = startServer({ dataDir: dir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  await until(async () => {
    const r = await fetch(`${srv.base}/api/health`);
    return r.ok && (await r.json()).migrating === false;
  });
  const { getJson, post, call } = makeClient(srv.base);

  // ---- A · the three switches -------------------------------------------------------------------
  const s = await getJson('/api/manage/memory');
  ok('formula is reported and is NOT optional', s.formula?.alwaysOn === true, JSON.stringify(s.formula));
  ok('the claude-CLI enrichment is reported', typeof s.llmEnrichment?.enabled === 'boolean');
  ok('and is marked live (no restart)', s.llmEnrichment?.live === true);
  ok('and states its cost, because someone pays it',
    /token|调用/.test(String(s.llmEnrichment?.cost ?? '')), s.llmEnrichment?.cost);
  ok('the local model is reported and OFF by default',
    s.localModel?.enabled === false && s.localModel?.active === false, JSON.stringify({
      enabled: s.localModel?.enabled, active: s.localModel?.active }));
  ok('the local model offers models with sizes and a recommendation',
    (s.localModel?.options ?? []).length > 0 && !!s.localModel?.recommendation?.id,
    JSON.stringify(s.localModel?.recommendation));
  ok('and the recommendation explains ITSELF, rather than being a bare default',
    String(s.localModel?.recommendation?.reason ?? '').length > 10, s.localModel?.recommendation?.reason);
  // Enrichment defaults ON: flipping that default would silently degrade recall for every existing
  // household on upgrade, which is a different (and worse) defect than the cost it was hiding.
  ok('enrichment defaults ON, so an upgrade does not silently degrade recall',
    s.llmEnrichment.enabled === true);

  // ---- B · the switch is LIVE, both ways, in one lifetime ---------------------------------------
  // The observable is the router line the memory consumer produces. Counting it is what makes this a
  // test of the COST rather than of a boolean we just wrote and read back.
  const routerCalls = () => (srv.log().match(/router: claude-cli/g) ?? []).length;
  let n = 0;
  const exercise = async () => {
    const before = routerCalls();
    n += 1;
    await call('remember_fact', { kind: 'preference', topic: `T${n}`, content: `Fact ${n} about bedtime.`, confidence: 0.9 });
    await call('recall_facts', { query: 'bedtime', limit: 3 });
    await new Promise((r) => setTimeout(r, 1200));
    return routerCalls() - before;
  };

  const onCalls = await exercise();
  ok('with enrichment on, a write + a recall spend model calls', onCalls > 0, `${onCalls} calls`);

  const off = await post('/api/manage/memory/enrichment', { enabled: false });
  ok('turning it off is accepted', off.status === 200, String(off.status));
  ok('and does NOT ask for a restart', off.body?.restartRequired === false, JSON.stringify(off.body));
  const offCalls = await exercise();
  ok('THE POINT: the spend stops immediately, with no restart', offCalls === 0, `${offCalls} calls`);
  ok('and the panel reports it off', (await getJson('/api/manage/memory')).llmEnrichment.enabled === false);

  const on = await post('/api/manage/memory/enrichment', { enabled: true });
  ok('turning it back on is accepted', on.status === 200, String(on.status));
  // Both directions, deliberately: a switch that only ever turns things off would pass a one-way test
  // while leaving the household unable to undo it.
  const backOn = await exercise();
  ok('and the spend resumes, still with no restart', backOn > 0, `${backOn} calls`);

  // ---- C · cortex exposes the consumer it was already routing to --------------------------------
  const cortex = await getJson('/api/manage/cortex');
  const consumers = (cortex.models ?? []).map((m) => m.consumer ?? m.Consumer);
  ok('cortex lists the memory consumer', consumers.includes('memory'), JSON.stringify(consumers));
  const put = await fetch(`${srv.base}/api/manage/cortex/model/memory`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'sonnet' }),
  });
  ok('and its model is settable — the comment promised a live override for months',
    put.status === 200, String(put.status));
  const after = (await getJson('/api/manage/cortex')).models.find((m) => (m.consumer ?? m.Consumer) === 'memory');
  ok('the override is reflected', JSON.stringify(after).includes('sonnet'), JSON.stringify(after));

  // ---- D · the local model refuses rather than pretending ----------------------------------------
  // These hold whether or not this machine has Ollama, which is the point: a refusal that only appears
  // on a developer's box is not a guarantee.
  // The gate is on SHAPE, not on catalog membership. Membership was the old rule and it blocked every
  // model published after a release — including, as shipped, the two best ones that already existed. What
  // must still hold is that something which is not a model NAME never reaches the registry or a process
  // argument, so that is what these assert.
  for (const [label, bad] of [
    ['a flag-shaped id', '--config'],
    ['a path traversal', '../../etc/passwd'],
    ['an id with whitespace', 'nomic embed text'],
  ]) {
    const r = await post('/api/manage/memory/local/pull', { model: bad });
    ok(`pull refuses ${label} before it reaches the registry`, r.status === 400, `${bad} → ${r.status}`);
  }
  // A WELL-FORMED id that this machine does not have is a different answer: not "unknown", but "not
  // downloaded". Conflating the two is what made a newer model look like a typo.
  const notHere = await post('/api/manage/memory/local/enable', { model: 'some-future-embedder:1b' });
  ok('enabling a well-formed model that is not installed says so (409, not 400)',
    notHere.status === 409, String(notHere.status));
  const reindex = await post('/api/manage/memory/local/reindex');
  ok('reindexing while disabled is refused, not silently zero', reindex.status === 409, String(reindex.status));

  // ---- E · WHERE the judge runs — CLI or a model on this machine --------------------------------
  ok('the judge reports its transport, and defaults to the CLI',
    s.llmEnrichment.transport === 'cli', String(s.llmEnrichment.transport));
  const badTransport = await post('/api/manage/memory/judge', { transport: 'somewhere-else' });
  ok('an unknown transport is refused', badTransport.status === 400, String(badTransport.status));
  // THE refusal worth having. An embedding model is installed and well-formed and can never answer a
  // judgement — and both memory policies are fail-open, so choosing one would surface as recall that
  // quietly never improves rather than as an error.
  const embedAsJudge = await post('/api/manage/memory/judge',
    { transport: 'local', model: s.localModel.options[0].id });
  ok('an EMBEDDING model is refused as a judge, by name',
    embedAsJudge.status === 409 || embedAsJudge.status === 400, String(embedAsJudge.status));
  const judgeMissing = await post('/api/manage/memory/judge', { transport: 'local', model: 'no-such-judge:9b' });
  ok('a judge model that is not installed says so, rather than being saved',
    judgeMissing.status === 409, String(judgeMissing.status));
  // Positive control: going BACK to the CLI must always be accepted — a household that switched away
  // needs the door to swing both ways, and this asserts the endpoint works at all rather than only
  // refusing things.
  const toCli = await post('/api/manage/memory/judge', { transport: 'cli' });
  ok('returning the judge to the CLI is accepted, and asks for a restart',
    toCli.status === 200 && toCli.body?.restartRequired === true, JSON.stringify(toCli.body));

  const known = s.localModel.options[0].id;
  const enable = await post('/api/manage/memory/local/enable', { model: known });
  ok('enabling a KNOWN model still refuses when its prerequisites are missing',
    enable.status === 200 || enable.status === 409, String(enable.status));
  if (enable.status === 409) {
    ok('and says why (Ollama not running, or the model not downloaded)',
      /Ollama|下载/.test(String(enable.body?.error ?? '')), enable.body?.error);
  } else {
    // This machine has Ollama AND the model: the positive control for the refusal above.
    ok('(this machine has Ollama + the model) enabling asks for a restart and a reindex',
      enable.body?.restartRequired === true && enable.body?.reindexRequired === true,
      JSON.stringify(enable.body));
  }
} catch (err) {
  fail('e2e-p51 fatal: ' + err.message);
  console.error(srv?.log?.().slice(-3000) ?? '');
} finally {
  try { srv?.stop(); } catch { /* best effort */ }
}
done();
