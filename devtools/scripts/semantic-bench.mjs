#!/usr/bin/env node
// semantic-bench.mjs — measures 语义 recall (the llama.cpp embedder bound to 语义) with and without Lyntai's D177 segmentation
// of over-window facts (docs/judge-bench.md Run 14). It exists beside judge-bench because neither existing bench can:
//   - recall-bench reads a HOUSEHOLD's own facts only (never a fixture), so it cannot pair two configurations;
//   - judge-bench's arms COPY one seed, built with 语义 off, so no arm has vectors. 语义's vectors are written at WRITE time,
//     and a refused input takes the write path's classifier (FactIndex.IndexAsync), which is the behaviour being measured.
// So here EVERY ARM WRITES THE FIXTURE ITSELF, from an empty data folder, in fixture order, with 判断 off (no annotation,
// no quota; the claude stub), timing each write — then asks every question in judge-bench's shuffled order (its order
// seed and repair, mirrored) and records where the target lands.
//
// ARMS (one at a time, each its own data folder and server; the routers are described below):
//   formula — 语义 off: the lexical/graph floor.
//   sem     — 语义 on, llama.cpp EmbeddingGemma, as shipped: an input past the window is refused and its fact kept without a vector.
//   sem2    — sem again: the A/A twin (how far two identical arms move).
//   sems    — sem with GATHERLIGHT_EMBED_SEGMENTATION=d177 (EmbedSegmentation): over-window inputs embedded in pieces, pooled.
//   cpu-sem — sem on the CPU ONLY (Run 15): its router launched with `n-gpu-layers = 0` AND `device = none` in place of the
//             product's 99 (judge-bench's CPU-only router, Runs 8 and 13 — `n-gpu-layers = 0` alone still offloads a big
//             batch's work to a visible GPU on b10549), the rest of the embedder section as the product writes it.
//   semb    — 语义 on 内置 (Run 15): `builtin` · embeddinggemma-300m-onnx, the in-process ONNX EmbeddingGemma
//             (OnnxEmbedder), from `<resources>/embed-model` (ResourceProvisioner's pinned files, re-checked here and
//             copied into the arm's state/resources/embed-model). No llama.cpp is planted, no address set, no router runs.
// Every arm pins the knob (blank or d177) and must announce exactly what it pinned.
//
// ROUTERS. Run 14 ran every llama.cpp arm on ONE shared router (`--shared-router` reproduces that). Since Run 15 each
// llama.cpp arm gets its OWN fresh router, started before the arm and stopped after it, on `--llama-port` + the arm's
// index: so a CPU arm has no GPU router it could reach, 内置 runs with no llama.cpp process at all, and every request a
// router proxied belongs to one arm — which lets the bench count them per pass (one per write, one per recall).
//
// FIXTURES: --fixture=embed (devtools/fixtures/recall-bilingual-embed.json, semantic-bench-fixture.mjs; refused unless it
// is what the generator writes), --fixture=short (recall-bilingual.json, every fact one piece) or --fixture=long (Run 15:
// recall-bilingual-long.json, 60 notes of 883–1,241 characters, refused unless it is judge-bench-long-fixture.mjs's bytes;
// every note inside EmbeddingGemma's window). `--capability` runs the one-fact check instead (measuring rule 3): the short
// fixture's 60 facts as distractors plus ONE over-window note whose distinctive sentence sits past the window, asked by
// paraphrases that share no wording with it, in `sem` and `sems`.
//
//   node devtools/scripts/semantic-bench.mjs --fixture=embed --resources=devtools/_rr-res [--arms=formula,sem,sem2,sems]
//       [--port-base=7830] [--llama-port=7890] [--n=<first n facts>] [--order-seed=12345] [--shared-router]
//   node devtools/scripts/semantic-bench.mjs --capability --resources=devtools/_rr-res
//   node devtools/scripts/semantic-bench.mjs --fixture=long --arms=formula,sem,sem2,semb,cpu-sem --resources=devtools/_rr-res
// Output: devtools/_semantic-bench-<fixture>/ (arm folders, rows-*.jsonl, results-*.json, each router's preset and log).
// Every process it starts is ended by PID as a tree.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { makeTestData, startServer, waitHealthy, makeClient, until, repo, git } from './e2e/_e2e-common.mjs';
import { QUESTION_SETS } from './recall-questions.mjs';
import { expectedEmbedBytes, EMBED_FIXTURE, BEFORE } from './semantic-bench-fixture.mjs';
import { FILLER, shuffled, seedOf, expectedLongBytes, LONG_FIXTURE, POSITIONS } from './judge-bench-long-fixture.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const flag = (n) => argv.includes(`--${n}`);
const die = (m) => { console.error(`semantic-bench: ${m}`); process.exit(2); };
const CAPABILITY = flag('capability');
const FIXTURE_NAME = CAPABILITY ? 'capability' : arg('fixture', 'embed');
if (!['embed', 'short', 'long', 'capability'].includes(FIXTURE_NAME)) die(`--fixture=${FIXTURE_NAME}: embed, short or long`);
const SHARED_ROUTER = flag('shared-router');
const RESOURCES = path.resolve(arg('resources', '') || die('--resources=<a folder holding llama-cpp/ and gguf/> is required (never a household data folder)'));
const PORT_BASE = Number(arg('port-base', '7830'));
const LLAMA_PORT = Number(arg('llama-port', '7890'));
const ORDER_SEED = Number(arg('order-seed', '12345'));
const LIMIT = 8;
const N = arg('n', null) === null ? null : Number(arg('n'));
const ARMS = arg('arms', CAPABILITY ? 'sem,sems' : 'formula,sem,sem2,sems').split(',');
const EMBEDDER = 'embeddinggemma-300M-Q8_0';
const WORK = path.join(repo, 'devtools', `_semantic-bench-${FIXTURE_NAME}`);
const rel = (p) => path.relative(repo, p).split(path.sep).join('/');
const KNOB = 'GATHERLIGHT_EMBED_SEGMENTATION';
const PINNED = { GATHERLIGHT_VERDICT_COMBINATION: '', GATHERLIGHT_JUDGE_DEADLINE_SECONDS: '', GATHERLIGHT_RERANK_CHUNKING: '', [KNOB]: '' };
const ARM_KINDS = {
  formula: { label: '公式 · 语义 off', semantic: false, env: {} },
  sem: { label: '语义 · llama.cpp EmbeddingGemma · refused past the window (as shipped)', semantic: true, env: {} },
  sem2: { label: '语义 · as shipped · A/A twin', semantic: true, env: {} },
  sems: { label: '语义 · llama.cpp EmbeddingGemma · D177 segmented', semantic: true, env: { [KNOB]: 'd177' }, knob: /\[measurement\] embed segmentation = d177 \(/ },
  'cpu-sem': { label: '语义 · llama.cpp EmbeddingGemma · CPU only (n-gpu-layers = 0, device = none)', semantic: true, cpu: true, env: {} },
  semb: { label: '语义 · 内置 · in-process ONNX EmbeddingGemma (CPU)', semantic: true, builtin: true, env: {} },
};
for (const a of ARMS) if (!ARM_KINDS[a]) die(`unknown arm ${a} — one of ${Object.keys(ARM_KINDS).join(', ')}`);
if (new Set(ARMS).size !== ARMS.length) die(`--arms names an arm twice (${ARMS.join(', ')})`);
const usesLlama = (k) => ARM_KINDS[k].semantic && !ARM_KINDS[k].builtin;
if (SHARED_ROUTER && ARMS.some((a) => ARM_KINDS[a].cpu)) die('--shared-router: cpu-sem needs a CPU-only router of its own');
// 内置 must run with no llama.cpp address the bench did not choose: an inherited one would point it at someone's router.
if (process.env.GATHERLIGHT_LLAMACPP_URL) die('GATHERLIGHT_LLAMACPP_URL is set in this shell — unset it; the bench sets it per llama.cpp arm');

// ---- the product numbers this restates, guarded against the C# ----------------------------------------------------
const cs = (f) => fs.readFileSync(path.join(repo, 'src', 'server', ...f.split('/')), 'utf8');
const catalogue = cs('Gatherlight.Platform/Agent/Llm/Services/GgufCatalog.cs');
const embedRow = catalogue.slice(catalogue.indexOf('RecommendedEmbedder, "'), catalogue.indexOf('RecommendedEmbedder, "') + 2000);
const WINDOW = Number(/ContextTokens: (\d+)\)/.exec(embedRow)?.[1]);
if (/public const string RecommendedEmbedder = "([^"]+)";/.exec(catalogue)?.[1] !== EMBEDDER || WINDOW !== 2048)
  die(`the catalogue's embedder is not ${EMBEDDER} with a declared 2,048 window (read ${WINDOW}) — this bench restates both`);
