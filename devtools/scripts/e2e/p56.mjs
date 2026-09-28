#!/usr/bin/env node
// e2e P56 — 内置 on 判断: the in-process reranker (BuiltInJudgeSource over InProcessReranker), bound, screened, at work,
// and fallen back.
//
// The export is a TINY but REAL cross-encoder (_tiny-cross-encoder.mjs): an ONNX graph run by the real ONNX Runtime
// through Lyntai's real ONNX provider and its owned SentencePiece tokenizer (D191), whose per-token weights the suite
// chooses. So nothing between the verifier and the scores is mocked, and the scores still mean what the suite says. What
// only the real 136 MB model can show — that it LOADS, passes the screen on its own weights, what it costs in memory and
// how fast it scores on a CPU — is measured by hand and recorded in docs/self-managed-llm-runtime.md (2026-09-28).
//
//   A. BINDING. 内置 is a real, bindable 判断 backend in the 本机模型 group, reporting itself as BUNDLED; with its files
//      missing it is unavailable and says what to download, and a bind is REFUSED with that sentence and saves nothing;
//      a model it does not offer is refused by name; a BACKWARDS scorer is refused by the screen (the answer ranked
//      below the distractor, both scores quoted) and saves nothing; the real screen's pair then passes on a scorer that
//      puts the answer first, and the toast says the checking moves here, the tagging goes to the Claude CLI on the
//      account's quota (MemorySources.CliTaggingCost), and that the model is UNMEASURED and not recommended; the route
//      written is claude-cli:haiku, never the model's id. The cost line says both halves.
//   A2. 资源. The model is a row — builtin runtime, reranking, its pinned size, a resource that exists — deletable, and
//      refused while bound; not recommended, and an installed copy does not end the suggestion of a MEASURED reranker.
//   B. AT WORK, on a server that booted bound to it. A fact write is tagged by the CLI stub on haiku; a recall is
//      VERIFIED IN PROCESS: with 判断 switched off (the live switch) a target fact the scorer rewards is off the page,
//      switched on it is on it and the recall came back judged — while nothing reaches a fake llama.cpp router and the
//      stub is never asked for a verification. The log says the model loaded and where the pace started (measured in
//      process at its first use, never below the GPU figure).
//   C. FALLBACK. A server whose settings bind 内置 while its files are absent comes up with 判断 on the CLI, and the
//      startup warning says so: which model is not there and what to download, that only the checking moved (the tagging
//      was on the CLI all along), and that a restart brings it back. The at-work server of B carries no such warning.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, until, repo,
} from './_e2e-common.mjs';

// Through the repo root rather than './': a suite copied elsewhere to run (a port-shifting wrapper does that) still finds
// the helper, the way it finds the harness.
const { writeTinyCrossEncoder, SCREEN_ANSWER_CHARS } = await import(
  pathToFileURL(path.join(repo, 'devtools', 'scripts', 'e2e', '_tiny-cross-encoder.mjs')).href);

const { ok, fail, done } = makeReporter('p56');

const MODEL = 'mmarco-mMiniLMv2-L12-H384-v1-onnx';
const RESOURCE = 'rerank-model';
const TAGGING_COST = '每条事实一次调用,消耗账号额度,事实内容会发给 Claude';
// The scorer's reward for the routing case: a character only the TARGET fact holds.
const MARKER = '鑫';
const good = Object.fromEntries([...SCREEN_ANSWER_CHARS.map((c) => [c, 1]), [MARKER, 5]]);
const backwards = Object.fromEntries(SCREEN_ANSWER_CHARS.map((c) => [c, -1]));

const PORT_BIND = 5620;
const PORT_WORK = 5621;
const PORT_GONE = 5622;

const layerOf = (mem, id) => (mem.layers ?? []).find((l) => l.id === id) ?? {};
const srcOf = (layer, id) => (layer.groups ?? []).flatMap((g) => (g.sources ?? []).map((s) => ({ ...s, group: g.id })))
  .find((s) => s.id === id);
