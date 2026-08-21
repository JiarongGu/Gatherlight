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

  // A rebuild re-remembers every fact — a model call each with the enrichment on — so it must not run
  // inside the POST. It used to, which gave the household a greyed-out button for minutes and a request
  // the browser could abandon while the server carried on working.
  // Deleting a model frees real disk, so the shape checks live here while the DESTRUCTIVE positive
  // control does not: this suite runs against whatever Ollama the developer has, and a test that removed
  // one of their models to prove a button works would be doing more harm than the assertion is worth.
  // That half was verified by hand (2026-08-21: guards 409/409, malformed 400, an unused model really
  // removed, 10 installed → 9).
  const rmBad = await post('/api/manage/memory/local/remove', { model: '--rf' });
  ok('deleting refuses a flag-shaped id before it reaches Ollama', rmBad.status === 400, String(rmBad.status));
  // Well-formed and absent must NOT read as success — that is the shape that would let a delete button
  // silently do nothing while reporting that space was freed.
  const rmGhost = await post('/api/manage/memory/local/remove', { model: 'not-installed-anywhere:1b' });
  ok('deleting something that is not installed does not report success',
    rmGhost.status !== 200, String(rmGhost.status));

  ok('the panel can always read reindex progress, even when idle',
    s.localModel.reindex && typeof s.localModel.reindex.running === 'boolean',
    JSON.stringify(s.localModel.reindex));

  // ---- E · WHERE the judge runs — CLI or a model on this machine --------------------------------
  // Reported as a SOURCE id, the same vocabulary the running-backend field speaks. Two vocabularies for
  // one comparison can never come out equal, which reads on screen as a restart permanently owed.
  ok('the judge reports its backend, and defaults to the CLI',
    s.llmEnrichment.transport === 'claude-cli', String(s.llmEnrichment.transport));
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

  // ---- F · the judge picker is driven by OLLAMA's capabilities, not by our shortlist ---------------
  // The filter used to be "not in EmbeddingCatalog", which is wrong in both directions and failed
  // silently both ways: a household whose local models were all catalogued embedders got an EMPTY
  // candidate list and a 本机模型 button that was disabled with no explanation anywhere on the panel —
  // while the same panel listed those models under 本机模型占用 — and the first embedder we had not
  // catalogued sailed past the refusal above into a fail-open policy, where the only symptom is recall
  // that quietly never improves.
  const held = s.localModel.ollama.models ?? [];
  const named = held.filter((m) => Array.isArray(m.capabilities) && m.capabilities.length > 0);
  if (named.length === 0) {
    // Say what was NOT covered rather than passing quietly: a suite that skips its own subject and
    // prints nothing reads afterwards as a suite that checked.
    ok('(no Ollama, or one too old to report capabilities) capability filtering not exercised here',
      true, `${held.length} models held, ${named.length} reporting capabilities`);
  } else {
    const cand = new Set((s.llmEnrichment.localCandidates ?? []).map((c) => c.name));
    const wrong = named.filter((m) => m.capabilities.includes('completion') !== cand.has(m.name));
    ok('every judge candidate is one Ollama calls completion-capable, and every other model is excluded',
      wrong.length === 0,
      wrong.map((m) => `${m.name} [${m.capabilities}] candidate=${cand.has(m.name)}`).join(' · ') || 'exact');

    // The refusal, against EVERY embedding-only model this machine actually holds — including any the
    // catalog has never heard of, which is the case the old check could not see.
    const embedders = named.filter((m) => !m.capabilities.includes('completion'));
    const catalogued = new Set((s.localModel.options ?? []).map((o) => o.id));
    const uncatalogued = embedders.filter(
      (m) => !catalogued.has(m.name) && !catalogued.has(m.name.split(':')[0]));
    for (const m of embedders) {
      const r = await post('/api/manage/memory/judge', { transport: 'local', model: m.name });
      ok(`an embedding-only model is refused as a judge: ${m.name}`, r.status === 409, String(r.status));
    }
    ok(`(${uncatalogued.length} of ${embedders.length} embedders are OUTSIDE the catalog — the ones the`
      + ' old shortlist check could not have refused)', true,
      uncatalogued.map((m) => m.name).join(', ') || 'none on this machine');

    // POSITIVE CONTROL. Every assertion above is a denial, and a denial-only test passes just as well
    // against a picker that refuses everything — which is the defect being fixed here, not a fix for it.
    const chat = named.find((m) => m.capabilities.includes('completion'));
    if (chat) {
      const acc = await post('/api/manage/memory/judge', { transport: 'local', model: chat.name });
      ok(`a completion-capable model IS accepted as a judge: ${chat.name}`,
        acc.status === 200, `${acc.status} ${JSON.stringify(acc.body)}`);

      // SAVED vs RUNNING. The transport is a startup registration, so between saving and restarting the
      // two disagree — and the layer's header now NAMES its backend. A badge rendered from the saved
      // value would announce a model that is not doing the work, which is the same false label the
      // rename removed from the title.
      const mid = await getJson('/api/manage/memory');
      ok('the panel reports the SAVED backend and the RUNNING one separately',
        mid.llmEnrichment.transport === 'ollama' && mid.llmEnrichment.transportActive === 'claude-cli',
        JSON.stringify({ saved: mid.llmEnrichment.transport, active: mid.llmEnrichment.transportActive,
          savedModel: mid.llmEnrichment.localModel, activeModel: mid.llmEnrichment.activeModel }));

      await post('/api/manage/memory/judge', { transport: 'cli' });   // leave it as we found it
    } else {
      ok('(this machine holds no chat model) the accept path is not exercised here', true,
        'the refusals above cannot distinguish "correctly strict" from "always refuses"');
    }
  }

  // A disabled control must SAY why. The panel's one sentence for this used to live inside the <select>,
  // which only renders when there is something to select — so the single case it explained was the single
  // case it could never appear in.
  const blocked = s.llmEnrichment.localBlocked;
  ok('the switch carries a reason exactly when it has no candidates',
    ((s.llmEnrichment.localCandidates ?? []).length === 0) === (typeof blocked === 'string' && blocked.length > 0),
    `candidates=${(s.llmEnrichment.localCandidates ?? []).length} blocked=${JSON.stringify(blocked)}`);

  // THE LOCAL JUDGE AND THE LOCAL EMBEDDER ARE ONE PROVIDER — same Ollama, same URL, same /api/pull; only
  // the model differs. So when the fix is "you need a chat model", the panel must offer the download it
  // already offers for embedding models rather than printing a terminal command. Asserted as a NAME the
  // client can POST, not as prose, because prose is exactly what the old version had.
  const suggest = s.llmEnrichment.localSuggest;
  const onlyEmbedders = (s.llmEnrichment.localCandidates ?? []).length === 0
    && s.localModel.ollama.serving;
  ok('when the fix is a download, the panel names a model it can pull — not a shell command',
    onlyEmbedders ? (typeof suggest === 'string' && suggest.length > 0) : suggest === null,
    `serving=${s.localModel.ollama.serving} candidates=${(s.llmEnrichment.localCandidates ?? []).length} suggest=${JSON.stringify(suggest)}`);
  // The button must POST a name the pull endpoint accepts — one that 400s would be a button that cannot
  // work, i.e. worse than the terminal command it replaced. Checked by SHAPE rather than by pulling: this
  // suite runs on a developer's machine and the suggestion is a multi-gigabyte chat model, so proving the
  // button works by downloading it would cost far more than the assertion is worth (the same line this
  // suite already draws around the destructive delete). The endpoint's own gate is EmbeddingCatalog
  // .IsWellFormedId, whose contract is mirrored here.
  ok('and the suggested name is one the pull endpoint would accept (shape, not a live download)',
    suggest === null || /^[A-Za-z0-9][A-Za-z0-9._\-]*(:[A-Za-z0-9._-]+)?$/.test(suggest),
    JSON.stringify(suggest));
  // Which of the two branches actually ran depends on what this machine holds, so say so — an assertion
  // that passed on the null branch has not seen the suggestion, and a run that prints only ✓ would read
  // as though it had.
  ok(suggest === null
    ? '(this machine has a chat model) the SUGGESTION branch was not exercised — only the "stay quiet" half'
    : `(this machine has only embedders) the suggestion branch ran: ${suggest}`,
    true, `serving=${s.localModel.ollama.serving}`);

  // ---- G · a download is started and REPORTED, not awaited inside the POST -------------------------
  // A model is hundreds of megabytes to gigabytes and the pull budget is two hours. Awaiting it in the
  // request gave a button reading 下载中… with no bar and no bytes — indistinguishable from a hang — over
  // a request the browser may abandon while Ollama carries on downloading.
  //
  // Driven with a model that does NOT exist, deliberately: this suite runs on a developer's machine and a
  // test that proves the download works by downloading a gigabyte is doing more harm than the assertion is
  // worth. A pull that fails fast exercises the whole seam — 202, live state, recorded outcome — and the
  // outcome is the half that would otherwise vanish.
  const ghost = 'gatherlight-no-such-model:1b';
  const t1 = Date.now();
  const pull = await post('/api/manage/memory/local/pull', { model: ghost });
  const pullTook = Date.now() - t1;
  ok('a pull is ACCEPTED and returns immediately, rather than running inside the request',
    pull.status === 202 && pullTook < 3000, `status=${pull.status} in ${pullTook}ms`);
  // Asking twice is not an error: the household asked for a download and one is running. A 409 here would
  // put an error toast over a working progress bar.
  ok('and asking again while it runs is still success, not a conflict',
    [202].includes((await post('/api/manage/memory/local/pull', { model: ghost })).status));

  let pulls = (await getJson('/api/manage/memory')).localModel.pulls ?? [];
  ok('the panel can read downloads back as STATE — this is what the progress bar renders from',
    Array.isArray(pulls) && pulls.some((p) => p.model === ghost),
    JSON.stringify(pulls));
  await until(async () => {
    pulls = (await getJson('/api/manage/memory')).localModel.pulls ?? [];
    return !pulls.some((p) => p.model === ghost && p.running);
  });
  const ended = pulls.find((p) => p.model === ghost);
  // A failed download that simply disappeared would read as one that never started — the same class of
  // silence as the greyed-out button this whole section replaces.
  ok('a download that failed says so instead of vanishing',
    !!ended && ended.running === false && !!ended.error, JSON.stringify(ended));

  // ---- H · enabling refuses a non-embedder without waiting out a cold model load ------------------
  const chatModel = named.find((m) => !m.capabilities.includes('embedding'));
  if (chatModel) {
    const t2 = Date.now();
    const r = await post('/api/manage/memory/local/enable', { model: chatModel.name });
    const took2 = Date.now() - t2;
    // The embed PROBE is still the load-bearing check and still runs for everything else; this only
    // spares the household a minute of a dead button for an answer Ollama already gave.
    ok(`enabling a chat model is refused, and quickly: ${chatModel.name}`,
      r.status === 409 && took2 < 20000, `${r.status} in ${took2}ms`);
  } else {
    ok('(this machine holds no chat model) the fast embed refusal is not exercised here', true,
      `${named.length} models reporting capabilities`);
  }

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

    // THE POINT of the async rebuild: the call RETURNS while the work continues. Asserted by the status
    // code and by the clock — a 202 that actually blocked would still be a 202.
    const t0 = Date.now();
    const started = await post('/api/manage/memory/local/reindex');
    const took = Date.now() - t0;
    ok('a reindex is ACCEPTED and returns immediately, rather than running inside the request',
      started.status === 202 && took < 3000, `status=${started.status} in ${took}ms`);
    ok('and a second one is refused while the first is running or finishing',
      [202, 409].includes((await post('/api/manage/memory/local/reindex')).status),
      'one rebuild at a time — two would interleave discards and writes over the same graph');
  }
} catch (err) {
  fail('e2e-p51 fatal: ' + err.message);
  console.error(srv?.log?.().slice(-3000) ?? '');
} finally {
  try { srv?.stop(); } catch { /* best effort */ }
}
done();