const runtime = cs('Gatherlight.Platform/Agent/Llm/Services/LlamaServerRuntime.cs');
if (!/keys\.Add\(\("embeddings", "true"\)\);\s*keys\.Add\(\("batch-size", embedWindow\)\);\s*keys\.Add\(\("ubatch-size", embedWindow\)\);/.test(runtime))
  die('LlamaServerRuntime no longer writes embeddings/batch-size/ubatch-size on an embedder section — the bench\'s preset mirrors them');
if (!/public static readonly bool On = string\.Equals\(Raw\?\.Trim\(\), "d177"/.test(cs('Gatherlight.Platform/Agent/Llm/Services/EmbedSegmentation.cs')))
  die('EmbedSegmentation no longer reads the knob as "d177"');
// 内置 (Run 15): the backend id, the model id, the resource directory and its pinned files — every one restated here, so
// each is read back from the C#: a bench binding a model the product would not is measuring a product we do not ship.
const BUILTIN_BACKEND = /public const string BuiltIn = "([^"]+)";/.exec(cs('Gatherlight.Platform/Agent/Llm/Sources/MemorySourceTypes.cs'))?.[1];
const builtinSource = cs('Gatherlight.Platform/Agent/Llm/Sources/BuiltInSemanticSource.cs');
const BUILTIN_MODEL = /public const string ModelId = "([^"]+)";/.exec(builtinSource)?.[1];
const BUILTIN_DIR = /public const string ResourceId = "([^"]+)";/.exec(builtinSource)?.[1];
const onnxEmbedder = cs('Gatherlight.Platform/Agent/Llm/Services/OnnxEmbedder.cs');
const BUILTIN_FILES = (() => {
  const prov = cs('Gatherlight.Platform/Hosting/Resources/Services/ResourceProvisioner.cs');
  const at = prov.indexOf('Id: Agent.Llm.Sources.BuiltInSemanticSource.ResourceId');
  const spec = at < 0 ? '' : prov.slice(at, prov.indexOf('Category: ResourceCategory.Model', at));
  return [...spec.matchAll(/EmbedModelUrl\("([^"]+)"\),\s*"([0-9a-f]{64})"\)/g)].map((m) => ({ path: m[1], sha: m[2] }));
})();
if (BUILTIN_BACKEND !== 'builtin' || BUILTIN_MODEL !== 'embeddinggemma-300m-onnx' || BUILTIN_DIR !== 'embed-model'
  || BUILTIN_FILES.map((f) => f.path).join('|') !== 'onnx/model_q4.onnx|onnx/model_q4.onnx_data|tokenizer.model'
  || !/public const string ModelFile = "onnx\/model_q4\.onnx";/.test(onnxEmbedder) || !/public const string TokenizerFile = "tokenizer\.model";/.test(onnxEmbedder))
  die(`the built-in embedder's ids or pinned files moved (backend ${BUILTIN_BACKEND}, model ${BUILTIN_MODEL}, dir ${BUILTIN_DIR}, `
    + `files ${BUILTIN_FILES.map((f) => f.path).join(', ')}) — this bench restates them`);
const BUILTIN_LOAD = /内置 embedder loaded in (\d+) ms/;
if (!onnxEmbedder.includes('"内置 embedder loaded in {Ms} ms from {Dir}"')) die('OnnxEmbedder no longer logs its load line as this bench reads it');

// ---- the fixture -----------------------------------------------------------------------------------------------------
const base = JSON.parse(fs.readFileSync(path.join(repo, 'devtools', 'fixtures', 'recall-bilingual.json'), 'utf8'));
let FIXTURE, FIXTURE_FILE;
if (FIXTURE_NAME === 'embed') {
  FIXTURE_FILE = EMBED_FIXTURE;
  if (Buffer.compare(fs.readFileSync(EMBED_FIXTURE), expectedEmbedBytes()) !== 0) die(`${rel(EMBED_FIXTURE)} is not what semantic-bench-fixture.mjs writes — regenerate it or restore it`);
  FIXTURE = JSON.parse(fs.readFileSync(EMBED_FIXTURE, 'utf8'));
} else if (FIXTURE_NAME === 'long') {
  // Run 15: the long notes as judge-bench's long fixture has them — each fact's position (start/middle/end/beyond) kept.
  FIXTURE_FILE = LONG_FIXTURE;
  if (Buffer.compare(fs.readFileSync(LONG_FIXTURE), expectedLongBytes()) !== 0) die(`${rel(LONG_FIXTURE)} is not what judge-bench-long-fixture.mjs writes — regenerate it or restore it`);
  FIXTURE = JSON.parse(fs.readFileSync(LONG_FIXTURE, 'utf8'));
} else {
  FIXTURE_FILE = path.join(repo, 'devtools', 'fixtures', 'recall-bilingual.json');
  FIXTURE = { ...base, facts: base.facts.map((f) => ({ ...f, position: 'short', answer: { text: f.content, offset: 0, length: f.content.length } })) };
}
// The capability fact: an over-window note of the same neutral filler, its one distinctive sentence LAST (past the
// window), asked by paraphrases that share no wording with it — so only a vector can reach it — and a positive control.
const CAP = {
  id: 'cap-beehives', kind: 'household', topic: '天台蜂箱',
  sentence: '楼顶的两个蜂箱归三楼的周老师照看,要取蜂蜜得提前一天跟他说好。',
  queries: [
    { key: 'cap-en', q: 'Who looks after the beehives up on the roof, and how much notice does he want before we collect the honey?' },
    { key: 'cap-zh', q: '天台上那些蜜蜂由哪位邻居负责?想采蜜要早点打招呼吗?' },
  ],
};
if (CAPABILITY) {
  const pool = [];
  for (let pass = 0; pool.join('').length < BEFORE.zh; pass++) for (const s of shuffled(FILLER.zh, seedOf(`${CAP.id}#${pass}`))) { if (pool.join('').length >= BEFORE.zh) break; pool.push(s); }
  const content = pool.join('') + CAP.sentence;
  if (base.facts.some((f) => /蜂|honey|bee/i.test(f.content + f.topic))) die('a distractor mentions bees — the capability check would not be one');
  FIXTURE = { ...FIXTURE, facts: [...FIXTURE.facts, { id: CAP.id, kind: CAP.kind, topic: CAP.topic, content, questions: {}, position: 'over',
    answer: { text: CAP.sentence, offset: content.length - CAP.sentence.length, length: CAP.sentence.length } }] };
}
const facts = N === null ? FIXTURE.facts : FIXTURE.facts.slice(0, N);
const FIXTURE_HASH = crypto.createHash('sha256').update(fs.readFileSync(FIXTURE_FILE)).digest('hex');

// judge-bench's question order, mirrored: every (fact, set) shuffled by the order seed, then same-fact neighbours repaired.
const mulberry32 = (a) => () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const queryOrder = (fs0, seed) => {
  const queries = fs0.filter((f) => Object.keys(f.questions).length).flatMap((f) => QUESTION_SETS.map((s) => ({ fact: f.id, set: s.key, q: f.questions[s.key] })));
  const rand = mulberry32(seed);
  for (let i = queries.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [queries[i], queries[j]] = [queries[j], queries[i]]; }
  for (let i = 1; i < queries.length; i++) {
    if (queries[i].fact !== queries[i - 1].fact) continue;
    const j = queries.findIndex((x, k) => k > i && x.fact !== queries[i - 1].fact);
    if (j > 0) [queries[i], queries[j]] = [queries[j], queries[i]];
  }
  return queries;
};
const queries = CAPABILITY
  ? [...CAP.queries.map((x) => ({ fact: CAP.id, set: x.key, q: x.q })),
    ...['mkt-east', 'dentist', 'vet'].map((id) => ({ fact: id, set: 'cross', q: base.facts.find((f) => f.id === id).questions.cross, control: true }))]
  : queryOrder(facts, ORDER_SEED);

// ---- statistics (judge-bench's) --------------------------------------------------------------------------------------
const logFact = (() => { const c = [0]; return (n) => { for (let i = c.length; i <= n; i++) c[i] = c[i - 1] + Math.log(i); return c[n]; }; })();
const binomSum = (from, to, n, p) => { let s = 0; for (let k = Math.max(0, from); k <= Math.min(n, to); k++) s += Math.exp(logFact(n) - logFact(k) - logFact(n - k) + k * Math.log(p) + (n - k) * Math.log1p(-p)); return Math.min(1, s); };
const mcnemarP = (b, c) => (b + c === 0 ? 1 : Math.min(1, 2 * binomSum(0, Math.min(b, c), b + c, 0.5)));
const netInterval = (b, c, pairs) => { if (!pairs) return null; const b1 = b + 0.5, c1 = c + 0.5, n1 = pairs + 2; const d = (c1 - b1) / n1; const h = 1.95996 * Math.sqrt(Math.max(0, (b1 + c1) - ((c1 - b1) ** 2) / n1) / (n1 * n1)); return [Math.max(-1, d - h), Math.min(1, d + h)]; };
const HITS = { top1: (r) => r.pos === 0, found: (r) => r.pos >= 0 };
const med = (xs) => { const q = [...xs].sort((a, b) => a - b); return q.length ? (q.length % 2 ? q[(q.length - 1) / 2] : (q[q.length / 2 - 1] + q[q.length / 2]) / 2) : null; };
// judge-bench's p90 (nearest rank) and sign test (McNemar's exact binomial over the untied pairs).
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const pv = (p) => (p >= 0.9995 ? '1.000' : p < 0.001 ? '<0.001' : p.toFixed(3));
const paired = (armRows, baseRows, where = () => true) => {
  const B = new Map(baseRows.map((r) => [r.seq, r]));
  const out = { pairs: 0 };
  const cnt = { top1: { b: 0, c: 0 }, found: { b: 0, c: 0 } };
  for (const r of armRows.filter(where)) {
    const q = B.get(r.seq); if (!q || r.error || q.error) continue;
    out.pairs++;
    for (const [k, h] of Object.entries(HITS)) { if (h(q) && !h(r)) cnt[k].b++; if (!h(q) && h(r)) cnt[k].c++; }
  }
  for (const [k, { b, c }] of Object.entries(cnt)) {
    const ci = netInterval(b, c, out.pairs);
    out[k] = { b, c, p: mcnemarP(b, c), netPp: out.pairs ? (100 * (c - b)) / out.pairs : null, interval95Pp: ci ? ci.map((v) => 100 * v) : null,
      equivalent: ci ? ci[0] >= -0.03 - 1e-12 && ci[1] <= 0.03 + 1e-12 : null };
  }
  return out;
};

// ---- processes -----------------------------------------------------------------------------------------------------
const started = [];
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };
const stopAll = () => { for (const p of started.splice(0)) killTree(p); };
process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });

const readLogs = (dir) => { const d = path.join(dir, 'state', 'logs'); return fs.existsSync(d) ? fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('\n') : ''; };
/** Run 15: a process's private bytes and working set, by the port it listens on (judge-bench's processMemoryOn). */
const processMemoryOn = (port) => {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `$p = (Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1).OwningProcess; `
      + '$x = Get-Process -Id $p; @{ pid = $x.Id; privateBytes = $x.PrivateMemorySize64; workingSet = $x.WorkingSet64 } | ConvertTo-Json -Compress'],
      { encoding: 'utf8', timeout: 30000 });
    return { at: new Date().toISOString(), ...JSON.parse(out.trim()) };
  } catch (e) { return { at: new Date().toISOString(), error: String(e?.message ?? e).slice(0, 200) }; }
};
const proxiedIn = (text) => (text.match(/proxying request to model /g) ?? []).length;
/** Run 15: what one arm's own router did — the child's launch arguments as the router logs them, its thread count, and
 *  every task's token count and truncation. */
const routerRecord = (text) => {
  const args = [...text.matchAll(/ load: {3}(\S+)/g)].map((m) => m[1]);
  const after = (flagName) => { const i = args.indexOf(flagName); return i >= 0 ? args[i + 1] ?? null : null; };
  const tasks = [...text.matchAll(/stop processing: n_tokens = (\d+), truncated = (\d+)/g)].map((m) => ({ n: Number(m[1]), truncated: Number(m[2]) }));
  return {
    spawns: (text.match(new RegExp(`spawning server instance with name=${EMBEDDER.replaceAll('.', '\\.')} `, 'g')) ?? []).length,
    childPort: Number(/spawning server instance with name=\S+ on port (\d+)/.exec(text)?.[1] ?? 0) || null,
    device: after('--device'), nGpuLayers: after('--n-gpu-layers'), batchSize: after('--batch-size'), ubatchSize: after('--ubatch-size'),
    embeddings: args.includes('--embeddings'),
    nThreads: Number(/n_threads = (\d+)/.exec(text)?.[1] ?? 0) || null,
    tasks: tasks.length, maxTaskTokens: tasks.length ? Math.max(...tasks.map((t) => t.n)) : null, truncated: tasks.filter((t) => t.truncated).length,
    errorLines: text.split(/\r?\n/).filter((l) => /\d+\.\d+\.\d+\.\d+ E /.test(l)).length,
    tooLarge: (text.match(/too large to process|larger than the max context size|exceed/gi) ?? []).length,
    proxied: proxiedIn(text),
  };
};
const vectorsOf = (dir) => {
  const db = new DatabaseSync(path.join(dir, 'state', 'gatherlight.db'), { readOnly: true });
  try {
    const refs = db.prepare('SELECT id, graph_ref FROM knowledge').all();
    const vecs = new Set(db.prepare("SELECT vec_id FROM lyntai_vector WHERE collection LIKE 'facts/graph%'").all().map((r) => String(r.vec_id)));
    return new Map(refs.map((r) => [Number(r.id), { ref: r.graph_ref ?? null, vector: r.graph_ref ? vecs.has(String(r.graph_ref).split('#').pop()) : false }]));
  } finally { db.close(); }
};

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:]/g, '').replace(/\.(\d+)Z$/, '.$1Z');
  const ROWS = path.join(WORK, `rows-${stamp}.jsonl`);
  const emit = (row) => fs.appendFileSync(ROWS, JSON.stringify(row) + '\n');
  const binary = Object.fromEntries(['Gatherlight.Platform.dll', 'Gatherlight.Planner.dll', 'Gatherlight.Server.dll'].map((f) =>
    [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, 'src/server/Gatherlight.Server/bin/Debug/net10.0', f))).digest('hex').slice(0, 16)]));
  console.log(`semantic-bench · ${FIXTURE_NAME} · ${facts.length} facts, ${queries.length} questions · arms ${ARMS.join(', ')} · server ${Object.values(binary).join('/')}`);

  // The pinned GGUF, and the product's embedder section — Run 14 checked both before starting its one router.
  const exe = path.join(RESOURCES, 'llama-cpp', 'llama-server.exe');
  const gguf = path.join(RESOURCES, 'gguf');
  const pinnedSha = new RegExp(`"${EMBEDDER.replaceAll('.', '\\.')}\\.gguf",\\s*"([0-9a-f]{64})"`).exec(catalogue)?.[1];
  if (SHARED_ROUTER || ARMS.some(usesLlama)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(gguf, `${EMBEDDER}.gguf`))).digest('hex');
    if (actual !== pinnedSha) die(`${EMBEDDER}.gguf is not the pinned file`);
  }
  // 内置's files (Run 15): ResourceProvisioner's pins, re-checked before any arm starts.
  const builtinSrc = path.join(RESOURCES, BUILTIN_DIR);
  if (ARMS.some((a) => ARM_KINDS[a].builtin))
    for (const f of BUILTIN_FILES) {
      const file = path.join(builtinSrc, ...f.path.split('/'));
      if (!fs.existsSync(file)) die(`${rel(file)} is missing — provision ${BUILTIN_DIR} through the app first`);
      const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (sha !== f.sha) die(`${rel(file)} is not the pinned file (sha256 ${sha.slice(0, 12)}… ≠ ${f.sha.slice(0, 12)}…)`);
    }

  /** A router with the product's embedder section; `cpu` (Run 15) swaps `n-gpu-layers = 99` for judge-bench's CPU-only
   *  pair. `tag` names its preset and log: '' for Run 14's shared router (presets.ini, router.log), `-arm-<i>` for one arm's. */
  const startRouter = async ({ cpu = false, port, tag }) => {
    const preset = path.join(WORK, `presets${tag}.ini`);
    fs.writeFileSync(preset, [`[${EMBEDDER}]`, ...(cpu ? ['n-gpu-layers = 0', 'device = none'] : ['n-gpu-layers = 99']),
      'embeddings = true', `batch-size = ${WINDOW}`, `ubatch-size = ${WINDOW}`, ''].join('\n'));
    const log = path.join(WORK, `router${tag}.log`);
    const logFd = fs.openSync(log, 'w');
    const child = spawn(exe, ['--models-dir', gguf, '--models-preset', preset, '--models-max', '1', '--host', '127.0.0.1', '--port', String(port)],
      { cwd: path.dirname(exe), stdio: ['ignore', logFd, logFd] });
    fs.closeSync(logFd);
    started.push(child.pid);
    await until(async () => (await fetch(`http://127.0.0.1:${port}/v1/models`)).ok, 60000);
    return { child, log, port, cpu, tag };
  };
  const stopRouter = async (rt) => {
    killTree(rt.child.pid);
    started.splice(started.indexOf(rt.child.pid), 1);
    await until(async () => { try { await fetch(`http://127.0.0.1:${rt.port}/v1/models`); return false; } catch { return true; } }, 60000).catch(() => {});
  };
  const shared = SHARED_ROUTER ? await startRouter({ port: LLAMA_PORT, tag: '' }) : null;

  // ONE empty data folder, booted once and settled, copied for every arm: its first boot writes plans/INDEX.md after the
  // data repo's initial commits, and a fresh boot per arm would carry that as a startup warning (judge-bench's
  // settleSeedRepo, for the same reason). No fact is in it.
  const TEMPLATE = path.join(WORK, 'template');
  fs.rmSync(TEMPLATE, { recursive: true, force: true });
  const made = makeTestData(TEMPLATE);
  if (made.status !== 0) throw new Error(`make-test-data exited ${made.status}`);
  {
    const t = startServer({ dataDir: TEMPLATE, port: PORT_BASE + 9, env: PINNED });
    started.push(t.server.pid);
    await waitHealthy(t.base);
    killTree(t.server.pid);
    started.splice(started.indexOf(t.server.pid), 1);
    await until(async () => { try { await fetch(`${t.base}/api/health`); return false; } catch { return true; } }, 60000).catch(() => {});
    if (git(TEMPLATE, 'status', '--porcelain').trim() !== '') {
      git(TEMPLATE, 'add', '-A');
      git(TEMPLATE, '-c', 'user.name=semantic-bench', '-c', 'user.email=semantic-bench@example.test', 'commit', '-q', '-m', 'semantic-bench: settle the template');
    }
    fs.rmSync(path.join(TEMPLATE, 'state', 'logs'), { recursive: true, force: true });
  }
  const arms = [];
  for (const [i, key] of ARMS.entries()) {
    const kind = ARM_KINDS[key];
    const dir = path.join(WORK, `arm-${i}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(TEMPLATE, dir, { recursive: true });
    const env = { ...PINNED, ...kind.env };
    const rt = usesLlama(key) ? (shared ?? await startRouter({ cpu: !!kind.cpu, port: LLAMA_PORT + i, tag: `-arm-${i}` })) : null;
    const expectSource = kind.builtin ? BUILTIN_BACKEND : 'llama-cpp';
    const expectModel = kind.builtin ? BUILTIN_MODEL : EMBEDDER;
    if (kind.semantic) {
      const res = path.join(dir, 'state', 'resources');
      if (kind.builtin) {
        // 内置: the pinned files where BuiltInSemanticSource looks; NO llama.cpp and no address — a machine without it.
        for (const f of BUILTIN_FILES) {
          const to = path.join(res, BUILTIN_DIR, ...f.path.split('/'));
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(path.join(builtinSrc, ...f.path.split('/')), to);
        }
      } else {
        fs.mkdirSync(path.join(res, 'llama-cpp'), { recursive: true });
        fs.mkdirSync(path.join(res, 'gguf'), { recursive: true });
        fs.writeFileSync(path.join(res, 'llama-cpp', 'llama-server.exe'), '');
        fs.writeFileSync(path.join(res, 'gguf', `${EMBEDDER}.gguf`), '');
        env.GATHERLIGHT_LLAMACPP_URL = `http://127.0.0.1:${rt.port}`;
      }
      const sp = path.join(dir, 'state', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(sp, 'utf8'));
      settings.memory = { ...(settings.memory ?? {}), semanticEnabled: true, semanticSource: expectSource, embeddingModel: expectModel };
      fs.writeFileSync(sp, JSON.stringify(settings, null, 2));
    }
    const port = PORT_BASE + i;
    const srv = startServer({ dataDir: dir, port, env });
    started.push(srv.server.pid);
    const arm = { key, label: kind.label, dir, port, semantic: kind.semantic, knob: kind.env[KNOB] ?? '', backend: kind.semantic ? expectSource : null, cpu: !!kind.cpu };
    const routerText = () => (rt ? fs.readFileSync(rt.log, 'utf8') : '');
    try {
      await waitHealthy(srv.base);
      const c = makeClient(srv.base);
      const log = srv.log();
      if (kind.knob && !kind.knob.test(log)) throw new Error(`arm ${key}: its knob did not announce itself`);
      if (!kind.knob && /\[measurement\]/.test(log)) throw new Error(`arm ${key}: sets no knob, yet the server printed a [measurement] line`);
      arm.migrationWarnings = (await c.getJson('/api/migration/status')).warnings ?? [];
      const layers = (await c.getJson('/api/manage/memory')).layers ?? [];
      const sem = layers.find((l) => l.id === 'semantic');
      arm.semanticSource = sem?.activeSource ?? null; arm.semanticModel = sem?.activeModel ?? null;
      if (kind.semantic && (arm.semanticSource !== expectSource || arm.semanticModel !== expectModel))
        throw new Error(`arm ${key}: 语义 runs ${arm.semanticSource} · ${arm.semanticModel}, not ${expectSource} · ${expectModel}`);
      if (!kind.semantic && arm.semanticSource) throw new Error(`arm ${key}: 语义 runs ${arm.semanticSource}, not off`);
      const off = await c.post('/api/manage/memory/enrichment', { enabled: false });
      if (off.status !== 200) throw new Error(`arm ${key}: 判断 off → HTTP ${off.status}`);
      // Run 15's record: memory, pass windows, and the router's proxied count at each boundary (so one arm's passes can
      // be shown to have made exactly one embed per write and per recall; the startup probes are counted apart).
      arm.memory = { beforeWrites: processMemoryOn(port) };
      arm.passes = {};
      const proxiedAtStart = proxiedIn(routerText());
      // WRITE the fixture, in order, timed.
      arm.idOf = {}; arm.writes = [];
      arm.passes.writes = { from: new Date().toISOString() };
      for (const f of facts) {
        const t0 = Date.now();
        const w = await c.call('remember_fact', { kind: f.kind, topic: f.topic, content: f.content, source: `https://example.test/${f.id}`, confidence: 0.8 });
        const ms = Date.now() - t0;
        if (w.result?.ok !== true) throw new Error(`arm ${key}: writing ${f.id} → ${JSON.stringify(w.result).slice(0, 300)}`);
        arm.idOf[f.id] = Number(w.result.id);
        arm.writes.push({ fact: f.id, position: f.position, chars: f.content.length, ms });
        emit({ arm: key, pass: 'write', fact: f.id, position: f.position, chars: f.content.length, ms });
      }
      arm.passes.writes.to = new Date().toISOString();
      const proxiedAfterWrites = proxiedIn(routerText());
      arm.memory.afterWrites = processMemoryOn(port);
      // What the writes left: a vector per fact or not, and the classifier's lines.
      const v = vectorsOf(dir);
      for (const w of arm.writes) { const x = v.get(arm.idOf[w.fact]); w.ref = x?.ref ?? null; w.vector = x?.vector ?? false; }
      const logs = readLogs(dir);
      arm.refusedLines = (logs.match(/the embedder refused the content of fact/g) ?? []).length;
      arm.embedFailures = (logs.match(/router: llamacpp-embed .*→ (?!Ok)/g) ?? []).length;
      // ASK every question, in order.
      arm.rows = [];
      arm.passes.recalls = { from: new Date().toISOString() };
      for (const [seq, x] of queries.entries()) {
        const t0 = Date.now();
        const r = await c.call('recall_facts', { query: x.q, limit: LIMIT });
        const ms = Date.now() - t0;
        const list = Array.isArray(r.result?.facts) ? r.result.facts : null;
        const ids = list ? list.map((f) => Number(f.id)) : [];
        const target = arm.idOf[x.fact];
        const row = { arm: key, pass: 'recall', seq, fact: x.fact, set: x.set, position: facts.find((f) => f.id === x.fact)?.position ?? null,
          control: x.control ?? false, status: r.status, ranked: r.result?.ranked ?? null, error: list ? null : (r.result?.error ?? `HTTP ${r.status}`),
          pos: list ? ids.indexOf(target) : null, page: ids, matched: list ? (list.find((f) => Number(f.id) === target)?.matched ?? null) : null, ms };
        arm.rows.push(row);
        emit(row);
      }
      arm.passes.recalls.to = new Date().toISOString();
      arm.memory.afterRecalls = processMemoryOn(port);
      const all = readLogs(dir);
      arm.cliCalls = (all.match(/router: claude-cli /g) ?? []).length;
      // Run 15's log guards: every line of the arm's own log at INFO; 内置's load line; and no line from the llama.cpp
      // runtime in an arm that binds none (formula, 内置) — the app did nothing with llama.cpp there.
      arm.logLevels = { warn: (all.match(/\] \[WARN/g) ?? []).length, error: (all.match(/\] \[(ERROR|ERR|FAIL|CRIT)/g) ?? []).length,
        firstNonInfo: all.split(/\r?\n/).find((l) => /^\[[^\]]+\] \[(?!INFO)/.test(l))?.slice(0, 300) ?? null };
      arm.builtinLoadMs = kind.builtin ? Number(BUILTIN_LOAD.exec(all)?.[1] ?? NaN) : null;
      arm.llamaRuntimeLines = (all.match(/\] \[LlamaServerRuntime\]/g) ?? []).length;
      if (rt && !shared) {
        const text = routerText();
        arm.router = { ...routerRecord(text), atStart: proxiedAtStart, duringWrites: proxiedAfterWrites - proxiedAtStart,
          duringRecalls: proxiedIn(text) - proxiedAfterWrites, cpu: !!kind.cpu, log: rel(rt.log) };
        arm.router.childMemory = arm.router.childPort ? processMemoryOn(arm.router.childPort) : { error: 'no child port in the router log' };
        arm.router.routerMemory = processMemoryOn(rt.port);
      }
    } finally {
      killTree(srv.server.pid);
      started.splice(started.indexOf(srv.server.pid), 1);
      await until(async () => { try { await fetch(`${srv.base}/api/health`); return false; } catch { return true; } }, 60000).catch(() => {});
      if (rt && !shared) await stopRouter(rt);
    }
    arms.push(arm);
    console.log(`  ${key}: wrote ${arm.writes.length} (median ${med(arm.writes.map((w) => w.ms))} ms), vectors ${arm.writes.filter((w) => w.vector).length}/${arm.writes.length}, `
      + `refused lines ${arm.refusedLines}, asked ${arm.rows.length}`);
  }
  let routerSummary;
  if (shared) {
    await stopRouter(shared);
    const text = fs.readFileSync(shared.log, 'utf8');
    routerSummary = { spawns: (text.match(new RegExp(`spawning server instance with name=${EMBEDDER.replaceAll('.', '\\.')} `, 'g')) ?? []).length,
      errorLines: text.split(/\r?\n/).filter((l) => /\d+\.\d+\.\d+\.\d+ E /.test(l)).length,
      tooLarge: (text.match(/too large to process|larger than the max context size|exceed/gi) ?? []).length };
  }
  const results = { at: new Date().toISOString(), fixture: FIXTURE_NAME, fixtureFile: rel(FIXTURE_FILE), fixtureHash: FIXTURE_HASH, facts: facts.length,
    orderSeed: ORDER_SEED, limit: LIMIT, serverBinary: binary, appHead: git(repo, 'rev-parse', '--short', 'HEAD').trim(), embedder: EMBEDDER, window: WINDOW,
    ...(routerSummary ? { router: routerSummary } : { routers: 'per arm' }),
    ...(ARMS.some((a) => ARM_KINDS[a].builtin) ? { builtin: { model: BUILTIN_MODEL, files: BUILTIN_FILES } } : {}),
    arms: arms.map(({ dir, ...a }) => ({ ...a, dir: rel(dir) })) };
  const file = path.join(WORK, `results-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  report(results);
  console.log(`\nraw rows: ${rel(ROWS)}\nresults: ${rel(file)}`);
}

function report(r) {
  const by = Object.fromEntries(r.arms.map((a) => [a.key, a]));
  const stat = (rows) => ({ n: rows.length, top1: rows.filter(HITS.top1).length, found: rows.filter(HITS.found).length, err: rows.filter((x) => x.error).length });
  const groups = r.fixture === 'capability' ? [['all', () => true]] : [['all', () => true], ...QUESTION_SETS.map((s) => [s.key, (x) => x.set === s.key]),
    ...(r.fixture === 'embed' ? [['short targets', (x) => x.position === 'short'], ['over-window targets', (x) => x.position === 'over']] : []),
    ...(r.fixture === 'long' ? POSITIONS.map((p) => [`answer at ${p}`, (x) => x.position === p]) : [])];
  console.log(`\n== writes (ms per remember_fact, 判断 off) and what they left ==`);
  for (const a of r.arms) {
    const w = (pos) => a.writes.filter((x) => pos === null || x.position === pos);
    const line = (pos) => { const xs = w(pos); return xs.length ? `${pos ?? 'all'} ${xs.length}: median ${med(xs.map((x) => x.ms))} ms (max ${Math.max(...xs.map((x) => x.ms))}), vectors ${xs.filter((x) => x.vector).length}` : ''; };
    const positions = r.fixture === 'long' ? [null] : ['short', 'over'];
    console.log(`  ${a.key.padEnd(8)} ${positions.map(line).filter(Boolean).join(' · ')}; refused lines ${a.refusedLines}, failed embeds ${a.embedFailures}, claude-cli ${a.cliCalls}, warnings ${a.migrationWarnings.length}`);
  }
  if (r.fixture === 'capability') {
    console.log('\n== the capability check: where each question put the target ==');
    for (const a of r.arms) for (const x of a.rows)
      console.log(`  ${a.key.padEnd(6)} ${x.control ? 'control' : 'target '} ${x.set.padEnd(6)} pos ${x.pos} (${x.ranked}${x.matched ? `, matched ${x.matched}` : ''}) of ${x.page.length} · ${x.ms} ms`);
    return;
  }
  console.log(`\n== recall: top-1 / found@8 of n ==`);
  for (const [g, where] of groups) console.log(`  ${g.padEnd(20)} ` + r.arms.map((a) => { const s = stat(a.rows.filter(where)); return `${a.key} ${s.top1}/${s.found} of ${s.n}${s.err ? ` (${s.err} err)` : ''}`; }).join(' · '));
  // Run 14's pairs first, in Run 14's order (a saved Run 14 run prints exactly what it printed); Run 15's after them.
  const pairsOf = [['sems', 'sem'], ['sem2', 'sem'], ['sem', 'formula'], ['sems', 'formula'],
    ['semb', 'cpu-sem'], ['semb', 'sem'], ['cpu-sem', 'sem'], ['cpu-sem', 'formula'], ['semb', 'formula']].filter(([x, y]) => by[x] && by[y]);
  console.log(`\n== paired (b = right-hand hit & left-hand miss, c = the reverse; McNemar exact; Agresti–Min 95%) ==`);
  r.paired = {};
  for (const [x, y] of pairsOf) {
    r.paired[`${x} vs ${y}`] = {};
    for (const [g, where] of groups) {
      const p = paired(by[x].rows, by[y].rows, where);
      r.paired[`${x} vs ${y}`][g] = p;
      const f = (m) => `${p[m].b}/${p[m].c} p ${pv(p[m].p)} ${p[m].netPp >= 0 ? '+' : ''}${p[m].netPp?.toFixed(1)}pp [${p[m].interval95Pp?.map((v) => v.toFixed(1)).join(', ')}]${p[m].equivalent && g === 'all' ? ' equivalent' : ''}`;
      console.log(`  ${`${x} vs ${y}`.padEnd(16)} ${g.padEnd(20)} found@8 ${f('found')} · top-1 ${f('top1')} (${p.pairs})`);
    }
  }
  const differ = (xa, ya) => { const B = new Map(ya.rows.map((x) => [x.seq, x])); return xa.rows.filter((x) => { const q = B.get(x.seq); return !q || q.pos !== x.pos || JSON.stringify(q.page) !== JSON.stringify(x.page); }); };
  // Identity (the short fixture's clause): every row's position and whole page.
  if (by.sems && by.sem) {
    const d = differ(by.sems, by.sem);
    const differA = by.sem2 ? differ(by.sem2, by.sem).length : null;
    r.identity = { semsVsSem: d.length, sem2VsSem: differA };
    console.log(`\n== identity: rows whose position or page differ — sems vs sem ${d.length} of ${by.sems.rows.length}${differA === null ? '' : `; sem2 vs sem (A/A) ${differA}`} ==`);
  }
  if (!r.router) {
    // Run 15: rows whose target position or whole page differ, per pair — the implementations' spread against llama.cpp's own.
    const ids = [['sem2', 'sem'], ['cpu-sem', 'sem'], ['semb', 'cpu-sem'], ['semb', 'sem']].filter(([x, y]) => by[x] && by[y]);
    if (ids.length) {
      r.identity15 = Object.fromEntries(ids.map(([x, y]) => {
        const d = differ(by[x], by[y]);
        return [`${x} vs ${y}`, { rows: by[x].rows.length, differ: d.length, positionDiffers: d.filter((q) => by[y].rows.find((z) => z.seq === q.seq)?.pos !== q.pos).length }];
      }));
      console.log(`\n== identity: rows whose target position or whole page differ ==  ${Object.entries(r.identity15).map(([k, v]) => `${k} ${v.differ} of ${v.rows} (position ${v.positionDiffers})`).join(' · ')}`);
    }
  }
  console.log(`\n== time per recall (median ms) ==  ${r.arms.map((a) => `${a.key} ${med(a.rows.map((x) => x.ms))}`).join(' · ')}`);
  if (r.router) console.log(`router: ${r.router.spawns} spawn(s), ${r.router.errorLines} error line(s), ${r.router.tooLarge} too-large line(s)`);
  else report15(r, by);
}

/** Run 15's block: the rule's two clauses, its reference comparisons, and every guard the bench itself can read. */
function report15(r, by) {
  const ms = (xs) => `median ${med(xs)} (p90 ${pct(xs, 0.9)})`;
  const mb = (m) => (m && m.privateBytes ? `${(m.privateBytes / 1048576).toFixed(0)} MB private (${(m.workingSet / 1048576).toFixed(0)} MB ws)` : (m?.error ? `unread: ${m.error}` : '—'));
  console.log(`\n== RUN 15 — per arm: time, memory, guards ==`);
  for (const a of r.arms) {
    const rec = a.rows.filter((x) => !x.error).map((x) => x.ms);
    console.log(`  ${a.key.padEnd(8)} recall ${ms(rec)} ms over ${rec.length} · write ${ms(a.writes.map((w) => w.ms))} ms over ${a.writes.length}`
      + ` · vectors ${a.writes.filter((w) => w.vector).length}/${a.writes.length} · refused ${a.refusedLines}`);
    console.log(`           语义 ${a.semanticSource ?? 'off'}${a.semanticModel ? ` · ${a.semanticModel}` : ''} · log WARN ${a.logLevels?.warn} ERROR ${a.logLevels?.error}`
      + `${a.logLevels?.firstNonInfo ? ` (first: ${a.logLevels.firstNonInfo})` : ''} · migration warnings ${a.migrationWarnings.length} · claude-cli ${a.cliCalls}`
      + `${a.builtinLoadMs !== null && a.builtinLoadMs !== undefined ? ` · 内置 load ${a.builtinLoadMs} ms` : ''} · LlamaServerRuntime lines ${a.llamaRuntimeLines}`);
    console.log(`           server memory: before writes ${mb(a.memory?.beforeWrites)}; after writes ${mb(a.memory?.afterWrites)}; after recalls ${mb(a.memory?.afterRecalls)}`);
    if (a.router) {
      const x = a.router;
      console.log(`           router: ${x.spawns} spawn(s), --device ${x.device ?? '(none given)'}, --n-gpu-layers ${x.nGpuLayers}, --embeddings ${x.embeddings}, batch ${x.batchSize}/${x.ubatchSize},`
        + ` n_threads ${x.nThreads}; proxied ${x.atStart} at start, ${x.duringWrites} during writes, ${x.duringRecalls} during recalls; tasks ${x.tasks},`
        + ` largest ${x.maxTaskTokens} tokens, truncated ${x.truncated}; E lines ${x.errorLines}, too-large ${x.tooLarge}; child ${mb(x.childMemory)}`);
    }
    console.log(`           passes: writes ${a.passes?.writes?.from} – ${a.passes?.writes?.to}; recalls ${a.passes?.recalls?.from} – ${a.passes?.recalls?.to}`);
  }
  const signTest = (x, y) => {
    const B = new Map(y.rows.filter((q) => !q.error).map((q) => [q.seq, q]));
    let slower = 0, faster = 0, tied = 0;
    for (const q of x.rows.filter((z) => !z.error)) { const o = B.get(q.seq); if (!o) continue; if (q.ms > o.ms) slower++; else if (q.ms < o.ms) faster++; else tied++; }
    const p = mcnemarP(slower, faster);
    return { slower, faster, tied, p, significantlySlower: p < 0.05 && slower > faster };
  };
  const bi = by.semb, cpu = by['cpu-sem'], gpu = by.sem;
  if (!bi || !cpu) return;
  r.run15 = {};
  const acc = r.paired['semb vs cpu-sem'].all.found;
  const worse = acc.p < 0.05 && acc.c - acc.b < 0;
  const mBi = med(bi.rows.filter((q) => !q.error).map((q) => q.ms)), mCpu = med(cpu.rows.filter((q) => !q.error).map((q) => q.ms));
  const st = signTest(bi, cpu);
  const higher = mBi > mCpu && st.significantlySlower;
  r.run15 = { accuracy: { ...acc, significantlyWorse: worse }, latency: { semb: mBi, cpuSem: mCpu, ...st, higher, plainHigher: mBi > mCpu } };
  console.log(`\n== RUN 15 — the rule's clauses on this fixture (b = cpu-sem hit & semb miss) ==`);
  console.log(`  accuracy: semb vs cpu-sem all found@8 ${acc.b}/${acc.c}, p ${pv(acc.p)}, ${acc.netPp >= 0 ? '+' : ''}${acc.netPp.toFixed(1)}pp`
    + ` [${acc.interval95Pp.map((v) => v.toFixed(1)).join(', ')}]${acc.equivalent ? ' (equivalent)' : ''} → significantly worse: ${worse ? 'YES' : 'no'}`);
  console.log(`  latency: median per recall semb ${mBi} ms against cpu-sem ${mCpu} ms; semb slower on ${st.slower}, faster on ${st.faster}, tied ${st.tied}`
    + ` (sign test p ${pv(st.p)}) → HIGHER (median higher AND significantly slower): ${higher ? 'YES' : 'no'}; the plain medians alone: ${mBi > mCpu ? 'higher' : 'not higher'}`);
  if (gpu) {
    const g = r.paired['semb vs sem'].all, st2 = signTest(bi, gpu);
    r.run15.vsGpu = { found: g.found, top1: g.top1, time: st2 };
    console.log(`  reference, semb vs sem (GPU): found@8 ${g.found.b}/${g.found.c} p ${pv(g.found.p)}${g.found.equivalent ? ' equivalent' : ''}, top-1 ${g.top1.b}/${g.top1.c} p ${pv(g.top1.p)}`
      + `${g.top1.equivalent ? ' equivalent' : ''}; time slower on ${st2.slower}, faster on ${st2.faster}, tied ${st2.tied} (p ${pv(st2.p)})`);
    const cg = r.paired['cpu-sem vs sem'].all;
    console.log(`  llama.cpp's own spread, cpu-sem vs sem: found@8 ${cg.found.b}/${cg.found.c} p ${pv(cg.found.p)}${cg.found.equivalent ? ' equivalent' : ''}, top-1 ${cg.top1.b}/${cg.top1.c} p ${pv(cg.top1.p)}`);
  }
  if (by.sem2 && gpu) {
    const aa = r.paired['sem2 vs sem']?.all ?? paired(by.sem2.rows, gpu.rows);
    console.log(`  A/A, sem2 vs sem: found@8 ${aa.found.b}/${aa.found.c} p ${pv(aa.found.p)}, top-1 ${aa.top1.b}/${aa.top1.c} p ${pv(aa.top1.p)} → quiet: ${aa.found.p >= 0.05 && aa.top1.p >= 0.05 ? 'yes' : 'NO'}`);
  }
}

if (argv.find((a) => a.startsWith('--report-only='))) report(JSON.parse(fs.readFileSync(arg('report-only'), 'utf8')));
else main().catch((e) => { console.error(e); stopAll(); process.exit(1); });