const storedKey = (dir, key) => {
  const db = new DatabaseSync(path.join(dir, 'state', 'gatherlight.db'), { readOnly: true });
  try { return db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value ?? null; }
  finally { db.close(); }
};
const settingsOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'state', 'settings.json'), 'utf8'));
const logText = (dir) => {
  const logs = path.join(dir, 'state', 'logs');
  return fs.existsSync(logs) ? fs.readdirSync(logs).map((f) => fs.readFileSync(path.join(logs, f), 'utf8')).join('\n') : '';
};
const modelDir = (dir) => path.join(dir, 'state', 'resources', RESOURCE);

// A fake llama.cpp router on the runtime's address: it answers nothing useful and COUNTS what reaches it. The in-process
// judge must send it nothing — a reranker call there would mean the verifier was wired to llama.cpp's provider.
const routerHits = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => { routerHits.push(`${req.method} ${req.url}`); res.writeHead(404); res.end('{}'); });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${fake.address().port}`;

const servers = [];
try {
  // ---- A. BINDING ---------------------------------------------------------------------------------------------------
  const bindDir = dataDirFor('p56');
  makeTestData(bindDir);
  // The built-in EMBEDDER's files, planted (never loaded — 语义 stays unbound): with an embedder "in", 资源's badge moves
  // past the embedder suggestion to the reranker question (A2).
  const embedDir = path.join(bindDir, 'state', 'resources', 'embed-model');
  fs.mkdirSync(path.join(embedDir, 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(embedDir, 'onnx', 'model_q4.onnx'), '');
  fs.writeFileSync(path.join(embedDir, 'tokenizer.model'), '');
  const bindServer = startServer({ dataDir: bindDir, port: PORT_BIND, env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl } });
  servers.push(bindServer);
  await waitHealthy(bindServer.base);
  const a = makeClient(bindServer.base);

  let judge = layerOf(await a.getJson('/api/manage/memory'), 'judge');
  let builtin = srcOf(judge, 'builtin');
  ok('THE POINT: 内置 is a real, BINDABLE 判断 backend now — in the 本机模型 group, running in this process',
    builtin?.bindable === true && builtin?.group === 'managed' && builtin?.origin?.kind === 'bundled',
    JSON.stringify(builtin ?? null));
  ok('…nothing on 判断 is declined any more — its one declined entry was this one',
    (judge.groups ?? []).flatMap((g) => g.sources ?? []).every((s) => s.bindable === true),
    JSON.stringify((judge.groups ?? []).flatMap((g) => (g.sources ?? []).map((s) => [s.id, s.bindable]))));
  ok('with its files missing it is unavailable, names what to download, and offers no model',
    builtin?.available === false && /内置重排模型还没有下载/.test(String(builtin?.reason)) && builtin?.suggest === RESOURCE
      && (builtin?.models ?? []).length === 0,
    JSON.stringify({ available: builtin?.available, reason: builtin?.reason, suggest: builtin?.suggest }));
  ok('its description says what it moves and that it is unmeasured, not recommended',
    /Claude CLI/.test(String(builtin?.description)) && /不推荐/.test(String(builtin?.description))
      && /不需要 llama\.cpp/.test(String(builtin?.description)),
    String(builtin?.description));

  const missing = await a.post('/api/manage/memory/layer/judge', { source: 'builtin', model: MODEL });
  ok('binding it with its files missing is REFUSED with the download sentence',
    missing.status === 409 && /内置重排模型还没有下载/.test(String(missing.body?.error)),
    `${missing.status} ${JSON.stringify(missing.body)}`);
  ok('…and saves nothing', settingsOf(bindDir).memory?.judgeSource !== 'builtin',
    JSON.stringify(settingsOf(bindDir).memory ?? null));

  writeTinyCrossEncoder(modelDir(bindDir), backwards);
  const wrongModel = await a.post('/api/manage/memory/layer/judge', { source: 'builtin', model: 'haiku' });
  ok('a model 内置 does not offer is refused BY NAME, before anything scores',
    wrongModel.status === 409 && /haiku 不是「内置」的模型/.test(String(wrongModel.body?.error)),
    `${wrongModel.status} ${JSON.stringify(wrongModel.body)}`);
  const rev = await a.post('/api/manage/memory/layer/judge', { source: 'builtin', model: MODEL });
  const revErr = String(rev.body?.error ?? '');
  ok('THE POINT: a BACKWARDS scorer is refused by the screen — the answer below the distractor, both scores quoted',
    rev.status === 409 && /没有通过重排自检/.test(revErr) && /答案 -3/.test(revErr) && /干扰项 0/.test(revErr),
    `${rev.status} ${revErr}`);
  ok('…and saves nothing', settingsOf(bindDir).memory?.judgeSource !== 'builtin',
    JSON.stringify(settingsOf(bindDir).memory ?? null));

  writeTinyCrossEncoder(modelDir(bindDir), good);
  const bound = await a.post('/api/manage/memory/layer/judge', { source: 'builtin', model: MODEL });
  const note = String(bound.body?.note ?? '');
  ok('a scorer that puts the screen\'s answer first BINDS, owing a restart',
    bound.status === 200 && bound.body?.restartRequired === true, `${bound.status} ${JSON.stringify(bound.body)}`);
  ok('…the toast says the CHECKING moves here and the tagging goes to the Claude CLI, on the account\'s quota',
    /检索时的核对将由这个模型完成/.test(note) && /Claude CLI\(haiku\)/.test(note) && note.includes(TAGGING_COST), note);
  ok('THE POINT: …and that it is UNMEASURED and not recommended', /还没有实测过/.test(note) && /不推荐/.test(note), note);
  ok('the settings name the source and its one model together',
    settingsOf(bindDir).memory?.judgeSource === 'builtin' && settingsOf(bindDir).memory?.judgeModel === MODEL,
    JSON.stringify(settingsOf(bindDir).memory ?? null));
  ok('the route written is the CLI\'s model on the CLI — claude-cli:haiku, never the model\'s id',
    storedKey(bindDir, 'llm.route.memory') === 'claude-cli:haiku', String(storedKey(bindDir, 'llm.route.memory')));
  judge = layerOf(await a.getJson('/api/manage/memory'), 'judge');
  ok('the cost line of the bound arm says both halves: checking in process with no llama.cpp, tagging on the account',
    judge.source === 'builtin' && /不需要 llama\.cpp/.test(String(judge.cost)) && String(judge.cost).includes(TAGGING_COST),
    JSON.stringify({ source: judge.source, cost: judge.cost }));

  // ---- A2. 资源 -------------------------------------------------------------------------------------------------------
  const inv = await a.getJson('/api/manage/models');
  const row = (inv.models ?? []).find((m) => m.id === MODEL);
  ok('THE POINT: 资源 lists it as a row like any other — in-process, reranking, its pinned size, installed, in use',
    row?.runtime === 'builtin' && row?.capability === 'reranking' && row?.sizeBytes === 135704003
      && row?.installed === true && row?.inUse === 'judge' && row?.resourceId === RESOURCE,
    JSON.stringify(row ?? null));
  ok('…its note says it runs in process on the CPU without llama.cpp, the tagging spends the quota, and it is unmeasured',
    /CPU/.test(String(row?.note)) && /不需要 llama\.cpp/.test(String(row?.note)) && String(row?.note).includes(TAGGING_COST)
      && /还没有在本应用的测试集上实测过/.test(String(row?.note)) && /不推荐/.test(String(row?.note)),
    String(row?.note));
  const res = ((await a.getJson('/api/manage/resources')).resources ?? []).find((r) => r.id === RESOURCE);
  ok('…and its resource exists, sized, as a model', res?.approxBytes === 135704003 && res?.category === 'model',
    JSON.stringify(res ?? null));
  ok('THE POINT: nothing recommends it — the badge names a MEASURED reranker, whose suggestion an installed 内置 does not end',
    inv.recommendation?.id === 'bge-reranker-v2-m3-Q5_K_M', JSON.stringify(inv.recommendation ?? null));
  const refuse = await a.post('/api/manage/models/remove', { model: MODEL, runtime: 'builtin' });
  ok('deleting it while 判断 is bound to it is REFUSED, naming the layer',
    refuse.status === 409 && /正在用于记忆判断/.test(String(refuse.body?.error)) && fs.existsSync(modelDir(bindDir)),
    `${refuse.status} ${JSON.stringify(refuse.body)}`);
  const back = await a.post('/api/manage/memory/layer/judge', { source: 'claude-cli', model: 'haiku' });
  const removed = await a.post('/api/manage/models/remove', { model: MODEL, runtime: 'builtin' });
  ok('(control) bound elsewhere, it deletes — its directory gone, the row back to downloadable',
    back.status === 200 && removed.status === 200 && !fs.existsSync(modelDir(bindDir))
      && (await a.getJson('/api/manage/models')).models.find((m) => m.id === MODEL)?.installed === false,
    `${back.status} ${removed.status} ${JSON.stringify(removed.body)}`);

  // ---- B. AT WORK -----------------------------------------------------------------------------------------------------
  const workDir = dataDirFor('p56-work');
  makeTestData(workDir);
  writeTinyCrossEncoder(modelDir(workDir), good);
  fs.writeFileSync(path.join(workDir, 'state', 'settings.json'), JSON.stringify({
    memory: { judgeSource: 'builtin', judgeModel: MODEL },
  }, null, 2), 'utf8');
  const argsLog = path.join(workDir, 'stub-args.jsonl');
  fs.rmSync(argsLog, { force: true });
  const workServer = startServer({
    dataDir: workDir, port: PORT_WORK, env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl, GATHERLIGHT_STUB_ARGS_LOG: argsLog },
  });
  servers.push(workServer);
  await waitHealthy(workServer.base);
  const w = makeClient(workServer.base);
  const working = layerOf(await w.getJson('/api/manage/memory'), 'judge');
  ok('(fixture) 判断 is RUNNING on 内置, bound to its model',
    working.activeSource === 'builtin' && working.activeModel === MODEL,
    JSON.stringify({ active: working.activeSource, activeModel: working.activeModel }));

  // Ten fillers name every word of the query; the target names one, holds the scorer's reward, and is written FIRST (the
  // engine weighs recency: written last, it ranked 6th). So the engine ranks the target below the fillers — past a page
  // of 8 among 11 — and only an in-process verdict can bring it onto the page. The judge-off recall below checks exactly
  // that, so a fixture the engine ranks differently fails there rather than passing for the wrong reason.
  const fillers = [...'abcdefghij'].map((id) => ({
    topic: `zzbuiltopic${id} 泳道`, content: `zzbuiltshared 泳道开放时间与更衣室须知,第${id}号泳道。`,
  }));
  const target = { topic: 'zzbuilttarget 票价', content: `zzbuiltshared 儿童票的说明:${MARKER}。` };
  for (const f of [target, ...fillers]) {
    const r = await w.call('remember_fact', { kind: 'household', ...f, source: 'https://example.test/p56', confidence: 0.8 });
    if (!(r.status === 200 && r.result?.ok === true)) fail(`(fixture) fact not stored: ${JSON.stringify(r.result)}`);
  }
  const calls = () => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8') : '')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const modelArg = (c) => { const i = c.args.indexOf('--model'); return i >= 0 ? c.args[i + 1] : null; };
  await until(() => calls().some((c) => c.kind === 'annotation' && c.tail.includes('zzbuilttarget')), 60000).catch(() => {});
  const tagged = calls().filter((c) => c.kind === 'annotation');
  ok('THE POINT: a fact write is TAGGED by the Claude CLI, on the CLI\'s model',
    tagged.length > 0 && tagged.every((c) => modelArg(c) === 'haiku'), JSON.stringify(tagged.map(modelArg)));

  const query = 'zzbuiltshared 泳道开放时间';
  const onPage = (r) => (r.result?.facts ?? []).some((f) => String(f.content ?? '').includes(MARKER));
  const off = await w.post('/api/manage/memory/enrichment', { enabled: false });
  const unjudged = await w.call('recall_facts', { query, limit: 8 });
  ok('(control) with 判断 switched off the target is OFF the page — the engine alone ranks it below the fillers',
    off.status === 200 && unjudged.status === 200 && !onPage(unjudged) && (unjudged.result?.facts ?? []).length === 8,
    JSON.stringify((unjudged.result?.facts ?? []).map((f) => f.topic)));
  const hitsBefore = routerHits.length;
  await w.post('/api/manage/memory/enrichment', { enabled: true });
  const judged = await w.call('recall_facts', { query, limit: 8 });
  ok('THE POINT: switched on, the recall is JUDGED and the scorer\'s choice is on the page — verified in process',
    judged.status === 200 && judged.result?.answered === true && judged.result?.ranked === 'graph' && onPage(judged),
    JSON.stringify({ answered: judged.result?.answered, ranked: judged.result?.ranked,
      topics: (judged.result?.facts ?? []).map((f) => f.topic) }));
  ok('…and NOTHING reached the llama.cpp router — not a rerank call, not a probe',
    routerHits.length === hitsBefore && !routerHits.some((h) => /\/v1\/rerank/.test(h)), JSON.stringify(routerHits));
  ok('…nor was the CLI asked for a verification — only the tagging is the CLI\'s',
    !calls().some((c) => c.kind === 'verification'), JSON.stringify(calls().map((c) => c.kind)));
  const log = logText(workDir);
  ok('the log says the model LOADED in process, with its own window',
    /builtin-rerank: loaded the in-process reranker in \d+ ms from .* \(its window 512 tokens\)/.test(log),
    log.split('\n').filter((l) => /builtin-rerank/.test(l)).join(' | ') || '(no builtin-rerank line)');
  ok('…and where the pace STARTED: this machine\'s CPU measured in process at first use, never below the GPU figure',
    /builtin-rerank: the rerank pace starts from [\d.]+ ms per 1,000 pair tokens — this machine's CPU, measured in process at the pace's first use \(8 full windows, \d+ pair tokens in \d+ ms: [\d.]+\), never below the GPU figure [\d.]+/.test(log),
    log.split('\n').filter((l) => /rerank pace starts/.test(l)).join(' | ') || '(no pace line)');

  // ---- C. FALLBACK ----------------------------------------------------------------------------------------------------
  const goneDir = dataDirFor('p56-gone');
  makeTestData(goneDir);
  fs.writeFileSync(path.join(goneDir, 'state', 'settings.json'), JSON.stringify({
    memory: { judgeSource: 'builtin', judgeModel: MODEL },
  }, null, 2), 'utf8');
  const goneServer = startServer({ dataDir: goneDir, port: PORT_GONE, env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl } });
  servers.push(goneServer);
  await waitHealthy(goneServer.base);
  const g = makeClient(goneServer.base);
  const gone = layerOf(await g.getJson('/api/manage/memory'), 'judge');
  ok('THE POINT: bound to 内置 with its files absent, 判断 comes up on the Claude CLI',
    gone.activeSource === 'claude-cli' && gone.activeModel === 'haiku',
    JSON.stringify({ active: gone.activeSource, activeModel: gone.activeModel }));
  const warnings = async (base) => ((await (await fetch(`${base}/api/migration/status`)).json()).warnings ?? []).map(String);
  const goneWarn = (await warnings(goneServer.base)).find((x) => /内置重排模型/.test(x)) ?? '';
  ok('THE POINT: …and the startup SAYS so — which model is not there, where to get it, that 判断 is on the CLI now',
    /「判断」绑定的本机模型用不了/.test(goneWarn) && /内置重排模型 mMiniLMv2 的文件不在/.test(goneWarn)
      && /资源 · Resources/.test(goneWarn) && /这次启动「判断」退回 Claude CLI/.test(goneWarn),
    goneWarn || JSON.stringify(await warnings(goneServer.base)));
  ok('…that only the CHECKING moved — its tagging was on the CLI all along — and what brings it back',
    /写入时的主题标注本来就由它完成/.test(goneWarn) && /现在检索时的核对也改由它完成/.test(goneWarn)
      && /重启服务才会用回它/.test(goneWarn),
    goneWarn);
  ok('(control) the at-work server, whose files are there, carries no such warning',
    !(await warnings(workServer.base)).some((x) => /绑定的本机模型用不了/.test(x)),
    JSON.stringify(await warnings(workServer.base)));
} catch (e) {
  fail(`fatal: ${e?.stack ?? e}`);
  for (const s of servers) console.log(s.log().split('\n').filter((l) => /ERROR|fail|Exception/i.test(l)).slice(-10).join('\n'));
} finally {
  for (const s of servers) s.stop();
  fake.close();
}
done();
