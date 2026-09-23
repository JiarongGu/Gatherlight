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
//      4b: the positive control — a key written for the RUNNING client (the CLI rebound to sonnet) is read.
//   5. A RERANKER binding says what it moves — the checking; tagging goes to the CLI and spends the account —
//      in its toast, in the cost line beside it and in the catalogued rerankers' notes, where the toast used
//      to claim both halves for every binding and none of the three said the tagging uses quota; and it writes
//      the CLI's model to llm.model.memory, never the reranker's id. The bind-time screen really runs against
//      the runtime and refuses a reranker that ranks by word OVERLAP or simply BACKWARDS; one it refuses for
//      a reason other than its ordering is told apart, quoting the server.
//   6. A reranker AT WORK, on a server that booted bound to one: a fact write makes no chat call to
//      llama.cpp and is tagged by the CLI on the CLI's model, and a recall sends the query AND each
//      candidate's CONTENT to /v1/rerank.
//   7. Whether a reranker's TAGGING is happening — it goes to the CLI, and a signed-out CLI means none — is
//      said in the 判断 row, the bind toast and the startup warning, each paired with a signed-in control.
//   8. A model downloaded AFTER the router started is unknown to it (the real router reads its models
//      directory once). A router the app did not start is not restarted for it, and the refusal says what
//      would load the model rather than quoting a 400.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
// (ResourceProvisioner.GgufKind) — the same rule the real router's presets follow.
const EMBED_MODEL = 'zzroute-embed';
// "rerank" in the name is what classifies a household-supplied GGUF as a reranker (the same rule, checked
// before "embed").
const RERANK_MODEL = 'zzroute-rerank';
// Scores by OVERLAP with the query — what a lexical scorer, or a cross-encoder a bad conversion reduced to
// mean-pooled cosine, amounts to. The screen exists to refuse exactly this.
const LEXICAL_RERANK = 'zzlexical-rerank';
// Ranks the answer LAST — the answer-aware score negated. What Lyntai actually found in the wild: a
// converted GGUF that loads, scores, and ranks backwards.
const BACKWARDS_RERANK = 'zzbackwards-rerank';
// Two that fail the screen for reasons that are NOT the ordering, so their sentences must say so.
const BROKEN_RERANK = 'zzbroken-rerank';
const SHORT_RERANK = 'zzshort-rerank';
// Case 8: downloaded after the router started, so the router does not list it.
const LATE_RERANK = 'zzlate-rerank';
// Case 7: two servers bound at boot to a reranker the router does NOT list — so the startup warm fails and the
// warning has to say what happens to tagging — one with a signed-OUT CLI, one signed in as the control.
const TAGGING_RERANK = 'zztagging-rerank';
const SIGNED_OUT_PORT = 5415;
const SIGNED_IN_PORT = 5416;

// Case 6: a SECOND server that boots already bound to the reranker, in a data folder of its own. Its own
// port too — never 5412/5413, which cases 1–5 used.
const RERANK_PORT = 5414;
const rerankDir = dataDirFor('p52-rerank');
const rerankArgsLog = path.join(rerankDir, 'stub-args.jsonl');

// Planted, not downloaded: IsConfigured asks only that the runtime and a model of the right KIND are on
// disk. Nothing ever executes these — the fake below is already serving on the runtime's address, and
// EnsureServingAsync adopts a port that answers before it looks for a binary (pinned in p51).
const resources = path.join(dataDir, 'state', 'resources');
fs.mkdirSync(path.join(resources, 'llama-cpp'), { recursive: true });
fs.mkdirSync(path.join(resources, 'gguf'), { recursive: true });
fs.writeFileSync(path.join(resources, 'llama-cpp', 'llama-server.exe'), '');
fs.writeFileSync(path.join(resources, 'gguf', `${JUDGE_MODEL}.gguf`), '');
fs.writeFileSync(path.join(resources, 'gguf', `${EMBED_MODEL}.gguf`), '');
for (const m of [RERANK_MODEL, LEXICAL_RERANK, BACKWARDS_RERANK, BROKEN_RERANK, SHORT_RERANK])
  fs.writeFileSync(path.join(resources, 'gguf', `${m}.gguf`), '');

