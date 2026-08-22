#!/usr/bin/env node
// e2e P51 — recall layers, their backends, and where models are managed.
//
// What this exists to prevent, in order of how much it cost:
//
//   1. A cost nobody chose. The Lyntai 3.0 adoption turned annotation + verification on wholesale, and
//      they spent a model call on every remember_fact and every recall — with no way to decline short of
//      editing code. Case B is what stops that regressing back into a build-time fact.
//   2. A backend admitted by a FILTER rather than by existing. The old picker inferred "chat model" from
//      absence in an embedding shortlist, which was wrong in both directions at once: a machine whose
//      models were all catalogued embedders got a dead switch with no explanation, and the first
//      uncatalogued embedder sailed through into a fail-open policy whose only symptom is recall that
//      quietly never improves. Case E asserts the capability filter over EVERY installed model.
//   3. Two writers of one value. cortex's 记忆判断 row and DefaultModelByConsumer both set the judge's
//      model, and cortex won — so a household who set haiku there and later moved the judge local had the
//      router asking OLLAMA for "haiku". Zero calls, no error. Case C asserts there is one writer now.
//   4. Provisioning on the wrong panel. Downloading a model is not a recall setting; case F asserts it
//      moved, and that it MOVED rather than being aliased at both addresses.
//
//   A  the three layers are reported as rows, and the floor is not optional
//   B  判断 flips OFF and back ON inside one server lifetime — no restart
//   C  cortex no longer offers a second place to set the judge's model
//   D  binding refuses rather than pretending
//   E  a backend serves a layer by EXISTING — capability decides, over every installed model
//   F  models are a RESOURCE: the inventory answers, and the old paths are gone
//   G  a download is started and REPORTED, not awaited inside the POST
//   H  语义 refuses a non-embedder without waiting out a cold model load
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

  const layerOf = (state, id) => (state.layers ?? []).find((l) => l.id === id);

  // ---- A · the layers, as rows ------------------------------------------------------------------
  const s = await getJson('/api/manage/memory');
  ok('the three layers are reported as rows',
    (s.layers ?? []).length === 3 && ['formula', 'judge', 'semantic'].every((id) => !!layerOf(s, id)),
    JSON.stringify((s.layers ?? []).map((l) => l.id)));

  const formula = layerOf(s, 'formula');
  const judge = layerOf(s, 'judge');
  const semantic = layerOf(s, 'semantic');

  ok('公式 is reported and is NOT optional', formula.alwaysOn === true && formula.on === true,
    JSON.stringify({ alwaysOn: formula.alwaysOn, on: formula.on }));
  ok('判断 is reported and marked live (no restart for its switch)',
    typeof judge.on === 'boolean' && judge.live === true, JSON.stringify({ on: judge.on, live: judge.live }));
  ok('and states its cost, because someone pays it',
    /token|调用/.test(String(judge.cost ?? '')), judge.cost);
  // COST IS TWO THINGS. The token cost was stated from the start; the LATENCY was measured later at 8.9 s
  // per recall against 37 ms for the 公式 floor (240×, essentially all of it a CLI process spawn) and was
  // not stated anywhere. A household leaving 判断 on is entitled to that before recall starts feeling slow,
  // so the CLI arm's cost line has to keep naming a time — and a baseline, since a duration with nothing to
  // compare it against is not a decision.
  if (judge.source === 'claude-cli') {
    ok('and, on the CLI arm, names the LATENCY too — with the 公式 floor to compare it against',
      /秒/.test(String(judge.cost ?? '')) && /0\.04|公式/.test(String(judge.cost ?? '')), judge.cost);
  }
  // Defaults ON: flipping that default would silently degrade recall for every existing household on
  // upgrade, which is a different (and worse) defect than the cost it was hiding.
  ok('判断 defaults ON, so an upgrade does not silently degrade recall', judge.on === true);
  ok('语义 is reported and OFF by default (it costs a download and a rebuild)',
    semantic.on === false && semantic.activeSource === null,
    JSON.stringify({ on: semantic.on, active: semantic.activeSource }));
  ok('the panel can always read reindex progress, even when idle',
    semantic.reindex && typeof semantic.reindex.running === 'boolean', JSON.stringify(semantic.reindex));
  ok('and it reports index COVERAGE — state, not a history of runs',
    semantic.coverage && typeof semantic.coverage.total === 'number', JSON.stringify(semantic.coverage));

  // The demotion of 语义 rests on a measurement taken on somebody ELSE'S corpus. Presenting it as this
  // household's would be unearned confidence, so the sentence must keep naming its source.
  ok('the weighting note names 判断 as primary AND attributes the measurement it rests on',
    s.weighting?.primary === 'judge' && /Lyntai/.test(String(s.weighting?.note ?? '')),
    JSON.stringify(s.weighting));
  ok('and the panel says where models are managed now, rather than leaving a household hunting',
    typeof s.modelsAt === 'string' && s.modelsAt.length > 0, s.modelsAt);

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
  ok('with 判断 on, a write + a recall spend model calls', onCalls > 0, `${onCalls} calls`);

  const off = await post('/api/manage/memory/enrichment', { enabled: false });
  ok('turning it off is accepted', off.status === 200, String(off.status));
  ok('and does NOT ask for a restart', off.body?.restartRequired === false, JSON.stringify(off.body));
  const offCalls = await exercise();
  ok('THE POINT: the spend stops immediately, with no restart', offCalls === 0, `${offCalls} calls`);
  ok('and the panel reports it off', layerOf(await getJson('/api/manage/memory'), 'judge').on === false);

  const on = await post('/api/manage/memory/enrichment', { enabled: true });
  ok('turning it back on is accepted', on.status === 200, String(on.status));
  // Both directions, deliberately: a switch that only ever turns things off would pass a one-way test
  // while leaving the household unable to undo it.
  const backOn = await exercise();
  ok('and the spend resumes, still with no restart', backOn > 0, `${backOn} calls`);

  // ---- C · ONE writer for the judge's model ------------------------------------------------------
  // cortex used to carry a 记忆判断 row, and its value OVERRODE DefaultModelByConsumer. So a household who
  // set it once and later moved the judge to a local model had the router asking the Ollama provider for
  // a claude model name — and because both memory policies are fail-open, the symptom was no model calls
  // and no error anywhere.
  const cortex = await getJson('/api/manage/cortex');
  const consumers = (cortex.models ?? []).map((m) => m.consumer ?? m.Consumer);
  ok('cortex no longer offers a second place to set the judge model',
    !consumers.includes('memory'), JSON.stringify(consumers));
  // …and the consumers it DOES own are untouched. Without this, deleting the row entirely would pass.
  ok('while the consumers cortex still owns are intact',
    ['chat', 'extract', 'scorer'].every((c) => consumers.includes(c)), JSON.stringify(consumers));
  const put = await fetch(`${srv.base}/api/manage/cortex/model/memory`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'sonnet' }),
  });
  ok('and setting it there is refused rather than silently accepted',
    put.status >= 400, String(put.status));

  // The positive half: binding the layer writes the model key itself, so there is still exactly one
  // control and it is reachable.
  const bindCli = await post('/api/manage/memory/layer/judge', { source: 'claude-cli', model: 'sonnet' });
  ok('binding 判断 to a backend and a model is accepted', bindCli.status === 200, String(bindCli.status));
  ok('and asks for a restart, because a backend is a startup registration',
    bindCli.body?.restartRequired === true, JSON.stringify(bindCli.body));
  const afterBind = layerOf(await getJson('/api/manage/memory'), 'judge');
  ok('the layer reports the model it was just bound to',
    afterBind.source === 'claude-cli' && afterBind.model === 'sonnet',
    JSON.stringify({ source: afterBind.source, model: afterBind.model }));
  // Put it back, so later cases start from the default.
  await post('/api/manage/memory/layer/judge', { source: 'claude-cli', model: 'haiku' });

  // ---- D · binding refuses rather than pretending ------------------------------------------------
  const badSource = await post('/api/manage/memory/layer/judge', { source: 'nope', model: 'haiku' });
  ok('an unknown backend is refused', badSource.status === 400, String(badSource.status));
  const badLayer = await post('/api/manage/memory/layer/nope', { source: 'claude-cli', model: 'haiku' });
  ok('an unknown layer is refused', badLayer.status === 404, String(badLayer.status));
  // 判断 is turned off by its LIVE switch, never unbound: conflating them would put a restart in front of
  // a change that needs none, and leave the layer with no backend to turn back on to.
  const judgeOff = await post('/api/manage/memory/layer/judge/off');
  ok('判断 cannot be unbound — it has its own live switch', judgeOff.status === 404, String(judgeOff.status));

  // The gate is on SHAPE, not on catalog membership. Membership was the old rule and it blocked every
  // model published after a release — including, as shipped, the two best ones that already existed. What
  // must still hold is that something which is not a model NAME never reaches the registry or a process
  // argument, so that is what these assert.
  for (const [label, bad] of [
    ['a flag-shaped id', '--config'],
    ['a path traversal', '../../etc/passwd'],
    ['an id with whitespace', 'nomic embed text'],
  ]) {
    const r = await post('/api/manage/models/pull', { model: bad });
    ok(`pull refuses ${label} before it reaches the registry`, r.status === 400, `${bad} → ${r.status}`);
  }
  // A WELL-FORMED id that this machine does not have is a different answer: not "unknown", but "not
  // downloaded". Conflating the two is what made a newer model look like a typo.
  const notHere = await post('/api/manage/memory/layer/semantic',
    { source: 'ollama', model: 'some-future-embedder:1b' });
  ok('binding a well-formed model that is not installed says so (409, not 400)',
    notHere.status === 409, String(notHere.status));
  const reindex = await post('/api/manage/memory/layer/semantic/reindex');
  ok('reindexing while 语义 is unbound is refused, not silently zero',
    reindex.status === 409, String(reindex.status));

  // Deleting a model frees real disk, so the shape checks live here while the DESTRUCTIVE positive
  // control does not: this suite runs against whatever Ollama the developer has, and a test that removed
  // one of their models to prove a button works would be doing more harm than the assertion is worth.
  // That half was verified by hand (2026-08-21: guards 409/409, malformed 400, an unused model really
  // removed, 10 installed → 9).
  const rmBad = await post('/api/manage/models/remove', { model: '--rf' });
  ok('deleting refuses a flag-shaped id before it reaches Ollama', rmBad.status === 400, String(rmBad.status));
  // Well-formed and absent must NOT read as success — that is the shape that would let a delete button
  // silently do nothing while reporting that space was freed.
  const rmGhost = await post('/api/manage/models/remove', { model: 'not-installed-anywhere:1b' });
  ok('deleting something that is not installed does not report success',
    rmGhost.status !== 200, String(rmGhost.status));

  // ---- E · a backend serves a layer by EXISTING --------------------------------------------------
  const judgeSources = (judge.sources ?? []).map((x) => x.id);
  const semanticSources = (semantic.sources ?? []).map((x) => x.id);
  // The FULL list, in the order MemoryBackends fixes. `llama-cpp` joined it on 2026-08-22 and pushed
  // `builtin` one place along — this assertion firing is how that was noticed, which is the point of
  // pinning an order rather than a set. Update it when a backend lands, deliberately.
  const BACKENDS = ['claude-cli', 'ollama', 'openai-compat', 'llama-cpp', 'builtin'];

  // EVERY backend on EVERY layer. A layer showing one button and nothing about the others answers "why
  // isn't this an option here?" by making the question unaskable — "no class implements it" is an answer
  // only the source tree gives. This is the same rule the available-but-blocked case already followed
  // (three causes, three sentences), applied one level further out.
  ok('判断 lists every backend', BACKENDS.every((b) => judgeSources.includes(b)),
    JSON.stringify(judgeSources));
  ok('语义 lists every backend too — including the ones it cannot use',
    BACKENDS.every((b) => semanticSources.includes(b)), JSON.stringify(semanticSources));
  // SAME ORDER on every layer. Sorting by status put the same four labels in different positions on the
  // two rows, so position could never become a landmark a household learns. Usability is carried by how a
  // button is DRAWN, not by where it sits.
  ok('and both layers list them in the SAME order, so position is stable',
    judgeSources.join() === BACKENDS.join() && semanticSources.join() === BACKENDS.join(),
    JSON.stringify({ judge: judgeSources, semantic: semanticSources }));

  // …and `bindable` is what separates "cannot, ever" from "cannot yet". THE load-bearing pair of this
  // design: Claude is unbindable under 语义 because no class implements that layer's interface (no
  // embeddings endpoint), and it is bindable under 判断. If Anthropic ships embeddings and a
  // ClaudeCliSemanticSource is added, the first of these SHOULD fail and be updated deliberately.
  const bindable = (l, id) => (l.sources ?? []).find((x) => x.id === id)?.bindable;
  ok('Claude cannot be BOUND to 语义 — it has no embeddings endpoint',
    bindable(semantic, 'claude-cli') === false, String(bindable(semantic, 'claude-cli')));
  ok('…but it can be bound to 判断, which is the same backend doing what it can do',
    bindable(judge, 'claude-cli') === true, String(bindable(judge, 'claude-cli')));
  // THE BUILT-IN RUNTIME SHIPPED FOR 语义 — this assertion used to say "bindable on neither", and flipping
  // it was the plan: docs/builtin-model-runner.md predicted this exact line would have to change, so that
  // nobody could add the source without noticing the suite's claim about it had changed.
  //
  // It stays DECLINED for 判断, which would need an in-process CHAT model — a much larger thing than an
  // embedder, and 判断 already has two working backends.
  ok('the built-in runtime is bindable on 语义 now, and still declined on 判断',
    bindable(semantic, 'builtin') === true && bindable(judge, 'builtin') === false,
    JSON.stringify({ judge: bindable(judge, 'builtin'), semantic: bindable(semantic, 'builtin') }));
  // …and BINDABLE is not AVAILABLE. The fixture has not downloaded 222 MB of weights, so it must report
  // itself unusable AND name the download — the distinction between "no implementation" and "not set up
  // yet" is the whole reason those are two fields.
  const builtIn = (semantic.sources ?? []).find((x) => x.id === 'builtin');
  ok('with the model not downloaded it is unavailable, and says where to get it',
    builtIn?.available === false && /资源|下载/.test(String(builtIn?.reason ?? '')), builtIn?.reason);
  ok('and it offers no model until the weights are there, rather than one that cannot load',
    (builtIn?.models ?? []).length === 0, JSON.stringify(builtIn?.models));
  ok('it needs no address either — it runs in this process', builtIn?.needsEndpoint === false);
  // Binding it without the model must be refused, not accepted-and-broken: a registered embedder with no
  // weights throws on the first fact written, which is the "installed is not usable" failure this codebase
  // keeps paying for.
  const bindNoModel = await post('/api/manage/memory/layer/semantic',
    { source: 'builtin', model: 'embeddinggemma-300m-onnx' });
  ok('binding the built-in backend before its model is downloaded is refused',
    bindNoModel.status === 409, `${bindNoModel.status} ${JSON.stringify(bindNoModel.body?.error ?? '').slice(0, 60)}`);
  ok('Ollama is bindable on both — one daemon, a different model on each layer',
    bindable(judge, 'ollama') === true && bindable(semantic, 'ollama') === true);

  // ONE CLASS implementing BOTH layer interfaces — the case the per-layer design exists for, and until
  // this backend there was no instance of it. Ollama does not count: it is two classes.
  ok('a generic OpenAI-compatible endpoint is bindable on BOTH layers, from one class',
    bindable(judge, 'openai-compat') === true && bindable(semantic, 'openai-compat') === true,
    JSON.stringify({ judge: bindable(judge, 'openai-compat'), semantic: bindable(semantic, 'openai-compat') }));
  // It is the only backend that needs an ADDRESS, because it is the only one we do not manage. Declared
  // rather than inferred, so the client does not have to know which ids are special.
  const needsUrl = (l, id) => (l.sources ?? []).find((x) => x.id === id)?.needsEndpoint;
  ok('and it is the only backend that asks for an address — the managed ones know their own',
    needsUrl(judge, 'openai-compat') === true && needsUrl(semantic, 'openai-compat') === true
      && needsUrl(judge, 'claude-cli') === false && needsUrl(judge, 'ollama') === false,
    JSON.stringify((judge.sources ?? []).map((x) => [x.id, x.needsEndpoint])));
  ok('with no address set it is unavailable and SAYS what to type',
    (judge.sources ?? []).find((x) => x.id === 'openai-compat')?.available === false
      && /127\.0\.0\.1/.test(String((judge.sources ?? []).find((x) => x.id === 'openai-compat')?.reason ?? '')),
    (judge.sources ?? []).find((x) => x.id === 'openai-compat')?.reason);

  // LOOPBACK IS ENFORCED, not advised. This address arrives from a text box and every fact written goes to
  // it, so a remote host must be refused rather than warned about. Asserted through the API, because the
  // client's own validation is not the boundary.
  const remote = await post('/api/manage/memory/layer/judge',
    { source: 'openai-compat', model: '', endpoint: 'http://192.168.1.50:8080' });
  ok('a NON-LOOPBACK endpoint is refused — facts would be sent off this machine',
    remote.status === 409, `${remote.status} ${JSON.stringify(remote.body?.error ?? '').slice(0, 80)}`);
  const junk = await post('/api/manage/memory/layer/judge',
    { source: 'openai-compat', model: '', endpoint: 'not-a-url' });
  ok('and so is something that is not a URL at all', junk.status === 409, String(junk.status));

  // The POSITIVE control: a loopback address IS accepted, and accepted WITHOUT a model — the model list
  // comes from the address, so demanding both at once would make the field impossible to submit. Nothing
  // is listening on this port in the fixture, which is the point: saving the address and REACHING it are
  // two different steps and only the first one happens here.
  const localAddr = await post('/api/manage/memory/layer/judge',
    { source: 'openai-compat', model: '', endpoint: 'http://127.0.0.1:8099' });
  ok('a loopback address is accepted on its own, before any model is chosen',
    localAddr.status === 200 && localAddr.body?.restartRequired === false,
    `${localAddr.status} ${JSON.stringify(localAddr.body)}`);
  const withAddr = layerOf(await getJson('/api/manage/memory'), 'judge');
  const compat = (withAddr.sources ?? []).find((x) => x.id === 'openai-compat');
  ok('and it is echoed back, so the box shows what was typed',
    compat?.endpoint === 'http://127.0.0.1:8099', compat?.endpoint);
  ok('while nothing is listening there, it reports unreachable rather than pretending',
    compat?.available === false && /8099/.test(String(compat?.reason ?? '')), compat?.reason);
  // A half-configured binding must not become the RUNNING backend: saving an address is not choosing a
  // judge, and the layer has to stay on the one that works.
  ok('saving an address does not silently rebind the layer',
    withAddr.source === 'claude-cli', withAddr.source);
  // Clear it, so later cases and the next run start from nothing.
  await post('/api/manage/memory/layer/judge', { source: 'openai-compat', model: '', endpoint: '' });

  // A backend that cannot be used must SAY so. This is the assertion that would fail if someone "tidied
  // up" by dropping the declined entries instead of explaining them.
  ok('every backend a layer cannot use carries a reason, not just a disabled button',
    [...judge.sources, ...semantic.sources]
      .filter((x) => !x.bindable)
      .every((x) => typeof x.reason === 'string' && x.reason.length > 10),
    JSON.stringify([...judge.sources, ...semantic.sources]
      .filter((x) => !x.bindable).map((x) => [x.id, x.reason?.slice(0, 40)])));
  // And Claude's refusal under 语义 must not read as "Claude is useless for meaning" — via 判断 it is the
  // strongest measured arm, and the sentence has to say so or it teaches the household the wrong thing.
  ok('and Claude\'s refusal under 语义 still points at 判断, rather than reading as a dead end',
    /判断/.test(String((semantic.sources ?? []).find((x) => x.id === 'claude-cli')?.reason ?? '')),
    (semantic.sources ?? []).find((x) => x.id === 'claude-cli')?.reason);
  ok('every backend says whether it is usable here, and why not when it is not',
    [...judge.sources, ...semantic.sources].every(
      (x) => typeof x.available === 'boolean' && (x.available || (typeof x.reason === 'string' && x.reason.length > 0))),
    JSON.stringify([...judge.sources, ...semantic.sources].map((x) => [x.id, x.available, x.reason])));
  ok('and each carries what choosing it costs, rather than just a name',
    [...judge.sources, ...semantic.sources].every((x) => String(x.description ?? '').length > 10));

  // Unbindable is enforced at the ENDPOINT too, not only greyed out in the client: the button is one
  // writer of this decision and the API is another, and only one of them is a security-relevant boundary.
  const bindDeclined = await post('/api/manage/memory/layer/semantic',
    { source: 'claude-cli', model: 'haiku' });
  ok('binding 语义 to Claude is refused by the API, not merely disabled in the UI',
    bindDeclined.status === 400, String(bindDeclined.status));
  const bindEmbedded = await post('/api/manage/memory/layer/judge',
    { source: 'builtin', model: 'haiku' });
  ok('and so is binding anything to the runtime that is not shipped yet',
    bindEmbedded.status === 400, String(bindEmbedded.status));

  // THE APP-PROVISIONED BACKEND, on BOTH layers. It is the second class to implement both layer
  // interfaces (after openai-compat), and the first where the app owns the runtime — so it must appear
  // under 判断 AND 语义 from one registration, which is the property the source catalog exists to give.
  for (const [layer, name] of [[judge, 'judge'], [semantic, 'semantic']]) {
    const llama = (layer.sources ?? []).find((x) => x.id === 'llama-cpp');
    ok(`llama.cpp is listed on ${name}`, !!llama,
      JSON.stringify((layer.sources ?? []).map((x) => x.id)));
    // BINDABLE but not AVAILABLE is the distinction that matters here: there IS an implementation (so the
    // button is real), and the prerequisite is unmet (so it carries a reason instead of vanishing).
    ok(`and is bindable-but-unavailable on ${name} until it is downloaded`,
      llama?.bindable === true && llama?.available === false, JSON.stringify(
        { bindable: llama?.bindable, available: llama?.available }));
    ok(`and names 资源 as the fix on ${name}`, /资源/.test(String(llama?.reason ?? '')),
      String(llama?.reason));
    // …and NAMES a row that exists. `suggest` is what lets the panel point at a download instead of at
    // itself, so a stale literal renders a button that fetches nothing — which is what it was while 判断
    // had no chat GGUF to suggest at all.
    //
    // WHICH id depends on how far along the install is, and both are right: with no runtime it must offer
    // the runtime, and with a runtime but no model it must offer a model. A fixture has neither, so this
    // asserts the SET rather than one literal — pinning `gguf-` here failed against the correct answer,
    // which is the assertion being wrong rather than the code.
    const suggestable = ['llama-cpp', ...(await getJson('/api/manage/resources')).resources
      .map((r) => r.id).filter((i) => i.startsWith('gguf-'))];
    ok(`and suggests a resource that actually EXISTS on ${name}`,
      typeof llama?.suggest === 'string' && suggestable.includes(llama.suggest),
      `${llama?.suggest} not in ${suggestable.join(',')}`);
    // Origin is a CONSTANT for this backend, unlike ollama/claude-cli where it depends on the install:
    // a household's own llama-server is reached through openai-compat, so this one is always ours.
    ok(`and reports origin=app on ${name} — never household`,
      llama?.origin?.kind === 'app', JSON.stringify(llama?.origin));
    // It asks for no address. That is the whole difference from openai-compat, which is the same protocol.
    ok(`and asks for no address on ${name}`, llama?.needsEndpoint === false,
      String(llama?.needsEndpoint));
  }
  // Binding it with nothing provisioned must be refused — a binding registers a provider against a port
  // nothing will answer on, and both memory policies are fail-open, so it would surface as silence.
  const bindLlama = await post('/api/manage/memory/layer/semantic',
    { source: 'llama-cpp', model: 'embeddinggemma-300M-Q8_0' });
  ok('binding 语义 to an unprovisioned llama.cpp is refused rather than saved',
    bindLlama.status >= 400, `${bindLlama.status} ${JSON.stringify(bindLlama.body)}`);

  // THE APP-MANAGED RUNTIME, before it is provisioned. A fixture has neither the 35 MB binary nor a
  // 334 MB GGUF and should not download them — so what is asserted here is the ABSENT case, which is the
  // one every household starts in and the one where a bad message costs the most.
  const llamaCold = await getJson('/api/manage/models/llama');
  ok('the llama.cpp runtime reports itself absent rather than broken',
    llamaCold.installed === false && llamaCold.serving === false,
    JSON.stringify({ installed: llamaCold.installed, serving: llamaCold.serving }));
  // The fix is a download, so the sentence must name the panel that does it — the same rule the recall
  // sources follow. A bare "not available" is what sends a household hunting.
  ok('and says where to get it, rather than just that it is missing',
    /资源/.test(String(llamaCold.problem ?? '')), String(llamaCold.problem));
  // ITS OWN PORT, derived from the data folder. A fixed port made this suite report `installed:false,
  // serving:true` and list the DEVELOPER's model — a fixture adopting the real install's router, which is
  // the same bug two Gatherlights on one machine would hit: each adopts the other and serves the wrong
  // data folder's models. Asserted as loopback-and-in-range rather than as a literal, since the value is a
  // hash of a path that differs per fixture.
  {
    const u = new URL(String(llamaCold.baseUrl));
    ok('the runtime has its OWN loopback port, derived from this install',
      u.hostname === '127.0.0.1' && Number(u.port) >= 11435 && Number(u.port) < 11499,
      String(llamaCold.baseUrl));
  }
  ok('and reports no devices and no models, instead of guessing',
    (llamaCold.devices ?? []).length === 0 && (llamaCold.models ?? []).length === 0,
    JSON.stringify({ devices: llamaCold.devices, models: llamaCold.models }));
  // Starting something that is not installed must fail with that same sentence, not a 500 and not a
  // silent 200 that leaves the caller believing a runtime is up.
  const llamaStart = await post('/api/manage/models/llama/start', {});
  ok('starting an unprovisioned runtime is refused with the reason, not a 500',
    llamaStart.status === 409 && /资源/.test(String(llamaStart.body?.error ?? '')),
    `${llamaStart.status} ${JSON.stringify(llamaStart.body)}`);
  // NO POSITIVE CONTROL HERE, stated rather than left as a gap: the serving path needs 35 MB + 334 MB of
  // real downloads, which a suite has no business fetching. It was verified by hand on 2026-08-22 —
  // provision both, POST start (15 s: router launch plus the lazy model load, which is exactly what the
  // warm step exists to pay up front), then embed-bench through the app's own runtime: 9/10 top-1,
  // 10/10 top-3, 25 ms/query. The 25 ms is itself the proof that the generated preset's n-gpu-layers
  // reached the child, since a CPU child measures ~200 ms on the same fixture.

  // WHOSE RUNTIME. The panel used to answer this only by accident, in a failure message: the Ollama the
  // APP downloads and starts was labelled 本机 · Ollama, which reads as the household's. That let a
  // provisioned runtime pass for a manual prerequisite — and it did, in this project's own docs.
  const originOf = (layer, id) =>
    (layer.sources ?? []).find((x) => x.id === id)?.origin ?? null;

  // Deterministic rows first — these do not depend on what is installed on the machine running the suite.
  ok('内置 reports itself as BUNDLED — it runs in-process, so there is no program and no port',
    originOf(semantic, 'builtin')?.kind === 'bundled',
    JSON.stringify(originOf(semantic, 'builtin')));
  ok('其他本机服务 reports HOUSEHOLD — it exists for a service we do not manage',
    originOf(semantic, 'openai-compat')?.kind === 'household',
    JSON.stringify(originOf(semantic, 'openai-compat')));
  // A declined backend has no runtime, so it gets NULL rather than a plausible label. Inventing
  // "the app can download this" for something that can never run is the exact class of unenforced
  // promise this panel exists to refuse.
  ok('a DECLINED backend reports no origin at all, rather than a made-up one',
    originOf(semantic, 'claude-cli') === null && originOf(judge, 'builtin') === null,
    JSON.stringify({ sem: originOf(semantic, 'claude-cli'), judge: originOf(judge, 'builtin') }));
  // Machine-dependent rows: assert the SHAPE, since a CI box and a developer's box legitimately differ.
  for (const [layer, id] of [[judge, 'ollama'], [judge, 'claude-cli']]) {
    const o = originOf(layer, id);
    ok(`${id} reports one of app/household, never nothing`,
      o !== null && ['app', 'household'].includes(o.kind), JSON.stringify(o));
  }

  // POSITIVE CONTROL for the branch this machine does not exercise. Both runtimes resolve the copy WE
  // provisioned before falling through to PATH, so planting a file where the provisioner installs must
  // flip the answer to `app`. Without this the suite only ever proves the `household` half — and a
  // path-comparison that answered `household` unconditionally would pass everything above.
  {
    const planted = path.join(dir, 'state', 'resources', 'ollama', 'ollama.exe');
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.writeFileSync(planted, 'not a real binary — only its PATH is under test');
    const after = originOf((await getJson('/api/manage/memory?refresh=true')).layers
      .find((l) => l.id === 'judge'), 'ollama');
    ok('planting a provisioned copy flips Ollama to APP — the app-managed branch is real',
      after?.kind === 'app', JSON.stringify(after));
    fs.rmSync(planted, { force: true });
  }

  // GGUF INVENTORY AND REMOVAL. A GGUF used to be the one kind of model whose row could not say what it
  // was for or whether a layer held it, because /api/manage/models reported only Ollama's inventory — so
  // its delete button went to Ollama's remove and would have done nothing.
  const inv2 = await getJson('/api/manage/models');
  ok('the inventory is per-RUNTIME, so both can report into one list',
    (inv2.models ?? []).every((m) => typeof m.runtime === 'string' && m.runtime.length > 0),
    JSON.stringify((inv2.models ?? []).map((m) => `${m.id}:${m.runtime}`).slice(0, 4)));
  // Removal must be told WHICH runtime: an Ollama tag and a GGUF id are not reliably distinguishable, and
  // guessing deletes the wrong thing or reports success having deleted nothing.
  const rmGgufGhost = await post('/api/manage/models/remove',
    { model: 'not-installed-at-all', runtime: 'llama-cpp' });
  ok('removing a GGUF that is not installed is a 404, not a false success',
    rmGgufGhost.status === 404, `${rmGgufGhost.status}`);
  // The id gate applies to BOTH runtimes — for a GGUF it is a filename, which needs it at least as much.
  const rmGgufBad = await post('/api/manage/models/remove', { model: '../escape', runtime: 'llama-cpp' });
  ok('and a traversal-shaped id is refused before it can become a path',
    rmGgufBad.status === 400, `${rmGgufBad.status}`);

  // THE BENCHMARK DOOR. `dev.mjs embed-bench` scores every Ollama-hosted embedder through
  // /v1/embeddings; the in-process 内置 backend has no such endpoint, so it was the one arm nobody could
  // measure — and its "same score as Ollama" turned out to be an 8-query artifact. This endpoint is how it
  // gets measured, so its guards are worth asserting even though the fixture cannot hold the 222 MB model.
  const embedEmpty = await post('/api/manage/models/embed', { texts: [] });
  ok('the embed door refuses an empty batch', embedEmpty.status === 400, String(embedEmpty.status));
  const embedFlood = await post('/api/manage/models/embed',
    { texts: Array.from({ length: 65 }, (_, i) => `t${i}`) });
  ok('and refuses more than the cap — it is a measurement door, not an embedding service',
    embedFlood.status === 400, String(embedFlood.status));
  const embedNoModel = await post('/api/manage/models/embed', { texts: ['probe'] });
  // 409 NAMING THE RESOURCE, not a bare 404: the fix is a download, and the caller (the bench) prints
  // "内置 model not downloaded" instead of a status code because this body says which resource.
  ok('and, with no model on disk, says so as a 409 that NAMES the resource to download',
    embedNoModel.status === 409 && embedNoModel.body?.resource === 'embed-model',
    `${embedNoModel.status} ${JSON.stringify(embedNoModel.body)}`);
  // No positive control here, and that is a stated gap rather than an oversight: a 200 needs the 222 MB
  // model, which no fixture should download. It is covered instead by the run that produced the numbers
  // now in BuiltInSemanticSource — 8/10 top-1, 10/10 top-3, 28 ms/query — which is only obtainable
  // THROUGH this endpoint.

  // CAPABILITY, over every model this machine actually holds. Ollama's own answer decides; the shortlist
  // is only the fallback for a daemon too old to report one.
  const inv = await getJson('/api/manage/models');
  const named = (inv.models ?? []).filter((m) => Array.isArray(m.capabilities) && m.capabilities.length > 0);
  const ollamaJudge = judge.sources.find((x) => x.id === 'ollama');
  const ollamaSemantic = semantic.sources.find((x) => x.id === 'ollama');
  if (named.length > 0) {
    const offered = new Set((ollamaJudge?.models ?? []).map((m) => m.id));
    const chatty = named.filter((m) => m.capabilities.includes('completion')).map((m) => m.name);
    const embedOnly = named.filter((m) => !m.capabilities.includes('completion')).map((m) => m.name);
    ok('every judge candidate is one Ollama calls completion-capable, and every other model is excluded',
      chatty.every((x) => offered.has(x)) && embedOnly.every((x) => !offered.has(x)),
      JSON.stringify({ offered: [...offered], chatty, embedOnly }));

    // The mirror, on the other layer: an embedder is offered to 语义 and a chat model is not.
    const embedOffered = new Set((ollamaSemantic?.models ?? []).filter((m) => m.installed).map((m) => m.id));
    ok('and the embedding layer offers the mirror set — embedders yes, chat models no',
      named.filter((m) => m.capabilities.includes('embedding')).every((m) => embedOffered.has(m.name))
        && named.filter((m) => m.capabilities.includes('completion') && !m.capabilities.includes('embedding'))
          .every((m) => !embedOffered.has(m.name)),
      JSON.stringify({ embedOffered: [...embedOffered] }));

    // THE refusal worth having. An embedding model is installed and well-formed and can never answer a
    // judgement — and both memory policies are fail-open, so choosing one would surface as recall that
    // quietly never improves rather than as an error.
    for (const m of embedOnly) {
      const r = await post('/api/manage/memory/layer/judge', { source: 'ollama', model: m });
      ok(`an embedding-only model is refused as a judge: ${m}`, r.status === 409, `${r.status}`);
    }
    // The shortlist could never have refused these — they are the case the old catalog check missed.
    const uncatalogued = embedOnly.filter((x) => !/nomic-embed-text|bge-m3|all-minilm|granite-embedding|snowflake-arctic-embed2|paraphrase-multilingual|qwen3-embedding|embeddinggemma/.test(x));
    ok(`(${uncatalogued.length} of ${embedOnly.length} embedders are OUTSIDE the catalog — the ones the`
      + ' old shortlist check could not have refused)', true,
      uncatalogued.join(', ') || 'none on this machine');

    // POSITIVE CONTROL. Every assertion above is a denial, and a denial-only test passes just as well
    // against a picker that refuses everything — which is the defect being fixed, not a fix for it.
    if (chatty.length > 0) {
      const acc = await post('/api/manage/memory/layer/judge', { source: 'ollama', model: chatty[0] });
      ok(`a completion-capable model IS accepted as a judge: ${chatty[0]}`,
        acc.status === 200, `${acc.status} ${JSON.stringify(acc.body)}`);

      // SAVED vs RUNNING. A binding is a startup registration, so between saving and restarting the two
      // disagree — and the layer's header NAMES its backend. A badge rendered from the saved value would
      // announce a model that is not doing the work.
      const mid = layerOf(await getJson('/api/manage/memory'), 'judge');
      ok('the panel reports the SAVED backend and the RUNNING one separately',
        mid.source === 'ollama' && mid.activeSource === 'claude-cli',
        JSON.stringify({ saved: mid.source, active: mid.activeSource,
          savedModel: mid.model, activeModel: mid.activeModel }));

      await post('/api/manage/memory/layer/judge', { source: 'claude-cli', model: 'haiku' }); // as we found it
    } else {
      ok('(this machine holds no chat model) the accept path is not exercised here', true,
        'the refusals above cannot distinguish "correctly strict" from "always refuses"');
    }
  } else {
    ok('(no Ollama on this machine) the capability filter is not exercised here', true,
      'the layer/source shape above still holds');
  }

  // A disabled control must SAY why — and the sentence must live OUTSIDE the <select>, which only renders
  // when there is something to select: the one case it existed to explain was the one it could never
  // appear in.
  ok('a source carries a reason exactly when it cannot serve',
    [...judge.sources, ...semantic.sources].every((x) => x.available === !x.reason),
    JSON.stringify([...judge.sources, ...semantic.sources].map((x) => [x.id, x.available, !!x.reason])));
  // …and when the fix is a download, it NAMES a model rather than printing a shell command. Asserted as a
  // name the pull endpoint would accept, by SHAPE: this suite runs on a developer's machine and the
  // suggestion is a multi-gigabyte model, so proving the button by downloading it would cost far more
  // than the assertion is worth.
  for (const src of [...judge.sources, ...semantic.sources]) {
    if (!src.suggest) continue;
    ok(`the suggested model is a name the pull endpoint would accept: ${src.suggest}`,
      /^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9._-]+)?$/.test(src.suggest), src.suggest);
  }

  // ---- F · models are a RESOURCE, not a recall setting -------------------------------------------
  ok('the model inventory answers, and reports the runtime that hosts them',
    Array.isArray(inv.models) && !!inv.runtime && typeof inv.runtime.serving === 'boolean',
    JSON.stringify(inv.runtime));
  ok('every installed model names its runtime and carries what Ollama says it can do',
    (inv.models ?? []).every((x) => x.runtime === 'ollama' && 'capabilities' in x),
    JSON.stringify((inv.models ?? [])[0] ?? null));
  ok('downloads in flight are readable here — this is what the progress bar renders from',
    Array.isArray(inv.pulls));
  // The offers list is not just the embedding catalog: the local judge and the local embedder are ONE
  // provider, so when the missing piece is a CHAT model this panel must be able to fetch that too.
  ok('what can be downloaded covers both capabilities, not embedders alone',
    (inv.offers ?? []).some((o) => o.capability === 'embedding')
      && ((inv.offers ?? []).some((o) => o.capability === 'completion')
        || (inv.models ?? []).some((m) => (m.capabilities ?? []).includes('completion'))),
    JSON.stringify((inv.offers ?? []).map((o) => [o.id, o.capability])));
  ok('and the comparison it offers carries its sample size, not just a verdict',
    typeof inv.measuredOn === 'string' && /\d/.test(inv.measuredOn), inv.measuredOn);

  // A MOVE, not an alias. An endpoint answering at both addresses is two surfaces to keep in step, and
  // the one nobody remembers is the one that rots.
  //
  // The CONTROL first: this app answers an unrouted POST with 405, not 404 — the request falls through to
  // the static/SPA handler, which allows only GET. Without establishing that here, the assertions below
  // would be checking a number nobody could interpret, and a future 404 would look like a regression when
  // it is the same answer.
  const unrouted = await post('/api/manage/memory/definitely-not-a-route', {});
  const goneStatus = unrouted.status;
  ok('(control) an unrouted POST answers 405 here, so that is what "gone" looks like',
    goneStatus === 405 || goneStatus === 404, String(goneStatus));
  for (const [label, path_] of [
    ['pull', '/api/manage/memory/local/pull'],
    ['remove', '/api/manage/memory/local/remove'],
    ['start', '/api/manage/memory/local/start'],
    ['enable', '/api/manage/memory/local/enable'],
    ['judge', '/api/manage/memory/judge'],
  ]) {
    const gone = await post(path_, { model: 'bge-m3' });
    ok(`the old ${label} path is gone, not quietly aliased`, gone.status === goneStatus,
      `${path_} → ${gone.status} (unrouted answers ${goneStatus})`);
  }

  // ---- G · a download is started and REPORTED, not awaited inside the POST -------------------------
  // A model is hundreds of megabytes to gigabytes and the pull budget is two hours. Awaiting it in the
  // request gave a button reading 下载中… with no bar and no bytes — indistinguishable from a hang — over
  // a request the browser may abandon while Ollama carries on downloading.
  //
  // Driven with a model that does NOT exist, deliberately: a test that proves the download works by
  // downloading a gigabyte is doing more harm than the assertion is worth. A pull that fails fast
  // exercises the whole seam — 202, live state, recorded outcome — and the outcome is the half that would
  // otherwise vanish.
  const ghost = 'gatherlight-no-such-model:1b';
  const t1 = Date.now();
  const pull = await post('/api/manage/models/pull', { model: ghost });
  const pullTook = Date.now() - t1;
  ok('a pull is ACCEPTED and returns immediately, rather than running inside the request',
    pull.status === 202 && pullTook < 3000, `status=${pull.status} in ${pullTook}ms`);
  // Asking twice is not an error: the household asked for a download and one is running. A 409 here would
  // put an error toast over a working progress bar.
  ok('and asking again while it runs is still success, not a conflict',
    [202].includes((await post('/api/manage/models/pull', { model: ghost })).status));

  let pulls = (await getJson('/api/manage/models')).pulls ?? [];
  ok('the panel can read downloads back as STATE — this is what the progress bar renders from',
    Array.isArray(pulls) && pulls.some((p) => p.model === ghost),
    JSON.stringify(pulls));
  await until(async () => {
    pulls = (await getJson('/api/manage/models')).pulls ?? [];
    return !pulls.some((p) => p.model === ghost && p.running);
  });
  const ended = pulls.find((p) => p.model === ghost);
  // A failed download that simply disappeared would read as one that never started — the same class of
  // silence as the greyed-out button this whole section replaces.
  ok('a download that failed says so instead of vanishing',
    !!ended && ended.running === false && !!ended.error, JSON.stringify(ended));

  // ---- H · 语义 refuses a non-embedder without waiting out a cold model load ---------------------
  const chatModel = named.find((m) => !m.capabilities.includes('embedding'));
  if (chatModel) {
    const t2 = Date.now();
    const r = await post('/api/manage/memory/layer/semantic', { source: 'ollama', model: chatModel.name });
    const took2 = Date.now() - t2;
    // The embed PROBE is still the load-bearing check and still runs for everything else; this only
    // spares the household a minute of a dead button for an answer Ollama already gave.
    ok(`binding a chat model to 语义 is refused, and quickly: ${chatModel.name}`,
      r.status === 409 && took2 < 20000, `${r.status} in ${took2}ms`);
  } else {
    ok('(this machine holds no chat model) the fast embed refusal is not exercised here', true,
      `${named.length} models reporting capabilities`);
  }

  const anyEmbedder = (ollamaSemantic?.models ?? []).find((m) => m.installed);
  if (anyEmbedder) {
    // This machine has Ollama AND an embedder: the positive control for every refusal above.
    const bindSem = await post('/api/manage/memory/layer/semantic',
      { source: 'ollama', model: anyEmbedder.id });
    ok('(this machine has an embedder) binding 语义 asks for a restart and a reindex',
      bindSem.status === 200 && bindSem.body?.restartRequired === true && bindSem.body?.reindexRequired === true,
      JSON.stringify(bindSem.body));
    ok('and reports the vector width it actually measured, rather than one looked up',
      typeof bindSem.body?.dimensions === 'number' && bindSem.body.dimensions > 0,
      JSON.stringify({ dims: bindSem.body?.dimensions, ms: bindSem.body?.probeMs }));

    // THE POINT of the async rebuild: the call RETURNS while the work continues. Asserted by the status
    // code and by the clock — a 202 that actually blocked would still be a 202.
    const t0 = Date.now();
    const started = await post('/api/manage/memory/layer/semantic/reindex');
    const took = Date.now() - t0;
    ok('a reindex is ACCEPTED and returns immediately, rather than running inside the request',
      started.status === 202 && took < 3000, `status=${started.status} in ${took}ms`);
    ok('and a second one is refused while the first is running or finishing',
      [202, 409].includes((await post('/api/manage/memory/layer/semantic/reindex')).status),
      'one rebuild at a time — two would interleave discards and writes over the same graph');

    // Unbinding leaves the model and its vectors alone: turning a feature off must not throw away
    // something that cost a large download and a long reindex.
    const offSem = await post('/api/manage/memory/layer/semantic/off');
    ok('语义 can be unbound, and asks for a restart', offSem.status === 200, String(offSem.status));
    const afterOff = layerOf(await getJson('/api/manage/memory'), 'semantic');
    ok('and the model choice is REMEMBERED, so turning it back on costs neither download nor rebuild',
      afterOff.on === false && afterOff.model === anyEmbedder.id,
      JSON.stringify({ on: afterOff.on, model: afterOff.model }));
  } else {
    ok('(no embedder on this machine) the 语义 accept path is not exercised here', true,
      'the refusals above cannot distinguish "correctly strict" from "always refuses"');
  }
  // ---- I · a settings.json written BEFORE the source model still resolves correctly ---------------
  // Found on a real data folder, not by this fixture — which is why it is now a case.
  //
  // JudgeModel used to belong to the LOCAL arm alone, and the old switch deliberately REMEMBERED it when
  // moving back to the CLI ("going back should not throw away a choice that cost a download"). So an
  // install can hold `transport: cli` beside `judgeModel: gemma3:4b`. Reading that as the CLI's model
  // hands an Ollama model id to Claude AND writes it into DefaultModelByConsumer — the mirror of the
  // two-writers bug this pass removed, and just as silent, because both policies are fail-open. It
  // surfaced as a badge reading "Claude CLI · gemma3:4b".
  //
  // A SECOND server on its own port: the resolution happens during DI, so it cannot be re-exercised by
  // poking the running one — and restarting a server on the SAME port inside one suite is its own trap.
  const legacyDir = dataDirFor('p51-legacy');
  fs.rmSync(legacyDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(legacyDir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, 'state', 'settings.json'),
    JSON.stringify({ memory: { judgeTransport: 'cli', judgeModel: 'gemma3:4b' } }, null, 2),
    'utf8');

  let legacy;
  try {
    legacy = startServer({ dataDir: legacyDir, port: PORT + 1, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
    await until(async () => {
      const r = await fetch(`${legacy.base}/api/health`);
      return r.ok && (await r.json()).migrating === false;
    });
    const old = layerOf(await makeClient(legacy.base).getJson('/api/manage/memory'), 'judge');
    ok('a legacy settings.json resolves to the CLI backend', old.source === 'claude-cli', old.source);
    ok('THE TRAP: its remembered LOCAL model is not reported as the CLI\'s model',
      old.model === 'haiku', `model=${old.model} (gemma3:4b would mean an Ollama id was handed to Claude)`);
    ok('and the running backend agrees, so no restart is falsely owed',
      old.activeSource === 'claude-cli' && old.activeModel === 'haiku',
      JSON.stringify({ active: old.activeSource, activeModel: old.activeModel }));
  } finally {
    try { legacy?.stop(); } catch { /* best effort */ }
  }
} catch (err) {
  fail('e2e-p51 fatal: ' + err.message);
  console.error(srv?.log?.().slice(-3000) ?? '');
} finally {
  try { srv?.stop(); } catch { /* best effort */ }
}
done();
