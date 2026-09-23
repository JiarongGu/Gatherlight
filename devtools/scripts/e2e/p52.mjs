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

let server = null;
try {
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl } });
  const base = `http://127.0.0.1:${PORT}`;
  await waitHealthy(base);
  const c = makeClient(base);

  // NON-VACUITY: the fixture really bound both layers to llama.cpp. If either fell back (to the CLI, or
  // to off), every routing check below would fail for a reason that has nothing to do with routing.
  const mem = await c.getJson('/api/manage/memory');
  const layer = (id) => (mem.layers ?? []).find((l) => l.id === id) ?? {};
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
} catch (err) {
  fail('e2e-p52 fatal: ' + (err?.stack || err?.message || String(err)));
} finally {
  try { server?.stop(); } catch {}
  await new Promise((r) => fake.close(r));
}

done();
