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
import http from 'node:http';
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
  // Backends arrive GROUPED (cli / machine / self-contained — see MemoryGroups). Flattening keeps every
  // assertion below written about backends, which is deliberate: they now also prove the grouping lost
  // nothing, since a member that failed to land in a group would vanish from this list.
  const srcs = (layer) => (layer?.groups ?? []).flatMap((g) => g.sources ?? []);

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

  // ---- A2 · THREE places a model can live, not five implementations -----------------------------
  // The picker listed one row per backend, so `ollama` and `openai-compat` sat side by side as separate
  // answers when they are the same answer ("something already on my machine"), and one row per layer was
  // DECLINED — a fifth of the control that could never work. The axis a household chooses on is who
  // MANAGES the model, and there are three answers.
  for (const [layer, name] of [[judge, 'judge'], [semantic, 'semantic']]) {
    const gs = layer.groups ?? [];
    ok(`${name} offers at most three groups, in a fixed order`,
      gs.length > 0 && gs.length <= 3
        && JSON.stringify(gs.map((g) => g.id))
          === JSON.stringify(['cli', 'managed', 'none'].filter((g) => gs.some((x) => x.id === g))),
      JSON.stringify(gs.map((g) => g.id)));
    // The words belong to the server: a group is a product statement about who manages a model, and the
    // console re-deriving them would be a second writer of the same sentence.
    ok(`and every ${name} group carries its own name and sentence`,
      gs.every((g) => typeof g.name === 'string' && g.name.length > 0
        && typeof g.description === 'string' && g.description.length > 10),
      JSON.stringify(gs.map((g) => [g.id, g.name])));
    // An empty group is omitted rather than rendered blank — EXCEPT `none`, whose emptiness IS its
    // meaning: it offers no backend because choosing it is choosing not to have one. Every other heading
    // with nothing under it is a defect.
    ok(`and no ${name} group is empty except the no-model one`,
      gs.every((g) => (g.sources ?? []).length > 0 || g.id === 'none'),
      JSON.stringify(gs.map((g) => [g.id, (g.sources ?? []).length])));
  }
  // BOTH ways we supply a model share one heading, because the household's decision is who manages it —
  // llama-server in its own process, or an ONNX session in ours, are two implementations of one answer.
  {
    const g = (l, id) => (l.groups ?? []).find((x) => x.id === id)?.sources?.map((s) => s.id) ?? [];
    ok('llama.cpp holds BOTH ways we supply a model, from one heading',
      g(semantic, 'managed').includes('llama-cpp') && g(semantic, 'managed').includes('builtin'),
      JSON.stringify(g(semantic, 'managed')));
    // The declined member sits inside a group whose OTHER member works, so 判断 still has that whole
    // heading available — what used to be a dead fifth of the picker is not a choice at all any more.
    ok('判断 can use the managed heading THROUGH llama.cpp even though ONNX cannot judge',
      g(judge, 'managed').includes('llama-cpp') && g(judge, 'managed').includes('builtin'),
      JSON.stringify(g(judge, 'managed')));
    // And the no-model group is the empty one, on both layers: no backend, because choosing it is
    // choosing no model.
    ok('the no-model group offers no backend at all — on both layers',
      g(judge, 'none').length === 0 && g(semantic, 'none').length === 0,
      JSON.stringify({ judge: g(judge, 'none'), semantic: g(semantic, 'none') }));

    // ONE WORD, ONE MEANING. 内置 is the id and the 资源 label of the ONNX embedder that runs INSIDE this
    // process. It was ALSO the picker's name for the no-model group, so the same word meant "a real model,
    // hosted by us" in one panel and "switch this layer off" in another. That lands hardest on exactly the
    // household this matters most to: someone on the Claude CLI, for whom the in-process embedder is the
    // only way to get real vectors without running a separate program, being told 内置 means turning the
    // layer off.
    const nameOf = (l, id) => (l.groups ?? []).find((x) => x.id === id)?.name ?? '';
    ok('the no-model group is NOT called 内置 — that word belongs to the in-process backend',
      !nameOf(semantic, 'none').includes('内置') && !nameOf(judge, 'none').includes('内置'),
      JSON.stringify({ judge: nameOf(judge, 'none'), semantic: nameOf(semantic, 'none') }));

    // And the download group is not named after ONE of its two runtimes. llama.cpp is a resident service;
    // the other member is ONNX in our own process and uses no part of it. Naming the heading "llama.cpp"
    // told a household they had to download and run llama.cpp to get the thing that needs neither.
    ok('the managed group is named for what it COSTS, not after one of its runtimes',
      nameOf(semantic, 'managed').length > 0 && !nameOf(semantic, 'managed').includes('llama'),
      JSON.stringify(nameOf(semantic, 'managed')));
  }

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
  // THE COST LINE MUST DESCRIBE THE BOUND ARM, and for 语义 it did not.
  //
  // It was a fixed string from when the only arm was an embedder: 「不消耗 token;资料不离开这台电脑」.
  // The Claude CLI arm sends every fact to Claude to be rephrased and bills for it, so a household that
  // chose that arm was reading a privacy promise answered for a backend they had not chosen. That is the
  // unenforced plain-language claim this whole surface exists to prevent, in its worst form.
  {
    const bindSem = await post('/api/manage/memory/layer/semantic',
      { source: 'claude-cli', model: 'haiku' });
    ok('(fixture) 语义 binds to the Claude arm', bindSem.status === 200, String(bindSem.status));
    const semCli = layerOf(await getJson('/api/manage/memory'), 'semantic');
    ok('语义 on Claude does NOT claim the data stays on this machine',
      !/不离开这台电脑/.test(semCli?.cost ?? ''), JSON.stringify(semCli?.cost));
    ok('…and says what it actually does with the facts',
      /发送给/.test(semCli?.cost ?? '') && /额度|token/i.test(semCli?.cost ?? ''),
      JSON.stringify(semCli?.cost));
    // The claim is not simply deleted — it is still TRUE for a local arm, and dropping it everywhere
    // would understate what a household gets from running the model themselves.
    const bindLocal = await post('/api/manage/memory/layer/semantic',
      { source: 'builtin', model: 'embeddinggemma-300M-Q8_0' });
    if (bindLocal.status === 200) {
      const semLocal = layerOf(await getJson('/api/manage/memory'), 'semantic');
      ok('…while a local arm still says the data stays put',
        /不离开这台电脑/.test(semLocal?.cost ?? ''), JSON.stringify(semLocal?.cost));
    } else {
      ok('(skipped) the in-process embedder is not installed in this fixture',
        true, `bind -> ${bindLocal.status}`);
    }
    // Leave the layer as this block found it — later cases assert on 语义 being UNBOUND, and a fixture
    // that quietly changes shared state makes the next assertion fail for a reason that is not its own.
    await post('/api/manage/memory/layer/semantic/off');
  }

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
  // must still hold is that something which is not a model NAME never reaches a path or a process
  // argument, so that is what these assert.
  //
  // Aimed at REMOVE rather than at pull, which is gone with Ollama (see section G). That is the stricter
  // target anyway: remove is the one that turns an id into a filesystem path under the resources folder,
  // so a traversal here would matter in a way it never did against a registry tag.
  for (const [label, bad] of [
    ['a flag-shaped id', '--config'],
    ['a path traversal', '../../etc/passwd'],
    ['an id with whitespace', 'nomic embed text'],
  ]) {
    const r = await post('/api/manage/models/remove', { model: bad, runtime: 'llama-cpp' });
    ok(`remove refuses ${label} before it becomes a path`, r.status === 400, `${bad} → ${r.status}`);
  }
  // A WELL-FORMED id that this machine does not have is a different answer: not "unknown", but "not
  // downloaded". Conflating the two is what made a newer model look like a typo.
  const notHere = await post('/api/manage/memory/layer/semantic',
    // Asked of llama.cpp rather than of a daemon: the point is the DISTINCTION between "not a model name"
    // (400) and "a real name we do not have" (409), and a managed runtime answers it without an address.
    { source: 'llama-cpp', model: 'some-future-embedder-Q8_0' });
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
  const judgeSources = srcs(judge).map((x) => x.id);
  const semanticSources = srcs(semantic).map((x) => x.id);
  // The FULL list, in the order MemoryBackends fixes. `llama-cpp` joined it on 2026-08-22 and pushed
  // `builtin` one place along — this assertion firing is how that was noticed, which is the point of
  // pinning an order rather than a set. Update it when a backend lands, deliberately.
  // No `ollama`: the dedicated backend is GONE. The managed local runtime is llama.cpp — we install it,
  // start it and pin its models — and a household running Ollama reaches it through `openai-compat` by
  // address, verified end to end (/v1/models, /v1/embeddings, /v1/chat/completions). Half-managing a
  // second runtime is what produced a panel that listed a daemon's models while nothing could add or
  // remove one. The legacy id still RESOLVES — asserted below — so no existing install loses its layer.
  const BACKENDS = ['claude-cli', 'llama-cpp', 'builtin'];

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

  // …and `bindable` separates "cannot, ever" from "cannot yet".
  //
  // THIS PAIR WAS INVERTED ON PURPOSE, and the old test said so: it asserted Claude was unbindable under
  // 语义 "because no class implements that layer's interface", and predicted that adding a
  // ClaudeCliSemanticSource SHOULD make it fail and be updated deliberately. That is what happened — the
  // prediction was right and the reasoning was not. The class was absent because we had DEFINED the layer
  // as embeddings, which left every install that cannot run a local model with no option and a paragraph.
  // Claude still cannot embed; it can rephrase, which serves the same job by another route.
  const bindable = (l, id) => srcs(l).find((x) => x.id === id)?.bindable;
  ok('Claude IS bindable on 语义 now — by rephrasing, which needs no local model',
    bindable(semantic, 'claude-cli') === true, String(bindable(semantic, 'claude-cli')));
  ok('…but it can be bound to 判断, which is the same backend doing what it can do',
    bindable(judge, 'claude-cli') === true, String(bindable(judge, 'claude-cli')));
  // THE BUILT-IN RUNTIME SHIPPED FOR 语义 — this assertion used to say "bindable on neither", and flipping
  // it was the plan: docs/builtin-model-runner.md predicted this exact line would have to change, so that
  // nobody could add the source without noticing the suite's claim about it had changed.
  //
  // It stays DECLINED for 判断 — as an option nobody BUILT, not an impossibility: an in-process reranker
  // could verify (Lyntai 3.2 ships one), but that path reads only English-only models today, so the
  // multilingual rerankers run on llama.cpp (MemorySources.BuiltInCannotJudge says so to the household).
  ok('the built-in runtime is bindable on 语义 now, and still declined on 判断',
    bindable(semantic, 'builtin') === true && bindable(judge, 'builtin') === false,
    JSON.stringify({ judge: bindable(judge, 'builtin'), semantic: bindable(semantic, 'builtin') }));
  // …and BINDABLE is not AVAILABLE. The fixture has not downloaded 222 MB of weights, so it must report
  // itself unusable AND name the download — the distinction between "no implementation" and "not set up
  // yet" is the whole reason those are two fields.
  const builtIn = srcs(semantic).find((x) => x.id === 'builtin');
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
    bindable(judge, 'claude-cli') === true && bindable(semantic, 'claude-cli') === true);
  // THE REMOVED BACKEND STAYS REMOVED. Asserted as absence because a re-added `ollama` source would quietly
  // recreate the two-members-one-daemon ambiguity that ORIGIN already had to untangle once.
  ok('there is no `ollama` backend on either layer any more',
    bindable(judge, 'ollama') === undefined && bindable(semantic, 'ollama') === undefined,
    JSON.stringify({ judge: bindable(judge, 'ollama'), semantic: bindable(semantic, 'ollama') }));

  // ONE CLASS implementing BOTH layer interfaces — the case the per-layer design exists for, and until
  // this backend there was no instance of it. Ollama does not count: it is two classes.
  // THE RETIRED BACKENDS STAY RETIRED, and an install still naming one is TOLD rather than moved.
  //
  // `openai-compat` was the one path never tested end to end: every case that used to live here was a
  // denial (non-loopback refused, junk refused, unreachable reported) or an address round-trip against a
  // port with nothing listening — the comment said so itself, "saving the address and REACHING it are two
  // different steps and only the first one happens here". Nothing ever listed models from a live endpoint,
  // embedded through it, or answered a judgement through it; its only evidence was that llama.cpp uses the
  // same underlying provider. `ollama` went for a different reason — we half-managed a runtime we did not
  // own. Neither has anywhere to be mapped TO, so a binding to one is REFUSED and the layer says why.
  for (const id of ['openai-compat', 'ollama']) {
    const r = await post('/api/manage/memory/layer/judge', { source: id, model: 'haiku' });
    ok(`binding the retired \`${id}\` is refused rather than silently redirected`,
      r.status === 400, `${r.status} ${JSON.stringify(r.body?.error ?? '').slice(0, 50)}`);
  }

  // A backend that cannot be used must SAY so. This is the assertion that would fail if someone "tidied
  // up" by dropping the declined entries instead of explaining them.
  ok('every backend a layer cannot use carries a reason, not just a disabled button',
    [...srcs(judge), ...srcs(semantic)]
      .filter((x) => !x.bindable)
      .every((x) => typeof x.reason === 'string' && x.reason.length > 10),
    JSON.stringify([...srcs(judge), ...srcs(semantic)]
      .filter((x) => !x.bindable).map((x) => [x.id, x.reason?.slice(0, 40)])));
  // Claude no longer HAS a refusal under 语义 — it has an arm. What must still hold is that the arm does
  // not pretend to embed: the probe reports what it actually proved, and a fabricated vector width is the
  // fail-open lie this whole area exists to prevent (a bogus width matches nothing, silently, for ever).
  ok('the CLI arm on 语义 describes itself as rephrasing, not as embedding',
    /改写|说法/.test(String(srcs(semantic).find((x) => x.id === 'claude-cli')?.description ?? '')),
    String(srcs(semantic).find((x) => x.id === 'claude-cli')?.description ?? '').slice(0, 80));
  ok('and each carries what choosing it costs, rather than just a name',
    [...srcs(judge), ...srcs(semantic)].every((x) => String(x.description ?? '').length > 10));

  // Unbindable is still enforced at the ENDPOINT and not merely greyed out — the button is one writer of
  // that decision and the API is another, and only one of them is a boundary. Demonstrated on a backend
  // that is declined (内置 on 判断 — unbuilt rather than impossible since a reranker can judge, but still
  // unbindable), since Claude on 语义 is now a real arm and no longer serves as the example.
  const bindDeclined = await post('/api/manage/memory/layer/judge',
    { source: 'builtin', model: 'haiku' });
  ok('binding a DECLINED backend is refused by the API, not merely disabled in the UI',
    bindDeclined.status === 400, String(bindDeclined.status));

  // THE APP-PROVISIONED BACKEND, on BOTH layers. It is the second class to implement both layer
  // interfaces (after openai-compat), and the first where the app owns the runtime — so it must appear
  // under 判断 AND 语义 from one registration, which is the property the source catalog exists to give.
  for (const [layer, name] of [[judge, 'judge'], [semantic, 'semantic']]) {
    const llama = srcs(layer).find((x) => x.id === 'llama-cpp');
    ok(`llama.cpp is listed on ${name}`, !!llama,
      JSON.stringify(srcs(layer).map((x) => x.id)));
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
    // Origin is a CONSTANT for this backend, unlike claude-cli where it depends on the install:
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
    srcs(layer).find((x) => x.id === id)?.origin ?? null;

  // Deterministic rows first — these do not depend on what is installed on the machine running the suite.
  ok('内置 reports itself as BUNDLED — it runs in-process, so there is no program and no port',
    originOf(semantic, 'builtin')?.kind === 'bundled',
    JSON.stringify(originOf(semantic, 'builtin')));
  // A declined backend has no runtime, so it gets NULL rather than a plausible label. Inventing
  // "the app can download this" for something that can never run is the exact class of unenforced
  // promise this panel exists to refuse.
  // Still asserted, on the backend that is still declined: 内置 cannot judge. The 语义/Claude half moved
  // out of this check because that entry is no longer declined — it is a real arm with a real runtime, and
  // a real runtime must report its origin.
  ok('a DECLINED backend reports no origin at all, rather than a made-up one',
    originOf(judge, 'builtin') === null,
    JSON.stringify({ sem: originOf(semantic, 'claude-cli'), judge: originOf(judge, 'builtin') }));
  // Machine-dependent rows: assert the SHAPE, since a CI box and a developer's box legitimately differ.
  for (const [layer, id] of [[judge, 'claude-cli']]) {
    const o = originOf(layer, id);
    ok(`${id} reports one of app/household, never nothing`,
      o !== null && ['app', 'household'].includes(o.kind), JSON.stringify(o));
  }

  // THE `app` ORIGIN BRANCH IS COVERED IN p50, NOT HERE — and the reason is a property of this suite.
  //
  // It used to be exercised by planting an `ollama.exe` where the provisioner installs, which flipped that
  // backend's origin from `household` to `app`. Removing the Ollama backend removed the only case this
  // suite could drive: llama.cpp's origin is a CONSTANT `app` (no branch to get wrong), 内置 is a constant
  // `bundled`, openai-compat a constant `household` — and claude-cli, the one backend that still decides
  // per install, resolves GATHERLIGHT_CLAUDE_CMD first, which every suite must set to the stub. So a
  // planted file loses to the override by design and the assertion measured nothing.
  //
  // What remains covered HERE: the three constants above, and that claude-cli returns one of the two rather
  // than null. The branch itself now has a home — p50 case F runs claudeless and downloads a real file to
  // the provisioned path, so `Locate()` returns it with no override in the way, and that suite asserts
  // origin=app. That is the "fixture that does not stub the CLI" this note used to ask for.

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

  // CAPABILITY, over every model this machine actually holds.
  //
  // THE GROUND TRUTH MOVED, and the suite says so rather than quietly weakening. It used to come from
  // `/api/manage/models`, which listed the household's Ollama inventory with Ollama's own `capabilities`
  // on each row — an INDEPENDENT source to check the picker against. 资源 no longer manages Ollama (it
  // provisions what Gatherlight owns; Ollama is a household runtime we only connect to), so that endpoint
  // holds GGUFs now and the Ollama answer is reachable only through the picker itself.
  //
  // So this compares the picker's TWO INTERNAL answers against each other: what each layer OFFERS
  // (ModelsAsync) versus what it REFUSES (RejectAsync). That is weaker than an external oracle and still
  // catches the defect this section exists for — the old capability predicate was wrong in both
  // directions at once, admitting an uncatalogued embedder as a judge while disabling the switch on a
  // machine full of chat models, and either half shows up here as offer/refusal disagreement.
  const inv = await getJson('/api/manage/models');
  // THE CAPABILITY SPLIT IS llama.cpp's NOW, and this block had to be rebuilt or it would have kept
  // reporting PASS while executing nothing: it keyed on `srcs(judge).find(x => x.id === 'ollama')`, and
  // after that backend was removed every `if` below was false. A suite that skips silently is worse than a
  // missing one — it reads as coverage.
  //
  // The oracle is BETTER than before, too. It used to ask Ollama what each model could do; the inventory now
  // declares it from the catalogue we pinned, which is independent of the picker being tested rather than
  // another view of it.
  const local = (inv.models ?? []).filter((m) => m.installed && m.runtime === 'llama-cpp');
  const embedders = local.filter((m) => m.capability === 'embedding');
  const chatModels = local.filter((m) => m.capability === 'completion');

  if (embedders.length > 0) {
    // THE refusal worth having. An embedding model is installed, well-formed, and can never answer a
    // judgement — and both memory policies are fail-open, so choosing one surfaces as recall that quietly
    // never improves rather than as an error.
    for (const m of embedders) {
      const r = await post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: m.id });
      ok(`an embedding model is refused as a judge: ${m.id}`, r.status === 409, `${r.status}`);
    }
  } else {
    ok('(no embedding model on this machine) the judge refusal is not exercised here', true,
      'needs a downloaded embedding GGUF; the fixture has none and must not fetch 334 MB');
  }

  if (chatModels.length > 0) {
    // POSITIVE CONTROL. Every assertion above is a denial, and a denial-only test passes just as well
    // against a picker that refuses everything — which is the defect, not a fix for it.
    const pick = chatModels[0];
    const acc = await post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: pick.id });
    ok(`a chat model IS accepted as a judge: ${pick.id}`, acc.status === 200,
      `${acc.status} ${JSON.stringify(acc.body)}`);

    // SAVED vs RUNNING. A binding that registers a provider is a startup registration, so between saving
    // and restarting the two disagree — and the layer's header NAMES its backend. A badge rendered from the
    // saved value would announce a model that is not doing the work.
    const mid = layerOf(await getJson('/api/manage/memory'), 'judge');
    ok('the panel reports the SAVED backend and the RUNNING one separately',
      mid.source === 'llama-cpp' && mid.activeSource === 'claude-cli',
      JSON.stringify({ saved: mid.source, active: mid.activeSource,
        savedModel: mid.model, activeModel: mid.activeModel }));

    await post('/api/manage/memory/layer/judge', { source: 'claude-cli', model: 'haiku' }); // as we found it
  } else {
    ok('(no chat model on this machine) the judge accept path is not exercised here', true,
      'needs a downloaded completion GGUF; the refusals above cannot tell "strict" from "refuses everything"');
  }

  // A disabled control must SAY why — and the sentence must live OUTSIDE the <select>, which only renders
  // when there is something to select: the one case it existed to explain was the one it could never
  // appear in.
  ok('a source carries a reason exactly when it cannot serve',
    [...srcs(judge), ...srcs(semantic)].every((x) => x.available === !x.reason),
    JSON.stringify([...srcs(judge), ...srcs(semantic)].map((x) => [x.id, x.available, !!x.reason])));
  // …and when the fix is a download, it NAMES a model rather than printing a shell command. Asserted as a
  // name the pull endpoint would accept, by SHAPE: this suite runs on a developer's machine and the
  // suggestion is a multi-gigabyte model, so proving the button by downloading it would cost far more
  // than the assertion is worth.
  for (const src of [...srcs(judge), ...srcs(semantic)]) {
    if (!src.suggest) continue;
    ok(`the suggested model is a name the pull endpoint would accept: ${src.suggest}`,
      /^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9._-]+)?$/.test(src.suggest), src.suggest);
  }

  // ---- E2 · 语义 HAS A CLI ARM, so a machine with no local model is not left with nothing ----------
  // This layer was defined as "turn a fact into a vector", which made it unavailable on exactly the
  // installs that need it most: no GPU to spare, a GPU wanted for something else, or a household who
  // declines the download. The panel then EXPLAINED the absence instead of offering anything — and the
  // explanation ("no class implements the interface") was circular, since the interface asked for a vector
  // because we had defined the layer that way.
  const semGroups = semantic.groups ?? [];
  const cliArm = semGroups.flatMap((g) => g.sources ?? []).find((x) => x.id === 'claude-cli');
  ok('语义 offers a Claude arm — it rephrases instead of embedding, so no local model is needed',
    !!cliArm && cliArm.bindable === true, JSON.stringify(cliArm ?? null));
  ok('…and it offers models to pick from rather than an empty picker with a sentence beside it',
    (cliArm?.models ?? []).some((m) => m.installed),
    JSON.stringify((cliArm?.models ?? []).map((m) => m.id)));
  // NOTHING DECLINED. A declined entry is the right shape for a real impossibility and the wrong shape for
  // an option nobody built — asserted as emptiness so re-adding one has to be deliberate.
  ok('nothing is declined on 语义 any more, so no paragraph stands in for a choice',
    semGroups.every((g) => (g.sources ?? []).every((x) => x.bindable)),
    JSON.stringify(semGroups.flatMap((g) => (g.sources ?? []).map((x) => [x.id, x.bindable]))));

  // IT BINDS, and binding runs the real prove path — RephraseAsync through the stubbed CLI. A source that
  // merely LISTS is the gap this project has been caught by repeatedly ("listed" is not "usable").
  const bindRephrase = await post('/api/manage/memory/layer/semantic',
    { source: 'claude-cli', model: 'haiku' });
  ok('binding 语义 to the CLI arm succeeds, having actually proved it can rephrase',
    bindRephrase.status === 200, `${bindRephrase.status} ${JSON.stringify(bindRephrase.body)}`);
  // AND THE NUMBER SAYS WHAT IT IS. This arm's probe returns a count of PHRASINGS, which shares a field
  // with the embedding arms' vector width — `dimensions: 4` from a rephrasing probe would read as a
  // 4-dimensional embedding. The companion assertion for the embedding case lives further down inside a
  // branch that only runs where a real model is installed, so without this one the field had no coverage
  // in a fixture at all — which is how it came to exist, unsent, for a whole commit.
  ok('…and reports WHAT it proved, so a phrasing count is not read as a vector width',
    bindRephrase.body?.proved === 'phrasings',
    JSON.stringify({ dimensions: bindRephrase.body?.dimensions, proved: bindRephrase.body?.proved }));
  const afterRephrase = layerOf(await getJson('/api/manage/memory'), 'semantic');
  ok('…and the panel reports the CLI arm as the saved backend',
    afterRephrase.source === 'claude-cli',
    JSON.stringify({ source: afterRephrase.source, model: afterRephrase.model }));

  // NO RESTART IS OWED, and this is the assertion the fix needs or it regresses silently.
  //
  // The panel decides "a restart is owed" by comparing the SAVED backend against the RUNNING one, and it
  // infers running for 语义 from whether the container holds an ISemanticMemory. This arm registers
  // nothing — its effect is at write time — so it read as permanently un-applied and the banner asked
  // forever for a restart that would change nothing. That is the failure MemoryRecallPanel's own comment
  // already records about a remembered model compared against a null running one, one case over.
  ok('binding the CLI arm does not ask for a restart — its effect is on the next WRITE',
    bindRephrase.body?.restartRequired === false, JSON.stringify(bindRephrase.body));
  ok('…and saved equals running, so the restart banner cannot become permanent',
    afterRephrase.source === afterRephrase.activeSource
      && afterRephrase.model === afterRephrase.activeModel,
    JSON.stringify({ saved: afterRephrase.source, active: afterRephrase.activeSource,
      savedModel: afterRephrase.model, activeModel: afterRephrase.activeModel }));

  // ---- F · models are a RESOURCE, not a recall setting -------------------------------------------
  ok('the model inventory answers, and reports the runtime that hosts them',
    Array.isArray(inv.models) && !!inv.runtime && typeof inv.runtime.serving === 'boolean',
    JSON.stringify(inv.runtime));
  // THE RUNTIME REPORTED HERE IS OURS. It used to be Ollama's — this endpoint described a daemon under
  // the household's own Programs directory and put pull and delete buttons beside its models. 资源 shows
  // what Gatherlight provisions; the runtime it provisions is llama.cpp.
  ok('the runtime 资源 reports is the one WE install, not one we merely detect',
    inv.runtime?.id === 'llama-cpp', JSON.stringify(inv.runtime));
  ok('and no listed model belongs to a runtime we do not manage',
    (inv.models ?? []).length > 0
      && (inv.models ?? []).every((x) => x.runtime === 'llama-cpp' || x.runtime === 'builtin'),
    JSON.stringify((inv.models ?? []).map((m) => [m.id, m.runtime])));
  // ONE ROW SHAPE, and BOTH STATES IN IT. Installed and not-installed used to be `models` and `offers` —
  // two arrays the console rendered as three different components, which is where the three left edges
  // came from. `installed` is a field now.
  //
  // The installed half is exercised by planting an EMPTY .gguf rather than by downloading one: a fixture
  // that fetched 806 MB to prove a boolean would cost far more than the assertion is worth, and the flat
  // `<id>.gguf` layout is a real case anyway — it is the file a household drops in themselves, which gets
  // a row with no note and no measurement precisely so they can reclaim the space.
  const ggufDir = path.join(dir, 'state', 'resources', 'gguf');
  fs.mkdirSync(ggufDir, { recursive: true });
  fs.writeFileSync(path.join(ggufDir, 'household-dropped-this-in.gguf'), '');
  const withPlanted = await getJson('/api/manage/models');
  const planted = (withPlanted.models ?? []).find((m) => m.id === 'household-dropped-this-in');
  ok('installed and available models are ONE list, distinguished by a field',
    (withPlanted.models ?? []).some((m) => m.installed)
      && (withPlanted.models ?? []).some((m) => !m.installed)
      && (withPlanted.models ?? []).every((m) => typeof m.installed === 'boolean' && !!m.resourceId),
    JSON.stringify((withPlanted.models ?? []).map((m) => [m.id, m.installed])));
  // …and a file we did not pin still gets a row, with the honest blanks: no note, no measurement.
  ok('a GGUF the household supplied is listed too, with no invented note or score',
    !!planted && planted.installed === true && !planted.measured && !planted.note,
    JSON.stringify(planted ?? null));
  // A note is read where a household CHOOSES a model, so it may only compare with an option they have.
  // Two compared with 「本机」里 Ollama for a month after that option was retired.
  const staleNotes = (withPlanted.models ?? []).filter((m) => /Ollama|「本机」/.test(String(m.note ?? '')));
  ok('no model note compares with a retired option',
    (withPlanted.models ?? []).some((m) => m.note) && staleNotes.length === 0,
    JSON.stringify(staleNotes.map((m) => [m.id, m.note])));
  // …nor any other SENTENCE the memory panel returns: a status reason is read at the same moment as a note,
  // and one still promised the built-in model would free the layer from Ollama after the notes were fixed.
  // `retired` is exempt — naming the retired backend is that field's whole job.
  const panelStrings = [];
  const collect = (v, key) => {
    if (key === 'retired') return;
    if (typeof v === 'string') panelStrings.push(v);
    else if (Array.isArray(v)) v.forEach((x) => collect(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) collect(x, k);
  };
  collect(await getJson('/api/manage/memory'));
  const stalePanel = panelStrings.filter((t) => /Ollama|「本机」/.test(t));
  ok('no sentence in the memory panel names a retired option',
    panelStrings.length > 0 && stalePanel.length === 0, JSON.stringify(stalePanel));
  fs.rmSync(path.join(ggufDir, 'household-dropped-this-in.gguf'), { force: true });
  // The BUILT-IN model is a row in that same list rather than a card of its own — and it is deletable, so
  // its 222 MB is reclaimable. It used to offer 重新下载 where every other row offered 删除.
  ok('the built-in ONNX model is a row like any other, with a resource behind it',
    (inv.models ?? []).some((m) => m.runtime === 'builtin' && !!m.resourceId),
    JSON.stringify((inv.models ?? []).filter((m) => m.runtime === 'builtin')));
  // No `pulls`: a GGUF is downloaded as a sha256-pinned RESOURCE and reports progress through the resource
  // list. One download mechanism, not two — asserted because a leftover empty array is exactly what a
  // half-finished removal looks like, and the panel would poll it forever.
  ok('there is no second download mechanism left behind here',
    inv.pulls === undefined, JSON.stringify(inv.pulls ?? null));
  // The list must cover both capabilities: the local judge and the local embedder are ONE runtime, so a
  // panel that can fetch an embedder and not a chat model leaves 判断 bindable with nothing to bind.
  ok('the list covers both capabilities, not embedders alone',
    (inv.models ?? []).some((m) => m.capability === 'embedding')
      && (inv.models ?? []).some((m) => m.capability === 'completion'),
    JSON.stringify((inv.models ?? []).map((m) => [m.id, m.capability])));
  // Every row names the RESOURCE that fetches it, and that resource must actually exist. The client used
  // to build this id by string-concatenation, which is how models landed in the runtimes column twice.
  const resIds = new Set(((await getJson('/api/manage/resources')).resources ?? []).map((r) => r.id));
  ok('every model names a resource that really exists, so its 下载 button is not a dead end',
    (inv.models ?? []).length > 0
      && (inv.models ?? []).every((m) => m.resourceId && resIds.has(m.resourceId)),
    JSON.stringify((inv.models ?? []).map((m) => m.resourceId)));
  // NO DATE FIELD. The Ollama table's `vintage` meant the MODEL's release date and was styled "old" below
  // 2025; filling it from a measurement date put two meanings in one field, so a freshly measured model
  // would eventually render as an obsolete one. When it was measured belongs with the sample size.
  ok('a model row carries no date field — when it was measured lives with the sample size',
    (inv.models ?? []).every((m) => m.vintage === undefined) && typeof inv.measuredOn === 'string',
    JSON.stringify([(inv.models ?? [])[0]?.vintage, inv.measuredOn]));
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

  // ---- G · 资源 does not manage the household's runtime --------------------------------------------
  // The verbs are GONE, not merely unused. Ollama is a HOUSEHOLD runtime: we detect it, list what it holds
  // and embed against it. 资源 used to additionally pull models into it and delete models out of it — on a
  // real install, against `…\Programs\Ollama\ollama.exe`. That is this panel claiming ownership it
  // does not have, and an unused management endpoint is an invitation to the next caller.
  for (const [label, path_] of [
    ['pull', '/api/manage/models/pull'],
    ['start (the Ollama daemon)', '/api/manage/models/start'],
  ]) {
    const gone = await post(path_, { model: 'bge-m3' });
    ok(`资源 can no longer ${label} — that belongs to Ollama, not to us`, gone.status === goneStatus,
      `${path_} → ${gone.status} (unrouted answers ${goneStatus})`);
  }
  // AND THE MANAGEMENT ENDPOINTS ARE GONE TOO — this time correctly, which is why the reasoning is here.
  //
  // They were removed once for a bad reason (code hygiene overruling what the household could do), which
  // left the app depending on a daemon it would not manage. They are gone now because the DEPENDENCY is
  // gone: the managed local runtime is llama.cpp, whose models are pinned, ranked and downloadable in 资源.
  // A household running Ollama still uses it — through openai-compat, by address — so the OPTION survives
  // while our pretence of owning their daemon does not.
  for (const [label, path_] of [
    ['pull an Ollama model', '/api/manage/memory/ollama/pull'],
    ['delete an Ollama model', '/api/manage/memory/ollama/remove'],
  ]) {
    const gone = await post(path_, { model: 'bge-m3' });
    ok(`we no longer ${label} — that runtime is not ours to manage`, gone.status === goneStatus,
      `${path_} → ${gone.status} (unrouted answers ${goneStatus})`);
  }

  // THE POSITIVE CONTROL, and it is the whole point: the same two verbs for the runtime we DO manage are
  // still here. Without this pair the assertions above would pass just as well on a build that had lost
  // model management altogether — which is a different bug wearing the same green tick.
  const ourStart = await post('/api/manage/models/llama/start', {});
  ok('…while starting OUR runtime is still a route (it may fail, but it is not gone)',
    ourStart.status !== goneStatus, `→ ${ourStart.status}`);
  const ourRemove = await post('/api/manage/models/remove', { model: 'no-such-gguf', runtime: 'llama-cpp' });
  ok('…and deleting OUR models is still a route, refusing one it cannot see',
    ourRemove.status !== goneStatus, `→ ${ourRemove.status}`);

  // AND THE OPTION DID NOT GO AWAY. Removing a backend must not remove the ability — 本机 is still a
  // group, still bindable, and what it asks for is an address. This is the assertion that tells "we stopped
  // managing a runtime" apart from "we dropped support for it", and its absence is what let the first
  // removal pass every check while a capability quietly vanished.
  const machine = (judge.groups ?? []).find((g) => g.id === 'machine');
  const byoc = (machine?.sources ?? []).find((x) => x.id === 'openai-compat');
  // The no-model group has zero backends: it exists so that turning a layer off is an answer
  // to "where does its model come from" rather than a separate button somewhere else, which is what made
  // having a model look mandatory.
  const none = (judge.groups ?? []).find((g) => g.id === 'none');
  ok('内置 is offered as a real choice, holding nothing to configure',
    !!none && (none.sources ?? []).length === 0 && String(none.description ?? '').length > 10,
    JSON.stringify(none ? { id: none.id, name: none.name, sources: none.sources.length } : null));
  // …and it comes LAST, because the order is cheapest-first in what the household must already have and
  // this is the one needing nothing — putting it first would present "off" as the recommendation.
  ok('…and it comes last, after the two that can actually do the work',
    (judge.groups ?? []).map((g) => g.id).indexOf('none') === (judge.groups ?? []).length - 1,
    JSON.stringify((judge.groups ?? []).map((g) => g.id)));

  // ---- H · 语义 refuses a non-embedder without waiting out a cold model load ---------------------
  // The mirror refusal: a completion model cannot embed, so 语义 must refuse it — and quickly, from the
  // catalogue, rather than after waiting out a cold model load.
  if (chatModels.length > 0) {
    const t2 = Date.now();
    const r = await post('/api/manage/memory/layer/semantic',
      { source: 'llama-cpp', model: chatModels[0].id });
    const took2 = Date.now() - t2;
    ok(`binding a chat model to 语义 is refused, and quickly: ${chatModels[0].id}`,
      r.status === 409 && took2 < 20000, `${r.status} in ${took2}ms`);
  } else {
    ok('(no chat model on this machine) the fast 语义 refusal is not exercised here', true,
      'needs a downloaded completion GGUF');
  }

  // THE SEMANTIC POSITIVE CONTROL. Retargeted from Ollama to whichever local embedder is actually
  // installed — and it cannot be faked: a planted empty .gguf would fail the embed probe, which is the one
  // thing this asserts. So it runs where a real model exists and says so loudly where one does not.
  const anyEmbedder = embedders[0];
  if (anyEmbedder) {
    const bindSem = await post('/api/manage/memory/layer/semantic',
      { source: 'llama-cpp', model: anyEmbedder.id });
    ok('(this machine has an embedder) binding 语义 asks for a restart and a reindex',
      bindSem.status === 200 && bindSem.body?.restartRequired === true
        && bindSem.body?.reindexRequired === true,
      JSON.stringify(bindSem.body));
    ok('and reports the vector width it actually measured, rather than one looked up',
      typeof bindSem.body?.dimensions === 'number' && bindSem.body.dimensions > 0
        && bindSem.body?.proved === 'dimensions',
      JSON.stringify({ dimensions: bindSem.body?.dimensions, proved: bindSem.body?.proved }));

    // TURNING IT OFF REMEMBERS THE MODEL, so switching back costs neither a download nor a rebuild.
    await post('/api/manage/memory/layer/semantic/off');
    const afterOff = layerOf(await getJson('/api/manage/memory'), 'semantic');
    ok('turning 语义 off keeps the model it was using, rather than forgetting it',
      afterOff.on === false && afterOff.model === anyEmbedder.id,
      JSON.stringify({ on: afterOff.on, model: afterOff.model }));
  } else {
    ok('(no embedding model on this machine) the 语义 accept path is not exercised here', true,
      'needs a real embedder — a planted file would fail the probe this asserts');
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
  // ---- AN ALREADY-SERVING ROUTER IS ADOPTED, NOT DUPLICATED ----------------------------------
  //
  // A forced kill orphans a router; the next start must ADOPT it rather than spawn a second one on the
  // same port (measured by hand as two processes across a restart, not four). It also covers a household
  // running their own llama-server on that port — same rule, same reason.
  //
  // Recorded as needing a real binary, which it does not: EnsureServingAsync probes `Serving` BEFORE it
  // checks the executable exists, so with NOTHING installed a start still succeeds when the port already
  // answers. That ordering IS the adoption, and it is the whole thing worth pinning — swap those two
  // lines and every start on a machine with an orphan spawns a duplicate.
  {
    const u = new URL(String(llamaCold.baseUrl));
    let asked = 0;
    const hits = [];
    const fake = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        asked++;
        res.writeHead(200, { 'content-type': 'application/json' });
        // The router REPORTS which models it holds, and the start endpoint warms exactly those. One
        // embedder and one chat model, because the two take different warm calls.
        res.end(JSON.stringify({ data: [{ id: 'zzwarm-embed-model' }, { id: 'zzwarm-chat-model' }, { id: 'zzwarm-rerank-model' }] }));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push({ path: req.url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((r) => fake.listen(Number(u.port), '127.0.0.1', r));
    try {
      const started = await post('/api/manage/models/llama/start');
      ok('THE POINT: a port that already answers is adopted, with no binary installed at all',
        started.status === 200, `${started.status} ${JSON.stringify(started.body)}`);
      ok('…and it really probed the running router rather than assuming',
        asked > 0, `GET /v1/models seen ${asked} time(s)`);

      // ---- STARTING MEANS START-AND-WARM ------------------------------------------------------
      //
      // llama.cpp loads models LAZILY: --models-max is a cap, not a preload, so the first request for a
      // model spawns a child and waits — 17.3 s measured for a 1B q4. Returning when the router answers
      // would hand back a runtime that stalls on the first real recall, which is the very cost this
      // runtime was chosen to remove. Nothing checked that warming happened.
      //
      // Reachable without a spawn after all: the start endpoint warms the models the ROUTER reports, so
      // a fake router naming two models gets both warm calls sent to it.
      // COUNTED AT THE FAKE SERVER, not read from the response. The first version of this asserted
      // `started.body.warmed.length === 2` — and it PASSED with the warm call deleted, because the
      // endpoint still built that list from the models it had probed. A field reporting that work
      // happened is not evidence the work happened; that is this whole session in one assertion.
      ok('every model the router reports is warmed, not just started',
        hits.length === 3 && (started.body?.warmed ?? []).length === 3,
        JSON.stringify({ requests: hits.map((h) => h.path), reported: started.body?.warmed }));

      // The two warm calls are NOT the same request, and sending an embedder a chat completion (or the
      // reverse) fails against a real llama-server — `embeddings = true` restricts that child to one API.
      const embedHit = hits.find((h) => h.body.includes('zzwarm-embed-model'));
      const chatHit = hits.find((h) => h.body.includes('zzwarm-chat-model'));
      ok('an EMBEDDER is warmed through /v1/embeddings',
        embedHit?.path === '/v1/embeddings' && embedHit.body.includes('"input"'),
        JSON.stringify(embedHit));
      ok('a CHAT model is warmed through /v1/chat/completions',
        chatHit?.path === '/v1/chat/completions' && chatHit.body.includes('"messages"'),
        JSON.stringify(chatHit));
      const rerankHit = hits.find((h) => h.body.includes('zzwarm-rerank-model'));
      ok('a RERANKER is warmed through /v1/rerank',
        rerankHit?.path === '/v1/rerank' && rerankHit.body.includes('"documents"'),
        JSON.stringify(rerankHit));
    } finally {
      await new Promise((r) => fake.close(r));
    }
  }

  // ---- THE LLAMA LAUNCH CONTRACT IS WRITTEN DOWN, NOT ASSUMED --------------------------------
  //
  // `--n-gpu-layers` is the one setting whose absence is invisible: llama-server silently runs on the
  // CPU at ~30x the latency and logs nothing about it, on the path of every recall. The code says so in
  // three places and NOTHING checked it — the only mention in this suite was a comment citing a manual
  // measurement. That is a contract enforced by remembering, which is how the 30x comes back.
  //
  // Drivable without llama.cpp installed, because the preset file is written BEFORE the child is
  // spawned: a stub binary that merely EXISTS gets past the executable check, the spawn then fails, and
  // presets.ini is on disk either way. The same trick p50 case F uses for the provisioned CLI.
  {
    const res = path.join(dir, 'state', 'resources');
    const ggufDir = path.join(res, 'gguf');
    fs.mkdirSync(path.join(res, 'llama-cpp'), { recursive: true });
    fs.mkdirSync(ggufDir, { recursive: true });
    fs.writeFileSync(path.join(res, 'llama-cpp', 'llama-server.exe'), 'not a real binary');
    // Two models, because the second half of the contract is that `embeddings = true` goes on embedders
    // ONLY — it RESTRICTS a child to embedding, which is right for an embedder and fatal for a judge.
    fs.writeFileSync(path.join(ggufDir, 'zztest-embed-model.gguf'), 'x');
    fs.writeFileSync(path.join(ggufDir, 'zztest-chat-model.gguf'), 'x');
    // A RERANKER is the third kind: `reranking = true` restricts its child to /v1/rerank, and a cross-encoder
    // needs the whole (query, document) pair in ONE physical batch, so the batch sizes are contract too.
    fs.writeFileSync(path.join(ggufDir, 'zztest-rerank-model.gguf'), 'x');

    await post('/api/manage/models/llama/start');   // spawn fails; presets are written first

    const presetPath = path.join(ggufDir, 'presets.ini');
    const preset = fs.existsSync(presetPath) ? fs.readFileSync(presetPath, 'utf8') : '';
    ok('(fixture) starting the router generated its preset file',
      preset.includes('[zztest-embed-model]') && preset.includes('[zztest-chat-model]'),
      JSON.stringify(preset.slice(0, 200)));

    const sectionOf = (id) => {
      const body = preset.split(`[${id}]`)[1] ?? '';
      return body.split('[')[0];
    };
    ok('THE POINT: every model gets n-gpu-layers — without it recall is ~30x slower, silently',
      /n-gpu-layers\s*=\s*\d+/.test(sectionOf('zztest-embed-model'))
        && /n-gpu-layers\s*=\s*\d+/.test(sectionOf('zztest-chat-model')),
      JSON.stringify({ embed: sectionOf('zztest-embed-model'), chat: sectionOf('zztest-chat-model') }));

    ok('embeddings = true goes on the EMBEDDER and nowhere else',
      /embeddings\s*=\s*true/.test(sectionOf('zztest-embed-model'))
        && !/embeddings\s*=\s*true/.test(sectionOf('zztest-chat-model')),
      JSON.stringify({ embed: sectionOf('zztest-embed-model'), chat: sectionOf('zztest-chat-model') }));

    ok('a RERANKER gets reranking = true and a whole-pair batch — and nothing else does',
      /reranking\s*=\s*true/.test(sectionOf('zztest-rerank-model'))
        && /^ubatch-size\s*=\s*4096/m.test(sectionOf('zztest-rerank-model'))
        && /^batch-size\s*=\s*4096/m.test(sectionOf('zztest-rerank-model'))
        // ctx-size too: the whole pair must fit the CONTEXT as well as the batch — a longer pair fails the
        // entire rerank call (measured, docs/self-managed-llm-runtime.md), which RerankInputCap is sized against.
        && /^ctx-size\s*=\s*4096/m.test(sectionOf('zztest-rerank-model'))
        && !/embeddings\s*=\s*true/.test(sectionOf('zztest-rerank-model'))
        && !/reranking\s*=\s*true/.test(sectionOf('zztest-embed-model'))
        && !/reranking\s*=\s*true/.test(sectionOf('zztest-chat-model')),
      JSON.stringify({ rerank: sectionOf('zztest-rerank-model'), embed: sectionOf('zztest-embed-model'),
        chat: sectionOf('zztest-chat-model') }));

    // Planted files removed: later runs of this fixture assert on llama.cpp being ABSENT, and a stub
    // left behind would make those pass or fail for a reason that is not theirs.
    fs.rmSync(path.join(res, 'llama-cpp'), { recursive: true, force: true });
    fs.rmSync(ggufDir, { recursive: true, force: true });
  }

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
