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
//      3b: a judge that HANGS costs its verdict, never the page: the verification's own deadline ends it inside
//      the tool call's, and the engine's page stands — where the tool's deadline used to cancel the recall itself
//      and drop it to FTS.
//   4. When 判断 FALLS BACK to the CLI (its runtime gone), the CLI is asked for the CLI's model — not for
//      the GGUF named by the saved judgeModel or by the live route the binding wrote. Read from the stub's own
//      argv log, because a CLI asked for an unknown model is otherwise indistinguishable from one that answered
//      badly. Since Lyntai 3.3 the route is PROVIDER and model (llm.route.memory = llamacpp:<gguf>), and the
//      router ignores one naming a provider it does not hold — which is all that keeps the GGUF's id from the
//      CLI now: the app-side store that withheld the old model-only key is deleted. So the case fails if the
//      binding writes the wrong provider (claude-cli:<gguf> is read straight through; confirmed). And the restart
//      DROPS that route (LiveRouteMigrationStep): no router in the fallen-back process holds llamacpp, so Lyntai
//      would warn of it on every annotation and recall for as long as the fallback lasts — the log must carry no
//      such warning (confirmed to fail with the drop removed).
//      4b: the positive control — a route written for the RUNNING client (the CLI rebound to sonnet) is read,
//      live, before any restart; confirmed to fail when the bind writes no route.
//   5. A RERANKER binding says what it moves — the checking; tagging goes to the CLI and spends the account —
//      in its toast, in the cost line beside it and in the catalogued rerankers' notes, where the toast used
//      to claim both halves for every binding and none of the three said the tagging uses quota; and it writes
//      the route claude-cli:haiku, never the reranker's id nor llama.cpp's provider (confirmed to fail with the
//      provider taken from the chat branch). The bind-time screen really runs against
//      the runtime and refuses a reranker that ranks by word OVERLAP or simply BACKWARDS; one it refuses for
//      a reason other than its ordering is told apart, quoting the server.
//   6. A reranker AT WORK, on a server that booted bound to one: a fact write makes no chat call to
//      llama.cpp and is tagged by the CLI on the CLI's model, and a recall sends the query AND each
//      candidate's CONTENT to /v1/rerank. 6b: a long fact reaches it as several WINDOWS of at most 1,000
//      characters, its tail included, while a short fact in the same call is sent exactly as written. 6c: a
//      catalogued reranker whose row declares a 512-token window is sent only pairs that fit it, the query included,
//      a long fact in windows of that budget and a short one whole; BGE, declaring none, gets 1,000-character
//      windows and a query cut only past 2,045 characters (half its 4,096-token batch). Both confirmed to FAIL with
//      GATHERLIGHT_RERANK_CHUNKING=off (the cut). Each of 6b/6c also asserts the recall came back as a VERDICT
//      (`answered`), because a fault in the windowing is fail-open.
//      6d: the windows' scores are credited to the right candidate — a long note whose rewarded text is only in its
//      TAIL window makes a full page of 8 among 11, which fails under the cut, a first-window mapping and a mapping
//      off by one window. 6e–6g: the time a rerank call is sized to (RerankPace, half the verification deadline). 6e:
//      a lone slow call is not believed at once, a second is, and a long note is then read in FEWER windows; a fast
//      pass-through call does not pull the estimate back down, a slow call too small to measure teaches nothing, and a
//      user's STOP presumes the router busy only for the rest of the call's prediction.
//      6f: after a call the deadline CUT — its true time ~2.8× the deadline — a recall at once after it sends nothing
//      (the router is presumed still scoring the abandoned call, as the fake is), and once that has passed the next reads
//      one window per candidate and gets its verdict, rather than halving from a lower bound into a second cut. 6g: a
//      pace learned on English sizes a Chinese note by its tokens, not its characters. 6h: where even one window per
//      candidate cannot fit, the judge is SKIPPED — decided above Lyntai, cut TWICE (the lone cut damped), then fast
//      with nothing sent, nothing sent while the router is presumed busy however small the recall, and the 判断 row and
//      资源's badge both saying so — and after the re-probe interval a probe re-measures: still slow, still skipped; a
//      one-window call past the sized budget but inside 0.8 of the deadline is sent; fast, and the same recall runs the
//      judge. 6i: ONE stall past the deadline on an otherwise fast fake does not switch the judge off, nor does a cut
//      call sent while another was in flight count as a second. 6c also cuts a long question, counted by NFKC.
//   7. Whether a reranker's TAGGING is happening — it goes to the CLI, and a signed-out CLI means none — is
//      said in the 判断 row, the bind toast and the startup warning, each paired with a signed-in control.
//      7b: a measurement knob set at startup reaches state/logs, not only stdout.
//   8. A model downloaded AFTER the router started is unknown to it (the real router reads its models
//      directory once). A router the app did not start is not restarted for it, and the refusal says what
//      would load the model rather than quoting a 400 — on the 语义 bind too, and in the startup warning.
//   9. A write that keeps NO VECTOR is classified by one probe (Lyntai 3.4 bump). 9a: the embedder refuses one fact's
//      CONTENT and answers the probe — the fact keeps its ref, indexed without a vector, the log names it, and the next
//      start does not retry it (confirmed to FAIL with every vector-less write left unindexed: its ref empty, and the next
//      start embedding it again); the embedder is DOWN, probe included — the row is left UNINDEXED and the next start's
//      back-fill re-indexes it (confirmed to FAIL with the probe's answer ignored and the ref kept). An embedder that is
//      down at startup: the fact index re-remembers NOTHING and leaves its layout marker — our COST policy, sparing the
//      household's quota an annotation per pending fact per start of an outage (asserted as "no fact's content reaches
//      the embedder", which fails with the probe removed). 9c: a memory import while the embedder is down — its
//      detached back-fill is gated too, skips, and the next start indexes the fact (confirmed to FAIL with that gate
//      removed). 9b: a rebuild the embedder goes down during writes its marker anyway — the facts it left are empty
//      refs, the retry queue — and the next start back-fills them WITHOUT a rebuild, every other node kept (confirmed to
//      FAIL against the rule it replaced, no marker until the count reached the total, under which the next start
//      rebuilt everything again).
//  10. A BOUND model whose file is gone falls back at startup — 判断 to the CLI, 语义 off — even while another
//      model of its kind remains on disk; the startup warnings name the model, what the fallback costs and what
//      brings it back; and the fact index's layout marker keeps the vector rebuild owed rather than claiming it done.
//      10b: bind refuses a model startup would drop — one the router lists but our folder does not hold.
//      10c: the fallback's OTHER branch — a gone RERANKER, where only the checking moves — onto a CLI that is
//      signed out: the warning says nothing will be tagged or checked until it signs in (case 10 is the control).
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
const LATE_EMBED = 'zzlate-embed';
// Case 7: two servers bound at boot to a reranker the router does NOT list — so the startup warm fails and the
// warning has to say what happens to tagging — one with a signed-OUT CLI, one signed in as the control.
const TAGGING_RERANK = 'zztagging-rerank';
const SIGNED_OUT_PORT = 5415;
const SIGNED_IN_PORT = 5416;
// Case 9: one data folder booted five times — up, up again (9a's back-fill), down, partly down (9b), up — each on a
// port of its own.
const REBUILD_PORTS = [5417, 5418, 5419];
const BACKFILL_PORT = 5442;
const PARTIAL_PORT = 5443;
// Case 10: a folder whose settings name GGUFs that are no longer on disk.
const GONE_PORT = 5420;
// Case 10c: a folder whose settings name a gone RERANKER, booted against a signed-out CLI.
const GONE_OUT_PORT = 5421;

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
// A CATALOGUED reranker too, by its pinned id, so the picker's name for it can be read (case 5). Never bound.
const CATALOGUED_RERANK = 'LAMAR-600m.Q5_K_M';
fs.writeFileSync(path.join(resources, 'gguf', `${CATALOGUED_RERANK}.gguf`), '');

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

// Case 6c: two servers, each booted bound to a CATALOGUED reranker by its pinned id. mMiniLMv2's row declares a
// 512-token window — and its upstream name has no "rerank" in it, so only the row makes it a reranker at all; BGE's
// row declares none. Planted flat by id, like every stand-in here.
const WINDOWED_RERANK = 'mmarco-mMiniLMv2-L12-H384-v1-Q8_0';
const UNWINDOWED_RERANK = 'bge-reranker-v2-m3-Q5_K_M';
const WINDOWED_PORT = 5422;
const UNWINDOWED_PORT = 5423;
const plantBoundReranker = (suffix, model) => {
  const dir = dataDirFor(`p52-${suffix}`);
  makeTestData(dir);
  const res = path.join(dir, 'state', 'resources');
  fs.mkdirSync(path.join(res, 'llama-cpp'), { recursive: true });
  fs.mkdirSync(path.join(res, 'gguf'), { recursive: true });
  fs.writeFileSync(path.join(res, 'llama-cpp', 'llama-server.exe'), '');
  fs.writeFileSync(path.join(res, 'gguf', `${model}.gguf`), '');
  fs.writeFileSync(path.join(dir, 'state', 'settings.json'), JSON.stringify({
    memory: { judgeSource: 'llama-cpp', judgeModel: model },
  }, null, 2), 'utf8');
  return dir;
};
const windowedDir = plantBoundReranker('windowed', WINDOWED_RERANK);
const unwindowedDir = plantBoundReranker('unwindowed', UNWINDOWED_RERANK);
// Case 6e: a server bound to a reranker the fake answers SLOWLY, so the app's pace estimate has something to learn.
// "rerank" in the name types it a reranker; no catalogue row, so its windows are 1,000 characters.
const SLOW_RERANK = 'zzslow-rerank';
const PACE_PORT = 5424;
const paceDir = plantBoundReranker('pace', SLOW_RERANK);
// Cases 6f and 6g: the same slow reranker on servers of their own, so each pace starts from the seed.
const CUTOFF_PORT = 5425;
const cutoffDir = plantBoundReranker('cutoff', SLOW_RERANK);
const SCRIPT_PORT = 5426;
const scriptDir = plantBoundReranker('script', SLOW_RERANK);
// Case 6h: the same slow reranker, slower than one window per candidate can fit, on a server of its own. The GGUF
// embedder is planted beside it (not bound) so 资源's 推荐 badge has moved past the embedder to the reranker question.
const SKIP_PORT = 5427;
const skipDir = plantBoundReranker('skip', SLOW_RERANK);
fs.writeFileSync(path.join(skipDir, 'state', 'resources', 'gguf', 'embeddinggemma-300M-Q8_0.gguf'), '');
// Case 6i: the same slow reranker on a server of its own, stalled ONCE past the deadline on an otherwise fast fake.
const STALL_PORT = 5430;
const stallDir = plantBoundReranker('stall', SLOW_RERANK);

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
let refuseEmbeddings = false;
// Case 9: refuse only an embed whose input contains this token — an input the embedder will not take (9a) or one fact
// of a rebuild (9b).
let refuseEmbedToken = null;
// Case 9b: how many of the fact index's probes (FactIndex.EmbedderReadyAsync, by their text) are answered before every
// later one is refused — 1 lets the startup gate pass and then takes the embedder DOWN for the rebuild's own probe.
let probeBudget = Infinity;
// Case 8a: a router that ACCEPTS and never answers /v1/models — counted, so the case can prove it was asked.
let hangModels = false;
let modelsHung = 0;
// Case 3b: a chat judge that never answers — each held response is kept, and released when the case ends.
let hangChat = false;
const heldChats = [];
// Cases 6e–6h: how long the slow reranker takes per pair TOKEN; 0 answers at once (its startup warm included).
let slowMsPerToken = 0;
// …and when it will have finished everything it was sent, abandoned requests included (the fake's one queue).
let slowFreeAt = 0;
// Case 6i: the NEXT request of the slow reranker stalls this long (a model reload, a GPU busy elsewhere) and is then
// answered; every other request answers at once. Taken by the first request that arrives.
let stallNextMs = 0;
// A pair's tokens as a real XLM-R reranker's cost follows them: 0.83 per CJK character, 0.25 per other — the rates
// measured on the real router (docs/self-managed-llm-runtime.md), per UTF-16 unit, from U+2E80 up counted as CJK.
const fakeTokens = (s) => {
  let t = 0;
  for (let i = 0; i < s.length; i++) t += s.charCodeAt(i) >= 0x2e80 ? 0.83 : 0.25;
  return t;
};
const served = new Set([JUDGE_MODEL, EMBED_MODEL, RERANK_MODEL, LEXICAL_RERANK, BACKWARDS_RERANK, BROKEN_RERANK, SHORT_RERANK,
  WINDOWED_RERANK, UNWINDOWED_RERANK, SLOW_RERANK]);
