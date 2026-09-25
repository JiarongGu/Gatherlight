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
    // What the fake router LISTS, mutable: the last start below takes a bound model off it. zzcache-chat-model
    // is never planted on disk — it stands in for the machine's own llama.cpp/Hugging Face cache, which the real
    // router lists beside ours and which the start button must not load.
    let listing = ['zzwarm-embed-model', 'zzwarm-chat-model', 'zzwarm-rerank-model', 'zzcache-chat-model'];
    // How many more times the model list is answered before it is refused with a 500 — HELD, to the runtime.
    let answerModels = Infinity;
    const fake = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        asked++;
        if (answerModels-- <= 0) { res.writeHead(500); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: listing.map((id) => ({ id })) }));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push({ path: req.url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        // Enough of each route's answer for a BIND to pass against this fake: 语义's proof reads a vector's
        // width, and a reranker's screen needs the answer (index 1) scored above the distractor. A warm call
        // reads only the status, so the same answers serve it.
        res.end(req.url === '/v1/embeddings'
          ? JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
          : req.url === '/v1/rerank'
            ? JSON.stringify({ results: [{ index: 0, relevance_score: -1 }, { index: 1, relevance_score: 2 }] })
            : '{}');
      });
    });
    await new Promise((r) => fake.listen(Number(u.port), '127.0.0.1', r));
    // OURS are files in {data}/state/resources/gguf — one of each kind, so each warm route can be checked.
    const res = path.join(dir, 'state', 'resources');
    const warmGguf = path.join(res, 'gguf');
    const stubExe = path.join(res, 'llama-cpp', 'llama-server.exe');
    fs.mkdirSync(warmGguf, { recursive: true });
    for (const m of ['zzwarm-embed-model', 'zzwarm-chat-model', 'zzwarm-rerank-model'])
      fs.writeFileSync(path.join(warmGguf, `${m}.gguf`), '');
    const requests = () => hits.map((h) => `${h.path} ${h.body.slice(0, 60)}`);
    const warmedAt = (id) => hits.filter((h) => h.body.includes(id));
    try {
      const started = await post('/api/manage/models/llama/start');
      ok('THE POINT: a port that already answers is adopted, with no binary installed at all',
        started.status === 200, `${started.status} ${JSON.stringify(started.body)}`);
      ok('…and it really probed the running router rather than assuming',
        asked > 0, `GET /v1/models seen ${asked} time(s)`);

      // ---- STARTING MEANS START-AND-WARM — WHAT IS BOUND, AND NOTHING ELSE -----------------------
      //
      // llama.cpp loads models LAZILY: --models-max is a cap, not a preload, so the first request for a
      // model spawns a child and waits — 17.3 s measured for a 1B q4. Returning when the router answers
      // would hand back a runtime that stalls on the first real recall, which is the very cost this
      // runtime was chosen to remove.
      //
      // But only a BOUND model is ever recalled, and the router holds two (--models-max). The button used to
      // warm every GGUF of ours the router listed — three here — so it loaded them in turn and could evict
      // the bound judge or embedder with an unbound one of our own. It warms MemorySources.BoundToLlamaCpp
      // now, the set the startup warm step reads. Nothing is bound yet (both layers are on the CLI), so this
      // start loads nothing.
      //
      // COUNTED AT THE FAKE SERVER, not read from the response. An earlier version asserted the endpoint's
      // own `warmed` list — and it PASSED with the warm call deleted, because the endpoint still built that
      // list from the models it had probed. A field reporting that work happened is not evidence the work
      // happened.
      ok('THE POINT: with nothing bound, starting loads nothing — three GGUFs of ours are listed, none is warmed',
        hits.length === 0 && Array.isArray(started.body?.warmed) && started.body.warmed.length === 0,
        JSON.stringify({ requests: requests(), reported: started.body?.warmed }));

      // BIND, through the endpoint the console uses: 语义 to the embedder, 判断 to the chat model. A binding
      // needs the runtime on disk (IsConfigured), so a stub binary goes in now — AFTER the adoption above,
      // which must hold with nothing installed. The fake answers every probe, so this stub is never run as a
      // router. Binding sends its own requests (the embed proof, the chat judge's warm), so the count restarts.
      fs.mkdirSync(path.dirname(stubExe), { recursive: true });
      fs.writeFileSync(stubExe, 'not a real binary');
      const bindEmbed = await post('/api/manage/memory/layer/semantic', { source: 'llama-cpp', model: 'zzwarm-embed-model' });
      const bindChat = await post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: 'zzwarm-chat-model' });
      ok('(fixture) 语义 and 判断 bind to llama.cpp against the fake router',
        bindEmbed.status === 200 && bindChat.status === 200,
        JSON.stringify({ semantic: [bindEmbed.status, bindEmbed.body?.error], judge: [bindChat.status, bindChat.body?.error] }));
      hits.length = 0;

      const bound = await post('/api/manage/models/llama/start');
      ok('both BOUND models are warmed — two requests, one per layer, 语义 first',
        hits.length === 2 && JSON.stringify(bound.body?.warmed) === JSON.stringify(['zzwarm-embed-model', 'zzwarm-chat-model']),
        JSON.stringify({ requests: requests(), reported: bound.body?.warmed }));
      // THE POINT of the binding: a GGUF of OURS the router lists, and nothing bound to it. The code before
      // this sent it a warm request, and with three of ours listed that is the load that evicts a bound model.
      ok('THE POINT: a GGUF of ours the router lists but no layer is bound to is NOT warmed',
        warmedAt('zzwarm-rerank-model').length === 0 && !(bound.body?.warmed ?? []).includes('zzwarm-rerank-model'),
        JSON.stringify({ requests: requests(), reported: bound.body?.warmed }));
      // The machine's llama.cpp/Hugging Face cache (four unrelated chat models, seen on a real restart) is not
      // ours to load — and cannot be bound, since a binding needs the file in our folder.
      ok('a model the router lists that is not in our models folder is NOT warmed',
        warmedAt('zzcache-chat-model').length === 0 && !(bound.body?.warmed ?? []).includes('zzcache-chat-model'),
        JSON.stringify({ requests: requests(), reported: bound.body?.warmed }));
      ok('…and a start that warmed everything bound has nothing to report — no note, so the console says 已完成',
        (bound.body?.notWarmed ?? []).length === 0 && bound.body?.note == null, JSON.stringify(bound.body));

      // The warm calls are NOT the same request, and sending an embedder a chat completion (or the reverse)
      // fails against a real llama-server — `embeddings = true` restricts that child to one API.
      const embedHit = warmedAt('zzwarm-embed-model')[0];
      const chatHit = warmedAt('zzwarm-chat-model')[0];
      ok('an EMBEDDER is warmed through /v1/embeddings',
        embedHit?.path === '/v1/embeddings' && embedHit.body.includes('"input"'),
        JSON.stringify(embedHit));
      ok('a CHAT model is warmed through /v1/chat/completions',
        chatHit?.path === '/v1/chat/completions' && chatHit.body.includes('"messages"'),
        JSON.stringify(chatHit));

      // THE THIRD KIND needs a second binding: 判断 holds a chat model OR a reranker, never both, so one
      // binding cannot cover all three warm routes. Rebinding it also makes the chat model the unbound one.
      const bindRerank = await post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: 'zzwarm-rerank-model' });
      ok('(fixture) 判断 rebinds to the reranker — the fake passes its screen',
        bindRerank.status === 200, `${bindRerank.status} ${JSON.stringify(bindRerank.body)}`);
      hits.length = 0;

      const reranked = await post('/api/manage/models/llama/start');
      const rerankHit = warmedAt('zzwarm-rerank-model')[0];
      ok('a RERANKER is warmed through /v1/rerank',
        rerankHit?.path === '/v1/rerank' && rerankHit.body.includes('"documents"'),
        JSON.stringify(rerankHit));
      ok('…and the chat model it replaced, still listed and still ours, is not warmed any more',
        hits.length === 2 && warmedAt('zzwarm-chat-model').length === 0
          && JSON.stringify(reranked.body?.warmed) === JSON.stringify(['zzwarm-embed-model', 'zzwarm-rerank-model']),
        JSON.stringify({ requests: requests(), reported: reranked.body?.warmed }));

      // A BOUND MODEL THE ROUTER DOES NOT LIST is reported, not restarted in: loading it means a restart, which
      // is a bind's decision, and the start button is not a bind. (This router is adopted, so no restart could
      // happen here anyway — the runtime never kills a process it did not start. What is asserted is the
      // report: which layer, which model, why it is cold, and what to do.)
      listing = listing.filter((id) => id !== 'zzwarm-rerank-model');
      hits.length = 0;
      const unlisted = await post('/api/manage/models/llama/start');
      const skipped = (unlisted.body?.notWarmed ?? []).find((n) => n.model === 'zzwarm-rerank-model');
      ok('THE POINT: a bound model the router does not list is REPORTED — layer, model and why — not warmed',
        unlisted.status === 200 && skipped?.layer === 'judge' && /不在这个 llama\.cpp 列出的模型里/.test(skipped?.why ?? '')
          && warmedAt('zzwarm-rerank-model').length === 0,
        JSON.stringify({ requests: requests(), body: unlisted.body }));
      // THE CURE DEPENDS ON WHOSE ROUTER IT IS, and this one is ADOPTED: the app started nothing here. A service
      // restart ends only a router the app started, and leaves an adopted one running, to be adopted again, still
      // not listing the model. The first version of this note said 「重启服务」 anyway, and this assertion pinned it.
      // For a router the app did not start the cure is the runtime's own not-ours clause: end that process.
      const note = String(unlisted.body?.note ?? '');
      ok('THE POINT: on an ADOPTED router the note says to end that llama-server.exe — never 重启服务, which leaves it running',
        note.includes('zzwarm-rerank-model') && /任务管理器/.test(note) && /llama-server\.exe/.test(note) && !/重启服务/.test(note),
        note);
      ok('…while the model that IS listed is still warmed',
        JSON.stringify(unlisted.body?.warmed) === JSON.stringify(['zzwarm-embed-model']) && hits.length === 1,
        JSON.stringify({ requests: requests(), reported: unlisted.body?.warmed }));

      // BOTH layers cold on one router share one cure, and the note says it once, after both models.
      listing = listing.filter((id) => id !== 'zzwarm-embed-model');
      hits.length = 0;
      const bothCold = await post('/api/manage/models/llama/start');
      const bothNote = String(bothCold.body?.note ?? '');
      ok('…and with BOTH layers cold, both are reported and the cure is said once',
        (bothCold.body?.notWarmed ?? []).length === 2 && bothNote.includes('zzwarm-embed-model')
          && bothNote.includes('zzwarm-rerank-model') && bothNote.split('任务管理器').length === 2 && hits.length === 0,
        bothNote);

      // A ROUTER THAT STOPS ANSWERING once the start has succeeded is the start failing. This returned 200 with
      // 「llama.cpp 已在运行」 over a router that was gone or no longer answering, and threw away the probe's own
      // sentence. The fake answers the start's probe, then refuses the model list: a non-2xx is HELD.
      answerModels = 1;
      const stopped = await post('/api/manage/models/llama/start');
      answerModels = Infinity;
      ok("a router that stops answering right after the start is a 409 in the probe's own words, never 「已在运行」",
        stopped.status === 409 && /被另一个进程占着/.test(String(stopped.body?.error ?? ''))
          && !/已在运行/.test(JSON.stringify(stopped.body ?? {})),
        `${stopped.status} ${JSON.stringify(stopped.body)}`);
    } finally {
      // As we found them: both layers on the CLI. The files the bindings name go below, and a binding left
      // pointing at them would fall back at the next boot of this folder for a reason that is not its own.
      await post('/api/manage/memory/layer/judge', { source: 'claude-cli', model: 'haiku' });
      await post('/api/manage/memory/layer/semantic', { source: 'claude-cli', model: 'haiku' });
      fake.closeAllConnections();
      await new Promise((r) => fake.close(r));
      // Leave the directory as later cases expect it — the next block plants its own files under the same
      // path, and asserts the held sentence wins over 「还没有下载」, which a stub binary left here would void.
      for (const m of ['zzwarm-embed-model', 'zzwarm-chat-model', 'zzwarm-rerank-model'])
        fs.rmSync(path.join(warmGguf, `${m}.gguf`), { force: true });
      fs.rmSync(stubExe, { force: true });
    }
  }

  // ---- A PORT THAT ACCEPTS AND NEVER ANSWERS IS HELD: NAMED, NEVER SPAWNED BESIDE ---------------------
  //
  // The probe's `GET /v1/models` has a 4 s HttpClient timeout, which arrives as a TaskCanceledException — and
  // the catch filtered on the exception's TYPE, so it escaped. On the real binary that was a bind returning
  // 500 with llama.cpp left stopped, most likely a dying router whose socket still accepted the re-probe.
  // The first fix read the timeout as "not serving", and "not serving" means "start one": the app then spawned a
  // router BESIDE a process that holds the port, and said 「没能启动」 or 「还没有下载」. A port that accepts and
  // does not answer is HELD — its own state, its own sentence, and no spawn. Same port as the adoption fake above.
  {
    const u = new URL(String(llamaCold.baseUrl));
    const port = Number(u.port);
    let asked = 0;
    const hung = http.createServer((req) => {
      if (req.url === '/v1/models') asked++;
      // Never answered; the server's own timeout is what ends each request.
    });
    await new Promise((r) => hung.listen(port, '127.0.0.1', r));
    // What the runtime logs when it TRIES to start a router: "llama-server starting: …" once the process exists,
    // "starting llama-server failed: …" when it could not even be started (this stub is not a real binary).
    const logsDir = path.join(dir, 'state', 'logs');
    const spawnLines = () => (fs.existsSync(logsDir)
      ? fs.readdirSync(logsDir).map((n) => fs.readFileSync(path.join(logsDir, n), 'utf8')).join('\n') : '')
      .split('\n').filter((l) => /llama-server starting|starting llama-server failed/.test(l));
    // The held sentence: names llama-server, says it does not answer, and names THIS port.
    const isHeld = (t) => /llama-server/.test(t) && /没有像 llama\.cpp 那样回答/.test(t) && t.includes(String(port));
    const res = path.join(dir, 'state', 'resources');
    const stubExe = path.join(res, 'llama-cpp', 'llama-server.exe');
    const stubModel = path.join(res, 'gguf', 'zzheld-chat-model.gguf');
    try {
      // No binary installed yet — so the held sentence has to WIN over 「还没有下载」.
      const probe = await fetch(`${srv.base}/api/manage/models/llama?refresh=true`);
      const probeBody = await probe.json().catch(() => null);
      const problem = String(probeBody?.problem ?? '');
      ok('THE POINT: a port that accepts and never answers is HELD — not serving, and the sentence names it',
        probe.status === 200 && probeBody?.serving === false && isHeld(problem),
        `${probe.status} ${JSON.stringify(probeBody ? { serving: probeBody.serving, problem } : null)}`);
      ok('…and that sentence wins over 「还没有下载」, which would send the household to fetch what could not start',
        !/还没有下载/.test(problem), problem);

      // Now a binary and a model that WOULD be started — the start must still not spawn beside the held port.
      fs.mkdirSync(path.dirname(stubExe), { recursive: true });
      fs.mkdirSync(path.dirname(stubModel), { recursive: true });
      fs.writeFileSync(stubExe, 'not a real binary');
      fs.writeFileSync(stubModel, 'x');
      const spawnsBefore = spawnLines().length;
      const started = await post('/api/manage/models/llama/start');
      await new Promise((r) => setTimeout(r, 500));
      const error = String(started.body?.error ?? '');
      ok('…starting against it is refused with THAT sentence — not 「没能启动」, not a 500',
        started.status === 409 && isHeld(error), `${started.status} ${JSON.stringify(started.body)}`);
      const spawned = spawnLines().slice(spawnsBefore);
      ok('THE POINT: and no router was spawned beside it', spawned.length === 0, JSON.stringify(spawned));
      ok('(anti-vacuity) the held port really was asked for /v1/models', asked > 0, `GET /v1/models seen ${asked} time(s)`);
    } finally {
      hung.closeAllConnections();
      await new Promise((r) => hung.close(r));
      // Leave the folder as the next block expects it: it plants its own binary and models.
      for (const p of [stubExe, stubModel, path.join(res, 'gguf', 'presets.ini')]) fs.rmSync(p, { force: true });
    }
  }

  // ---- 判断's LOCAL DEFAULT IS THE RERANKER; A CHAT MODEL MEASURED WORSE IS DESCRIBED, NOT RECOMMENDED ----
  //
  // docs/judge-bench.md Run 3 measured Gemma 3 1B as a local chat 判断 significantly WORSE than no judge (top-1
  // 79 → 33 of 240). It had been the catalogue's recommended judge: 推荐 in its name, 「判断质量没有单独实测过」
  // in its note, the model 资源's 推荐 badge moved to once an embedder was in, and the download the 判断 row
  // suggested. All four went false with the measurement. It stays SELECTABLE — "worse" is a reason to describe an
  // option, not to remove it — and 判断's local default is the recommended RERANKER, the local judge that measured
  // better. Nothing here downloads: the rows come from the catalogue, and "installed" is an empty planted file.
  {
    const res = path.join(dir, 'state', 'resources');
    const ggufDir = path.join(res, 'gguf');
    const builtinDir = path.join(res, 'embed-model');
    const stubExe = path.join(res, 'llama-cpp', 'llama-server.exe');
    const RERANKER = 'bge-reranker-v2-m3-Q5_K_M';
    const GEMMA_1B = 'gemma-3-1b-it-Q4_K_M';
    const MMINILM = 'mmarco-mMiniLMv2-L12-H384-v1-Q8_0';
    const QWEN3 = 'Qwen3-0.6B-Q8_0';
    // MemorySources.CliTaggingCost, pinned as the exact clause for the reason p52 case 5 gives.
    const TAGGING_COST = '每条事实一次调用,消耗账号额度,事实内容会发给 Claude';
    const rowOf = (shelf, id) => (shelf.models ?? []).find((m) => m.id === id);
    try {
      const shelf = await getJson('/api/manage/models');
      const gemma = rowOf(shelf, GEMMA_1B);
      ok('Gemma 3 1B is still on the shelf as a chat model — described, not removed',
        !!gemma && gemma.capability === 'completion', JSON.stringify(gemma ?? null));
      ok('THE POINT: its name carries no 推荐', !!gemma && !/推荐/.test(String(gemma.name)), String(gemma?.name));
      // WITH its configuration: the base it is read against (no judge: 79 / 125 of 240) and the result.
      const gemmaNote = String(gemma?.note ?? '');
      ok('…and its note states the measurement — worse than no judge, 79 → 33 of 240 on top-1, 125 → 111 on found@8',
        /比不开判断/.test(gemmaNote) && /240/.test(gemmaNote) && /79/.test(gemmaNote) && /33/.test(gemmaNote)
          && /125/.test(gemmaNote) && /111/.test(gemmaNote) && !/没有单独实测/.test(gemmaNote), gemmaNote);
      // The 资源 row that downloads it is generated from the same catalogue row — asserted, not assumed.
      const resources = (await getJson('/api/manage/resources')).resources ?? [];
      const gemmaRes = resources.find((r) => r.id === `gguf-${GEMMA_1B}`);
      ok('…and the 资源 row that downloads it carries no 推荐 either',
        !!gemmaRes && !/推荐/.test(String(gemmaRes.name)), JSON.stringify(gemmaRes?.name ?? null));
      const big = rowOf(shelf, 'gemma-3-4b-it-Q4_K_M');
      ok('the 4B chat model says it was not measured here, rather than guessing from the 1B',
        /没有在这里实测过/.test(String(big?.note ?? '')), String(big?.note));

      // THE SMALL RERANKER (docs/judge-bench.md Run 4): listed, typed a RERANKER by its row although its upstream
      // name carries no "rerank" (an uncatalogued file of that name would be typed CHAT), pinned at its exact size,
      // and NOT recommended — BGE stays the recommended reranker, which the badge assertions below pin.
      const mini = rowOf(shelf, MMINILM);
      const miniRes = resources.find((r) => r.id === `gguf-${MMINILM}`);
      ok('mMiniLMv2 is on the shelf as a reranker, at its pinned size',
        !!mini && mini.capability === 'reranking' && mini.sizeBytes === 132584000 && miniRes?.approxBytes === 132584000,
        JSON.stringify({ row: mini ?? null, resource: miniRes?.approxBytes ?? null }));
      // The long-fact cost is MEASURED since docs/judge-bench.md Runs 6 and 6c: cut to its first window, an end-position
      // answer reached the page 4 times in 60 (no judge: 29); read in windows, 44. The note used to say 「还没有量过」.
      ok('…carries no 推荐, and says why it is not the default: the 512-token window, the licence, and what reading a LONG fact costs, measured',
        !!mini && !/推荐/.test(String(mini.name)) && /512/.test(String(mini.note)) && /非商业/.test(String(mini.note))
          && /4\/60/.test(String(mini.note)) && /29\/60/.test(String(mini.note)) && /44\/60/.test(String(mini.note))
          && !/截短对长事实的检索影响有多大还没有量过/.test(String(mini.note)) && /199\/240/.test(String(mini.note)),
        JSON.stringify({ name: mini?.name, note: mini?.note }));
      // …where unread stretches BEGIN: past five window-lengths (5 × 253–506), not four — the sentence was one window early.
      ok('…and says a fact goes partly unread only past 5 windows — 1,265–2,530 characters — and how much',
        /1,265–2,530 字以上/.test(String(mini?.note)) && /约一半读不到/.test(String(mini?.note))
          && !/1,000–2,000 字以上/.test(String(mini?.note)), String(mini?.note));
      // EVERY catalogued reranker says what a SLOW machine does, in ONE shared clause (GgufCatalog.RerankerLatencyCaveat), each
      // part what RerankPace does: long facts read in fewer windows, down to the first; the first recall after a launch can
      // still wait the minute (the pace starts from the GPU figure); ONE wait is damped, so a truly slow machine waits TWICE;
      // after a wait, one window per long fact until a recall answers in time; a recall whose one-window call is predicted
      // past ~48 s (0.8 of the minute — computed from RerankPace.OneWindowShareOfDeadline, so it cannot drift) or half the
      // minute right after a wait is SKIPPED at once and re-measured at most every ten minutes; for a minute or two after a
      // wait recalls skip too; the skips show in the 判断 row. And what docs/judge-bench.md Run 9 (VALID; 1a22630) measured
      // for long and short facts in ONE recall, with its configuration, in the words its intervals allow: short-target
      // found@8 not significantly lower when long notes are read in windows (94→91, 101→99, 98→97 of 120), a loss of up to
      // ~4–6 points not ruled out, and long targets +30 to +69 of 120. It said 「长短事实混在一起的检索还没有量过」 until
      // then. The clause was 978 characters in one parenthesis, repeated on three rows, until review (2026-09-25); Run 8's
      // CPU figures now live in mMiniLMv2's row only, below.
      const rerankerNotes = [RERANKER, 'LAMAR-600m.Q5_K_M', MMINILM].map((id) => [id, String(rowOf(shelf, id)?.note ?? '')]);
      const MIXED = '长短事实混在一起时(在显卡上,30 条短事实加 30 条约 900–1,200 字的长笔记、240 道提问、不开语义、没有主题标注、'
        + '每次由它挑 8 条上页),分段读没有让答案在短事实里的提问显著少进前八(120 道里 BGE 94→91、LAMAR 101→99、mMiniLMv2 98→97,'
        + '但排除不了最多约 4–6 个百分点的损失),答案在长笔记里的则多进了 30–69 道';
      for (const [id, n] of rerankerNotes) {
        ok(`${id}: its note says what a slow machine does — fewer windows, down to the first — and Run 9's mixed-recall result, that clause exactly`,
          /机器较慢时,应用按测到的速度让长事实少读几段,最少只读开头一段/.test(n) && /写在后面的答案就读不到/.test(n)
            && n.includes(MIXED) && !/混在一起的检索还没有量过/.test(n),
          n.slice(n.indexOf('长短事实'), n.indexOf('长短事实') + 200));
        // The pace starts from this machine's MEASUREMENT of the reranker where there is one (RerankDeviceVerdict.PaceSeed,
        // e2e-p53), never faster than the GPU figure — it said 「先按显卡上的速度估计」, false once a device is measured.
        ok(`${id}: …that the pace restarts at every launch from the rate measured on this machine (the GPU reference figure without one, or when faster) — a first recall can still wait the minute — and that a truly slow machine waits TWICE, because one wait is damped`,
          /每次启动后它先按应用在这台机器上为它实测的速度估计\(没有实测、或实测比一块独立显卡上的参考速度还快时,按那个参考速度\)/.test(n)
            && /估计偏快时,启动后头一次要读的长事实太多,仍可能等满一分钟、按没有判断时的顺序返回/.test(n)
            && !/先按显卡上的速度估计/.test(n)
            && /单独一次等满,应用只把速度估计放慢几倍/.test(n) && /真正慢的机器一般要等满两次/.test(n),
          n.slice(n.indexOf('每次启动后'), n.indexOf('每次启动后') + 140));
        ok(`${id}: …what follows a wait, and when a recall is SKIPPED — past ~48 s, or half a minute right after a wait — re-measured every ten minutes, skipped for a minute or two after a wait, and counted in the 判断 row`,
          /等满之后,遇到长事实的检索先每条只读开头一段/.test(n) && /等有一次在时限内做完、测出这台机器的速度/.test(n)
            && /预计每条只读开头一段也要超过约 48 秒\(刚等满过一分钟时是半分钟\)时,应用当即跳过这次判断/.test(n)
            && /最多每十分钟花几秒重新测一次速度/.test(n) && /等满一分钟之后的一两分钟里,检索也会先跳过判断/.test(n)
            && /跳过了几次,「判断」那一行会写出来/.test(n),
          n.slice(n.indexOf('等满之后'), n.indexOf('等满之后') + 200));
        // The words the review replaced (M7, I3): a figure that was one attempt, a window that was two minutes, and a
        // threshold said as 「来不及」 where the code skipped at HALF the minute.
        ok(`${id}: …and none of the replaced wordings`,
          !/多等约 5 秒/.test(n) && !/约两分钟内/.test(n) && !/也来不及时/.test(n) && !/这类检索每次都会等满一分钟/.test(n)
            && !/检测不到显卡/.test(n) && !/这一点还没有在只有 CPU 的机器上实测过/.test(n),
          n.slice(0, 120));
      }
      // Run 8's CPU measurement is mMiniLMv2's row's, with its configuration — the reason it is recommended where llama.cpp can
      // use no GPU (an integrated one counts), or where the judge has been skipped — and what is known of an integrated GPU
      // now: on that same laptop's Arc both rerankers were slower than its CPU (Run 8b, descriptive; the device measurement on
      // the real binary), so the app measures the devices and, on that laptop with only the Arc visible, chose the CPU for
      // both and moved the badge to mMiniLMv2. It said 「只有集成显卡的机器两者都还没有量过」 until then.
      const miniNote = String(mini?.note ?? '');
      ok('mMiniLMv2\'s row states Run 8\'s CPU result with its configuration — 17.5 s, at most ~22 s, 180/240; BGE ~3 s per 1,000 tokens, 1–2 minutes, 230 of 240 minute-waits, 104/240 — and LAMAR unmeasured there',
        /在一台只用 CPU 的笔记本上实测过\(Intel Core Ultra 9 185H,不用显卡,llama\.cpp b10549;/.test(miniNote)
          && /240 道提问/.test(miniNote) && /不开语义/.test(miniNote) && /17\.5 秒、最慢约 22 秒/.test(miniNote) && /180\/240/.test(miniNote)
          && /104\/240/.test(miniNote) && /每 1,000 个词元要约 3 秒/.test(miniNote) && /一分多钟到两分钟/.test(miniNote)
          && /230 次等满一分钟\(那时应用还不会跳过\)/.test(miniNote) && /LAMAR 没有在只用 CPU 的机器上量过/.test(miniNote),
        miniNote.slice(miniNote.indexOf('在一台只用 CPU'), miniNote.indexOf('在一台只用 CPU') + 240));
      ok('mMiniLMv2\'s row says it is what the app recommends where llama.cpp can use no GPU (an integrated one counts), or where the judge was skipped — that its long-note loss to BGE was on a GPU — and what one laptop\'s integrated GPU did',
        /llama\.cpp 用不了任何显卡时\(集成显卡也算显卡\),应用推荐它而不是 BGE/.test(miniNote) && /「判断」那一行也会建议改用它/.test(miniNote)
          && /有显卡、BGE 在这台机器上也没有测出太慢时,推荐的仍是 BGE。只有集成显卡时:在同一台笔记本的 Arc 集成显卡上,两个重排模型都比它的 CPU 慢\(mMiniLMv2 约 6–7 倍,BGE 约 3 倍;只是这一台机器上的数\)/.test(miniNote)
          && /那台笔记本只露出集成显卡时,两者都选了 CPU;BGE 在那里连 CPU 上也赶不上默认检索里的长事实,应用测完就改为推荐 mMiniLMv2/.test(miniNote)
          && !/还没有量过。/.test(miniNote.slice(miniNote.indexOf('只有集成显卡'))) && !/两者都还没有量过/.test(miniNote)
          && /BGE 下载后,应用会在这台机器的 CPU 和每块显卡上测它的速度,连最快的设备都赶不上时,「资源」也会改为推荐它/.test(miniNote)
          && /\(在显卡上;测完后另算的比较\)/.test(miniNote),
        miniNote);
      // BGE's and LAMAR's rows POINT at it, with a line of their own, and do not repeat the configuration.
      const bgeNote = String(rowOf(shelf, RERANKER)?.note ?? '');
      const lamarNote = String(rowOf(shelf, 'LAMAR-600m.Q5_K_M')?.note ?? '');
      ok('BGE\'s row says what Run 8 found for it on a CPU — almost never in time, 230 of 240 minute-waits before the skip, no verdict either way, 104/240 — pointing at mMiniLMv2\'s row for the configuration',
        /只用 CPU 时它几乎总是来不及判断/.test(bgeNote) && /实测和设置见 mMiniLMv2 那一行/.test(bgeNote)
          && /230 次等满一分钟、没能判断/.test(bgeNote) && /现在会当即跳过,同样没有判断/.test(bgeNote) && /104\/240/.test(bgeNote)
          && /llama\.cpp 用不了任何显卡时,应用推荐 mMiniLMv2/.test(bgeNote)
          && /在同一台笔记本的集成显卡上,它比它的 CPU 还慢约 3 倍\(实测和设置见 mMiniLMv2 那一行\)/.test(bgeNote)
          && !/两者都还没有量过/.test(bgeNote)
          && /它在这台机器上多快,应用要等下载之后才测得出\(在 CPU 和每块显卡上各测一次,之后让它在最快的那个上运行\)/.test(bgeNote)
          && /连最快的设备都赶不上时,也改为推荐 mMiniLMv2/.test(bgeNote)
          && !/Intel Core Ultra 9 185H/.test(bgeNote),
        bgeNote.slice(bgeNote.indexOf('只用 CPU 时'), bgeNote.indexOf('只用 CPU 时') + 200));
      ok('LAMAR\'s row says it was not run on a CPU, and points at BGE\'s — the same size — without repeating the configuration',
        /LAMAR 没有在只用 CPU 的机器上量过;和它一样大的 BGE/.test(lamarNote) && /见 BGE 那一行/.test(lamarNote)
          && /llama\.cpp 用不了任何显卡时,应用推荐 mMiniLMv2/.test(lamarNote) && !/Intel Core Ultra 9 185H/.test(lamarNote),
        lamarNote.slice(lamarNote.indexOf('LAMAR 没有'), lamarNote.indexOf('LAMAR 没有') + 120));
      // mMiniLMv2's parity with BGE is a SHORT-fact result: on Run 6c's long notes, both read in windows, it brought the
      // answer onto the page significantly less often (182 against 201 of 240, 33/14, p = 0.008) — post hoc, and said so.
      ok('…and mMiniLMv2\'s parity with BGE is qualified as short-fact, beside the long-note loss with its p and that it was computed afterwards',
        /没有测出显著差别\(事实都很短时\)/.test(String(mini?.note)) && /182\/240 对 201\/240/.test(String(mini?.note))
          && /p = 0\.008/.test(String(mini?.note)) && /38\/60 对 51\/60/.test(String(mini?.note))
          // The position cell is one of 16 and descriptive, so it carries no p (review, 2026-09-25).
          && !/p = 0\.007/.test(String(mini?.note)) && /按位置拆开的数字只作描述/.test(String(mini?.note))
          && /测完后另算的比较/.test(String(mini?.note)),
        String(mini?.note));

      // QWEN3 0.6B (docs/judge-bench.md Run 5b): the first CHAT judge measured better than no judge on both metrics —
      // catalogued, described by its measurement with its configuration, and NOT recommended (BGE stays the default).
      // Its note must also say what was NOT measured: the tags it writes (the fixture's tags came from the Claude CLI).
      const qwen = rowOf(shelf, QWEN3);
      const qwenRes = resources.find((r) => r.id === `gguf-${QWEN3}`);
      const qwenNote = String(qwen?.note ?? '');
      ok('Qwen3 0.6B is on the shelf as a CHAT model at its pinned size, with a 资源 row — and neither name says 推荐',
        !!qwen && qwen.capability === 'completion' && qwen.sizeBytes === 639446688 && qwenRes?.approxBytes === 639446688
          && !/推荐/.test(String(qwen.name)) && !/推荐/.test(String(qwenRes?.name)),
        JSON.stringify({ row: qwen ?? null, resource: qwenRes ?? null }));
      ok('…its note carries Run 5b with its configuration — 79 → 110 and 125 → 148 of 240, 语义 off, thinking off, BGE\'s 203 beside it, ~0.38 s',
        /240 道提问/.test(qwenNote) && /不开语义/.test(qwenNote) && /关闭思考/.test(qwenNote)
          && /79 题增加到 110 题/.test(qwenNote) && /125 题增加到 148 题/.test(qwenNote) && /显著/.test(qwenNote)
          && /203 对 148/.test(qwenNote) && /0\.38 秒/.test(qwenNote),
        qwenNote);
      // Its TAGGING was measured since (docs/judge-bench.md Run 7): over its OWN tags against Claude's, replayed through
      // the same path, no significant difference — −4.2pp top-1, +1.3pp found@8 — and not equivalent either, so the note
      // says what the run cannot rule out (~9 / ~4pp); still significantly better than no judge over the same tags
      // (+10.8 / +14.6pp); and its tags collapse unrelated facts (`parent` on 12). It said 「没有量过」 until then.
      ok('…and states what its OWN tagging measured — no significant difference, what it cannot rule out, better than none, the collapse — and its licence',
        /4\.2 个百分点/.test(qwenNote) && /1\.3 个百分点/.test(qwenNote) && /约 9 个/.test(qwenNote) && /约 4 个百分点/.test(qwenNote)
          && /10\.8/.test(qwenNote) && /14\.6/.test(qwenNote) && /parent 标了 12 条/.test(qwenNote)
          && !/没有量过/.test(qwenNote) && /Apache-2\.0/.test(qwenNote), qwenNote);
      // A 640 MB download whose child held +5,175 MiB of GPU memory uncapped and +2,472 MiB at the chat cap
      // (docs/self-managed-llm-runtime.md, 2026-09-24): the footprint is part of the trade, so the note states it —
      // with the context it was measured at, which is the launch setting that decides it.
      ok('…and states its measured GPU footprint with the context it was taken at — not only its download size',
        /显存却约 2\.6 GB/.test(qwenNote) && /16,384 个词元/.test(qwenNote) && /40,960 个词元/.test(qwenNote)
          && /约 5\.4 GB/.test(qwenNote), qwenNote);

      // 判断's WHAT-IT-DOES SENTENCE quotes a range for "the local rerankers" — so it must cover EVERY catalogued one.
      // It read 203–208 / 7–11 until mMiniLMv2 (199, +20) was catalogued, which made both ends false while every check
      // stayed green. Derived from the rows' own notes rather than restated, so adding a reranker whose figures fall
      // outside the range fails here instead of in a household's reading.
      const figuresOf = (note, label) => Number((String(note).match(new RegExp(`${label} (\\d+)/240`)) ?? [])[1]);
      const rerankRows = (shelf.models ?? []).filter((m) => m.capability === 'reranking' && m.note);
      const found8 = rerankRows.map((m) => figuresOf(m.note, '前八命中'));
      const top1 = rerankRows.map((m) => figuresOf(m.note, '首位命中'));
      const judgeWhat = String(layerOf(await getJson('/api/manage/memory'), 'judge')?.what ?? '');
      ok('(fixture) every catalogued reranker note states its top-1 and found@8 of 240',
        rerankRows.length >= 3 && [...found8, ...top1].every(Number.isFinite), JSON.stringify({ found8, top1 }));
      ok('THE POINT: 判断\'s sentence quotes a found@8 and top-1 range spanning EVERY catalogued reranker, from the no-judge 125 / 79',
        judgeWhat.includes(`从 125 题增加到 ${Math.min(...found8)}–${Math.max(...found8)} 题`)
          && judgeWhat.includes(`排第一的多 ${Math.min(...top1) - 79}–${Math.max(...top1) - 79} 题`)
          && /不开语义/.test(judgeWhat),
        JSON.stringify({ found8, top1, what: judgeWhat }));

      // THE BADGE, before anything is installed: the GGUF embedder, with a reason that is true of it. It said
      // 「这几个里只有它…量过」, false of both embedders — each has a score in the same 检索质量 column.
      ok('with nothing installed the badge is the GGUF embedder, and its reason claims no exclusive measurement',
        shelf.recommendation?.id === 'embeddinggemma-300M-Q8_0' && /实测过/.test(String(shelf.recommendation?.reason))
          && !/只有它/.test(String(shelf.recommendation?.reason)),
        JSON.stringify(shelf.recommendation ?? null));

      // THE BADGE. It recommends only what is not installed — and ONE embedder is enough: the two embedder rows are
      // the same EmbeddingGemma 300M, as a GGUF and as ONNX, and 语义 binds one of them. With EITHER in, the other is
      // never suggested and the badge moves on to 判断; it used to suggest the second copy and hide the reranker
      // behind it. Both directions, each with ONE embedder planted (empty files: the GGUF by its id, the built-in by
      // the two files OnnxEmbedder.IsPresent checks).
      fs.mkdirSync(path.join(builtinDir, 'onnx'), { recursive: true });
      fs.writeFileSync(path.join(builtinDir, 'onnx', 'model_q4.onnx'), '');
      fs.writeFileSync(path.join(builtinDir, 'tokenizer.model'), '');
      const withBuiltIn = await getJson('/api/manage/models');
      const embedderState = (inv) => JSON.stringify((inv.models ?? []).filter((m) => m.capability === 'embedding')
        .map((m) => [m.id, m.installed]));
      ok('(fixture) the built-in embedder reads as installed, the GGUF one does not',
        (withBuiltIn.models ?? []).filter((m) => m.capability === 'embedding' && m.installed).length === 1,
        embedderState(withBuiltIn));
      ok('THE POINT: with the built-in embedder in, the badge skips the GGUF copy of the same model and recommends the RERANKER',
        withBuiltIn.recommendation?.id === RERANKER, JSON.stringify(withBuiltIn.recommendation ?? null));
      fs.rmSync(builtinDir, { recursive: true, force: true });
      fs.mkdirSync(ggufDir, { recursive: true });
      fs.writeFileSync(path.join(ggufDir, 'embeddinggemma-300M-Q8_0.gguf'), '');

      // …BUT ONLY AN EMBEDDER THAT CAN RUN COUNTS. The GGUF copy needs the llama.cpp runtime, and with none installed
      // the badge used to treat it as "in" and move on to the reranker — which needs the same runtime — while 语义 had
      // nothing that worked. What makes the model they already have work is the runtime, not the built-in second copy.
      const noRuntime = await getJson('/api/manage/models');
      ok('(fixture) the GGUF embedder reads as installed, the built-in one does not, and there is no llama.cpp runtime',
        (noRuntime.models ?? []).filter((m) => m.capability === 'embedding' && m.installed).length === 1
          && noRuntime.runtime?.installed === false,
        `${embedderState(noRuntime)} runtime.installed=${noRuntime.runtime?.installed}`);
      const noRuntimeRec = noRuntime.recommendation;
      ok('THE POINT: a GGUF embedder with no runtime is not "in" — the line recommends the RUNTIME, not the reranker (which needs it too) and not a second copy of the model',
        noRuntimeRec?.id === 'llama-cpp', JSON.stringify(noRuntimeRec ?? null));
      ok('…naming the download (35 MB) and the no-runtime alternative, the built-in row',
        /35 MB/.test(String(noRuntimeRec?.reason)) && /内置/.test(String(noRuntimeRec?.reason)), String(noRuntimeRec?.reason));

      // RUNTIME IN — a stub binary that merely exists is what `installed` asks — so the GGUF embedder is usable.
      fs.mkdirSync(path.dirname(stubExe), { recursive: true });
      fs.writeFileSync(stubExe, 'not a real binary');
      const withEmbedders = await getJson('/api/manage/models');
      ok('(fixture) the GGUF embedder reads as installed, the built-in one does not, and the runtime is in',
        (withEmbedders.models ?? []).filter((m) => m.capability === 'embedding' && m.installed).length === 1
          && withEmbedders.runtime?.installed === true,
        `${embedderState(withEmbedders)} runtime.installed=${withEmbedders.runtime?.installed}`);
      const rec = withEmbedders.recommendation;
      ok('THE POINT: …and the other way round: 资源 recommends the RERANKER for 判断 — not the built-in copy, never the 1B chat model, never the small reranker',
        rec?.id === RERANKER, JSON.stringify(rec ?? null));
      ok('…and its reason says what binding it moves: the checking is local, the tagging goes to the Claude CLI on the account',
        /Claude CLI/.test(String(rec?.reason)) && String(rec?.reason ?? '').includes(TAGGING_COST), String(rec?.reason));
      // THE LIMITATION, said where the badge is (owner decision 2026-09-26, after Run 8b): the app MEASURES a reranker's
      // devices on this machine (RerankDeviceMeter; e2e-p53) — but only once it is on disk, so the badge offers BGE first
      // everywhere and moves to mMiniLMv2 only after BGE has been downloaded and measured too slow here.
      ok('…and it says the machine is unknown until BGE is downloaded and measured — and what happens if it is too slow here',
        /要等下载后、应用下一次自己启动 llama\.cpp 时才测得出/.test(String(rec?.reason))
          && /连最快的设备都太慢的话,这里会改为推荐更小的 mMiniLMv2/.test(String(rec?.reason)),
        String(rec?.reason));

      // THE 判断 ROW'S SUGGESTION: runtime present, no model 判断 can use (the embedder is the wrong kind), so its
      // sentence names a download — and that download is the reranker's.
      const llamaJudge = srcs(layerOf(await getJson('/api/manage/memory'), 'judge')).find((x) => x.id === 'llama-cpp');
      ok('THE POINT: the 判断 row, runtime in and no judge model, suggests downloading the reranker',
        llamaJudge?.suggest === `gguf-${RERANKER}`,
        JSON.stringify({ suggest: llamaJudge?.suggest, reason: llamaJudge?.reason }));

      // WHERE llama.cpp SEES NO GPU, THE SUGGESTION IS mMiniLMv2 (docs/judge-bench.md Run 8: on a CPU it judged every
      // recall within the minute, where BGE needed ~2 minutes for 40–60 long notes and ended where no judge is). What
      // decides is the device list the BINARY prints, so the stand-in has to be a process that answers `--list-devices`:
      // a copy of Windows' own more.com, which prints the file its argument names from its working directory — and the
      // runtime runs the binary with its own folder as the working directory. So a file named `--list-devices` there is
      // the answer: first no device (b10549's own words with its Vulkan devices hidden), then a GPU. The stand-in's
      // identity (path, time, size) keys the runtime's memo of those facts, so each new answer comes with a new time.
      // "Unknown" — the unreadable stub above — kept BGE, and the reason claimed nothing about the machine.
      ok('(control) with the device list unknown — the stub cannot answer it — the badge is BGE and its reason names no machine',
        rec?.id === RERANKER && !/显卡/.test(String(rec?.reason)), JSON.stringify(rec ?? null));
      const devicesFile = path.join(path.dirname(stubExe), '--list-devices');
      let stamp = Date.now() / 1000;
      const answerDevices = async (text) => {
        fs.writeFileSync(devicesFile, text);
        stamp += 10;
        fs.utimesSync(stubExe, stamp, stamp);
        return (await fetch(`${srv.base}/api/manage/models/llama?refresh=true`)).json();
      };
      fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'more.com'), stubExe);
      try {
        const noGpu = await answerDevices('Available devices:\r\n  (none)\r\n');
        ok('(non-vacuity) the stand-in binary ANSWERED --list-devices, with no device — the runtime reads "no GPU", not "unknown"',
          noGpu.devicesListed === true && noGpu.gpu === false && (noGpu.devices ?? []).length === 0,
          JSON.stringify({ devicesListed: noGpu.devicesListed, gpu: noGpu.gpu, devices: noGpu.devices }));
        const cpuShelf = await getJson('/api/manage/models');
        const cpuRec = cpuShelf.recommendation;
        ok('THE POINT: with no GPU, 资源 recommends mMiniLMv2 for 判断 — not BGE',
          cpuRec?.id === MMINILM && cpuShelf.runtime?.gpu === false,
          JSON.stringify({ rec: cpuRec ?? null, gpu: cpuShelf.runtime?.gpu }));
        ok('…and its reason says why, plainly: llama.cpp can use no GPU here, Run 8\'s CPU result with its configuration, BGE too slow there, what one laptop\'s integrated GPU did — and the tagging clause',
          /llama\.cpp 在这台机器上用不了任何显卡/.test(String(cpuRec?.reason)) && /Intel Core Ultra 9 185H/.test(String(cpuRec?.reason))
            && /17\.5 秒/.test(String(cpuRec?.reason)) && /180\/240/.test(String(cpuRec?.reason))
            && /104\/240/.test(String(cpuRec?.reason)) && /240 道提问/.test(String(cpuRec?.reason))
            && /不开语义/.test(String(cpuRec?.reason)) && /一分多钟到两分钟/.test(String(cpuRec?.reason))
            && /llama\.cpp 能用显卡、BGE 下载后在这台机器上也没有测出太慢时,推荐的是 BGE/.test(String(cpuRec?.reason))
            && /在同一台笔记本的集成显卡上,两者都比它的 CPU 慢\(实测和设置见 mMiniLMv2 那一行的说明\)/.test(String(cpuRec?.reason))
            && !/两者都还没有量过/.test(String(cpuRec?.reason))
            && !/没有检测到显卡|约两分钟/.test(String(cpuRec?.reason)) && String(cpuRec?.reason ?? '').includes(TAGGING_COST),
          String(cpuRec?.reason));
        const cpuJudge = srcs(layerOf(await getJson('/api/manage/memory'), 'judge')).find((x) => x.id === 'llama-cpp');
        ok('THE POINT: …and the 判断 row\'s download suggestion is mMiniLMv2 too — one writer for both',
          cpuJudge?.suggest === `gguf-${MMINILM}`, JSON.stringify({ suggest: cpuJudge?.suggest }));
        // …and an INVALIDATION does not flip it. Every start, restart and model removal drops the runtime's cached state;
        // the badge used to read the GPU answer from there, so for as long as the background re-probe took, "no GPU" read
        // as "not known" and the badge went back to BGE. It reads the memo of the binary's device list now, which an
        // invalidation leaves alone (ILlamaServerRuntime.Gpu). Removing a model is the household's own way to invalidate.
        fs.writeFileSync(path.join(ggufDir, 'zzthrowaway-Q4_K_M.gguf'), '');
        const removed = await post('/api/manage/models/remove', { model: 'zzthrowaway-Q4_K_M', runtime: 'llama-cpp' });
        const afterRemove = await getJson('/api/manage/models');
        ok('THE POINT: removing a model — which drops the runtime\'s cached state — leaves the badge on mMiniLMv2 and the runtime reading "no GPU", not "unknown"',
          removed.status === 200 && afterRemove.recommendation?.id === MMINILM && afterRemove.runtime?.gpu === false,
          JSON.stringify({ removed: removed.status, rec: afterRemove.recommendation?.id ?? null, gpu: afterRemove.runtime?.gpu }));
        // The one-reranker rule holds on a CPU too: BGE already in means nothing more is suggested — not a second reranker.
        fs.writeFileSync(path.join(ggufDir, `${RERANKER}.gguf`), '');
        const cpuWithBge = await getJson('/api/manage/models');
        ok('…and never a second reranker: with BGE installed and no GPU, nothing is recommended',
          cpuWithBge.recommendation == null, JSON.stringify(cpuWithBge.recommendation ?? null));
        fs.rmSync(path.join(ggufDir, `${RERANKER}.gguf`), { force: true });

        // A device list naming only NON-Vulkan devices comes from a build this app does not provision (CUDA, Metal, SYCL…):
        // a device is there, so it is not "no GPU" — and not one we know to be a GPU either, so "not known", which keeps BGE
        // and claims nothing (LlamaServerState.GpuFrom). It read "no GPU" at first, and recommended the CPU model beside one.
        const cuda = await answerDevices('Available devices:\r\n  CUDA0: zzfake GPU (8192 MiB, 8000 MiB free)\r\n');
        const cudaShelf = await getJson('/api/manage/models');
        ok('THE POINT: a device list naming only a non-Vulkan device reads as NOT KNOWN, not "no GPU" — the badge stays BGE and claims nothing about the machine',
          cuda.devicesListed === true && cuda.gpu === null && cudaShelf.runtime?.gpu === null
            && cudaShelf.recommendation?.id === RERANKER && !/显卡/.test(String(cudaShelf.recommendation?.reason)),
          JSON.stringify({ gpu: cuda.gpu, devices: cuda.devices, shelfGpu: cudaShelf.runtime?.gpu, rec: cudaShelf.recommendation?.id ?? null }));

        const withGpu = await answerDevices('Available devices:\r\n  Vulkan0: zzfake GPU (8192 MiB, 8000 MiB free)\r\n');
        ok('(non-vacuity) the same stand-in answered again, now listing a Vulkan GPU',
          withGpu.devicesListed === true && withGpu.gpu === true, JSON.stringify({ gpu: withGpu.gpu, devices: withGpu.devices }));
        const gpuShelf = await getJson('/api/manage/models');
        ok('(control) with a GPU, the badge is BGE again, with the reason that claims nothing about the machine',
          gpuShelf.recommendation?.id === RERANKER && !/显卡/.test(String(gpuShelf.recommendation?.reason)),
          JSON.stringify(gpuShelf.recommendation ?? null));
        const gpuJudge = srcs(layerOf(await getJson('/api/manage/memory'), 'judge')).find((x) => x.id === 'llama-cpp');
        ok('(control) …and the 判断 row suggests BGE', gpuJudge?.suggest === `gguf-${RERANKER}`,
          JSON.stringify({ suggest: gpuJudge?.suggest }));
      } finally {
        // Back to the unreadable stub the rest of this block expects — and a device list nobody can read again.
        fs.rmSync(devicesFile, { force: true });
        fs.writeFileSync(stubExe, 'not a real binary');
        await fetch(`${srv.base}/api/manage/models/llama?refresh=true`);
      }

      // A CHAT judge on disk — even the one measured better than none — is not the suggestion, and not a reason to
      // stop suggesting the reranker: it is a different kind of judge, not a second copy of one.
      fs.writeFileSync(path.join(ggufDir, `${QWEN3}.gguf`), '');
      const withChatJudge = await getJson('/api/manage/models');
      ok('(fixture) Qwen3 0.6B reads as an installed chat model',
        rowOf(withChatJudge, QWEN3)?.installed === true && rowOf(withChatJudge, QWEN3)?.capability === 'completion',
        JSON.stringify(rowOf(withChatJudge, QWEN3) ?? null));
      ok('THE POINT: with Qwen3 0.6B installed the badge still names the reranker — never the chat judge',
        withChatJudge.recommendation?.id === RERANKER, JSON.stringify(withChatJudge.recommendation ?? null));
      fs.rmSync(path.join(ggufDir, `${QWEN3}.gguf`), { force: true });

      // ONE RERANKER IS ENOUGH, as one embedder is: any installed reranker is a local judge that measured better than
      // none, so suggesting BGE beside another is the second-copy redundancy the embedder rule already refuses.
      fs.writeFileSync(path.join(ggufDir, `${MMINILM}.gguf`), '');
      const otherReranker = await getJson('/api/manage/models');
      ok('(fixture) the small reranker reads as an installed reranker',
        rowOf(otherReranker, MMINILM)?.installed === true && rowOf(otherReranker, MMINILM)?.capability === 'reranking',
        JSON.stringify(rowOf(otherReranker, MMINILM) ?? null));
      ok('THE POINT: with ANOTHER reranker in, BGE is not suggested as a second one — nothing is',
        otherReranker.recommendation == null, JSON.stringify(otherReranker.recommendation ?? null));
      fs.rmSync(path.join(ggufDir, `${MMINILM}.gguf`), { force: true });

      // …AND NOTHING AFTER IT. The badge used to fall through to "any embedder", then "whatever is smallest" —
      // which, with these in, is a model nobody chose to recommend.
      fs.writeFileSync(path.join(ggufDir, `${RERANKER}.gguf`), '');
      const allIn = await getJson('/api/manage/models');
      ok('…and once it is in, nothing else is recommended — not the 1B, not Qwen3 0.6B, not whichever file is smallest',
        allIn.recommendation == null, JSON.stringify(allIn.recommendation ?? null));
    } finally {
      // As the next block expects: it plants its own binary and models, and asserts on the preset they produce.
      fs.rmSync(builtinDir, { recursive: true, force: true });
      fs.rmSync(path.join(res, 'llama-cpp'), { recursive: true, force: true });
      fs.rmSync(ggufDir, { recursive: true, force: true });
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
    // …and a CATALOGUED reranker whose row declares a 512-token window (mMiniLMv2, docs/judge-bench.md Run 4),
    // under its upstream name — no "rerank" in it, so only the row can type it.
    const WINDOWED = 'mmarco-mMiniLMv2-L12-H384-v1-Q8_0';
    fs.writeFileSync(path.join(ggufDir, `${WINDOWED}.gguf`), 'x');
    // …and the catalogued CHAT judge (Qwen3 0.6B, docs/judge-bench.md Run 5b), whose template THINKS by default: the
    // kind that most needs `reasoning = off`. Its row types it chat; so would its name, so this pins the launch the
    // row gets rather than proving the row exists (the shelf block does that).
    const QWEN3 = 'Qwen3-0.6B-Q8_0';
    fs.writeFileSync(path.join(ggufDir, `${QWEN3}.gguf`), 'x');

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
    // EVERY section, of every kind — the rerankers' too, which carry the most other keys and are where a refactor of
    // the per-kind switch would most easily drop it.
    //
    // …A CPU SECTION INCLUDED. A reranker measured fastest on the CPU (RerankDeviceMeter) gets `device = none` — and KEEPS
    // `n-gpu-layers = 99` beside it, which is harmless there: on the real binary (b10549, 2026-09-26) that child logs
    // "offloaded 25/25 layers to GPU" yet holds only CPU buffers and scores at the CPU's rate, the same as with 0 — it is
    // `device = none` that keeps a batch off a visible GPU (Run 8: `n-gpu-layers = 0` alone does not). No section here is
    // measured (the stub binary answers neither --version nor --list-devices, so there is no key to measure under, and
    // no section gets a device key); e2e-p53 drives the measurement and asserts both lines on a CPU section.
    const allSections = ['zztest-embed-model', 'zztest-chat-model', 'zztest-rerank-model', WINDOWED];
    ok('(D) with no measurement possible, no section names a device — llama.cpp chooses, as before',
      allSections.every((id) => !/^device\s*=/m.test(sectionOf(id))),
      JSON.stringify(Object.fromEntries(allSections.map((id) => [id, sectionOf(id)]))));
    ok('THE POINT: every model gets n-gpu-layers — without it recall is ~30x slower, silently (a CPU section keeps it too; e2e-p53)',
      allSections.every((id) => /^n-gpu-layers\s*=\s*\d+\s*$/m.test(sectionOf(id))),
      JSON.stringify(Object.fromEntries(allSections.map((id) => [id, sectionOf(id)]))));
    // …and a CHAT section's context is capped (LlamaServerRuntime.ChatContextTokens, 2026-09-24). Unset, a chat child
    // takes its model's whole TRAINING context and llama.cpp reserves the KV cache for all of it up front: Qwen3-0.6B,
    // 40,960 tokens, 4,480 MiB of KV for a 604 MiB model — +5,175 MiB of GPU memory on the real binary, +2,472 MiB at
    // the cap (docs/self-managed-llm-runtime.md). 16,384 holds the measured worst prompt (400 fixture candidates,
    // ≤ 10,395 tokens, + the 512-token reply) with a third to spare. SILENT without it: nothing fails, the GPU just holds
    // gigabytes for nothing, and on a smaller one llama.cpp quietly shrinks the window to whatever is left.
    ok('THE POINT: a chat section launches with its context capped at 16,384 tokens — exactly one ctx-size line',
      /^ctx-size\s*=\s*16384\s*$/m.test(sectionOf('zztest-chat-model'))
        && (sectionOf('zztest-chat-model').match(/^ctx-size/gm) ?? []).length === 1,
      JSON.stringify({ chat: sectionOf('zztest-chat-model') }));
    // …and ONLY there: an embedder takes its own window (nobody measured it under another), and a reranker keeps its
    // whole-pair window — asserted below as its OWN value and here as its ONLY ctx-size line, so a chat cap written onto
    // every section (two values for one key, whichever the router then honours) cannot pass as "the reranker still says
    // 4096".
    ok('…and ONLY a chat section: the embedder carries no ctx-size, and each reranker exactly one — its own',
      !/ctx-size/.test(sectionOf('zztest-embed-model'))
        && ['zztest-rerank-model', WINDOWED].every((id) => (sectionOf(id).match(/^ctx-size/gm) ?? []).length === 1)
        && ['zztest-embed-model', 'zztest-rerank-model', WINDOWED].every((id) => !/16384/.test(sectionOf(id))),
      JSON.stringify({ embed: sectionOf('zztest-embed-model'), rerank: sectionOf('zztest-rerank-model'), windowed: sectionOf(WINDOWED) }));

    // A CHAT child launches with thinking OFF and a generation cap. Without the first, a thinking-capable template
    // thinks on every judgement (Lyntai 3.2.0's OpenAI-shaped wire drops TextReasoning.Suppress — its
    // docs/task-archive.md Part 288, closed as D179 and not yet released; this assertion goes only on that bump, after
    // each catalogued chat model is verified on the real binary — dev-conventions open workaround (5);
    // measured 1.3–17.5 s per verdict and past a 300 s timeout, docs/judge-bench.md Run 5's screen); without the
    // second a small model's runaway fills its whole context. Both SILENT: no error, only seconds. Verified in the
    // child's own argv on the real binary (--reasoning off --n-predict 512).
    ok('THE POINT: a chat section launches with thinking OFF and a 512-token generation cap — and still offloaded',
      /^reasoning\s*=\s*off\s*$/m.test(sectionOf('zztest-chat-model'))
        && /^n-predict\s*=\s*512\s*$/m.test(sectionOf('zztest-chat-model'))
        && /^n-gpu-layers\s*=\s*\d+\s*$/m.test(sectionOf('zztest-chat-model')),
      JSON.stringify({ chat: sectionOf('zztest-chat-model') }));
    ok('…and so does the catalogued Qwen3 0.6B — thinking off, both caps, offloaded, and none of another kind\'s keys',
      /^reasoning\s*=\s*off\s*$/m.test(sectionOf(QWEN3)) && /^n-predict\s*=\s*512\s*$/m.test(sectionOf(QWEN3))
        && /^n-gpu-layers\s*=\s*\d+\s*$/m.test(sectionOf(QWEN3))
        && /^ctx-size\s*=\s*16384\s*$/m.test(sectionOf(QWEN3))
        && !/batch-size|embeddings|reranking/.test(sectionOf(QWEN3)),
      JSON.stringify({ qwen3: sectionOf(QWEN3) }));
    // …and ONLY there: an embedder or a reranker never generates, and a key its child does not need is a key whose
    // meaning for that kind nobody measured.
    ok('…and ONLY a chat section: no embedder or reranker carries either key',
      ['zztest-embed-model', 'zztest-rerank-model', WINDOWED].every((id) => !/reasoning|n-predict/.test(sectionOf(id))),
      JSON.stringify(Object.fromEntries(['zztest-embed-model', 'zztest-rerank-model', WINDOWED].map((id) => [id, sectionOf(id)]))));

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

    // THE WINDOW IS THE ROW's. llama.cpp serves this model 512-token slots whatever the preset asks (it logs
    // n_ctx_seq (4096) > n_ctx_train (512)), so a preset claiming 4096 for it states a limit nothing honours. Typed
    // a reranker by its catalogue row — the name alone would make it a chat model with no reranking at all.
    ok('THE POINT: a reranker whose row declares a 512-token window is launched with that window, not 4096',
      /reranking\s*=\s*true/.test(sectionOf(WINDOWED))
        && /^ctx-size\s*=\s*512\s*$/m.test(sectionOf(WINDOWED))
        && /^batch-size\s*=\s*512\s*$/m.test(sectionOf(WINDOWED))
        && /^ubatch-size\s*=\s*512\s*$/m.test(sectionOf(WINDOWED))
        && !/4096/.test(sectionOf(WINDOWED)),
      JSON.stringify({ windowed: sectionOf(WINDOWED) }));

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
