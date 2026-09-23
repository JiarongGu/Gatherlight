#!/usr/bin/env node
// e2e P52 — the LOCAL recall backends are reached by ROUTING, not merely registered.
//
// Both memory policies are fail-open, so every way of mis-wiring them has the same symptom: zero model
// calls and no error. That is why this suite counts requests arriving at a fake llama-server instead of
// reading anything the app reports about itself. Three things have to hold, each of which a Lyntai upgrade
// (3.0.2 → 3.2) touched:
//   1. 判断 bound to llama.cpp reaches it through its NAMED client alone. Until Lyntai 3.1 a named client
//      narrowed only the provider pool, so the app widened the GLOBAL candidate list to include the local
//      provider (Lyntai Part 93). That workaround is deleted; this is what proves the library now narrows
//      the candidates too, rather than the judge silently making no calls.
//   2. 语义 bound to llama.cpp EMBEDS each fact write — the embedder is a Lyntai provider since 3.2, and an
//      undeclared or mis-kinded one would be skipped by the router without a word.
//   3. A RECALL embeds the QUERY. Only the semantic seed channel does that, and since 3.2 it is a registered
//      seed source rather than a graph option — so a missing registration leaves every vector bought on
//      write and read by no recall, which no API response shows.
//   4. When 判断 FALLS BACK to the CLI (its runtime gone), the CLI is asked for the CLI's model — not for
//      the GGUF named by the saved judgeModel or by the live llm.model.memory the binding wrote. Read from
//      the stub's own argv log, because a CLI asked for an unknown model is otherwise indistinguishable
//      from one that answered badly.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, until,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p52');
const { ok, fail, done } = makeReporter('p52');
makeTestData(dataDir);

const PORT = 5412;
// Case 4 restarts onto the data folder; a second port, because reusing one inside a suite is its own trap.
const RESTART_PORT = 5413;
// Where the claude stub records each call's argv (case 4) — in this suite's own data folder.
const argsLog = path.join(dataDir, 'stub-args.jsonl');
const JUDGE_MODEL = 'zzroute-chat';
// "embed" in the name is what classifies a household-supplied GGUF as an embedder
// (ResourceProvisioner.IsEmbeddingGguf) — the same rule the real router's presets follow.
const EMBED_MODEL = 'zzroute-embed';

// Planted, not downloaded: IsConfigured asks only that the runtime and a model of the right KIND are on
// disk. Nothing ever executes these — the fake below is already serving on the runtime's address, and
// EnsureServingAsync adopts a port that answers before it looks for a binary (pinned in p51).
const resources = path.join(dataDir, 'state', 'resources');
fs.mkdirSync(path.join(resources, 'llama-cpp'), { recursive: true });
fs.mkdirSync(path.join(resources, 'gguf'), { recursive: true });
fs.writeFileSync(path.join(resources, 'llama-cpp', 'llama-server.exe'), '');
fs.writeFileSync(path.join(resources, 'gguf', `${JUDGE_MODEL}.gguf`), '');
fs.writeFileSync(path.join(resources, 'gguf', `${EMBED_MODEL}.gguf`), '');
fs.writeFileSync(path.join(dataDir, 'state', 'settings.json'), JSON.stringify({
  memory: {
    judgeSource: 'llama-cpp', judgeModel: JUDGE_MODEL,
    semanticSource: 'llama-cpp', embeddingModel: EMBED_MODEL,
  },
}, null, 2), 'utf8');