makeTestData(rerankDir);
const rerankResources = path.join(rerankDir, 'state', 'resources');
fs.mkdirSync(path.join(rerankResources, 'llama-cpp'), { recursive: true });
fs.mkdirSync(path.join(rerankResources, 'gguf'), { recursive: true });
fs.writeFileSync(path.join(rerankResources, 'llama-cpp', 'llama-server.exe'), '');
fs.writeFileSync(path.join(rerankResources, 'gguf', `${RERANK_MODEL}.gguf`), '');
fs.writeFileSync(path.join(rerankDir, 'state', 'settings.json'), JSON.stringify({
  memory: { judgeSource: 'llama-cpp', judgeModel: RERANK_MODEL },
}, null, 2), 'utf8');
fs.rmSync(rerankArgsLog, { force: true });

const plantTaggingFixture = (suffix) => {
  const dir = dataDirFor(`p52-${suffix}`);
  makeTestData(dir);
  const res = path.join(dir, 'state', 'resources');
  fs.mkdirSync(path.join(res, 'llama-cpp'), { recursive: true });
  fs.mkdirSync(path.join(res, 'gguf'), { recursive: true });
  fs.writeFileSync(path.join(res, 'llama-cpp', 'llama-server.exe'), '');
  for (const m of [TAGGING_RERANK, RERANK_MODEL]) fs.writeFileSync(path.join(res, 'gguf', `${m}.gguf`), '');
  fs.writeFileSync(path.join(dir, 'state', 'settings.json'), JSON.stringify({
    memory: { judgeSource: 'llama-cpp', judgeModel: TAGGING_RERANK },
  }, null, 2), 'utf8');
  return dir;
};
const signedOutDir = plantTaggingFixture('signedout');
const signedInDir = plantTaggingFixture('signedin');
// A CLI that is installed and SIGNED OUT: `auth status` answers loggedIn:false (exit 1), the shape p50 uses.
const signedOutStub = path.join(signedOutDir, 'signed-out-claude.mjs');
fs.writeFileSync(signedOutStub, `const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }));
  process.exit(1);
}
process.exit(1);
`);
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
// What the fake router LISTS — like the real one, fixed at its start: llama-server reads --models-dir once,
// so a GGUF dropped in later is unknown to it until a restart (measured, docs/self-managed-llm-runtime.md).
// Case 8 plants a model outside this set to be exactly that; adding it later stands in for the restart.
const served = new Set([JUDGE_MODEL, EMBED_MODEL, RERANK_MODEL, LEXICAL_RERANK, BACKWARDS_RERANK, BROKEN_RERANK, SHORT_RERANK]);
const fake = http.createServer((req, res) => {
  const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url === '/v1/models') {
    send({ object: 'list', data: [...served].map((id) => ({ id })) });
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
    if (req.url === '/v1/rerank') {
      // ANSWER-AWARE, deliberately not lexical: a document that states the price or time the question asks
      // for outranks one that only shares its words. The bind-time screen exists to refuse a model that
      // ranks by overlap, so a fake that did would be refused too — and should be. Negative logits for the
      // non-answer, because a real cross-encoder's are, and the screen must not treat an unset zero as one.
      const docs = Array.isArray(json.documents) ? json.documents.map(String) : [];
      const answers = (d) => /[0-9]|[一二两三四五六七八九十百千]+\s*(元|块|点|分钟)/.test(d);
      // The share of the query's distinct letters a document contains — overlap and nothing else.
      const queryChars = [...new Set([...String(json.query ?? '')].filter((ch) => /\p{L}/u.test(ch)))];
      const overlap = (d) => queryChars.filter((ch) => d.includes(ch)).length / (queryChars.length || 1);
      const answerAware = (d) => (answers(d) ? 3.2 : -2.1);
      const score = json.model === LEXICAL_RERANK ? overlap
        : json.model === BACKWARDS_RERANK ? (d) => -answerAware(d)
        : answerAware;
      const results = docs.map((d, index) => ({ index, relevance_score: score(d) }))
        .sort((a, b) => b.relevance_score - a.relevance_score);
      if (json.model === BROKEN_RERANK) {
        // llama-server's own refusal shape, so the screen has something of the server's to quote.
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 400, message: 'zzllamasaid the model failed to load', type: 'invalid_request_error' } }));
        return;
      }
      // One result for two documents: the ANSWER alone, ranked first. Unusable — not a failed ordering.
      if (json.model === SHORT_RERANK) { send({ model: json.model, results: results.slice(0, 1) }); return; }
      send({ model: json.model, results });
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
let rerankServer = null;
let signedOutServer = null;
let signedInServer = null;
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

  // --- 4b. …and the key PASSES THROUGH when it was written for the client that is running ---------------
  // Every check above has the store withhold llm.model.memory, and every annotation lands on the default
  // haiku — which a store that ALWAYS withheld the key would pass too. So: on this server, whose judge runs on
  // the CLI, bind the CLI judge to sonnet. Same client, so the key must be read, and the very next annotation
  // — before any restart — asks for sonnet.
  const toSonnet = await c2.post('/api/manage/memory/layer/judge', { source: 'claude-cli', model: 'sonnet' });
  ok('(fixture) the CLI judge binds to sonnet', toSonnet.status === 200, `${toSonnet.status} ${JSON.stringify(toSonnet.body)}`);
  const wrotePass = await c2.call('remember_fact', {
    kind: 'household', topic: 'zzpassfact garden routine',
    content: 'The zzpassfact garden is watered every Sunday morning before the market.',
    source: 'https://example.test/zzpass', confidence: 0.8,
  });
  ok('remember_fact stores the fact after the rebind', wrotePass.status === 200 && wrotePass.result?.ok === true,
    JSON.stringify(wrotePass.result));
  await until(() => cliCalls().some((x) => x.kind === 'annotation' && x.tail.includes('zzpassfact')), 60000)
    .catch(() => {});
  const passed = cliCalls().filter((x) => x.kind === 'annotation' && x.tail.includes('zzpassfact'));
  ok('THE POINT: a key written for the running client is read — the annotation asks for sonnet, not the default',
    passed.length > 0 && passed.every((x) => modelOf(x) === 'sonnet'), JSON.stringify(passed.map(modelOf)));

  // --- 5. a RERANKER binding says what it moves: the checking, not the tagging ----------------------
  // The bind toast said 「标注与核对将由这个后端完成」 for every binding. For a reranker that is false — it
  // scores and never generates, so the tagging goes to the Claude CLI (for this household, coming from a local
  // chat judge, for the first time — which is why nothing below may say 仍) — and it contradicted the cost
  // line on the same panel. The runtime comes back first: binding asks the source whether it is configured.
  fs.writeFileSync(path.join(resources, 'llama-cpp', 'llama-server.exe'), '');
  const beforeBind = hits.length;
  const rr = await c2.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: RERANK_MODEL });
  ok('(fixture) a reranker that ranks the answer first is allowed to bind',
    rr.status === 200, `${rr.status} ${JSON.stringify(rr.body)}`);
  ok('…because the screen really ran against the runtime',
    hits.slice(beforeBind).some((h) => h.path === '/v1/rerank' && h.model === RERANK_MODEL),
    JSON.stringify(hits.slice(beforeBind).map((h) => `${h.path} ${h.model}`)));
  // THE TRAP: the binding writes the ANNOTATION model to llm.model.memory, and for a reranker that is the
  // CLI's. Writing the reranker's id there would send it to Claude on every fact write — fail-open, so no
  // error, just no tagging. Read from the database itself: no API response carries this key.
  const liveKey = (() => {
    const db = new DatabaseSync(path.join(dataDir, 'state', 'gatherlight.db'));
    try { return db.prepare('SELECT value FROM app_config WHERE key = ?').get('llm.model.memory')?.value ?? null; }
    finally { db.close(); }
  })();
  ok('THE TRAP: llm.model.memory holds the CLI\'s model, never the reranker\'s id',
    liveKey === 'haiku', `llm.model.memory=${JSON.stringify(liveKey)}`);
  const rrNote = String(rr.body?.note ?? '');
  ok('THE POINT: its toast says the tagging goes to the Claude CLI, on the CLI\'s model',
    /核对/.test(rrNote) && /Claude CLI/.test(rrNote) && /haiku/.test(rrNote) && !/标注与核对/.test(rrNote), rrNote);
  // Not "STILL on the CLI": this household came from a local CHAT judge, so its facts start leaving the
  // machine with this binding — and the toast is where it finds out.
  ok('…and says the facts\' content is sent to Claude, without calling that "still"',
    /发给 Claude/.test(rrNote) && !/仍/.test(rrNote), rrNote);
  // THE QUOTA HALF. The toast, the cost line and the model notes each said the checking is 不消耗账号额度, and
  // none said the TAGGING spends the account — so the only quota statement a household read about this
  // binding was the reassuring one. Pinned as the EXACT clause (MemorySources.CliTaggingCost), not a pattern:
  // the cost line's checking half says 不消耗账号额度, so a bare /账号额度/ passes on that alone, and even a
  // /(?<!不)消耗/ lookbehind would pass a future 不会消耗 / 无需消耗 / 不必消耗. The whole sentence it has to say
  // is short enough to say here.
  const TAGGING_COST = '每条事实一次调用,消耗账号额度,事实内容会发给 Claude';
  const spendsQuota = (text) => String(text ?? '').includes(TAGGING_COST);
  ok('THE POINT: the toast says the tagging spends the account\'s quota', spendsQuota(rrNote), rrNote);
  ok('(control) the chat GGUF\'s toast, in case 4, still names both halves',
    /标注与核对/.test(String(bound.body?.note ?? '')), JSON.stringify(bound.body?.note));
  const rrLayer = layerOf(await c2.getJson('/api/manage/memory'), 'judge');
  ok('…and the cost line beside it says the same thing',
    rrLayer.model === RERANK_MODEL && /重排/.test(String(rrLayer.cost)) && /Claude CLI/.test(String(rrLayer.cost)),
    JSON.stringify({ model: rrLayer.model, cost: rrLayer.cost }));
  ok('…including that each fact\'s content is sent to Claude for tagging',
    /发给 Claude/.test(String(rrLayer.cost)), JSON.stringify(rrLayer.cost));
  // The FOURTH surface: the 本机模型 group's own sentence, rendered under every model choice in it. It said
  // 「不消耗账号额度」 for the whole group — on 判断 that includes the reranker, whose tagging spends quota.
  const groupOf = (layer, id) => (layer.groups ?? []).find((g) => g.id === id) ?? {};
  const judgeManaged = String(groupOf(rrLayer, 'managed').description ?? '');
  ok('…and so does the 本机模型 group sentence on 判断: a reranker\'s tagging goes to Claude',
    /重排/.test(judgeManaged) && /发给 Claude/.test(judgeManaged), judgeManaged);
  // Control: on 语义 no member sends anything anywhere, so the group's no-quota claim stays — and stays true.
  const semManaged = String(groupOf(layerOf(await c2.getJson('/api/manage/memory'), 'semantic'), 'managed').description ?? '');
  ok('(control) on 语义 the same group still says it spends no quota — true of every member there',
    /不消耗账号额度/.test(semManaged) && !/发给 Claude/.test(semManaged), semManaged);
  ok('…and that the tagging spends the account\'s quota, beside a checking half that does not',
    spendsQuota(rrLayer.cost) && /不消耗账号额度/.test(String(rrLayer.cost)),
    JSON.stringify(rrLayer.cost));
  // The third surface is the note a household reads while CHOOSING — in the picker and in 本机模型. The planted
  // rerankers are uncatalogued and so carry no note; the pinned rows come from the inventory, which lists every
  // catalogued GGUF whether or not it is on disk.
  const inventory = await c2.getJson('/api/manage/models');
  const rerankNotes = (inventory.models ?? []).filter((m) => m.capability === 'reranking' && m.note);
  ok('…and every catalogued reranker\'s note says the same: content to Claude, on the account\'s quota',
    rerankNotes.length >= 2
      && rerankNotes.every((m) => spendsQuota(m.note)),
    JSON.stringify(rerankNotes.map((m) => [m.id, String(m.note).slice(0, 90)])));

  // THE SCREEN'S OWN POINT: a model that ranks by OVERLAP is refused. The screen pair makes the distractor
  // repeat the question's words while the answer states the price, so overlap puts the distractor first.
  // The pair it replaced let overlap rank its ANSWER first — against it this bind SUCCEEDED, which is the
  // regression the assertion exists to catch.
  const lexical = await c2.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: LEXICAL_RERANK });
  const lexicalErr = String(lexical.body?.error ?? '');
  ok('THE POINT: a reranker that ranks by word overlap fails the screen and is refused',
    lexical.status === 409 && /自检/.test(lexicalErr), `${lexical.status} ${lexicalErr || JSON.stringify(lexical.body)}`);
  ok('…and the refusal leaves the working binding in place',
    layerOf(await c2.getJson('/api/manage/memory'), 'judge').model === RERANK_MODEL,
    JSON.stringify(layerOf(await c2.getJson('/api/manage/memory'), 'judge').model));
  // …and so is one that is simply BACKWARDS, which is what Lyntai found in the wild: a converted GGUF that
  // loads and scores, and puts the answer last. The lexical case cannot stand in for this one — a backwards
  // model need not overlap-rank at all.
  const backwards = await c2.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: BACKWARDS_RERANK });
  const backwardsErr = String(backwards.body?.error ?? '');
  ok('THE POINT: a reranker that ranks the answer LAST fails the self-check and is refused',
    backwards.status === 409 && /自检/.test(backwardsErr),
    `${backwards.status} ${backwardsErr || JSON.stringify(backwards.body)}`);

  // A refusal carries what the SERVER said. It used to say 「看「日志」」, which pointed at nothing: the
  // screen logs nothing and llama-server's output is discarded.
  const broken = await c2.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: BROKEN_RERANK });
  const brokenErr = String(broken.body?.error ?? '');
  ok('a reranker the server refuses is refused, quoting the server\'s own message',
    broken.status === 409 && brokenErr.includes('zzllamasaid') && !brokenErr.includes('日志'),
    `${broken.status} ${brokenErr}`);
  // Fewer results than documents is an unusable reply, not a model that ranked the answer last.
  const short = await c2.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: SHORT_RERANK });
  const shortErr = String(short.body?.error ?? '');
  ok('a reply scoring fewer documents than it was sent is UNUSABLE — not a failed self-check',
    short.status === 409 && /无法使用/.test(shortErr) && !/自检/.test(shortErr), `${short.status} ${shortErr}`);

  // --- 6. a reranker AT WORK -------------------------------------------------------------------------
  // Case 5 proves what BINDING a reranker says and writes; this proves what a server built around one
  // DOES. It boots already bound, so the verifier is ScoringVerificationPolicy over the llamacpp-rerank
  // provider and annotation is the default client's — which only routing can show, because both halves are
  // fail-open and a mis-wired one simply makes no call.
  rerankServer = startServer({
    dataDir: rerankDir, port: RERANK_PORT,
    env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl, GATHERLIGHT_STUB_ARGS_LOG: rerankArgsLog },
  });
  const base3 = `http://127.0.0.1:${RERANK_PORT}`;
  await waitHealthy(base3);
  const c3 = makeClient(base3);

  const atWork = layerOf(await c3.getJson('/api/manage/memory'), 'judge');
  ok('(fixture) 判断 is running on llama.cpp, bound to the reranker',
    atWork.activeSource === 'llama-cpp' && atWork.activeModel === RERANK_MODEL,
    JSON.stringify({ active: atWork.activeSource, activeModel: atWork.activeModel }));

  // Distinct tokens: the TOPIC's, the CONTENT's, and the QUERY's, each appearing nowhere else — so a rerank
  // body carrying the content token can only have been sent the fact's content, not its topic or the query.
  const beforeWrite6 = hits.length;
  const wrote6 = await c3.call('remember_fact', {
    kind: 'household', topic: 'zzreranktopic weekly swim',
    content: 'The zzrerankcontent swim lane is booked every Thursday evening at the leisure centre.',
    source: 'https://example.test/zzrerank', confidence: 0.8,
  });
  ok('remember_fact stores the fact on the reranker-bound server',
    wrote6.status === 200 && wrote6.result?.ok === true, JSON.stringify(wrote6.result));

  const calls6 = () => (fs.existsSync(rerankArgsLog) ? fs.readFileSync(rerankArgsLog, 'utf8') : '')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const modelOf6 = (call) => { const i = call.args.indexOf('--model'); return i >= 0 ? call.args[i + 1] : null; };
  await until(() => calls6().some((x) => x.kind === 'annotation' && x.tail.includes('zzrerankcontent')), 60000)
    .catch(() => {});
  const tagged = calls6().filter((x) => x.kind === 'annotation' && x.tail.includes('zzrerankcontent'));
  ok('(non-vacuity) the write was annotated at all', tagged.length > 0,
    JSON.stringify(calls6().map((x) => `${x.kind} ${modelOf6(x)}`)));
  ok('THE POINT: the annotation went to the CLI, on the CLI\'s model',
    tagged.length > 0 && tagged.every((x) => modelOf6(x) === 'haiku'), JSON.stringify(tagged.map(modelOf6)));
  ok('…and the fact write asked llama.cpp for no chat completion — a reranker cannot generate',
    !hits.slice(beforeWrite6).some((h) => h.path === '/v1/chat/completions'),
    JSON.stringify(hits.slice(beforeWrite6).map((h) => `${h.path} ${h.model}`)));

  // The query shares ordinary words with the content, so the graph returns the fact as a candidate, and
  // carries a token of its own; it never names the content's token.
  const beforeRecall6 = hits.length;
  const recalled6 = await c3.call('recall_facts', { query: 'zzrerankquery swim lane Thursday evening', limit: 5 });
  ok('recall_facts answers on the reranker-bound server', recalled6.status === 200,
    JSON.stringify(recalled6.result).slice(0, 200));
  const reranked = () => hits.slice(beforeRecall6).filter((h) => h.path === '/v1/rerank' && h.model === RERANK_MODEL);
  await until(() => reranked().length > 0, 60000).catch(() => {});
  ok('THE POINT: the recall was verified by the reranker — the query and the fact\'s CONTENT went to /v1/rerank',
    reranked().some((h) => h.body.includes('zzrerankquery') && h.body.includes('zzrerankcontent')),
    JSON.stringify(hits.slice(beforeRecall6).map((h) => `${h.path} ${h.model} ${h.body.slice(0, 160)}`)));

  // --- 7. whether a reranker's TAGGING is happening, said where it is decided ---------------------------
  // A reranker hands tagging to the Claude CLI, and a CLI that is signed out means NO tagging — the annotation
  // policy is fail-open, so every fact is written unlabelled and nothing reports it. The 判断 row, the bind
  // toast and the startup warning each used to promise the tagging "carries on". Both servers are bound at
  // boot to a reranker the fake router does not list, so the startup warm fails and its warning is written.
  signedOutServer = startServer({
    dataDir: signedOutDir, port: SIGNED_OUT_PORT,
    env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl, GATHERLIGHT_CLAUDE_CMD: `node ${signedOutStub}` },
  });
  signedInServer = startServer({ dataDir: signedInDir, port: SIGNED_IN_PORT, env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl } });
  const outBase = `http://127.0.0.1:${SIGNED_OUT_PORT}`;
  const inBase = `http://127.0.0.1:${SIGNED_IN_PORT}`;
  await Promise.all([waitHealthy(outBase), waitHealthy(inBase)]);
  const cOut = makeClient(outBase);
  const cIn = makeClient(inBase);
  const warmWarning = async (base) => {
    const snap = await (await fetch(`${base}/api/migration/status`)).json();
    return (snap.warnings ?? []).map(String).find((w) => w.includes(TAGGING_RERANK)) ?? '';
  };

  const outJudge = layerOf(await cOut.getJson('/api/manage/memory'), 'judge');
  const inJudge = layerOf(await cIn.getJson('/api/manage/memory'), 'judge');
  ok('(fixture) both servers run 判断 on the reranker',
    outJudge.activeModel === TAGGING_RERANK && inJudge.activeModel === TAGGING_RERANK,
    JSON.stringify({ out: outJudge.activeModel, in: inJudge.activeModel }));
  ok('THE POINT: with the CLI signed out, the 判断 row says tagging is NOT happening',
    outJudge.tagging?.works === false && /登录/.test(String(outJudge.tagging?.text)), JSON.stringify(outJudge.tagging));
  ok('(control) signed in, the row says the CLI is tagging',
    inJudge.tagging?.works === true && /Claude CLI/.test(String(inJudge.tagging?.text)), JSON.stringify(inJudge.tagging));

  const outWarn = await warmWarning(outBase);
  const inWarn = await warmWarning(inBase);
  ok('THE POINT: the startup warning does not say tagging carries on when the CLI is signed out',
    /登录/.test(outWarn) && !/照常/.test(outWarn), outWarn || '(no warning naming the model)');
  ok('(control) signed in, the same warning says tagging carries on through the CLI',
    /照常由 Claude CLI/.test(inWarn) && !/登录/.test(inWarn), inWarn || '(no warning naming the model)');

  const outBind = await cOut.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: RERANK_MODEL });
  const inBind = await cIn.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: RERANK_MODEL });
  ok('THE POINT: binding a reranker with the CLI signed out, the toast says no tagging until it signs in',
    outBind.status === 200 && /还没有登录/.test(String(outBind.body?.note)), `${outBind.status} ${JSON.stringify(outBind.body?.note ?? outBind.body)}`);
  ok('(control) signed in, the toast carries no such warning',
    inBind.status === 200 && !/还没有登录/.test(String(inBind.body?.note)), `${inBind.status} ${JSON.stringify(inBind.body?.note ?? inBind.body)}`);

  // --- 8. a model downloaded AFTER the router started ---------------------------------------------------
  // The household's main path: a layer already runs on llama.cpp, they download a reranker, they bind it.
  // The real router reads its models directory once, so it answers `400 model not found` for the newcomer —
  // measured, and rewriting its preset file does not help; only a restart does. The app restarts a router it
  // STARTED; this one it ADOPTED (the fake was already answering), and killing a process it did not start is
  // not its to do — so the refusal has to say what would load the model, not quote a 400.
  fs.writeFileSync(path.join(rerankResources, 'gguf', `${LATE_RERANK}.gguf`), '');
  const late = await c3.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: LATE_RERANK });
  const lateErr = String(late.body?.error ?? '');
  ok('THE POINT: a model the running router does not know is refused with what would load it — a restart',
    late.status === 409 && /重启/.test(lateErr) && /llama-server/.test(lateErr), `${late.status} ${lateErr || JSON.stringify(late.body)}`);
  // …and once the router knows it (the real one would after its restart), the same bind goes through.
  served.add(LATE_RERANK);
  const lateAgain = await c3.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: LATE_RERANK });
  ok('(control) the same model binds once the router lists it',
    lateAgain.status === 200, `${lateAgain.status} ${JSON.stringify(lateAgain.body)}`);
} catch (err) {
  fail('e2e-p52 fatal: ' + (err?.stack || err?.message || String(err)));
} finally {
  try { server?.stop(); } catch {}
  try { rerankServer?.stop(); } catch {}
  try { signedOutServer?.stop(); } catch {}
  try { signedInServer?.stop(); } catch {}
  await new Promise((r) => fake.close(r));
}

done();