const fake = http.createServer((req, res) => {
  const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url === '/v1/models') {
    if (hangModels) { modelsHung++; return; }   // never answered; the server's own timeout ends it
    send({ object: 'list', data: [...served].map((id) => ({ id })) });
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let json = {};
    try { json = JSON.parse(body); } catch { /* recorded raw regardless */ }
    hits.push({ path: req.url, model: json.model, body, at: Date.now() });
    if (req.url === '/v1/embeddings') {
      // Case 9: an embedder that is wired and DOWN — what a router that has not started looks like to a write.
      const probe = body.includes('index probe');
      const overBudget = probe && probeBudget-- <= 0;
      if (refuseEmbeddings || overBudget || (refuseEmbedToken && body.includes(refuseEmbedToken))) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 503, message: 'zzfake embedder down' } }));
        return;
      }
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
      // A THIRD level for case 6d only: `zzmapbest` outscores any answer, so the mapping test never rests on a tie.
      const answerAware = (d) => (d.includes('zzmapbest') ? 9.0 : answers(d) ? 3.2 : -2.1);
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
      // Cases 6e–6h: a reranker on a slow machine — it answers in time proportional to the PAIR tokens it is sent (the
      // query beside each document), which is what a cross-encoder's cost follows. And ONE AT A TIME, as a real
      // llama-server child does: a request waits for the ones before it, and a request its client ABANDONED is scored to
      // the end all the same (docs/judge-bench.md Run 8 — the next call queues behind it). Every earlier case awaits each
      // call before the next and abandons none, so the queue only ever holds work after a deadline cut.
      // A request arriving while the fake is still busy waits for it even when it would itself cost nothing — the queue
      // case 6i's two concurrent recalls stand behind.
      if (json.model === SLOW_RERANK && (slowMsPerToken > 0 || stallNextMs > 0 || slowFreeAt > Date.now())) {
        const pairTokens = docs.reduce((a, d) => a + fakeTokens(String(json.query ?? '')) + fakeTokens(d), 0);
        const cost = stallNextMs > 0 ? stallNextMs : Math.round(pairTokens * slowMsPerToken);
        stallNextMs = 0;
        slowFreeAt = Math.max(Date.now(), slowFreeAt) + cost;
        setTimeout(() => { if (!res.destroyed) send({ model: json.model, results }); }, slowFreeAt - Date.now());
        return;
      }
      send({ model: json.model, results });
      return;
    }
    if (hangChat) { heldChats.push(res); return; }   // case 3b: accepted, never answered
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
let rebuildServer = null;
let goneServer = null;
let goneOutServer = null;
let windowedServer = null;
let unwindowedServer = null;
let paceServer = null;
let cutoffServer = null;
let scriptServer = null;
let skipServer = null;
let stallServer = null;
try {
  // The verification deadline shortened to 2 s (case 3b) — the knob can only shorten it, and every other judge call
  // on this server is answered by the fake at once.
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl, GATHERLIGHT_JUDGE_DEADLINE_SECONDS: '2' } });
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

  // --- 3b. a judge that HANGS costs its verdict, never the page -------------------------------------------
  // docs/judge-bench.md Run 5: a chat judge's verification hung, and at 120 s the TOOL call's deadline
  // (ToolRegistry) cancelled the recall itself. To Lyntai that is the CALLER cancelling — every layer rethrows it —
  // so FactIndex caught it and the page came back from FTS instead of from the engine. The verifier now has a
  // deadline of its own INSIDE the tool's (VerificationDeadlinePolicy: half of it, 2 s on this server through the
  // test knob); past it the verdict is NoOpinion and the engine's own page stands, as for any other judge failure.
  hangChat = true;
  const beforeHang = hits.length;
  const hangStarted = Date.now();
  const hung = await c.call('recall_facts', { query: 'zzroutefact morning walk bakery', limit: 5 });
  const hungMs = Date.now() - hangStarted;
  hangChat = false;
  for (const r of heldChats.splice(0)) { try { if (!r.destroyed) r.destroy(); } catch { /* already gone */ } }
  const heldVerification = hits.slice(beforeHang)
    .filter((h) => h.path === '/v1/chat/completions' && h.model === JUDGE_MODEL && h.body.includes('zzroutefact'));
  ok('(non-vacuity) the recall\'s verification reached the chat judge — and was never answered',
    heldVerification.length > 0, JSON.stringify(hits.slice(beforeHang).map((h) => `${h.path} ${h.model}`)));
  ok('THE POINT: a judge that never answers leaves the ENGINE\'s page — ranked by the graph, the fact on it, no verdict',
    hung.status === 200 && hung.result?.ranked === 'graph' && hung.result?.answered === undefined
      && (hung.result?.facts ?? []).some((f) => JSON.stringify(f).includes('zzroutefact')),
    `${hung.status} ${JSON.stringify(hung.result).slice(0, 300)}`);
  ok('…and it answers at the verification deadline, not at the tool call\'s 120 s', hungMs < 30000, `${hungMs} ms`);
  const logText = () => {
    const dir = path.join(dataDir, 'state', 'logs');
    return fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n') : '';
  };
  ok('…and the log says the judge gave no verdict in time, and that the deadline was the test knob\'s',
    /gave no verdict within 2 s/.test(logText()) && /Test knob set: judge verification deadline = 2 s/.test(logText()),
    logText().split('\n').filter((l) => /verdict within|deadline|falling back to FTS/.test(l)).slice(-4).join(' | '));
  ok('…and nothing fell back to FTS', !/recall failed; falling back to FTS/.test(logText()),
    logText().split('\n').filter((l) => /falling back to FTS/.test(l)).slice(-2).join(' | '));

  // --- 4. a FALLBACK to the CLI asks the CLI for the CLI's model -----------------------------------
  // The household story: a chat GGUF is bound, then the runtime goes (deleted, a failed update). 判断
  // resolves to the CLI — and two things written for the GGUF were still being read: settings' judgeModel
  // (the badge said "claude-cli · <gguf>", and it became DefaultModelByConsumer), and the live key the
  // binding wrote, which outranks that default. Either one hands the GGUF's id to Claude; both policies are
  // fail-open, so the symptom is zero enrichment and no error.
  //
  // BINDING through the endpoint, rather than planting settings, is what writes the live route.
  const bound = await c.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: JUDGE_MODEL });
  ok('(fixture) binding the chat GGUF succeeds',
    bound.status === 200, `${bound.status} ${JSON.stringify(bound.body)}`);
  // The route names the provider the GGUF annotates through — llama.cpp's, the one its named client holds. Read
  // from the database: no API response carries it. Its PROVIDER half is what the fallback below rests on.
  const storedKey = (dir, key) => {
    const db = new DatabaseSync(path.join(dir, 'state', 'gatherlight.db'), { readOnly: true });
    try { return db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value ?? null; }
    finally { db.close(); }
  };
  ok('…which writes the route llm.route.memory = llamacpp:<the GGUF>, provider and model together',
    storedKey(dataDir, 'llm.route.memory') === `llamacpp:${JUDGE_MODEL}`,
    `llm.route.memory=${JSON.stringify(storedKey(dataDir, 'llm.route.memory'))}`);
  ok('…and nothing under the pre-route key', storedKey(dataDir, 'llm.model.memory') === null,
    `llm.model.memory=${JSON.stringify(storedKey(dataDir, 'llm.model.memory'))}`);

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
  // THE FALLBACK'S ROUTE IS DROPPED AT THE START, not warned about on every call. It names llamacpp, which no router
  // in this process holds, so Lyntai would log "the live route for consumer memory … names no registered text
  // provider" on the annotation above and on the recall's verification — and on every one after, for as long as the
  // fallback lasts. Nothing is lost by dropping it: when the GGUF runs again, its model is the judge's default.
  const liveRouteLines = logText().split('\n').filter((l) => l.includes('live route') || l.includes('live routes:'));
  ok('THE POINT: the restart dropped the fallback\'s route, saying why — nothing left under llm.route.memory',
    storedKey(dataDir, 'llm.route.memory') === null
      && /live routes: dropped llm\.route\.memory = llamacpp:zzroute-chat — 判断 is running on claude-cli/.test(logText()),
    `llm.route.memory=${JSON.stringify(storedKey(dataDir, 'llm.route.memory'))} ${liveRouteLines.slice(-3).join(' | ')}`);
  ok('THE POINT: …so the fallback\'s annotation and recall log NO per-call router warning about the route',
    !/live route for consumer memory .*names no registered text provider/.test(logText()),
    liveRouteLines.filter((l) => l.includes('names no registered')).slice(0, 2).join(' | '));

  // --- 4b. …and the route IS READ when it names the provider that is running --------------------------
  // Every check above has the router ignore the GGUF's route, and every annotation lands on the default
  // haiku — which a route that was NEVER read would pass too. So: on this server, whose judge runs on the CLI,
  // bind the CLI judge to sonnet. The CLI's router holds claude-cli, so the route must be read, and the very
  // next annotation — before any restart — asks for sonnet.
  const toSonnet = await c2.post('/api/manage/memory/layer/judge', { source: 'claude-cli', model: 'sonnet' });
  ok('(fixture) the CLI judge binds to sonnet', toSonnet.status === 200, `${toSonnet.status} ${JSON.stringify(toSonnet.body)}`);
  ok('(fixture) …which writes the route llm.route.memory = claude-cli:sonnet',
    storedKey(dataDir, 'llm.route.memory') === 'claude-cli:sonnet',
    `llm.route.memory=${JSON.stringify(storedKey(dataDir, 'llm.route.memory'))}`);
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
  // THE TRAP: the binding writes the ANNOTATION route to llm.route.memory, and for a reranker that is the
  // CLI's model ON THE CLI. Writing the reranker's id there would send it to Claude on every fact write —
  // fail-open, so no error, just no tagging — and llama.cpp's provider would be a route no router serving
  // this judge holds, so the tagging would silently stay on whatever the running wiring had. Read from the
  // database itself: no API response carries this key.
  const liveKey = storedKey(dataDir, 'llm.route.memory');
  ok('THE TRAP: llm.route.memory is the CLI\'s model on the CLI — claude-cli:haiku, never the reranker\'s id',
    liveKey === 'claude-cli:haiku', `llm.route.memory=${JSON.stringify(liveKey)}`);
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
  // …and it claims measurement only where there is some. Gemma 3 1B's judging was measured (docs/judge-bench.md
  // Run 3) and came out worse than no judge; the sentence said none had been, which the measurement made false. It
  // must now say both: what the measured one did, and that the others were not measured.
  ok("…and does not claim every model on 判断 was measured — and says the chat model that was did worse than none",
    !/都实测排过名/.test(judgeManaged) && /没有实测过/.test(judgeManaged) && /比不开判断更差/.test(judgeManaged),
    judgeManaged);
  // Run 5b then measured Qwen3 0.6B BETTER than no judge, and it is catalogued — so "only Gemma 1B was measured, and
  // was worse" went false. The sentence names the one that did better, and that the reranker still wins on the page.
  ok('…and names the catalogued chat model that did BETTER than none, and that it trails the reranker on the page',
    /Qwen3 0\.6B 比不开判断好/.test(judgeManaged) && /前八的次数远不如重排模型/.test(judgeManaged)
      && !/实测过的只有/.test(judgeManaged),
    judgeManaged);
  // What the 判断 picker SHOWS for each model: it listed raw file ids, so a reranker and a chat model read
  // alike although binding one moves only the checking. A catalogued model shows the catalogue's name (which
  // says 重排); a household-dropped one keeps its raw id with its kind marked.
  const llamaModels = (layer) => (layer.groups ?? []).flatMap((g) => g.sources ?? [])
    .find((x) => x.id === 'llama-cpp')?.models ?? [];
  const shownAs = (id) => llamaModels(rrLayer).find((m) => m.id === id)?.name;
  ok('the 判断 picker names a catalogued reranker by its catalogue name, which says 重排',
    /^LAMAR 600M/.test(String(shownAs(CATALOGUED_RERANK))) && /重排/.test(String(shownAs(CATALOGUED_RERANK))),
    JSON.stringify(llamaModels(rrLayer).map((m) => [m.id, m.name])));
  ok("…and marks a household-dropped model's kind beside its raw id",
    shownAs(RERANK_MODEL) === `${RERANK_MODEL}(重排)` && shownAs(JUDGE_MODEL) === `${JUDGE_MODEL}(对话)`,
    JSON.stringify(llamaModels(rrLayer).map((m) => [m.id, m.name])));
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

  // --- 6b. a LONG fact is scored in WINDOWS — its tail included — and a short one exactly as written ------------
  // Measured on the real llama-server: one (query, document) pair past the router's 4096-token batch fails the
  // WHOLE /v1/rerank call with a 500, and the verifier is fail-open — so every pair is bounded: 1,000 characters for a
  // reranker declaring no window (~3,200 characters of Chinese is ~2,700 tokens). Until Run 6b the bound was a CUT, and
  // docs/judge-bench.md Run 6 measured what the cut costs when the answer is past it: the note scores like filler and is
  // pushed OFF the page. So a long candidate is scored in overlapping WINDOWS of that same bound, the last at its tail,
  // in the same call, keeping its best window's score (ChunkedScoreProvider); a candidate that fits one window is sent
  // exactly as before. Confirmed to FAIL with GATHERLIGHT_RERANK_CHUNKING=off (the cut: one head-only document).
  const longContent = 'zzlonghead 天文社每周五晚上在楼顶观测。' + '观测记录与器材清单。'.repeat(320) + ' zzlongtail';
  const wroteLong = await c3.call('remember_fact', {
    kind: 'household', topic: 'zzlongtopic 天文社', content: longContent,
    source: 'https://example.test/zzlong', confidence: 0.8,
  });
  ok('(fixture) a long fact is stored whole', wroteLong.status === 200 && wroteLong.result?.ok === true,
    JSON.stringify(wroteLong.result));
  const shortContent = 'The zzrerankcontent swim lane is booked every Thursday evening at the leisure centre.';
  const beforeLong = hits.length;
  // The query names both facts' words, so the long note AND case 6's short fact are candidates of ONE call.
  const longRecall = await c3.call('recall_facts', { query: 'zzlongquery 天文社每周五晚上在楼顶观测 swim lane Thursday evening', limit: 5 });
  const longDocs = () => hits.slice(beforeLong)
    .filter((h) => h.path === '/v1/rerank' && h.body.includes('zzlongquery'))
    .flatMap((h) => { try { return JSON.parse(h.body).documents ?? []; } catch { return []; } })
    .map(String);
  await until(() => longDocs().some((d) => d.includes('zzlonghead')), 60000).catch(() => {});
  // Every document cut from the long note: each carries its repeated body, its head or its tail.
  const sentLong = longDocs().filter((d) => d.includes('器材清单') || d.includes('zzlonghead') || d.includes('zzlongtail'));
  const longShape = JSON.stringify(sentLong.map((d) => ({ length: d.length, head: d.includes('zzlonghead'), tail: d.includes('zzlongtail') })));
  ok('THE POINT: the long fact reaches the reranker as several WINDOWS of at most 1,000 characters — its head in one, its TAIL in another',
    sentLong.length >= 2 && sentLong.every((d) => d.length <= 1000 && longContent.includes(d))
      && sentLong.some((d) => d.includes('zzlonghead')) && sentLong.some((d) => d.includes('zzlongtail')),
    longShape);
  const shortSent = longDocs().filter((d) => d.includes('zzrerankcontent'));
  ok('…and a SHORT fact in the same call is sent exactly as written, once — one window is the fact itself',
    shortSent.length === 1 && shortSent[0] === shortContent, JSON.stringify(shortSent));
  // What reached /v1/rerank is half of it: the windows' scores must come BACK as one verdict per candidate. The scoring
  // policy is fail-open, so a fault in ChunkedScoreProvider (a window count the scores do not match, an exception)
  // becomes NoOpinion with the engine's page standing — every assertion above green. Lyntai 3.2.0 sets `answered` only
  // when a verdict was judged (case 3b asserts its absence for the opposite).
  ok('THE POINT: …and the windowed call came back as a VERDICT — a graph page the reranker judged',
    longRecall.status === 200 && longRecall.result?.ranked === 'graph' && longRecall.result?.answered === true,
    `${longRecall.status} ${JSON.stringify({ ranked: longRecall.result?.ranked, answered: longRecall.result?.answered })}`);

  // --- 6d. the windows' scores come back to the RIGHT candidate — its best window, wherever that window sits ----------
  // 6b proves the windows reach /v1/rerank and a verdict comes back; this proves the verdict is PAIRED with them. Ten
  // fillers and one long note all name zzmapshared, so the recall shows the reranker at least 11 candidates for a page of
  // 8 — choosing 8 must leave some out, and under partition the page IS the endorsed 8. The fake scores a document
  // holding `zzmapbest` 9.0, one holding a digit 3.2, anything else −2.1. Each filler is two windows with its digit in the
  // FIRST only; the long note is five windows with `zzmapbest` in its TAIL only.
  //   - Max over the right windows: the long note scores 9.0, is endorsed, and is on the page.
  //   - The cut (GATHERLIGHT_RERANK_CHUNKING=off), or a mapping that keeps each candidate's FIRST window: −2.1, below all
  //     ten fillers' 3.2 — off the page.
  //   - A mapping off by one window that credits each candidate with the window BEFORE its own: its tail goes to the next
  //     candidate, and it gets its predecessor's last window — a filler's second, digit-free — so −2.1 again, off the page.
  // No tie is relied on: Lyntai ranks scores with a stable sort, so a tie would test the engine's order, not the mapping.
  const MAP_PAD = '泳池规则与更衣室须知。';
  const mapFillers = [...'abcdefghij'].map((id, i) => ({
    id, content: `zzmapfill${id} zzmapshared 泳道开放:第${i + 1}号泳道每周开放。` + MAP_PAD.repeat(95),
  }));
  const mapTarget = 'zzmaptarget zzmapshared 泳道开放时间的完整说明。' + MAP_PAD.repeat(300) + ' zzmapbest';
  for (const f of mapFillers) {
    const w = await c3.call('remember_fact', {
      kind: 'household', topic: `zzmaptopic${f.id} 泳道`, content: f.content,
      source: `https://example.test/zzmap${f.id}`, confidence: 0.8,
    });
    if (!(w.status === 200 && w.result?.ok === true)) fail(`(fixture) filler ${f.id} not stored: ${JSON.stringify(w.result)}`);
  }
  const wroteTarget = await c3.call('remember_fact', {
    kind: 'household', topic: 'zzmaptopic 泳道开放时间', content: mapTarget,
    source: 'https://example.test/zzmaptarget', confidence: 0.8,
  });
  ok('(fixture) ten fillers and the long note are stored', wroteTarget.status === 200 && wroteTarget.result?.ok === true,
    JSON.stringify(wroteTarget.result));
  const beforeMap = hits.length;
  const mapRecall = await c3.call('recall_facts', { query: 'zzmapquery zzmapshared 泳道开放', limit: 8 });
  const mapDocs = hits.slice(beforeMap)
    .filter((h) => h.path === '/v1/rerank' && h.model === RERANK_MODEL && h.body.includes('zzmapquery'))
    .flatMap((h) => { try { return JSON.parse(h.body).documents ?? []; } catch { return []; } })
    .map(String);
  // Candidates the reranker was SHOWN: each filler's first window carries its id; the long note is one more.
  const shown = new Set(mapDocs.flatMap((d) => [...d.matchAll(/zzmapfill([a-j])/g)].map((m) => m[1])));
  const targetShown = mapDocs.some((d) => d.includes('zzmaptarget') || d.includes('zzmapbest'));
  ok('(non-vacuity) the reranker was shown the long note and at least 8 fillers — more candidates than the page holds',
    targetShown && shown.size >= 8, JSON.stringify({ fillers: [...shown].sort().join(''), target: targetShown, documents: mapDocs.length }));
  ok('(non-vacuity) the long note\'s TAIL window — the only place zzmapbest is — was among what was sent',
    mapDocs.some((d) => d.includes('zzmapbest')) && !mapDocs.some((d) => d.includes('zzmaptarget') && d.includes('zzmapbest')),
    JSON.stringify(mapDocs.filter((d) => d.includes('zzmaptarget') || d.includes('zzmapbest')).map((d) => ({ length: d.length,
      head: d.includes('zzmaptarget'), tail: d.includes('zzmapbest') }))));
  const mapPage = mapRecall.result?.facts ?? [];
  ok('(non-vacuity) the page is full — 8 of the 11 — and was judged',
    mapRecall.status === 200 && mapRecall.result?.ranked === 'graph' && mapRecall.result?.answered === true && mapPage.length === 8,
    `${mapRecall.status} ${JSON.stringify({ ranked: mapRecall.result?.ranked, answered: mapRecall.result?.answered, n: mapPage.length })}`);
  ok('THE POINT: the long note whose only rewarded text is in its TAIL window is ON the page — its best window was credited to it',
    mapPage.some((f) => String(f.content ?? '').includes('zzmaptarget')),
    JSON.stringify(mapPage.map((f) => String(f.content ?? '').slice(0, 12))));

  // --- 6c. a reranker with a 512-token WINDOW is sent what fits it — the query included --------------------
  // mMiniLMv2 serves 512-token slots, and one (query, document) pair past that fails the WHOLE /v1/rerank call:
  // `400 input (781 tokens) is larger than the max context size (512 tokens)`, measured on dense Chinese at the
  // 1,000-character cap above (docs/judge-bench.md Run 4). The verifier is fail-open, so every recall surfacing a
  // long fact would go unverified and nothing would say so. Its catalogue row declares the window, and the input is
  // fitted per PAIR: on this tokenizer family a text costs at most its characters + 1 in tokens, plus 4 special
  // tokens around the pair, so query + document ≤ 512 − 6 = 506 characters is a hard bound — with the query held to
  // half of it. BGE's row declares no window: it keeps the 1,000-character bound and an unbounded query (the control).
  // A fact longer than its bound is read in WINDOWS of it, its tail included (docs/judge-bench.md Run 6c), and every
  // window is a pair that must fit; a short fact beside it is sent whole, as before.
  windowedServer = startServer({ dataDir: windowedDir, port: WINDOWED_PORT, env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl } });
  unwindowedServer = startServer({ dataDir: unwindowedDir, port: UNWINDOWED_PORT, env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl } });
  const winBase = `http://127.0.0.1:${WINDOWED_PORT}`;
  const unwinBase = `http://127.0.0.1:${UNWINDOWED_PORT}`;
  await Promise.all([waitHealthy(winBase), waitHealthy(unwinBase)]);
  const cWin = makeClient(winBase);
  const cUnwin = makeClient(unwinBase);
  const winJudge = layerOf(await cWin.getJson('/api/manage/memory'), 'judge');
  const unwinJudge = layerOf(await cUnwin.getJson('/api/manage/memory'), 'judge');
  ok('(fixture) one server runs 判断 on the windowed reranker, the other on BGE',
    winJudge.activeSource === 'llama-cpp' && winJudge.activeModel === WINDOWED_RERANK
      && unwinJudge.activeSource === 'llama-cpp' && unwinJudge.activeModel === UNWINDOWED_RERANK,
    JSON.stringify({ windowed: [winJudge.activeSource, winJudge.activeModel], bge: [unwinJudge.activeSource, unwinJudge.activeModel] }));

  // A Chinese fact past 1,000 characters (so BGE's cap engages too) and a query past half the window — both
  // dense CJK, the worst tokens-per-character case measured. The query's words are the fact's, so the graph
  // returns the fact as a candidate.
  const miniFact = 'zzminihead 天文社每周五晚上在楼顶观测。' + '观测记录与器材清单。'.repeat(120) + ' zzminitail';
  const miniQuery = ['zzminiquery', ...Array(14).fill('天文社每周五晚上在楼顶观测 观测记录与器材清单')].join(' ');
  // …and a SHORT one beside it (no compatibility characters, so its NFKC form is itself): it fits one window and must
  // be sent exactly as before chunking — whole.
  const miniShort = 'zzminishort 天文社每周五晚上在楼顶观测 带上望远镜';
  for (const [name, cl] of [['windowed', cWin], ['BGE', cUnwin]]) {
    const wrote = await cl.call('remember_fact', {
      kind: 'household', topic: 'zzminitopic 天文社', content: miniFact,
      source: 'https://example.test/zzmini', confidence: 0.8,
    });
    ok(`(fixture) the long fact is stored whole on the ${name} server`, wrote.status === 200 && wrote.result?.ok === true,
      JSON.stringify(wrote.result));
    const wroteShort = await cl.call('remember_fact', {
      kind: 'household', topic: 'zzminishorttopic 天文社', content: miniShort,
      source: 'https://example.test/zzminishort', confidence: 0.8,
    });
    ok(`(fixture) the short fact is stored on the ${name} server`, wroteShort.status === 200 && wroteShort.result?.ok === true,
      JSON.stringify(wroteShort.result));
  }
  const beforeMini = hits.length;
  const [winRecall, unwinRecall] = await Promise.all([
    cWin.call('recall_facts', { query: miniQuery, limit: 5 }), cUnwin.call('recall_facts', { query: miniQuery, limit: 5 })]);
  const rerankOf = (model) => hits.slice(beforeMini)
    .filter((h) => h.path === '/v1/rerank' && h.model === model && h.body.includes('zzminiquery'))
    .map((h) => { try { return JSON.parse(h.body); } catch { return null; } })
    .filter(Boolean);
  const carriesFact = (model) => rerankOf(model).some((b) => (b.documents ?? []).some((d) => String(d).includes('zzminihead')));
  await until(() => carriesFact(WINDOWED_RERANK) && carriesFact(UNWINDOWED_RERANK), 60000).catch(() => {});

  const win = rerankOf(WINDOWED_RERANK);
  const pairs = win.flatMap((b) => (b.documents ?? []).map((d) => ({ q: String(b.query ?? ''), d: String(d) })));
  const shape = (list) => JSON.stringify(list.map((p) => [p.q.length, p.d.length]));
  ok('(non-vacuity) the windowed reranker was sent the long fact, beside the long query',
    carriesFact(WINDOWED_RERANK) && win.every((b) => String(b.query ?? '').startsWith('zzminiquery')),
    JSON.stringify(hits.slice(beforeMini).map((h) => `${h.path} ${h.model} ${h.body.length}`)));
  ok('THE POINT: EVERY pair sent to the 512-token reranker fits its window — query + document ≤ 506 characters',
    pairs.length > 0 && pairs.every((p) => p.q.length + p.d.length <= 506), shape(pairs));
  ok('…the QUERY is bounded too — to half the budget, its head kept',
    win.length > 0 && win.every((b) => String(b.query).length <= 253 && miniQuery.startsWith(String(b.query))),
    JSON.stringify(win.map((b) => String(b.query).length)));
  // Every document cut from the long fact carries its repeated body, its head or its tail.
  const ofMini = (d) => d.includes('器材清单') || d.includes('zzminihead') || d.includes('zzminitail');
  const miniWindows = pairs.filter((p) => ofMini(p.d));
  ok('…and the long fact is sent as several WINDOWS, each fitting beside the query — its head in one, its TAIL in another',
    miniWindows.length >= 2 && miniWindows.some((p) => p.d.includes('zzminihead')) && miniWindows.some((p) => p.d.includes('zzminitail'))
      && miniWindows.every((p) => miniFact.includes(p.d)),
    shape(miniWindows));
  const miniShortSent = pairs.filter((p) => p.d.includes('zzminishort'));
  ok('…while the SHORT fact beside it is sent whole, once — exactly what it was sent before chunking',
    miniShortSent.length === 1 && miniShortSent[0].d === miniShort, JSON.stringify(miniShortSent.map((p) => p.d)));

  const bge = rerankOf(UNWINDOWED_RERANK);
  const bgeLong = bge.flatMap((b) => b.documents ?? []).map(String).filter(ofMini);
  ok('(control) BGE, whose row declares no window, gets the long fact in windows of at most 1,000 characters — its tail included — and this query (under 2,045 characters) uncut',
    bgeLong.length >= 2 && bgeLong.every((d) => d.length <= 1000 && miniFact.includes(d))
      && bgeLong.some((d) => d.includes('zzminihead')) && bgeLong.some((d) => d.includes('zzminitail'))
      && bge.every((b) => String(b.query ?? '').length > 253),
    JSON.stringify({ docs: bgeLong.map((d) => d.length), tail: bgeLong.some((d) => d.includes('zzminitail')),
      queries: bge.map((b) => String(b.query ?? '').length) }));
  const bgeShort = bge.flatMap((b) => b.documents ?? []).map(String).filter((d) => d.includes('zzminishort'));
  ok('(control) …and its short fact whole, once', bgeShort.length === 1 && bgeShort[0] === miniShort, JSON.stringify(bgeShort));
  // …and on both servers the windows' scores came back as a verdict (see 6b: a fault in the windowing is NoOpinion).
  const judgedPage = (r) => r.status === 200 && r.result?.ranked === 'graph' && r.result?.answered === true;
  const verdictShape = (r) => `${r.status} ${JSON.stringify({ ranked: r.result?.ranked, answered: r.result?.answered })}`;
  ok('THE POINT: …and each windowed recall came back as a VERDICT — on the 512-token reranker and on BGE',
    judgedPage(winRecall) && judgedPage(unwinRecall), `windowed ${verdictShape(winRecall)} · BGE ${verdictShape(unwinRecall)}`);

  // 6c, COMPATIBILITY CHARACTERS: the character bound holds for text the tokenizer does not EXPAND. XLM-R normalises
  // with nmt_nfkc first, so ℃ → °C, ㎡ → m2, ㎏ → kg, ㍿ → 株式会社 — measured on the real mMiniLMv2, a pair of 506 raw
  // characters dense in ℃ is 1,006 tokens and refused, the same pair counted on its NFKC form 510 and served. So the
  // rule is: the text sent is NFKC-normalised, and the budget is spent on the normalised length. Every rerank request
  // to the windowed model must satisfy both; the raw count sends ℃ unnormalised and ~25% past the budget.
  const compatFact = 'zzcompathead 天文社楼顶气温记录:' + '气温3℃,面积120㎡,重23㎏,㍿天文。'.repeat(30) + ' zzcompattail';
  const compatQuery = 'zzcompatquery 天文社楼顶气温记录 面积 ㍿天文';
  for (const [name, cl] of [['windowed', cWin], ['BGE', cUnwin]]) {
    const wrote = await cl.call('remember_fact', {
      kind: 'household', topic: 'zzcompattopic 天文社气温', content: compatFact,
      source: 'https://example.test/zzcompat', confidence: 0.8,
    });
    ok(`(fixture) the compatibility-dense fact is stored on the ${name} server`, wrote.status === 200 && wrote.result?.ok === true,
      JSON.stringify(wrote.result));
  }
  const beforeCompat = hits.length;
  const [winCompat, unwinCompat] = await Promise.all([
    cWin.call('recall_facts', { query: compatQuery, limit: 5 }), cUnwin.call('recall_facts', { query: compatQuery, limit: 5 })]);
  const compatOf = (model) => hits.slice(beforeCompat)
    .filter((h) => h.path === '/v1/rerank' && h.model === model && h.body.includes('zzcompatquery'))
    .map((h) => { try { return JSON.parse(h.body); } catch { return null; } })
    .filter(Boolean);
  const carriesCompat = (model) => compatOf(model).some((b) => (b.documents ?? []).some((d) => String(d).includes('zzcompathead')));
  await until(() => carriesCompat(WINDOWED_RERANK) && carriesCompat(UNWINDOWED_RERANK), 60000).catch(() => {});
  const nfkc = (s) => s.normalize('NFKC');
  const compatPairs = compatOf(WINDOWED_RERANK)
    .flatMap((b) => (b.documents ?? []).map((d) => ({ q: String(b.query ?? ''), d: String(d) })));
  const compatShape = (list) => JSON.stringify(list.map((p) => ({ raw: p.q.length + p.d.length, nfkc: nfkc(p.q).length + nfkc(p.d).length,
    normalised: p.q === nfkc(p.q) && p.d === nfkc(p.d) })));
  ok('(non-vacuity) the windowed reranker was sent the compatibility-dense fact',
    carriesCompat(WINDOWED_RERANK), JSON.stringify(hits.slice(beforeCompat).map((h) => `${h.path} ${h.model} ${h.body.length}`)));
  ok('THE POINT: every pair sent to the 512-token reranker is NFKC-normalised and fits on its NORMALISED length — ≤ 506',
    compatPairs.length > 0 && compatPairs.every((p) => p.q === nfkc(p.q) && p.d === nfkc(p.d)
      && nfkc(p.q).length + nfkc(p.d).length <= 506),
    compatShape(compatPairs));
  // The windows are cut from the NORMALISED text, so each is a piece of it — head and tail both reached.
  const compatWindows = compatPairs.filter((p) => nfkc(compatFact).includes(p.d));
  ok('…and the fact is read in windows of its normalised text — its head in one, its tail in another',
    compatWindows.length >= 2 && compatWindows.some((p) => p.d.includes('zzcompathead')) && compatWindows.some((p) => p.d.includes('zzcompattail')),
    compatShape(compatWindows));
  const bgeCompat = compatOf(UNWINDOWED_RERANK).flatMap((b) => b.documents ?? []).map(String).filter((d) => compatFact.includes(d) && d.length > 100);
  ok('(control) BGE, declaring no window, is sent the fact as WRITTEN — not normalised, ㍿ and ℃ intact, head and tail both',
    bgeCompat.length > 0 && bgeCompat.every((d) => d.includes('㍿') && d.includes('℃'))
      && bgeCompat.some((d) => d.includes('zzcompathead')) && bgeCompat.some((d) => d.includes('zzcompattail')),
    JSON.stringify(bgeCompat.map((d) => d.slice(0, 40))));
  ok('…and both compatibility-dense recalls came back as a VERDICT',
    judgedPage(winCompat) && judgedPage(unwinCompat), `windowed ${verdictShape(winCompat)} · BGE ${verdictShape(unwinCompat)}`);

  // 6c, A LONG QUESTION beside a reranker that declares NO window: the query is capped too — at 2,045 characters, half
  // the pair budget of the 4,096-token batch the preset launches BGE with (RerankInputCap.UndeclaredQueryMaxChars).
  // Uncapped, a question of ~4,000 Chinese characters beside a 1,000-character window is past the batch on the real
  // router, which refuses the WHOLE call — fail-open, every recall unjudged. The fake enforces no limit, so what is
  // asserted is what was SENT: every pair's query at most 2,045 characters, and the question's head. Confirmed to FAIL
  // with the cap removed (the whole 2,812-character query is sent).
  const hugeQuery = 'zzhugequery ' + '天文社每周五晚上在楼顶观测 '.repeat(200);
  const beforeHuge = hits.length;
  const hugeRecall = await cUnwin.call('recall_facts', { query: hugeQuery, limit: 5 });
  const hugeBodies = () => hits.slice(beforeHuge)
    .filter((h) => h.path === '/v1/rerank' && h.model === UNWINDOWED_RERANK && h.body.includes('zzhugequery'))
    .map((h) => { try { return JSON.parse(h.body); } catch { return null; } })
    .filter(Boolean);
  await until(() => hugeBodies().length > 0, 60000).catch(() => {});
  ok('(non-vacuity) the question really is past the cap, and a rerank call carried it',
    hugeQuery.length > 2045 && hugeBodies().length > 0 && hugeRecall.status === 200,
    JSON.stringify({ length: hugeQuery.length, calls: hugeBodies().length, status: hugeRecall.status }));
  ok('THE POINT: beside a reranker declaring no window, a long QUESTION is cut to 2,045 characters — its head kept',
    hugeBodies().length > 0 && hugeBodies().every((b) => String(b.query).length <= 2045 && hugeQuery.startsWith(String(b.query))),
    JSON.stringify(hugeBodies().map((b) => String(b.query ?? '').length)));
  // …and the question is COUNTED after NFKC, as the tokenizer counts it, and SENT as written. ㌚ is one character that
  // normalises to five (ミリバール), so a question of ~1,000 of them is ~5,000 characters to the tokenizer: counted raw it
  // passes the 2,045 cap whole, counted after NFKC it is cut to a head whose normalised length fits. Confirmed to FAIL
  // with the raw count (the whole 1,020-character question sent, 5,020 after NFKC).
  const compatQ = 'zzcompatq 天文社楼顶气温记录 ' + '㌚'.repeat(1000);
  const beforeCompatQ = hits.length;
  await cUnwin.call('recall_facts', { query: compatQ, limit: 5 });
  const compatQBodies = () => hits.slice(beforeCompatQ)
    .filter((h) => h.path === '/v1/rerank' && h.model === UNWINDOWED_RERANK && h.body.includes('zzcompatq'))
    .map((h) => { try { return JSON.parse(h.body); } catch { return null; } })
    .filter(Boolean);
  await until(() => compatQBodies().length > 0, 60000).catch(() => {});
  ok('THE POINT: …and a question dense in compatibility characters is cut by its NFKC length — sent as written, its head kept',
    compatQBodies().length > 0 && nfkc(compatQ).length > 2045 && compatQBodies().every((b) => {
      const q = String(b.query ?? '');
      return nfkc(q).length <= 2045 && compatQ.startsWith(q) && q.includes('㌚');
    }),
    JSON.stringify(compatQBodies().map((b) => ({ raw: String(b.query ?? '').length, nfkc: nfkc(String(b.query ?? '')).length }))));
  windowedServer.stop(); windowedServer = null;
  unwindowedServer.stop(); unwindowedServer = null;

  // --- 6e. on a SLOW machine a long note is read in fewer windows — as many as the verification has time for ----------
  // The per-call ceiling (480 windows) is a count tuned on one GPU. On a CPU-only machine the same call can outlast the
  // verification deadline, and a verification cut off there is NoOpinion after a minute's wait, reported nowhere a
  // household looks. So a chunked call is sized by TIME (RerankPace): the provider times each call it makes, in ms per
  // PAIR token (counted from the characters by script), and gives a long candidate only the windows its budget — half
  // the verification deadline — predicts this machine can score. Here the deadline knob is 12 s (a 6 s budget) and the
  // fake answers in 1.6 ms per pair token. The long note is Chinese: five 1,000-character windows are ~4,230 pair tokens,
  // ~6.8 s — over the budget, 5 s inside the deadline. At the seed that call is just big enough to teach (its scoring
  // predicted at ~212 ms, the floor 200 — RerankPace.MinSignalFactor).
  //   1. Before anything was timed, the GPU seed sizes it: all 5 windows, answered — the pace sees a slow call.
  //   2. A LONE slow call is not believed at once (it could be a model reloading): the estimate moves halfway in log
  //      space, at most ×4, which still allows all 5 windows. Believing it at once gives fewer — confirmed to FAIL so.
  //   3. The second slow call in a row is believed: fewer windows, head and tail still read, still a verdict.
  //   4. A fast PASS-THROUGH recall (a ~900-character fact, one window) big enough to teach — it may raise the estimate
  //      but never lowers it, so…
  //   5. …the long note is still read in fewer windows. Letting that call pull the estimate halfway down gives all 5
  //      again — confirmed to FAIL so.
  //   6. A SLOW recall of a SHORT fact alone (~33 pair tokens, ~3.3 s): too small to measure, so it teaches nothing — its
  //      time would be mostly overhead or a stall on any real machine, and ~98 ms per token read from it is a phantom.
  //   7. The long note is still read in fewer windows, not cut to its first. Without the floor that one call raises the
  //      estimate ×4 at least and the long note gets 1 window — confirmed to FAIL so.
  // Steps 5 and 7 assert "fewer than 5, at least 2", so a loaded fleet that makes the fake's calls read a little slower
  // moves them between 4 and 3 windows without failing; the floor makes step 6 a strict no-op, and step 4's call is far
  // from the "slower" line (it would need ~1.3 s against a fake that answers at once).
  paceServer = startServer({
    dataDir: paceDir, port: PACE_PORT,
    env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl, GATHERLIGHT_JUDGE_DEADLINE_SECONDS: '12' },
  });
  const paceBase = `http://127.0.0.1:${PACE_PORT}`;
  await waitHealthy(paceBase);
  const cPace = makeClient(paceBase);
  const paceJudge = layerOf(await cPace.getJson('/api/manage/memory'), 'judge');
  ok('(fixture) 判断 runs on the slow reranker',
    paceJudge.activeSource === 'llama-cpp' && paceJudge.activeModel === SLOW_RERANK,
    JSON.stringify({ active: paceJudge.activeSource, activeModel: paceJudge.activeModel }));
  const paceLong = 'zzpacehead 读书会每月第一个周六在图书馆见面。' + '读书会的书单与讨论记录。'.repeat(330) + ' zzpacetail';
  // Words shared with neither the long note nor each other, so each recall below is exactly the call it describes.
  const paceMid = 'zzpacemid The chess tournament schedule: ' + 'rounds start at nine, bring a clock and a notation sheet. '.repeat(15);
  const paceShort = 'zzpaceshort The swimming lesson moved to Tuesday afternoons at the leisure pool.';
  for (const [topic, content, name] of [['zzpacetopic 读书会', paceLong, 'long note'],
    ['zzpacemidtopic chess tournament', paceMid, 'one-window fact'], ['zzpaceshorttopic swimming lesson', paceShort, 'short fact']]) {
    const wrote = await cPace.call('remember_fact', {
      kind: 'household', topic, content, source: 'https://example.test/zzpace', confidence: 0.8,
    });
    ok(`(fixture) the ${name} is stored`, wrote.status === 200 && wrote.result?.ok === true, JSON.stringify(wrote.result));
  }
  const paceQuery = 'zzpacequery 读书会每月第一个周六在图书馆见面';
  const midQuery = 'zzpacemidquery chess tournament rounds clock notation';
  const shortQuery = 'zzpaceshortquery swimming lesson Tuesday leisure pool';
  // Each recall's own requests: from where it started to where it returned (a cut-off request is recorded on arrival).
  const rerankDocs = (span, token) => hits.slice(span.from, span.to)
    .filter((h) => h.path === '/v1/rerank' && h.model === SLOW_RERANK && h.body.includes(token))
    .flatMap((h) => { try { return JSON.parse(h.body).documents ?? []; } catch { return []; } })
    .map(String);
  const windowsOf = (span, token, note) => rerankDocs(span, token).filter((d) => d.length > 100 && note.includes(d)
    && d !== note);
  const shapeOf = (list, head, tail) => JSON.stringify({ windows: list.length, head: list.some((d) => d.includes(head)),
    tail: list.some((d) => d.includes(tail)) });
  const paceWindows = (span) => windowsOf(span, 'zzpacequery', paceLong);
  const windowShape = (list) => shapeOf(list, 'zzpacehead', 'zzpacetail');
  const timedRecall = async (cl, query) => {
    const from = hits.length;
    const started = Date.now();
    const result = await cl.call('recall_facts', { query, limit: 5 });
    return { from, to: hits.length, result, ms: Date.now() - started };
  };
  // A recall whose only candidate is `fact`, sent whole: a pass-through call — no window of the long note.
  const passThrough = (span, token, fact) => {
    const docs = rerankDocs(span, token);
    return docs.includes(fact) && !docs.some((d) => d !== fact && paceLong.includes(d));
  };
  slowMsPerToken = 1.6;
  const p1 = await timedRecall(cPace, paceQuery);
  const p2 = await timedRecall(cPace, paceQuery);
  const p3 = await timedRecall(cPace, paceQuery);
  slowMsPerToken = 0;
  const p4 = await timedRecall(cPace, midQuery);
  slowMsPerToken = 1.6;
  const p5 = await timedRecall(cPace, paceQuery);
  slowMsPerToken = 100;
  const p6 = await timedRecall(cPace, shortQuery);
  slowMsPerToken = 1.6;
  const p7 = await timedRecall(cPace, paceQuery);
  slowMsPerToken = 0;
  const [w1, w2, w3, w5, w7] = [p1, p2, p3, p5, p7].map(paceWindows);
  const at = (p) => `${verdictShape(p.result)} in ${p.ms} ms`;
  ok('(non-vacuity) before anything was timed, the long note went as all 5 windows — and that slow call still came back as a verdict',
    w1.length === 5 && judgedPage(p1.result), `${windowShape(w1)} ${at(p1)}`);
  ok('THE POINT: ONE slow call is not believed at once — the same recall again still reads all 5 windows, and is a verdict',
    w2.length === 5 && judgedPage(p2.result), `${windowShape(w2)} ${at(p2)}`);
  ok('THE POINT: the SECOND slow call in a row is believed — the long note is read in FEWER windows, its head and tail still',
    w3.length >= 2 && w3.length < 5 && w3.some((d) => d.includes('zzpacehead')) && w3.some((d) => d.includes('zzpacetail')),
    `first ${windowShape(w1)} · second ${windowShape(w2)} · third ${windowShape(w3)}`);
  // A verdict, not a speed-up: the time is printed, never asserted — two recalls a second apart differ by noise too.
  ok('…and that recall is still a verdict', judgedPage(p3.result), at(p3));
  ok('(non-vacuity) the one-window recall was a fast PASS-THROUGH call — the fact sent whole, no window of the long note — and a verdict',
    passThrough(p4, 'zzpacemidquery', paceMid) && judgedPage(p4.result),
    `${JSON.stringify(rerankDocs(p4, 'zzpacemidquery').map((d) => d.slice(0, 24)))} ${at(p4)}`);
  ok('THE POINT: a fast pass-through call big enough to teach does NOT pull the estimate back down — the long note is still read in fewer windows',
    w5.length >= 2 && w5.length < 5 && judgedPage(p5.result), `${windowShape(w5)} ${at(p5)}`);
  ok('(non-vacuity) the short-fact recall was a SLOW pass-through call — the short fact alone — and a verdict',
    passThrough(p6, 'zzpaceshortquery', paceShort) && p6.ms >= 3000 && judgedPage(p6.result),
    `${JSON.stringify(rerankDocs(p6, 'zzpaceshortquery').map((d) => d.slice(0, 24)))} ${at(p6)}`);
  ok('THE POINT: a slow call too SMALL to measure teaches nothing — the long note is still read in fewer windows, not cut to its first',
    w7.length >= 2 && w7.length < 5 && judgedPage(p7.result), `${windowShape(w7)} ${at(p7)}`);
  const logOf = (dir) => {
    const logs = path.join(dir, 'state', 'logs');
    return fs.existsSync(logs) ? fs.readdirSync(logs).map((n) => fs.readFileSync(path.join(logs, n), 'utf8')).join('\n') : '';
  };
  const paceLog = () => logOf(paceDir);
  ok('…and state/logs says why: fewer windows per long candidate, to fit the time the call has',
    /window\(s\) per long candidate instead of 5, so the call fits ~6 s/.test(paceLog()),
    paceLog().split('\n').filter((l) => /per long candidate/.test(l)).slice(-2).join(' | ') || '(no such line)');
  //   8. A user's STOP — the recall abandoned BEFORE its call was due to finish (the client's request aborted, which
  //      cancels the tool call) — proves nothing about the machine, so the router is presumed busy only for the REST of
  //      what the estimate predicted for that call, not for twice the time it ran (RerankPace.AtLeast). Stopped at ~55% of
  //      the call's cost, the next recall ~80% of that cost later finds the fake done and nothing presumed: it is SENT and
  //      judged. With twice the time it ran presumed, it falls inside the presumption and is skipped — confirmed to FAIL so.
  const pause = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  slowMsPerToken = 1.6;
  const stopFrom = hits.length;
  const stopper = new AbortController();
  const stopCall = fetch(`${paceBase}/api/tools/call`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: stopper.signal,
    body: JSON.stringify({ name: 'recall_facts', arguments: { query: paceQuery, limit: 5 } }),
  }).then(async (r) => `answered ${r.status}`, (e) => (e?.name === 'AbortError' ? 'aborted' : String(e)));
  const stopHit = await until(() => hits.slice(stopFrom).find((h) => h.path === '/v1/rerank' && h.model === SLOW_RERANK), 30000)
    .catch(() => null);
  let stopCost = 0;
  if (stopHit) {
    const b = JSON.parse(stopHit.body);
    stopCost = (b.documents ?? []).reduce((a, d) => a + fakeTokens(String(b.query ?? '')) + fakeTokens(String(d)), 0) * slowMsPerToken;
    await pause(stopHit.at + 0.55 * stopCost - Date.now());
  }
  stopper.abort();
  const stopOutcome = await stopCall;
  await pause((stopHit?.at ?? Date.now()) + 1.35 * stopCost - Date.now());
  const p8 = await timedRecall(cPace, paceQuery);
  slowMsPerToken = 0;
  const p8Calls = hits.slice(p8.from, p8.to).filter((h) => h.path === '/v1/rerank' && h.model === SLOW_RERANK);
  ok('(non-vacuity) a long-note recall was STOPPED by its client partway through its rerank call',
    !!stopHit && stopCost >= 2000 && stopOutcome === 'aborted', JSON.stringify({ arrived: !!stopHit, costMs: Math.round(stopCost), stopOutcome }));
  ok('THE POINT: a user\'s stop proves nothing — the next recall, once the fake has finished the stopped call, is SENT and judged, not skipped behind a presumed queue',
    p8Calls.length >= 1 && judgedPage(p8.result), `${p8Calls.length} request(s) ${at(p8)}`);
  paceServer.stop(); paceServer = null;

  // --- 6f. after a call the DEADLINE CUT, one window per candidate until a call answers ------------------------------
  // On a machine slow enough, the first long-note recall (sized by the GPU seed) outlasts the verification deadline and
  // comes back unjudged after the full wait. The cut proves only a LOWER bound on this machine's pace: sized to it, the
  // next call is half as big, and is cut again whenever the first one's true time was over twice the deadline — a
  // machine 30× slower would wait the minute four times running. So after a cut past the budget RerankPace is AfterCut:
  // ONE window per candidate — the fewest that scores them all — until a call answers, and that answer is believed whole.
  // Here the deadline knob is 6 s (a 3 s budget) and the fake answers in 4 ms per pair token: all 5 windows would take
  // ~17 s, 2.8× the deadline, so the first recall is cut at 6 s and is NoOpinion (`answered` absent — Lyntai sets it only
  // when a verdict was judged). The next reads ONE window, ~3.4 s, and gets its verdict. Sized by the lower bound instead,
  // it reads 2, ~6.8 s, and is cut again — confirmed to FAIL so (and with AtLeast disabled altogether, 5 again).
  // THE QUEUE (docs/judge-bench.md Run 8): the fake, like llama-server, goes on scoring the abandoned call — ~11 s more —
  // and the pace presumes it busy for twice as long as the call ran (~12 s). So a recall made AT ONCE after the cut is
  // SKIPPED — nothing sent, no verdict, fast — where sending it would queue behind the abandoned batch and be cut too
  // (confirmed to FAIL so with the presumption removed: the second recall is sent, waits, and is cut). The one-window
  // recall is made once the presumption has run out, read from the skip line's own figure.
  cutoffServer = startServer({
    dataDir: cutoffDir, port: CUTOFF_PORT,
    env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl, GATHERLIGHT_JUDGE_DEADLINE_SECONDS: '6' },
  });
  const cutBase = `http://127.0.0.1:${CUTOFF_PORT}`;
  await waitHealthy(cutBase);
  const cCut = makeClient(cutBase);
  const cutJudge = layerOf(await cCut.getJson('/api/manage/memory'), 'judge');
  ok('(fixture) 判断 runs on the slow reranker, on a server of its own',
    cutJudge.activeSource === 'llama-cpp' && cutJudge.activeModel === SLOW_RERANK,
    JSON.stringify({ active: cutJudge.activeSource, activeModel: cutJudge.activeModel }));
  const cutLong = 'zzcuthead 摄影社每月最后一个周日去湿地公园拍鸟。' + '摄影社的器材清单与出行记录。'.repeat(290) + ' zzcuttail';
  const wroteCut = await cCut.call('remember_fact', {
    kind: 'household', topic: 'zzcuttopic 摄影社', content: cutLong,
    source: 'https://example.test/zzcut', confidence: 0.8,
  });
  ok('(fixture) the long note is stored', wroteCut.status === 200 && wroteCut.result?.ok === true, JSON.stringify(wroteCut.result));
  const cutQuery = 'zzcutquery 摄影社每月最后一个周日去湿地公园拍鸟';
  const cutWindows = (span) => windowsOf(span, 'zzcutquery', cutLong);
  const cutShape = (list) => shapeOf(list, 'zzcuthead', 'zzcuttail');
  // Every /v1/rerank request of this model a recall made (the fake records a request on arrival, cut-off ones included).
  const rerankCalls = (span) => hits.slice(span.from, span.to).filter((h) => h.path === '/v1/rerank' && h.model === SLOW_RERANK);
  // The pace's skip line (RerankAdmission.Skipped) — "per candidate … (none is long)" on a recall of short facts — and,
  // when the router was presumed busy, for how much longer.
  const SKIP_LINE = /0 window\(s\) per (?:long )?candidate instead of \d+(?: \(none is long\))? — the judge is skipped for this recall/;
  const QUEUE_CLAUSE = /behind the ~([\d.]+) s the router is presumed still busy with a call abandoned earlier/;
  slowMsPerToken = 4;
  const cut1 = await timedRecall(cCut, cutQuery);
  const cutQueued = await timedRecall(cCut, cutQuery);
  const queuedSkip = logOf(cutoffDir).split('\n').filter((l) => SKIP_LINE.test(l)).at(-1) ?? '';
  const presumed = Number((QUEUE_CLAUSE.exec(queuedSkip) ?? [])[1]);
  // Past the presumption the skip line itself states, with a margin — the fake has long finished by then (~11 s).
  await new Promise((r) => setTimeout(r, (Number.isFinite(presumed) ? presumed : 12) * 1000 + 1500));
  const cut2 = await timedRecall(cCut, cutQuery);
  slowMsPerToken = 0;
  // A window cut from the note, or the head alone: with one window per candidate the note goes as its first 1,000.
  const [cw1, cw2] = [cut1, cut2].map(cutWindows);
  const cutPage = (r) => r.status === 200 && r.result?.ranked === 'graph' && r.result?.answered === undefined
    && (r.result?.facts ?? []).some((f) => String(f.content ?? '').includes('zzcuthead'));
  ok('(non-vacuity) the first recall sent all 5 windows and the deadline CUT it — the engine\'s page, no verdict — its true time ~2.8× the deadline',
    cw1.length === 5 && cutPage(cut1.result), `${cutShape(cw1)} ${at(cut1)}`);
  ok('THE POINT: a recall made AT ONCE after the cut sends NOTHING — the router is presumed still scoring the abandoned call — and comes back fast, the engine\'s page, no verdict',
    rerankCalls(cutQueued).length === 0 && cutPage(cutQueued.result) && cutQueued.ms < 3000,
    `${rerankCalls(cutQueued).length} request(s) ${at(cutQueued)}`);
  ok('…and the log says so: skipped, behind the ~12 s the abandoned call is presumed to hold the router (twice the 6 s it ran)',
    SKIP_LINE.test(queuedSkip) && presumed >= 10 && presumed <= 13, queuedSkip || '(no skip line)');
  ok('THE POINT: once that has passed, the next recall reads ONE window per candidate — and comes back within the deadline with its verdict',
    cw2.length === 1 && cw2[0].includes('zzcuthead') && judgedPage(cut2.result), `${cutShape(cw2)} ${at(cut2)}`);
  const cutLog = logOf(cutoffDir);
  ok('…and the log says why — one window until a call answers in time — and names ONE cut, not two',
    /1 window\(s\) per long candidate instead of 5, until a call answers in time/.test(cutLog)
      && (cutLog.match(/gave no verdict within 6 s/g) ?? []).length === 1,
    cutLog.split('\n').filter((l) => /verdict within|per long candidate/.test(l)).slice(-3).join(' | ') || '(no such line)');
  cutoffServer.stop(); cutoffServer = null;

  // --- 6g. a pace learned on ENGLISH sizes a CHINESE note by its tokens -----------------------------------------------
  // A cross-encoder's cost follows tokens, and a character of Chinese is ~0.83 tokens where one of English is ~0.25
  // (measured). A pace per CHARACTER learned on English therefore under-predicts the same number of Chinese characters
  // by ~3.3× — more than the half-deadline margin. Here (the deadline knob 16 s, an 8 s budget; the fake at 2.2 ms per
  // pair token) two recalls of FOUR long English notes teach the pace — ~5,270 pair tokens, so big enough to teach at the
  // seed, ~11.6 s each, all 5 windows of each note; then two long CHINESE notes are recalled. Counted by script, their
  // 10 windows are ~18.6 s, so each is read in fewer and the call comes back with a verdict. Counted per character, the
  // English rate predicts ~5.6 s, all 10 windows go, and the call is cut at 16 s — confirmed to FAIL so.
  scriptServer = startServer({
    dataDir: scriptDir, port: SCRIPT_PORT,
    env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl, GATHERLIGHT_JUDGE_DEADLINE_SECONDS: '16' },
  });
  const scriptBase = `http://127.0.0.1:${SCRIPT_PORT}`;
  await waitHealthy(scriptBase);
  const cScript = makeClient(scriptBase);
  const enNotes = [1, 2, 3, 4].map((i) => `zzen${i}head The chess club meets on Wednesday evenings in the community hall. `
    + 'The chess club keeps a list of openings and the notes of every game. '.repeat(58) + ` zzen${i}tail`);
  const zhA = 'zzzhAhead 合唱团每周四晚上在社区礼堂排练。' + '合唱团的曲目单与排练记录。'.repeat(310) + ' zzzhAtail';
  const zhB = 'zzzhBhead 合唱团每周四晚上在社区礼堂排练。' + '合唱团的演出安排与服装清单。'.repeat(288) + ' zzzhBtail';
  // The Chinese notes are written only after the English recalls, so they cannot be candidates of theirs.
  const writeNote = async (topic, content, name) => {
    const wrote = await cScript.call('remember_fact', {
      kind: 'household', topic, content, source: 'https://example.test/zzscript', confidence: 0.8,
    });
    ok(`(fixture) the long ${name} note is stored`, wrote.status === 200 && wrote.result?.ok === true, JSON.stringify(wrote.result));
  };
  const enQuery = 'zzenquery chess club Wednesday evenings community hall';
  const zhQuery = 'zzzhquery 合唱团每周四晚上在社区礼堂排练';
  for (const [i, note] of enNotes.entries()) await writeNote(`zzen${i + 1}topic chess club`, note, `English #${i + 1}`);
  slowMsPerToken = 2.2;
  const e1 = await timedRecall(cScript, enQuery);
  const e2 = await timedRecall(cScript, enQuery);
  slowMsPerToken = 0;
  await writeNote('zzzhAtopic 合唱团', zhA, 'Chinese A');
  await writeNote('zzzhBtopic 合唱团', zhB, 'Chinese B');
  slowMsPerToken = 2.2;
  const z1 = await timedRecall(cScript, zhQuery);
  slowMsPerToken = 0;
  const enWindows = (span) => rerankDocs(span, 'zzenquery').filter((d) => d.length > 100 && enNotes.some((n) => n.includes(d) && d !== n));
  const [ew1, ew2] = [e1, e2].map(enWindows);
  const [zaw, zbw] = [zhA, zhB].map((n) => windowsOf(z1, 'zzzhquery', n));
  ok('(non-vacuity) the four English notes were read in all 5 windows each (20), twice, each a verdict — the pace learned from English',
    ew1.length === 20 && ew2.length === 20 && judgedPage(e1.result) && judgedPage(e2.result),
    `${ew1.length} · ${ew2.length} windows; ${at(e1)} · ${at(e2)}`);
  ok('THE POINT: the Chinese notes, as long in characters, are read in FEWER windows each — sized by their tokens — and the recall gets its verdict',
    zaw.length >= 1 && zaw.length < 5 && zbw.length >= 1 && zbw.length < 5 && judgedPage(z1.result),
    `A ${shapeOf(zaw, 'zzzhAhead', 'zzzhAtail')} · B ${shapeOf(zbw, 'zzzhBhead', 'zzzhBtail')} ${at(z1)}`);
  scriptServer.stop(); scriptServer = null;

  // --- 6h. where even ONE window per candidate cannot fit, the judge is SKIPPED at once — and re-measured later -------
  // docs/judge-bench.md Run 8: on a CPU, BGE needed 80–120 s for a recall of 40–60 long notes at one window each, and 230
  // of 240 recalls waited out the minute for no verdict. No sizing can fix that — fewer windows than candidates would
  // leave one unscored — so the pace SKIPS such a recall: nothing sent, NoOpinion at once, decided ABOVE Lyntai
  // (RerankAdmission), so no verdict reaches it. Here the deadline knob is 3 s: a sized call has 1.5 s, a one-window call
  // may be predicted up to 2.4 s (0.8 of the deadline) while the estimate comes from an answer and 1.5 s after a cut, and
  // the re-probe interval — ten deadlines — is 30 s. The recall's candidates are EIGHT notes of ~950 characters, each one
  // window already (a pass-through call of ~6,250 pair tokens: big enough to teach at the seed, ~0.36 s predicted there).
  // The fake takes ~0.93 ms per pair token, so that call takes ~5.8 s, ~2× the deadline:
  //   1. the first recall, sized by the GPU seed, is sent and CUT at 3 s. ALONE, that cut is DAMPED — at most ×4, so one
  //      stall does not switch the judge off (case 6i);
  //   2. at once after it, a recall is SKIPPED behind the presumed queue — and the 判断 row now COUNTS the skip and offers
  //      mMiniLMv2, as 资源's badge now does beside the installed reranker (before any skip: neither says anything);
  //   3. with ~1 s of the presumption left, a SHORT-fact recall — ~50 ms predicted, so presumption plus prediction fit the
  //      budget — is skipped too: nothing is sent while the router is presumed busy. A queued call's cut teaches nothing
  //      and extends the presumption, so a slow machine could wait again and again without learning — confirmed to FAIL,
  //      the call sent and judged, when a send only had to fit the budget with the queue added. Its line says
  //      "per candidate … (none is long)";
  //   4. once the presumption has run out, the big recall is SENT — the damped estimate predicts it at ~1 s — and CUT again:
  //      a truly slow machine waits the deadline TWICE, the price of damping. The second cut, a repeat, is believed;
  //   5. at once after it, skipped behind the queue; once that has run out, SKIPPED for the pace alone: fast, nothing sent;
  //   6. a SHORT-fact recall fits and is sent — a pass-through call — and must NOT restart the interval: a pass-through
  //      answer can raise the estimate and never lower it, so short-fact recalls coming more often than the interval
  //      would otherwise keep a machine that became fast in the skip for good (confirmed to FAIL, step 7 skipped with
  //      nothing sent, when every sent call restarts the interval);
  //   7. once 30 s have passed since the FIRST skip — the interval runs from the last call that could LOWER the estimate (a
  //      chunked one or a probe), and both cut calls were pass-through — a skipped recall sends a PROBE: the first window
  //      of ONE candidate, sized to a sixth of the budget at the estimate, which reads the machine as slow as it is, so the
  //      recall is still skipped (a real call was sent, and the judge still did not wait);
  //   8. at once after the probe, skipped again with nothing sent — a probe restarts the interval;
  //   9. a recall of THREE ~840-character notes, one window each predicted at that estimate at ~1.9 s — past the 1.5 s a
  //      SIZED call has, inside the 2.4 s a one-window call may take — is SENT and judged (~1.9 s at the fake). Held to the
  //      half-deadline budget, as the first version was, it is skipped — confirmed to FAIL so;
  //  10. once 30 s have passed again, the fake is FAST (its GPU freed): the probe reads it so, and the SAME recall sends the
  //      whole call and gets its verdict.
  // With the skip removed, steps 2, 3 and 5 each send the call and wait out the deadline — confirmed to FAIL so.
  skipServer = startServer({
    dataDir: skipDir, port: SKIP_PORT,
    env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl, GATHERLIGHT_JUDGE_DEADLINE_SECONDS: '3' },
  });
  const skipBase = `http://127.0.0.1:${SKIP_PORT}`;
  await waitHealthy(skipBase);
  const cSkip = makeClient(skipBase);
  const skipJudge = layerOf(await cSkip.getJson('/api/manage/memory'), 'judge');
  ok('(fixture) 判断 runs on the slow reranker, on a server of its own',
    skipJudge.activeSource === 'llama-cpp' && skipJudge.activeModel === SLOW_RERANK,
    JSON.stringify({ active: skipJudge.activeSource, activeModel: skipJudge.activeModel }));
  // Eight notes of ~950 characters — under the 1,000-character window, so each is sent whole.
  const skipNotes = [1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
    `zzskip${i}head 园艺社每月第二个周六在社区花园劳动。` + '园艺社的种子清单与劳动记录。'.repeat(64) + ` zzskip${i}tail`);
  for (const [i, note] of skipNotes.entries()) {
    const wrote = await cSkip.call('remember_fact', {
      kind: 'household', topic: `zzskip${i + 1}topic 园艺社`, content: note,
      source: 'https://example.test/zzskip', confidence: 0.8,
    });
    ok(`(fixture) note #${i + 1} is stored`, wrote.status === 200 && wrote.result?.ok === true, JSON.stringify(wrote.result));
  }
  const skipShort = 'zzskipshort The swimming lesson moved to Tuesday afternoons at the leisure pool.';
  const wroteShort = await cSkip.call('remember_fact', {
    kind: 'household', topic: 'zzskipshorttopic swimming lesson', content: skipShort,
    source: 'https://example.test/zzskip', confidence: 0.8,
  });
  ok('(fixture) the short fact is stored', wroteShort.status === 200 && wroteShort.result?.ok === true, JSON.stringify(wroteShort.result));
  // Step 9's three notes: ~840 characters each, in words none of the others share.
  const fitNotes = [1, 2, 3].map((i) =>
    `zzfit${i}head 书法班逢周三晚上去文化馆上课。` + '毛笔宣纸墨汁砚台都放进储物柜里。'.repeat(51) + ` zzfit${i}tail`);
  for (const [i, note] of fitNotes.entries()) {
    const wrote = await cSkip.call('remember_fact', {
      kind: 'household', topic: `zzfit${i + 1}topic 书法班`, content: note,
      source: 'https://example.test/zzfit', confidence: 0.8,
    });
    ok(`(fixture) step 9's note #${i + 1} is stored`, wrote.status === 200 && wrote.result?.ok === true, JSON.stringify(wrote.result));
  }
  const skipQuery = 'zzskipquery 园艺社每月第二个周六在社区花园劳动';
  const skipShortQuery = 'zzskipshortquery swimming lesson Tuesday leisure pool';
  const fitQuery = 'zzfitquery 书法班逢周三晚上去文化馆上课';
  const MMINILM = 'mmarco-mMiniLMv2-L12-H384-v1-Q8_0';
  const skipLog = () => logOf(skipDir);
  const skipLines = () => skipLog().split('\n').filter((l) => SKIP_LINE.test(l));
  const queueLeft = (line) => Number((QUEUE_CLAUSE.exec(line) ?? [])[1]);
  // The documents of each /v1/rerank request a recall made.
  const requestDocs = (span) => rerankCalls(span).map((h) => { try { return (JSON.parse(h.body).documents ?? []).map(String); } catch { return []; } });
  const skippedPage = (r) => r.status === 200 && r.result?.ranked === 'graph' && r.result?.answered === undefined
    && (r.result?.facts ?? []).some((f) => String(f.content ?? '').includes('zzskip'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  const judgeBefore = layerOf(await cSkip.getJson('/api/manage/memory'), 'judge');
  const shelfBefore = await cSkip.getJson('/api/manage/models');
  slowMsPerToken = 0.93;
  const s1 = await timedRecall(cSkip, skipQuery);
  const s2 = await timedRecall(cSkip, skipQuery);
  const s2At = Date.now() - s2.ms;
  const s2Line = skipLines().at(-1) ?? '';
  const judgeAfterSkip = layerOf(await cSkip.getJson('/api/manage/memory'), 'judge');
  const shelfAfterSkip = await cSkip.getJson('/api/manage/models');
  // The same, with NO embedder installed (final review): the skip is a repair, and it outranks the embedder suggestion —
  // which used to come first, so the 判断 row's promise that 资源 recommends mMiniLMv2 was false until one was installed.
  const skipEmbedder = path.join(skipDir, 'state', 'resources', 'gguf', 'embeddinggemma-300M-Q8_0.gguf');
  fs.rmSync(skipEmbedder);
  const shelfSkipNoEmbedder = await cSkip.getJson('/api/manage/models');
  fs.writeFileSync(skipEmbedder, '');
  // Step 3: ~1 s before the presumption the skip line stated runs out.
  const presumptionEnds = s2At + (queueLeft(s2Line) || 6) * 1000;
  await sleep(presumptionEnds - 1000 - Date.now());
  const sQueued = await timedRecall(cSkip, skipShortQuery);
  const sQueuedLine = skipLines().at(-1) ?? '';
  // Step 4, past it: the fake finished the abandoned call ~3 s earlier.
  await sleep(presumptionEnds + 1500 - Date.now());
  const s3 = await timedRecall(cSkip, skipQuery);
  const s3b = await timedRecall(cSkip, skipQuery);
  const s3bLine = skipLines().at(-1) ?? '';
  await sleep((queueLeft(s3bLine) || 6) * 1000 + 1500);
  const s3c = await timedRecall(cSkip, skipQuery);
  const s3cLine = skipLines().at(-1) ?? '';
  const sShort = await timedRecall(cSkip, skipShortQuery);
  // The re-probe interval (30 s) runs from the first skip — the second recall's — so wait past it, with a margin.
  await sleep(s2At + 30_000 + 2_000 - Date.now());
  const s4 = await timedRecall(cSkip, skipQuery);
  const s4Line = skipLines().at(-1) ?? '';
  const s4At = Date.now() - s4.ms;
  const s5 = await timedRecall(cSkip, skipQuery);
  const sFit = await timedRecall(cSkip, fitQuery);
  await sleep(s4At + 30_000 + 2_000 - Date.now());
  slowMsPerToken = 0;
  const s6 = await timedRecall(cSkip, skipQuery);
  const docCounts = (span) => JSON.stringify(requestDocs(span).map((d) => d.length));
  ok('(non-vacuity) the first recall sent all eight notes whole in ONE call, and the deadline CUT it — the engine\'s page, no verdict',
    requestDocs(s1).length === 1 && requestDocs(s1)[0].length >= 8 && skippedPage(s1.result) && s1.ms >= 3000,
    `requests ${docCounts(s1)} ${at(s1)}`);
  ok('THE POINT: at once after the cut, a recall sends nothing and comes back fast — the engine\'s page, no verdict',
    rerankCalls(s2).length === 0 && skippedPage(s2.result) && s2.ms < 1500, `${rerankCalls(s2).length} request(s) ${at(s2)}`);
  ok('(control) before any recall was skipped, the 判断 row said nothing about skips and 资源 recommended nothing — a reranker is installed (the one-reranker rule)',
    judgeBefore.pace == null && shelfBefore.recommendation == null,
    JSON.stringify({ pace: judgeBefore.pace ?? null, recommendation: shelfBefore.recommendation ?? null }));
  const paceText = String(judgeAfterSkip.pace?.text ?? '');
  ok('THE POINT: after a skip, the 判断 row SAYS so — how many of the recent recalls were skipped — and offers mMiniLMv2 to download, whatever the device probe says, and what one laptop\'s integrated GPU did (Run 8b) — never the old "not measured"',
    judgeAfterSkip.pace?.skipped >= 1 && judgeAfterSkip.pace?.recalls >= judgeAfterSkip.pace?.skipped
      && paceText.includes(`最近 ${judgeAfterSkip.pace?.recalls} 次检索里有 ${judgeAfterSkip.pace?.skipped} 次因为这台机器太慢`)
      && /下载 mMiniLMv2 改用它/.test(paceText) && judgeAfterSkip.pace?.suggest === `gguf-${MMINILM}`
      && paceText.includes('在同一台笔记本的集成显卡上,它和 BGE 都比它的 CPU 慢(实测和设置见它那一行的说明)')
      && !paceText.includes('还没有量过'),
    JSON.stringify(judgeAfterSkip.pace ?? null));
  const skipRec = shelfAfterSkip.recommendation;
  ok('THE POINT: …and 资源 recommends mMiniLMv2 BESIDE the installed reranker — the one exception to the one-reranker rule — saying why, with Run 8\'s configuration',
    skipRec?.id === MMINILM && /次因为这台机器太慢跳过了判断/.test(String(skipRec?.reason))
      && /Intel Core Ultra 9 185H/.test(String(skipRec?.reason))
      && String(skipRec?.reason ?? '').includes('在同一台笔记本的集成显卡上,两者都比它的 CPU 慢(实测和设置见 mMiniLMv2 那一行的说明)')
      && !String(skipRec?.reason ?? '').includes('还没有量过')
      && /一分多钟到两分钟/.test(String(skipRec?.reason)),
    JSON.stringify(skipRec ?? null));
  ok('THE POINT (final review): …and with NO embedder installed it is STILL mMiniLMv2 — the repair outranks the embedder suggestion',
    shelfSkipNoEmbedder.models?.find((m) => m.id === 'embeddinggemma-300M-Q8_0')?.installed === false
      && shelfSkipNoEmbedder.recommendation?.id === MMINILM
      && /次因为这台机器太慢跳过了判断/.test(String(shelfSkipNoEmbedder.recommendation?.reason)),
    JSON.stringify({ embedder: shelfSkipNoEmbedder.models?.find((m) => m.id === 'embeddinggemma-300M-Q8_0')?.installed,
      rec: shelfSkipNoEmbedder.recommendation ?? null }));
  ok('THE POINT: with ~1 s of the presumed queue left, a SHORT-fact recall — tiny, so queue plus prediction fit the budget — is still skipped: nothing is sent while the router is presumed busy',
    rerankCalls(sQueued).length === 0 && sQueued.result.status === 200 && sQueued.result.result?.answered === undefined
      && sQueued.ms < 1500,
    `${rerankCalls(sQueued).length} request(s) ${at(sQueued)}`);
  ok('…and its line says so, as a recall with no long candidate — per candidate, none is long — behind the queue',
    /0 window\(s\) per candidate instead of 1 \(none is long\) — the judge is skipped for this recall/.test(sQueuedLine)
      && QUEUE_CLAUSE.test(sQueuedLine) && sQueuedLine !== s2Line,
    sQueuedLine || '(no skip line)');
  ok('THE POINT: once the presumption has run out, the big recall is SENT again — the lone cut was damped — and CUT again: a truly slow machine waits the deadline twice',
    requestDocs(s3).length === 1 && requestDocs(s3)[0].length >= 8 && skippedPage(s3.result) && s3.ms >= 3000,
    `requests ${docCounts(s3)} ${at(s3)}`);
  ok('…and at once after that second cut, nothing is sent',
    rerankCalls(s3b).length === 0 && skippedPage(s3b.result) && s3b.ms < 1500, `${rerankCalls(s3b).length} request(s) ${at(s3b)}`);
  ok('THE POINT: the second cut was believed — once its presumption has run out, a recall is STILL skipped, for the pace alone: fast, nothing sent, no verdict',
    rerankCalls(s3c).length === 0 && skippedPage(s3c.result) && s3c.ms < 1500, `${rerankCalls(s3c).length} request(s) ${at(s3c)}`);
  ok('…and the log says so for the pace alone — skipped, predicted past the ~1.5 s a call has after a cut, no queue in the sentence',
    SKIP_LINE.test(s3cLine) && !QUEUE_CLAUSE.test(s3cLine) && /past the ~1\.5 s a call has while the last deadline cut leaves the estimate a lower bound/.test(s3cLine)
      && s3cLine !== s3bLine,
    s3cLine || '(no skip line)');
  ok('(non-vacuity) between them, a SHORT-fact recall fit and was sent — the short fact alone, a pass-through call — and got its verdict',
    requestDocs(sShort).length === 1 && requestDocs(sShort)[0].length === 1 && requestDocs(sShort)[0][0] === skipShort
      && judgedPage(sShort.result), `requests ${docCounts(sShort)} ${at(sShort)}`);
  ok('THE POINT: after the re-probe interval, a real call IS sent again — a PROBE of fewer candidates than the recall has — and, the machine still slow, the recall is still skipped with no verdict',
    requestDocs(s4).length === 1 && requestDocs(s4)[0].length >= 1 && requestDocs(s4)[0].length < 8 && skippedPage(s4.result)
      && s4.ms < 3000,
    `requests ${docCounts(s4)} ${at(s4)}`);
  ok('…and its skip line says what the probe read',
    SKIP_LINE.test(s4Line) && /a probe of \d+ of \d+ candidates' first windows just now read [\d.]+ ms per 1,000 pair tokens/.test(s4Line),
    s4Line || '(no skip line)');
  ok('…and a probe restarts the interval: at once after it, nothing is sent',
    rerankCalls(s5).length === 0 && skippedPage(s5.result), `${rerankCalls(s5).length} request(s) ${at(s5)}`);
  ok('THE POINT: a one-window call predicted past the 1.5 s a SIZED call has, but inside the 2.4 s (0.8 of the deadline) a one-window call may take, is SENT — the three notes whole — and judged',
    requestDocs(sFit).length === 1 && requestDocs(sFit)[0].length === 3
      && requestDocs(sFit)[0].every((d) => fitNotes.includes(d)) && judgedPage(sFit.result) && sFit.ms >= 1500,
    `requests ${docCounts(sFit)} ${at(sFit)}`);
  ok('THE POINT: when the machine has become FAST, the next probe says so and the SAME recall sends the whole call — and gets its verdict',
    requestDocs(s6).length === 2 && requestDocs(s6)[0].length < 8 && requestDocs(s6)[1].length >= 8 && judgedPage(s6.result),
    `requests ${docCounts(s6)} ${at(s6)}`);
  ok('…and the log says it re-measured the machine and the judge runs again — and names TWO deadline cuts in all',
    /re-measured this machine on \d+ of \d+ candidates' first windows: [\d.]+ ms per 1,000 pair tokens, so one window per candidate is predicted at ~[\d.]+ s — the judge runs this recall/.test(skipLog())
      && (skipLog().match(/gave no verdict within 3 s/g) ?? []).length === 2,
    skipLog().split('\n').filter((l) => /verdict within|re-measured/.test(l)).slice(-4).join(' | ') || '(no such line)');
  skipServer.stop(); skipServer = null;

  // --- 6i. ONE stall is not a slow machine: a LONE deadline cut is damped, like a lone slow answer -------------------
  // Believed in full, one GPU stall — a model reloading, the GPU busy elsewhere — switched the judge off: a 70 s stall on
  // a 5,800-token pass-through call, cut at 60 s, set the estimate to 206× the seed, and every recall above ~2,900 pair
  // tokens was then skipped until the ten-minute probe, silently (review, 2026-09-25). So a LONE cut moves the estimate
  // halfway in log space, at most ×4; a second in a row is believed (case 6h). Here the deadline knob is 6 s (a sized call
  // has 3 s, and 3 s is also what a one-window call has after a cut) and the fake answers at once — except the request it
  // is told to STALL, 9 s:
  //   1. a recall of six ~930-character notes (ONE pass-through call, ~4,600 pair tokens — big enough to teach at the seed)
  //      is judged at once: the fake is fast;
  //   2. the same recall, its call stalled, is CUT at 6 s — ~1.3 ms per pair token read from it, ~25× the seed;
  //   3. once the presumed queue has run out, the same recall is SENT and JUDGED: damped, that cut set the estimate to ×4
  //      the seed, which predicts the call at ~1 s. Believed in full it predicts ~6 s, and the recall is skipped —
  //      confirmed to FAIL so;
  //   4. TWO recalls at once — one call stalled 9 s, the other queued behind it in the fake as a real router child queues
  //      it — both CUT. The second was sent while the first was IN FLIGHT, so it is possibly queued and teaches nothing;
  //      the first, alone (step 3's answer was fast), is damped again;
  //   5. once the presumption has run out, the same recall is SENT and JUDGED again (~2.4 s predicted). Had the second
  //      concurrent cut been believed as a repeat, the estimate would be ~25× the seed and the recall skipped — confirmed to
  //      FAIL so, with the in-flight mark removed.
  stallServer = startServer({
    dataDir: stallDir, port: STALL_PORT,
    env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl, GATHERLIGHT_JUDGE_DEADLINE_SECONDS: '6' },
  });
  const stallBase = `http://127.0.0.1:${STALL_PORT}`;
  await waitHealthy(stallBase);
  const cStall = makeClient(stallBase);
  const stallJudge = layerOf(await cStall.getJson('/api/manage/memory'), 'judge');
  ok('(fixture) 判断 runs on the slow reranker, on a server of its own',
    stallJudge.activeSource === 'llama-cpp' && stallJudge.activeModel === SLOW_RERANK,
    JSON.stringify({ active: stallJudge.activeSource, activeModel: stallJudge.activeModel }));
  const stallNotes = [1, 2, 3, 4, 5, 6].map((i) =>
    `zzstall${i}head 合唱团每周四晚上在社区礼堂排练。` + '合唱团的曲目单与排练记录。'.repeat(68) + ` zzstall${i}tail`);
  for (const [i, note] of stallNotes.entries()) {
    const wrote = await cStall.call('remember_fact', {
      kind: 'household', topic: `zzstall${i + 1}topic 合唱团`, content: note,
      source: 'https://example.test/zzstall', confidence: 0.8,
    });
    ok(`(fixture) stall note #${i + 1} is stored`, wrote.status === 200 && wrote.result?.ok === true, JSON.stringify(wrote.result));
  }
  const stallQuery = 'zzstallquery 合唱团每周四晚上在社区礼堂排练';
  // The engine's page with no verdict — what a cut leaves.
  const cutStallPage = (r) => r.status === 200 && r.result?.ranked === 'graph' && r.result?.answered === undefined
    && (r.result?.facts ?? []).some((f) => String(f.content ?? '').includes('zzstall'));
  const stallDocs = (span) => rerankCalls(span).map((h) => { try { return (JSON.parse(h.body).documents ?? []).length; } catch { return -1; } });
  const t0 = await timedRecall(cStall, stallQuery);
  stallNextMs = 9000;
  const t1 = await timedRecall(cStall, stallQuery);
  const t1End = Date.now();
  // The presumption: twice the 6 s the cut call ran, from the cut — the fake answered the stalled call ~3 s after it.
  await sleep(t1End + 12_000 + 1_500 - Date.now());
  const t2 = await timedRecall(cStall, stallQuery);
  stallNextMs = 9000;
  const pairFrom = hits.length;
  const [t3, t4] = await Promise.all([timedRecall(cStall, stallQuery), timedRecall(cStall, stallQuery)]);
  const pairEnd = Date.now();
  const pairHits = hits.slice(pairFrom).filter((h) => h.path === '/v1/rerank' && h.model === SLOW_RERANK);
  await sleep(pairEnd + 12_000 + 1_500 - Date.now());
  const t5 = await timedRecall(cStall, stallQuery);
  ok('(non-vacuity) with the fake fast, the recall of six notes was ONE pass-through call and a verdict',
    JSON.stringify(stallDocs(t0)) === '[6]' && judgedPage(t0.result), `${JSON.stringify(stallDocs(t0))} ${at(t0)}`);
  ok('(non-vacuity) the same recall, its one call stalled, was CUT at the deadline — no verdict',
    JSON.stringify(stallDocs(t1)) === '[6]' && cutStallPage(t1.result) && t1.ms >= 6000,
    `${JSON.stringify(stallDocs(t1))} ${at(t1)}`);
  ok('THE POINT: ONE stall is not believed in full — once the presumed queue has run out, the same big recall is SENT and JUDGED, not skipped',
    JSON.stringify(stallDocs(t2)) === '[6]' && judgedPage(t2.result), `${JSON.stringify(stallDocs(t2))} ${at(t2)}`);
  ok('(non-vacuity) two recalls ran at ONCE — both calls reached the fake within a second of each other — and both were CUT',
    pairHits.length === 2 && Math.abs(pairHits[0].at - pairHits[1].at) < 1000
      && [t3, t4].every((r) => cutStallPage(r.result) && r.ms >= 6000),
    `${pairHits.length} request(s) ${pairHits.length === 2 ? Math.abs(pairHits[0].at - pairHits[1].at) : '-'} ms apart; ${at(t3)} · ${at(t4)}`);
  ok('THE POINT: a call sent while another was IN FLIGHT is possibly queued, and its cut teaches nothing — the next big recall is SENT and JUDGED',
    JSON.stringify(stallDocs(t5)) === '[6]' && judgedPage(t5.result), `${JSON.stringify(stallDocs(t5))} ${at(t5)}`);
  ok('…and no recall of this server was skipped — three cuts, and a skip line nowhere',
    (logOf(stallDir).match(/gave no verdict within 6 s/g) ?? []).length === 3 && !SKIP_LINE.test(logOf(stallDir)),
    logOf(stallDir).split('\n').filter((l) => /verdict within|judge is skipped/.test(l)).slice(-4).join(' | ') || '(no such line)');
  stallServer.stop(); stallServer = null;

  // --- 7. whether a reranker's TAGGING is happening, said where it is decided ---------------------------
  // A reranker hands tagging to the Claude CLI, and a CLI that is signed out means NO tagging — the annotation
  // policy is fail-open, so every fact is written unlabelled and nothing reports it. The 判断 row, the bind
  // toast and the startup warning each used to promise the tagging "carries on". Both servers are bound at
  // boot to a reranker the fake router does not list, so the startup warm fails and its warning is written.
  signedOutServer = startServer({
    dataDir: signedOutDir, port: SIGNED_OUT_PORT,
    env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl, GATHERLIGHT_CLAUDE_CMD: `node ${signedOutStub}` },
  });
  // The judge-input knob rides along on this server (case 7b): it only affects an LLM verifier, and this one
  // runs a reranker, so it changes nothing here except whether the logs say it is set. Pinned to `both` —
  // NOT the default since 2026-09-24 — so the case is still exercising a knob that was actually SET, rather
  // than a value that would now be there anyway. The Lyntai bump that ships ContentChars deletes this knob; 7b
  // then moves to GATHERLIGHT_VERDICT_COMBINATION=fuse (JudgeSeesContentPolicy's class comment, "ON THE BUMP").
  signedInServer = startServer({
    dataDir: signedInDir, port: SIGNED_IN_PORT,
    env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl, GATHERLIGHT_JUDGE_INPUT: 'both' },
  });
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
  // The warm fails here because the router — adopted — does not list the model, and the runtime knows what would
  // load it. That sentence used to reach only the log; the warning said just 没能载入.
  ok('…and the warning carries what would load the model — the process to end — not only 没能载入',
    /llama-server/.test(inWarn) && /重启/.test(inWarn), inWarn || '(no warning naming the model)');
  ok('(control) signed in, the same warning says tagging carries on through the CLI',
    /照常由 Claude CLI/.test(inWarn) && !/登录/.test(inWarn), inWarn || '(no warning naming the model)');

  const outBind = await cOut.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: RERANK_MODEL });
  const inBind = await cIn.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: RERANK_MODEL });
  ok('THE POINT: binding a reranker with the CLI signed out, the toast says no tagging until it signs in',
    outBind.status === 200 && /还没有登录/.test(String(outBind.body?.note)), `${outBind.status} ${JSON.stringify(outBind.body?.note ?? outBind.body)}`);
  ok('(control) signed in, the toast carries no such warning',
    inBind.status === 200 && !/还没有登录/.test(String(inBind.body?.note)), `${inBind.status} ${JSON.stringify(inBind.body?.note ?? inBind.body)}`);

  // --- 7b. a MEASUREMENT KNOB is visible in state/logs ----------------------------------------------------
  // The knobs announced themselves on stdout only, which the desktop Host drops — so an install left running
  // with a bench knob behaved unlike every other with no trace in the logs anyone reads.
  const logsDir = path.join(signedInDir, 'state', 'logs');
  const knobLog = fs.existsSync(logsDir)
    ? fs.readdirSync(logsDir).map((f) => fs.readFileSync(path.join(logsDir, f), 'utf8')).join('\n') : '';
  ok('a measurement knob set at startup is logged as a Warning in state/logs',
    /WARN.*Measurement knob set: judge input = both/.test(knobLog),
    knobLog.split('\n').filter((l) => /knob|measurement/i.test(l)).join(' | ') || '(nothing about the knob in state/logs)');

  // --- 8. a model downloaded AFTER the router started ---------------------------------------------------
  // The household's main path: a layer already runs on llama.cpp, they download a reranker, they bind it.
  // The real router reads its models directory once, so it answers `400 model not found` for the newcomer —
  // measured, and rewriting its preset file does not help; only a restart does. The app restarts a router it
  // STARTED; this one it ADOPTED (the fake was already answering), and killing a process it did not start is
  // not its to do — so the refusal has to say what would load the model, not quote a 400.
  fs.writeFileSync(path.join(rerankResources, 'gguf', `${LATE_RERANK}.gguf`), '');
  // 8a. …while the port ACCEPTS and never answers /v1/models. The probe's 4 s HttpClient timeout arrives as a
  // TaskCanceledException, and the catch filtered on the exception's TYPE, so it escaped as a bare 500 — on the
  // real binary with llama.cpp left stopped. Reading it as "not serving" instead made the app spawn a router
  // BESIDE whatever holds the port and say 「没能启动」. The port is HELD: its own sentence, and no spawn.
  // What the runtime logs when it TRIES to start a router: "llama-server starting: …" once the process exists,
  // "starting llama-server failed: …" when it could not even be started (this fixture's binary is an empty file).
  const rerankLogs = path.join(rerankDir, 'state', 'logs');
  const spawnLines = () => (fs.existsSync(rerankLogs)
    ? fs.readdirSync(rerankLogs).map((n) => fs.readFileSync(path.join(rerankLogs, n), 'utf8')).join('\n') : '')
    .split('\n').filter((l) => /llama-server starting|starting llama-server failed/.test(l));
  const spawnsBefore = spawnLines().length;
  hangModels = true;
  let hungBind;
  try { hungBind = await c3.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: LATE_RERANK }); }
  finally { hangModels = false; }
  await new Promise((r) => setTimeout(r, 500));
  const hungErr = String(hungBind.body?.error ?? '');
  const fakePort = String(fake.address().port);
  ok('THE POINT: a port that accepts and never answers refuses the bind with the HELD sentence — not 「没能启动」',
    hungBind.status === 409 && /llama-server/.test(hungErr) && /没有像 llama\.cpp 那样回答/.test(hungErr) && hungErr.includes(fakePort),
    `${hungBind.status} ${hungErr || JSON.stringify(hungBind.body)}`);
  const spawned = spawnLines().slice(spawnsBefore);
  ok('THE POINT: and no router was spawned beside the held port', spawned.length === 0, JSON.stringify(spawned));
  ok('(anti-vacuity) the held port really was asked for /v1/models', modelsHung > 0, `GET /v1/models hung ${modelsHung} time(s)`);
  const late = await c3.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: LATE_RERANK });
  const lateErr = String(late.body?.error ?? '');
  ok('THE POINT: a model the running router does not know is refused with what would load it — a restart',
    late.status === 409 && /重启/.test(lateErr) && /llama-server/.test(lateErr), `${late.status} ${lateErr || JSON.stringify(late.body)}`);
  // …and once the router knows it (the real one would after its restart), the same bind goes through.
  served.add(LATE_RERANK);
  const lateAgain = await c3.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: LATE_RERANK });
  ok('(control) the same model binds once the router lists it',
    lateAgain.status === 200, `${lateAgain.status} ${JSON.stringify(lateAgain.body)}`);
  // …and on 语义 too. Its bind asks for a PROOF (one embed), which can only say "no vector" — so the runtime's
  // own refusal reached the household as the generic sentence, naming neither the process nor the cure.
  fs.writeFileSync(path.join(rerankResources, 'gguf', `${LATE_EMBED}.gguf`), '');
  const lateSem = await c3.post('/api/manage/memory/layer/semantic', { source: 'llama-cpp', model: LATE_EMBED });
  const lateSemErr = String(lateSem.body?.error ?? '');
  ok('THE POINT: the 语义 bind carries the same sentence — not the generic "no vector" one',
    lateSem.status === 409 && /重启/.test(lateSemErr) && /llama-server/.test(lateSemErr) && !/没有返回向量/.test(lateSemErr),
    `${lateSem.status} ${lateSemErr || JSON.stringify(lateSem.body)}`);

  // --- 9. a write that keeps no vector, an embedder that is down, and a rebuild it goes down during -------------
  // Lyntai's engine stores a fact whose write-time embed FAILED without its vector, and hands back its graph
  // reference anyway. On the 3.2 upgrade the layout rebuild ran before llama.cpp had started and a real install came
  // up with every fact indexed and no vector at all, marker written, coverage 100%. Since the Lyntai 3.4 bump the fact
  // index reads the write's own report (Ran) and CLASSIFIES a vector-less write by one probe: an embedder that answers
  // refused THIS input, and the fact keeps its ref without a vector, never retried (9a, input); one that does not
  // answer is down, and the row is left UNINDEXED for the gated back-fill (9a, outage). Both back-fills are gated (the
  // startup one here, the import's in 9c), and a partial rebuild writes its marker — its empty refs are the retry
  // queue (9b).
  {
    const probeDir = dataDirFor('p52-rebuild');
    makeTestData(probeDir);
    const res9 = path.join(probeDir, 'state', 'resources');
    fs.mkdirSync(path.join(res9, 'llama-cpp'), { recursive: true });
    fs.mkdirSync(path.join(res9, 'gguf'), { recursive: true });
    fs.writeFileSync(path.join(res9, 'llama-cpp', 'llama-server.exe'), '');
    fs.writeFileSync(path.join(res9, 'gguf', `${EMBED_MODEL}.gguf`), '');
    fs.writeFileSync(path.join(probeDir, 'state', 'settings.json'), JSON.stringify({
      memory: { semanticSource: 'llama-cpp', embeddingModel: EMBED_MODEL },
    }, null, 2), 'utf8');
    const layout = () => {
      const db = new DatabaseSync(path.join(probeDir, 'state', 'gatherlight.db'));
      try { return db.prepare("SELECT value FROM app_config WHERE key = 'facts.index.layout'").get()?.value ?? null; }
      finally { db.close(); }
    };
    // A fact's graph_ref by its topic: '' when unindexed, null when there is no such row.
    const refOf = (topic) => {
      const db = new DatabaseSync(path.join(probeDir, 'state', 'gatherlight.db'));
      try { return db.prepare("SELECT COALESCE(graph_ref, '') AS ref FROM knowledge WHERE topic = ?").get(topic)?.ref ?? null; }
      finally { db.close(); }
    };
    const logText = () => {
      const dir = path.join(probeDir, 'state', 'logs');
      return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') : '';
    };
    // Every fact carries `zzrebuildfact`; each of D, C and E also carries the one token its case refuses or looks for.
    const FACT_A = ['zzrebuildA 周末市场', 'The zzrebuildfact market opens at seven on weekends.'];
    const FACT_B = ['zzrebuildB 游泳馆', 'The zzrebuildfact pool charges forty yuan for an adult.'];
    const FACT_D = ['zzrebuildD 公园', 'The zzrebuildfact zzrefusedfact park note is refused by the embedder, whose probe answers.'];
    const FACT_C = ['zzrebuildC 图书馆', 'The zzrebuildfact zzpartialfact library closes at nine on weekdays.'];
    const FACT_E = ['zzrebuildE 博物馆', 'The zzrebuildfact zzimportfact museum is free on Sundays.'];
    const embedsOf = (since, needle) => hits.slice(since).filter((h) => h.path === '/v1/embeddings' && h.body.includes(needle));
    // The fact index's probe, by its text (FactIndex.EmbedderReadyAsync) — the gate's and the classification's alike.
    const probesOf = (since) => embedsOf(since, 'index probe');
    const remember = (client, [topic, content]) =>
      client.call('remember_fact', { kind: 'household', topic, content, source: 'https://example.test/zzr', confidence: 0.8 });

    // A: facts written while the embedder answers — each one embedded.
    rebuildServer = startServer({ dataDir: probeDir, port: REBUILD_PORTS[0], env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl } });
    const baseA = `http://127.0.0.1:${REBUILD_PORTS[0]}`;
    await waitHealthy(baseA);
    const cA = makeClient(baseA);
    await remember(cA, FACT_A);
    await remember(cA, FACT_B);

    // 9a, INPUT: the embedder refuses ONE fact's content and answers the probe — what llama.cpp does with an input past its
    // window. Retrying it would fail the same way at every start, an annotation each; it is kept without a vector instead.
    refuseEmbedToken = 'zzrefusedfact';
    const beforeD = hits.length;
    await remember(cA, FACT_D);
    ok('(fixture 9a, input) the write asked the embedder and was refused — and ONE probe followed, which it answered',
      embedsOf(beforeD, 'zzrefusedfact').length > 0 && probesOf(beforeD).length === 1,
      JSON.stringify(hits.slice(beforeD).map((h) => `${h.path} ${h.body.slice(0, 60)}`)));
    const refD = refOf(FACT_D[0]);
    ok('THE POINT (9a, input): a write whose CONTENT the embedder refused, while it answers a probe, keeps its ref — indexed without a vector',
      !!refD, `graph_ref=${JSON.stringify(refD)}`);
    let refusedLine = false;
    try { await until(() => (refusedLine = /refused the content of fact \d+ \(household\/zzrebuildD/.test(logText())), 15000, 300); }
    catch { /* reported below */ }
    ok('…and state/logs names the fact whose content was refused', refusedLine);

    // 9a, OUTAGE: the embedder refuses everything, the probe included — it is down, and the row is left for the back-fill.
    refuseEmbeddings = true;
    const beforeC = hits.length;
    await remember(cA, FACT_C);
    ok('(fixture 9a, outage) the write asked the embedder and was refused — and ONE probe followed, refused too',
      embedsOf(beforeC, 'zzpartialfact').length > 0 && probesOf(beforeC).length === 1,
      JSON.stringify(hits.slice(beforeC).map((h) => `${h.path} ${h.body.slice(0, 60)}`)));
    ok('THE POINT (9a, outage): a write that kept no vector while the embedder is DOWN leaves its row UNINDEXED — an empty graph_ref',
      refOf(FACT_C[0]) === '', `graph_ref=${JSON.stringify(refOf(FACT_C[0]))}`);

    // 9c: a memory IMPORT while the embedder is down. Its detached back-fill is gated like the startup one: walking would
    // re-remember each imported fact (an annotation each) for writes that stay unindexed and are walked again next start.
    const beforeE = hits.length;
    const imported = await fetch(`${baseA}/api/memory/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gatherlightMemory: 1, knowledge: [
        { kind: 'household', topic: FACT_E[0], content: FACT_E[1], source: 'https://example.test/zzr', confidence: 0.8 },
      ] }),
    });
    let backfillLine = '';
    try {
      await until(() => (backfillLine = logText().match(/back-fill after a memory import (skipped|indexed)[^\n]*/)?.[0] ?? ''),
        30000, 300);
    } catch { /* reported below */ }
    ok('(fixture 9c) the import succeeded and its detached back-fill ran', imported.status === 200 && !!backfillLine,
      `${imported.status} ${backfillLine}`);
    ok('THE POINT (9c): with the embedder down, the import\'s back-fill SKIPS — no imported fact\'s content reaches the embedder',
      /skipped/.test(backfillLine) && embedsOf(beforeE, 'zzimportfact').length === 0 && refOf(FACT_E[0]) === '',
      JSON.stringify({ line: backfillLine, embeds: embedsOf(beforeE, 'zzimportfact').length, ref: refOf(FACT_E[0]) }));
    refuseEmbeddings = false;
    rebuildServer.stop();
    rebuildServer = null;
    await new Promise((r) => setTimeout(r, 1200));

    // …and the next start, at the current layout and with the embedder answering (D's content still refused), back-fills
    // the rows the outage left — and leaves D alone.
    const beforeBackfill = hits.length;
    rebuildServer = startServer({ dataDir: probeDir, port: BACKFILL_PORT, env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl } });
    await waitHealthy(`http://127.0.0.1:${BACKFILL_PORT}`);
    ok('THE POINT (9a, outage): the next start re-indexes it once the embedder answers — its embed arrives, its row gets a ref',
      layout() === '3' && embedsOf(beforeBackfill, 'zzpartialfact').length > 0 && !!refOf(FACT_C[0]),
      JSON.stringify({ layout: layout(), embeds: embedsOf(beforeBackfill, 'zzpartialfact').length, ref: refOf(FACT_C[0]) }));
    ok('…and so does the import the outage skipped (9c)',
      embedsOf(beforeBackfill, 'zzimportfact').length > 0 && !!refOf(FACT_E[0]),
      JSON.stringify({ embeds: embedsOf(beforeBackfill, 'zzimportfact').length, ref: refOf(FACT_E[0]) }));
    ok('THE POINT (9a, input): the refused fact is NEVER retried — no embed of its content, its ref as it was',
      embedsOf(beforeBackfill, 'zzrefusedfact').length === 0 && refOf(FACT_D[0]) === refD,
      JSON.stringify({ embeds: embedsOf(beforeBackfill, 'zzrefusedfact').length, ref: refOf(FACT_D[0]), was: refD }));
    refuseEmbedToken = null;
    rebuildServer.stop();
    rebuildServer = null;
    await new Promise((r) => setTimeout(r, 1200));

    // The upgrade: this install is still at layout 2, so the next start REBUILDS — with the embedder refusing.
    { const db = new DatabaseSync(path.join(probeDir, 'state', 'gatherlight.db'));
      db.prepare("UPDATE app_config SET value = '2' WHERE key = 'facts.index.layout'").run(); db.close(); }
    refuseEmbeddings = true;

    const beforeDown = hits.length;
    rebuildServer = startServer({ dataDir: probeDir, port: REBUILD_PORTS[1], env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl } });
    const downBase = `http://127.0.0.1:${REBUILD_PORTS[1]}`;
    await waitHealthy(downBase);
    const downWarnings = ((await (await fetch(`${downBase}/api/migration/status`)).json()).warnings ?? []).map(String);
    ok('(fixture) the embedder was really asked, and refused',
      hits.slice(beforeDown).some((h) => h.path === '/v1/embeddings'), JSON.stringify(hits.slice(beforeDown).map((h) => h.path)));
    // The gate's own point since the per-write check keeps a lost vector retryable anyway: without it this start would
    // rebuild — re-remembering, and with 判断 on the CLI annotating, every fact — for vectors it cannot get.
    ok('THE POINT: with the embedder down, NO fact is re-remembered — the start sent the embedder its probe and no fact',
      embedsOf(beforeDown, 'zzrebuildfact').length === 0,
      JSON.stringify(hits.slice(beforeDown).filter((h) => h.path === '/v1/embeddings').map((h) => h.body.slice(0, 80))));
    ok('THE POINT: with the embedder down, the layout marker is NOT written — nothing was rebuilt',
      layout() === '2', `facts.index.layout=${JSON.stringify(layout())}`);
    ok('…and the startup says so, in a sentence', downWarnings.some((w) => /嵌入模型这次启动没有响应/.test(w)),
      JSON.stringify(downWarnings));
    rebuildServer.stop();
    rebuildServer = null;
    await new Promise((r) => setTimeout(r, 1200));

    // 9b: the rebuild runs — the gate's probe is answered — and the embedder goes DOWN for one fact mid-pass: C's content
    // is refused and so is every probe after the gate's, so C's write is classified as an outage and left unindexed. The
    // others are indexed at the current address, so the marker is TRUE after the pass: the one empty ref is the retry
    // queue the next start's back-fill finishes, with no second destructive rebuild. Confirmed to FAIL against the rule
    // it replaced — no marker until the count reached the total — under which the next start rebuilt everything again.
    refuseEmbeddings = false;
    refuseEmbedToken = 'zzpartialfact';
    probeBudget = 1;
    const beforePartial = hits.length;
    const partialBase = `http://127.0.0.1:${PARTIAL_PORT}`;
    rebuildServer = startServer({ dataDir: probeDir, port: PARTIAL_PORT, env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl } });
    await waitHealthy(partialBase);
    const partialWarnings = ((await (await fetch(`${partialBase}/api/migration/status`)).json()).warnings ?? []).map(String);
    const kept = Object.fromEntries([FACT_A, FACT_B, FACT_D, FACT_E].map(([t]) => [t, refOf(t)]));
    ok('(fixture 9b) the rebuild ran and was PARTIAL — the others re-indexed, C left unindexed after a probe the fake refused',
      Object.values(kept).every((r) => !!r) && refOf(FACT_C[0]) === '' && probesOf(beforePartial).length >= 2,
      JSON.stringify({ ...kept, C: refOf(FACT_C[0]), probes: probesOf(beforePartial).length }));
    ok('THE POINT (9b): a PARTIAL rebuild writes the layout marker — the entries are at the current address',
      layout() === '3', `facts.index.layout=${JSON.stringify(layout())}`);
    ok('…and the startup says so, in a sentence', partialWarnings.some((w) => /事实索引的重建没有全部完成/.test(w)),
      JSON.stringify(partialWarnings));
    rebuildServer.stop();
    rebuildServer = null;
    refuseEmbedToken = null;
    probeBudget = Infinity;
    await new Promise((r) => setTimeout(r, 1200));

    // …and the next start, the embedder answering, BACK-FILLS C — no rebuild: every other fact keeps its node.
    const beforeUp = hits.length;
    rebuildServer = startServer({ dataDir: probeDir, port: REBUILD_PORTS[2], env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl } });
    await waitHealthy(`http://127.0.0.1:${REBUILD_PORTS[2]}`);
    const after = Object.fromEntries(Object.keys(kept).map((t) => [t, refOf(t)]));
    ok('THE POINT (9b): the next start back-fills the fact the rebuild left, WITHOUT a rebuild — every other node id kept',
      layout() === '3' && embedsOf(beforeUp, 'zzpartialfact').length > 0 && !!refOf(FACT_C[0])
        && Object.keys(kept).every((t) => after[t] === kept[t]) && embedsOf(beforeUp, 'seven on weekends').length === 0,
      JSON.stringify({ layout: layout(), C: refOf(FACT_C[0]), kept, after,
        reEmbeddedA: embedsOf(beforeUp, 'seven on weekends').length }));
  }

  // --- 10. a BOUND model whose file is gone falls back — even while another model of its kind remains ---
  // IsConfigured asked "is there ANY judge-kind GGUF?", never "is the BOUND one here?" — so deleting the bound
  // chat GGUF while a reranker stayed kept 判断 wired to a model the router cannot serve (NoOpinion on every
  // recall, silently), and another embedder kept a missing 语义 model bound. Planted, not bound: the question
  // is what STARTUP makes of settings that name files no longer on disk.
  const goneDir = dataDirFor('p52-gone');
  makeTestData(goneDir);
  const goneRes = path.join(goneDir, 'state', 'resources');
  fs.mkdirSync(path.join(goneRes, 'llama-cpp'), { recursive: true });
  fs.mkdirSync(path.join(goneRes, 'gguf'), { recursive: true });
  fs.writeFileSync(path.join(goneRes, 'llama-cpp', 'llama-server.exe'), '');
  fs.writeFileSync(path.join(goneRes, 'gguf', `${RERANK_MODEL}.gguf`), '');      // a judge-kind survivor
  fs.writeFileSync(path.join(goneRes, 'gguf', 'zzother-embed.gguf'), '');       // an embedder survivor
  fs.writeFileSync(path.join(goneDir, 'state', 'settings.json'), JSON.stringify({ memory: {
    judgeSource: 'llama-cpp', judgeModel: 'zzgone-chat',
    semanticSource: 'llama-cpp', embeddingModel: 'zzgone-embed',
  } }, null, 2), 'utf8');
  const goneArgsLog = path.join(goneDir, 'stub-args.jsonl');
  fs.rmSync(goneArgsLog, { force: true });
  const beforeGone = hits.length;
  goneServer = startServer({
    dataDir: goneDir, port: GONE_PORT,
    env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl, GATHERLIGHT_STUB_ARGS_LOG: goneArgsLog },
  });
  // 10c's folder, booted beside it: a gone RERANKER, and case 7's signed-out CLI to fall back onto.
  const goneOutDir = dataDirFor('p52-gone-signedout');
  makeTestData(goneOutDir);
  const goneOutRes = path.join(goneOutDir, 'state', 'resources');
  fs.mkdirSync(path.join(goneOutRes, 'llama-cpp'), { recursive: true });
  fs.mkdirSync(path.join(goneOutRes, 'gguf'), { recursive: true });
  fs.writeFileSync(path.join(goneOutRes, 'llama-cpp', 'llama-server.exe'), '');
  fs.writeFileSync(path.join(goneOutDir, 'state', 'settings.json'), JSON.stringify({ memory: {
    judgeSource: 'llama-cpp', judgeModel: 'zzgone-rerank',
  } }, null, 2), 'utf8');
  goneOutServer = startServer({
    dataDir: goneOutDir, port: GONE_OUT_PORT,
    env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl, GATHERLIGHT_CLAUDE_CMD: `node ${signedOutStub}` },
  });
  await Promise.all([waitHealthy(goneServer.base), waitHealthy(goneOutServer.base)]);
  const gc = makeClient(goneServer.base);
  const goneMem = await gc.getJson('/api/manage/memory');
  const gJudge = layerOf(goneMem, 'judge');
  const gSem = layerOf(goneMem, 'semantic');
  ok('THE POINT: 判断 whose bound GGUF is gone falls back to the CLI — a surviving reranker does not keep it',
    gJudge.activeSource === 'claude-cli' && gJudge.activeModel === 'haiku',
    JSON.stringify({ active: gJudge.activeSource, activeModel: gJudge.activeModel }));
  // Positive field values, not "not llama-cpp": layerOf answers {} for a missing layer, so a negative check alone
  // would pass on a renamed field or layer.
  ok('…and 语义 whose bound GGUF is gone is off — a surviving embedder does not keep it',
    gSem.on === false && gSem.activeSource === null,
    JSON.stringify({ on: gSem.on, active: gSem.activeSource, activeModel: gSem.activeModel }));

  // Startup warnings live on the migration status — the same read case 7's warmWarning() uses.
  const goneWarnings = ((await (await fetch(`${goneServer.base}/api/migration/status`)).json()).warnings ?? [])
    .map(String);
  const judgeWarn = goneWarnings.find((w) => w.includes('zzgone-chat')) ?? '';
  const semWarn = goneWarnings.find((w) => w.includes('zzgone-embed')) ?? '';
  // A household-dropped GGUF has no row in 资源, so the sentence has to say where the file goes back.
  ok('the startup says WHICH model is gone, where its file goes back, and that 判断 is on the CLI now',
    /绑定的本机模型用不了/.test(judgeWarn) && /Claude CLI/.test(judgeWarn)
      && judgeWarn.includes(path.join('state', 'resources', 'gguf')),
    judgeWarn || JSON.stringify(goneWarnings));
  // A CHAT judge did both halves locally, so both move — for a reranker only the checking would (ChecksOnly);
  // that branch boots on its own, in 10c.
  ok('…and what that COSTS — the account, and the facts going to Claude, for the first time for a local chat judge',
    /账号额度/.test(judgeWarn) && /事实内容会发给 Claude/.test(judgeWarn) && /标注与核对都改由它完成/.test(judgeWarn),
    judgeWarn);
  // Not the warm step's 没能载入: that is the sentence a layer STILL WIRED to the missing file produced — it
  // names the model and 语义 too, so without this exclusion the check passed before the fix.
  ok('…and for 语义: off, with a remedy that carries the restart AND the rebuild — facts written meanwhile have no vector',
    /语义/.test(semWarn) && !/没能载入/.test(semWarn) && /重启服务/.test(semWarn) && /语义索引/.test(semWarn),
    semWarn || JSON.stringify(goneWarnings));

  // THE LAYOUT MARKER. With 语义 bound to an embedder that is not wired, the fact index moved its entries and no
  // vectors — so the marker must not claim the vectors are done. It used to say "3", the start that had the model
  // back then only synced, and the vectors Lyntai 3.2's address change orphaned were never re-embedded. "2" is what
  // it says instead: entries here, vectors owed, so the next start with the embedder rebuilds.
  const goneLayout = (() => {
    const db = new DatabaseSync(path.join(goneDir, 'state', 'gatherlight.db'), { readOnly: true });
    try { return db.prepare("SELECT value FROM app_config WHERE key = 'facts.index.layout'").get()?.value ?? null; }
    finally { db.close(); }
  })();
  ok('THE POINT: with the bound embedder not wired, the layout marker keeps the vector rebuild owed ("2", not "3")',
    goneLayout === '2', `facts.index.layout=${JSON.stringify(goneLayout)}`);

  // By ROUTING, not by report: a fact write is annotated by the CLI on the CLI's model, and nothing that reached
  // the fake router since this server started — its boot included — names a gone model.
  const wroteGone = await gc.call('remember_fact', {
    kind: 'household', topic: 'zzgonefact kitchen shelf',
    content: 'The zzgonefact teapot lives on the second kitchen shelf.',
    source: 'https://example.test/zzgone', confidence: 0.8,
  });
  ok('remember_fact stores the fact on the fallen-back server', wroteGone.status === 200 && wroteGone.result?.ok === true,
    JSON.stringify(wroteGone.result));
  const goneCalls = () => (fs.existsSync(goneArgsLog) ? fs.readFileSync(goneArgsLog, 'utf8') : '')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  await until(() => goneCalls().some((x) => x.kind === 'annotation' && x.tail.includes('zzgonefact')), 60000)
    .catch(() => {});
  const goneAnnotated = goneCalls().filter((x) => x.kind === 'annotation' && x.tail.includes('zzgonefact'));
  ok('…annotated by the CLI on the CLI\'s model', goneAnnotated.length > 0 && goneAnnotated.every((x) => modelOf(x) === 'haiku'),
    JSON.stringify(goneAnnotated.map(modelOf)));
  ok('…and nothing reached the router naming a gone model',
    !hits.slice(beforeGone).some((h) => String(h.model ?? '').startsWith('zzgone')),
    JSON.stringify(hits.slice(beforeGone).map((h) => `${h.path} ${h.model}`)));

  // --- 10c. the fallback's OTHER branch, onto a CLI that cannot do any of it ------------------------------
  // The warning said what the CLI takes over and never whether it CAN: a missing or signed-out CLI takes over
  // nothing — both policies are fail-open, so no fact is tagged and no recall checked, and nothing else says so.
  // A gone RERANKER here, so this is also the only boot of the branch where only the checking moves.
  const goneOutJudge = layerOf(await makeClient(goneOutServer.base).getJson('/api/manage/memory'), 'judge');
  ok('(fixture) a gone reranker falls back to the CLI too', goneOutJudge.activeSource === 'claude-cli',
    JSON.stringify({ active: goneOutJudge.activeSource, activeModel: goneOutJudge.activeModel }));
  const goneOutWarn = ((await (await fetch(`${goneOutServer.base}/api/migration/status`)).json()).warnings ?? [])
    .map(String).find((w) => w.includes('zzgone-rerank')) ?? '';
  ok('a gone RERANKER moves only the checking — the tagging was on the CLI all along',
    /本来就由它完成/.test(goneOutWarn) && /核对也改由它完成/.test(goneOutWarn) && !/标注与核对都改由它完成/.test(goneOutWarn),
    goneOutWarn || '(no warning naming the model)');
  ok('THE POINT: onto a signed-out CLI, the fallback warning says nothing is tagged OR checked until it signs in',
    /还没有登录/.test(goneOutWarn) && /不会被标注/.test(goneOutWarn) && /也不会核对/.test(goneOutWarn)
      && /点「登录」/.test(goneOutWarn),
    goneOutWarn || '(no warning naming the model)');
  // Case 10's server fell back onto the default stub, which answers signed in — so the same sentence must be absent.
  ok('(control) onto a signed-in CLI (case 10), the warning carries no such sentence',
    judgeWarn.length > 0 && !/在它能用之前/.test(judgeWarn) && !/还没有登录/.test(judgeWarn), judgeWarn);

  // (control) a server whose bound model IS on disk says none of this — case 6's, which booted bound to a planted
  // reranker. Without it, a HasModel that always said no would pass every check above.
  const rerankWarnings = ((await (await fetch(`${base3}/api/migration/status`)).json()).warnings ?? []).map(String);
  ok('(control) a server whose bound model is on disk gets no such warning',
    !rerankWarnings.some((w) => /绑定的本机模型用不了/.test(w)), JSON.stringify(rerankWarnings));

  // --- 10b. BIND refuses what startup would drop ----------------------------------------------------------
  // The resolver keeps a binding only while its model is one of the layer's files, so bind has to ask the same of
  // the NEW model. A model the router lists without our folder holding it — llama.cpp's own cache on a real machine
  // — used to pass: the router served it, the warm answered, the binding saved, and the next restart fell back.
  const CACHE_ONLY = 'zzcacheonly-chat';
  served.add(CACHE_ONLY);
  const beforeCacheOnly = layerOf(await c3.getJson('/api/manage/memory'), 'judge').model;
  const cacheOnly = await c3.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: CACHE_ONLY });
  const cacheOnlyErr = String(cacheOnly.body?.error ?? '');
  ok('THE POINT: a model the router lists but our folder does not hold is refused at bind, saying where it is missing',
    cacheOnly.status === 409 && cacheOnlyErr.includes(CACHE_ONLY) && /不在模型目录/.test(cacheOnlyErr),
    `${cacheOnly.status} ${cacheOnlyErr || JSON.stringify(cacheOnly.body)}`);
  ok('…and the refusal saves nothing', layerOf(await c3.getJson('/api/manage/memory'), 'judge').model === beforeCacheOnly,
    JSON.stringify({ before: beforeCacheOnly, after: layerOf(await c3.getJson('/api/manage/memory'), 'judge').model }));
  // A file that IS there but of the wrong kind says so, rather than that it is missing.
  const wrongKind = await c3.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: LATE_EMBED });
  const wrongKindErr = String(wrongKind.body?.error ?? '');
  ok('an embedder on disk is refused as a judge as the wrong KIND, not as missing',
    wrongKind.status === 409 && /嵌入模型/.test(wrongKindErr) && !/不在模型目录/.test(wrongKindErr),
    `${wrongKind.status} ${wrongKindErr || JSON.stringify(wrongKind.body)}`);
} catch (err) {
  fail('e2e-p52 fatal: ' + (err?.stack || err?.message || String(err)));
} finally {
  try { server?.stop(); } catch {}
  try { rerankServer?.stop(); } catch {}
  try { signedOutServer?.stop(); } catch {}
  try { signedInServer?.stop(); } catch {}
  try { goneOutServer?.stop(); } catch {}
  try { rebuildServer?.stop(); } catch {}
  try { goneServer?.stop(); } catch {}
  try { windowedServer?.stop(); } catch {}
  try { unwindowedServer?.stop(); } catch {}
  try { paceServer?.stop(); } catch {}
  try { stallServer?.stop(); } catch {}
  try { cutoffServer?.stop(); } catch {}
  try { scriptServer?.stop(); } catch {}
  try { skipServer?.stop(); } catch {}
  fake.closeAllConnections();
  await new Promise((r) => fake.close(r));
}

done();