// A deterministic, non-degenerate vector per text, so novelty and cosine have something real to compute.
const vectorFor = (text) => {
  const v = new Array(8).fill(0);
  for (let i = 0; i < text.length; i++) v[i % 8] += text.charCodeAt(i) % 17;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

const hits = [];
const fake = http.createServer((req, res) => {
  const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url === '/v1/models') {
    send({ object: 'list', data: [{ id: JUDGE_MODEL }, { id: EMBED_MODEL }] });
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let json = {};
    try { json = JSON.parse(body); } catch { /* recorded raw regardless */ }
    hits.push({ path: req.url, model: json.model, body });
    if (req.url === '/v1/embeddings') {
      const inputs = Array.isArray(json.input) ? json.input : [String(json.input ?? '')];
      send({
        object: 'list', model: json.model,
        data: inputs.map((t, index) => ({ object: 'embedding', index, embedding: vectorFor(String(t)) })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
      return;
    }
    // Chat: an answer no policy can parse. Both are fail-open, so this proves the call was MADE without
    // depending on what the judge concluded.
    send({
      id: 'p52', object: 'chat.completion', model: json.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'noted' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${fake.address().port}`;

const layerOf = (snapshot, id) => (snapshot?.layers ?? []).find((l) => l.id === id) ?? {};

let server = null;
try {
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl } });
  const base = `http://127.0.0.1:${PORT}`;
  await waitHealthy(base);
  const c = makeClient(base);

  // NON-VACUITY: the fixture really bound both layers to llama.cpp. If either fell back (to the CLI, or
  // to off), every routing check below would fail for a reason that has nothing to do with routing.
  const mem = await c.getJson('/api/manage/memory');
  const layer = (id) => layerOf(mem, id);
  ok('(fixture) 判断 is running on llama.cpp', layer('judge').activeSource === 'llama-cpp',
    JSON.stringify({ source: layer('judge').source, active: layer('judge').activeSource }));
  ok('(fixture) 语义 is running on llama.cpp', layer('semantic').activeSource === 'llama-cpp',
    JSON.stringify({ source: layer('semantic').source, active: layer('semantic').activeSource }));

  // Warm calls from boot are not what this suite is about; count only what the fact write causes.
  const before = hits.length;
  const wrote = await c.call('remember_fact', {
    kind: 'household', topic: 'zzroute morning routine',
    content: 'The zzroutefact morning walk leaves at seven and loops past the bakery.',
    source: 'https://example.test/zzroute', confidence: 0.8,
  });
  ok('remember_fact stores the fact', wrote.status === 200 && wrote.result?.ok === true, JSON.stringify(wrote.result));

  // --- 1. the judge ROUTES to llama.cpp -----------------------------------------------------------
  await until(() => hits.slice(before).some((h) => h.path === '/v1/chat/completions'
    && h.body.includes('zzroutefact')), 60000).catch(() => {});
  const judged = hits.slice(before).filter((h) => h.path === '/v1/chat/completions' && h.body.includes('zzroutefact'));
  ok('THE POINT: the write\'s annotation reached llama.cpp through the judge\'s named client',
    judged.length > 0, JSON.stringify(hits.slice(before).map((h) => `${h.path} ${h.model}`)));
  ok('…asking for the judge\'s model, not a default a candidate list carried',
    judged.every((h) => h.model === JUDGE_MODEL), JSON.stringify(judged.map((h) => h.model)));

  // --- 2. the fact is EMBEDDED ---------------------------------------------------------------------
  const embedded = hits.slice(before).filter((h) => h.path === '/v1/embeddings' && h.body.includes('zzroutefact'));
  ok('the fact write was embedded by the llama.cpp embedder', embedded.length > 0,
    JSON.stringify(hits.slice(before).map((h) => `${h.path} ${h.model}`)));
  ok('…with the embedding model', embedded.every((h) => h.model === EMBED_MODEL),
    JSON.stringify(embedded.map((h) => h.model)));
  ok('an embedder is never sent a chat completion (llama-server restricts an embeddings child to one API)',
    !hits.some((h) => h.path === '/v1/chat/completions' && h.model === EMBED_MODEL),
    JSON.stringify(hits.filter((h) => h.model === EMBED_MODEL).map((h) => h.path)));

  // --- 3. a recall embeds the QUERY ----------------------------------------------------------------
  // A query no fact contains, so a request carrying it can only be the recall embedding its own question.
  const beforeRecall = hits.length;
  const recalled = await c.call('recall_facts', { query: 'zzqueryprobe when does the walk start', limit: 5 });
  ok('recall_facts answers', recalled.status === 200, JSON.stringify(recalled.result).slice(0, 200));
  const queryEmbeds = hits.slice(beforeRecall)
    .filter((h) => h.path === '/v1/embeddings' && h.body.includes('zzqueryprobe'));
  ok('THE POINT: a recall embeds its query — the semantic seed channel is registered and reads the vectors',
    queryEmbeds.length > 0, JSON.stringify(hits.slice(beforeRecall).map((h) => `${h.path} ${h.model}`)));

  // --- 4. a FALLBACK to the CLI asks the CLI for the CLI's model -----------------------------------
  // The household story: a chat GGUF is bound, then the runtime goes (deleted, a failed update). 判断
  // resolves to the CLI — and two things written for the GGUF were still being read: settings' judgeModel
  // (the badge said "claude-cli · <gguf>", and it became DefaultModelByConsumer), and the live
  // llm.model.memory the binding wrote, which outranks that default. Either one hands the GGUF's id to
  // Claude; both policies are fail-open, so the symptom is zero enrichment and no error.
  //
  // BINDING through the endpoint, rather than planting settings, is what writes the live key.
  const bound = await c.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: JUDGE_MODEL });
  ok('(fixture) binding the chat GGUF succeeds, which writes llm.model.memory = that GGUF',
    bound.status === 200, `${bound.status} ${JSON.stringify(bound.body)}`);

  server.stop();
  server = null;
  // The replacement reads the same data folder; let the old process finish its last write.
  await new Promise((r) => setTimeout(r, 1200));
  fs.rmSync(path.join(resources, 'llama-cpp', 'llama-server.exe'), { force: true });
  fs.rmSync(argsLog, { force: true });

  // Its OWN port: restarting on the same one inside a suite is its own trap (a request can land on the
  // process on its way out). Still pointed at the fake, so a stray call to llama.cpp would be SEEN.
  server = startServer({
    dataDir, port: RESTART_PORT,
    env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl, GATHERLIGHT_STUB_ARGS_LOG: argsLog },
  });
  const base2 = `http://127.0.0.1:${RESTART_PORT}`;
  await waitHealthy(base2);
  const c2 = makeClient(base2);

  const fell = layerOf(await c2.getJson('/api/manage/memory'), 'judge');
  ok('(fixture) with the runtime gone, 判断 falls back to the CLI',
    fell.activeSource === 'claude-cli', JSON.stringify({ source: fell.source, active: fell.activeSource }));
  ok('THE POINT: the badge does not name the GGUF under the CLI — saved or running',
    fell.source === 'claude-cli' && fell.model === 'haiku' && fell.activeModel === 'haiku',
    JSON.stringify({ source: fell.source, model: fell.model, active: fell.activeSource, activeModel: fell.activeModel }));

  const beforeFallback = hits.length;
  const wrote2 = await c2.call('remember_fact', {
    kind: 'household', topic: 'zzfallbackfact evening routine',
    content: 'The zzfallbackfact evening walk leaves at six and loops past the library.',
    source: 'https://example.test/zzfallback', confidence: 0.8,
  });
  ok('remember_fact stores the fact after the fallback', wrote2.status === 200 && wrote2.result?.ok === true,
    JSON.stringify(wrote2.result));

  const cliCalls = () => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8') : '')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const modelOf = (call) => { const i = call.args.indexOf('--model'); return i >= 0 ? call.args[i + 1] : null; };
  await until(() => cliCalls().some((x) => x.kind === 'annotation' && x.tail.includes('zzfallbackfact')), 60000)
    .catch(() => {});
  const annotated = cliCalls().filter((x) => x.kind === 'annotation' && x.tail.includes('zzfallbackfact'));
  ok('(non-vacuity) the write\'s annotation reached the CLI', annotated.length > 0,
    JSON.stringify(cliCalls().map((x) => `${x.kind} ${modelOf(x)}`)));
  ok('THE POINT: the CLI is asked for the CLI\'s model — never the GGUF it fell back from',
    annotated.length > 0 && annotated.every((x) => modelOf(x) === 'haiku'),
    JSON.stringify(annotated.map(modelOf)));

  const recalled2 = await c2.call('recall_facts', { query: 'zzfallbackfact evening walk', limit: 5 });
  ok('recall_facts answers after the fallback', recalled2.status === 200, JSON.stringify(recalled2.result).slice(0, 200));
  await until(() => cliCalls().some((x) => x.kind === 'verification' && x.tail.includes('zzfallbackfact')), 60000)
    .catch(() => {});
  const verified = cliCalls().filter((x) => x.kind === 'verification' && x.tail.includes('zzfallbackfact'));
  ok('…and so is the recall\'s verification', verified.length > 0 && verified.every((x) => modelOf(x) === 'haiku'),
    JSON.stringify(verified.map(modelOf)));
  ok('nothing was sent to llama.cpp after the fallback',
    !hits.slice(beforeFallback).some((h) => h.path === '/v1/chat/completions'),
    JSON.stringify(hits.slice(beforeFallback).map((h) => `${h.path} ${h.model}`)));
} catch (err) {
  fail('e2e-p52 fatal: ' + (err?.stack || err?.message || String(err)));
} finally {
  try { server?.stop(); } catch {}
  await new Promise((r) => fake.close(r));
}

done();
