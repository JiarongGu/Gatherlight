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
// ARMS (one at a time, each its own data folder and server, all on ONE shared llama.cpp router):
//   formula — 语义 off: the lexical/graph floor.
//   sem     — 语义 on, llama.cpp EmbeddingGemma, as shipped: an input past the window is refused and its fact kept without a vector.
//   sem2    — sem again: the A/A twin (how far two identical arms move).
//   sems    — sem with GATHERLIGHT_EMBED_SEGMENTATION=d177 (EmbedSegmentation): over-window inputs embedded in pieces, pooled.
// Every arm pins the knob (blank or d177) and must announce exactly what it pinned.
//
// FIXTURES: --fixture=embed (devtools/fixtures/recall-bilingual-embed.json, semantic-bench-fixture.mjs; refused unless it
// is what the generator writes) or --fixture=short (recall-bilingual.json, every fact one piece). `--capability` runs the
// one-fact check instead (measuring rule 3): the short fixture's 60 facts as distractors plus ONE over-window note whose
// distinctive sentence sits past the window, asked by paraphrases that share no wording with it, in `sem` and `sems`.
//
//   node devtools/scripts/semantic-bench.mjs --fixture=embed --resources=devtools/_rr-res [--arms=formula,sem,sem2,sems]
//       [--port-base=7830] [--llama-port=7890] [--n=<first n facts>] [--order-seed=12345]
//   node devtools/scripts/semantic-bench.mjs --capability --resources=devtools/_rr-res
// Output: devtools/_semantic-bench-<fixture>/ (arm folders, rows-*.jsonl, results-*.json). Every process it starts is
// ended by PID as a tree.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { makeTestData, startServer, waitHealthy, makeClient, until, repo, git } from './e2e/_e2e-common.mjs';
import { QUESTION_SETS } from './recall-questions.mjs';
import { expectedEmbedBytes, EMBED_FIXTURE, BEFORE } from './semantic-bench-fixture.mjs';
import { FILLER, shuffled, seedOf } from './judge-bench-long-fixture.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const flag = (n) => argv.includes(`--${n}`);
const die = (m) => { console.error(`semantic-bench: ${m}`); process.exit(2); };
const CAPABILITY = flag('capability');
const FIXTURE_NAME = CAPABILITY ? 'capability' : arg('fixture', 'embed');
if (!['embed', 'short', 'capability'].includes(FIXTURE_NAME)) die(`--fixture=${FIXTURE_NAME}: embed or short`);
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
};
for (const a of ARMS) if (!ARM_KINDS[a]) die(`unknown arm ${a} — one of ${Object.keys(ARM_KINDS).join(', ')}`);

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

// ---- the fixture -----------------------------------------------------------------------------------------------------
const base = JSON.parse(fs.readFileSync(path.join(repo, 'devtools', 'fixtures', 'recall-bilingual.json'), 'utf8'));
let FIXTURE, FIXTURE_FILE;
if (FIXTURE_NAME === 'embed') {
  FIXTURE_FILE = EMBED_FIXTURE;
  if (Buffer.compare(fs.readFileSync(EMBED_FIXTURE), expectedEmbedBytes()) !== 0) die(`${rel(EMBED_FIXTURE)} is not what semantic-bench-fixture.mjs writes — regenerate it or restore it`);
  FIXTURE = JSON.parse(fs.readFileSync(EMBED_FIXTURE, 'utf8'));
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

  // The shared router: EmbeddingGemma with the product's embedder section.
  const exe = path.join(RESOURCES, 'llama-cpp', 'llama-server.exe');
  const gguf = path.join(RESOURCES, 'gguf');
  const pinnedSha = new RegExp(`"${EMBEDDER.replaceAll('.', '\\.')}\\.gguf",\\s*"([0-9a-f]{64})"`).exec(catalogue)?.[1];
  const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(gguf, `${EMBEDDER}.gguf`))).digest('hex');
  if (actual !== pinnedSha) die(`${EMBEDDER}.gguf is not the pinned file`);
  const preset = path.join(WORK, 'presets.ini');
  fs.writeFileSync(preset, [`[${EMBEDDER}]`, 'n-gpu-layers = 99', 'embeddings = true', `batch-size = ${WINDOW}`, `ubatch-size = ${WINDOW}`, ''].join('\n'));
  const routerLog = path.join(WORK, 'router.log');
  const logFd = fs.openSync(routerLog, 'w');
  const router = spawn(exe, ['--models-dir', gguf, '--models-preset', preset, '--models-max', '1', '--host', '127.0.0.1', '--port', String(LLAMA_PORT)],
    { cwd: path.dirname(exe), stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd);
  started.push(router.pid);
  await until(async () => (await fetch(`http://127.0.0.1:${LLAMA_PORT}/v1/models`)).ok, 60000);

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
    if (kind.semantic) {
      const res = path.join(dir, 'state', 'resources');
      fs.mkdirSync(path.join(res, 'llama-cpp'), { recursive: true });
      fs.mkdirSync(path.join(res, 'gguf'), { recursive: true });
      fs.writeFileSync(path.join(res, 'llama-cpp', 'llama-server.exe'), '');
      fs.writeFileSync(path.join(res, 'gguf', `${EMBEDDER}.gguf`), '');
      const sp = path.join(dir, 'state', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(sp, 'utf8'));
      settings.memory = { ...(settings.memory ?? {}), semanticEnabled: true, semanticSource: 'llama-cpp', embeddingModel: EMBEDDER };
      fs.writeFileSync(sp, JSON.stringify(settings, null, 2));
      env.GATHERLIGHT_LLAMACPP_URL = `http://127.0.0.1:${LLAMA_PORT}`;
    }
    const port = PORT_BASE + i;
    const srv = startServer({ dataDir: dir, port, env });
    started.push(srv.server.pid);
    const arm = { key, label: kind.label, dir, port, semantic: kind.semantic, knob: kind.env[KNOB] ?? '' };
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
      if (kind.semantic && (arm.semanticSource !== 'llama-cpp' || arm.semanticModel !== EMBEDDER))
        throw new Error(`arm ${key}: 语义 runs ${arm.semanticSource} · ${arm.semanticModel}, not llama-cpp · ${EMBEDDER}`);
      if (!kind.semantic && arm.semanticSource) throw new Error(`arm ${key}: 语义 runs ${arm.semanticSource}, not off`);
      const off = await c.post('/api/manage/memory/enrichment', { enabled: false });
      if (off.status !== 200) throw new Error(`arm ${key}: 判断 off → HTTP ${off.status}`);
      // WRITE the fixture, in order, timed.
      arm.idOf = {}; arm.writes = [];
      for (const f of facts) {
        const t0 = Date.now();
        const w = await c.call('remember_fact', { kind: f.kind, topic: f.topic, content: f.content, source: `https://example.test/${f.id}`, confidence: 0.8 });
        const ms = Date.now() - t0;
        if (w.result?.ok !== true) throw new Error(`arm ${key}: writing ${f.id} → ${JSON.stringify(w.result).slice(0, 300)}`);
        arm.idOf[f.id] = Number(w.result.id);
        arm.writes.push({ fact: f.id, position: f.position, chars: f.content.length, ms });
        emit({ arm: key, pass: 'write', fact: f.id, position: f.position, chars: f.content.length, ms });
      }
      // What the writes left: a vector per fact or not, and the classifier's lines.
      const v = vectorsOf(dir);
      for (const w of arm.writes) { const x = v.get(arm.idOf[w.fact]); w.ref = x?.ref ?? null; w.vector = x?.vector ?? false; }
      const logs = readLogs(dir);
      arm.refusedLines = (logs.match(/the embedder refused the content of fact/g) ?? []).length;
      arm.embedFailures = (logs.match(/router: llamacpp-embed .*→ (?!Ok)/g) ?? []).length;
      // ASK every question, in order.
      arm.rows = [];
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
      arm.cliCalls = (readLogs(dir).match(/router: claude-cli /g) ?? []).length;
    } finally {
      killTree(srv.server.pid);
      started.splice(started.indexOf(srv.server.pid), 1);
      await until(async () => { try { await fetch(`${srv.base}/api/health`); return false; } catch { return true; } }, 60000).catch(() => {});
    }
    arms.push(arm);
    console.log(`  ${key}: wrote ${arm.writes.length} (median ${med(arm.writes.map((w) => w.ms))} ms), vectors ${arm.writes.filter((w) => w.vector).length}/${arm.writes.length}, `
      + `refused lines ${arm.refusedLines}, asked ${arm.rows.length}`);
  }
  killTree(router.pid);
  started.splice(started.indexOf(router.pid), 1);
  const routerText = fs.readFileSync(routerLog, 'utf8');
  const results = { at: new Date().toISOString(), fixture: FIXTURE_NAME, fixtureFile: rel(FIXTURE_FILE), fixtureHash: FIXTURE_HASH, facts: facts.length,
    orderSeed: ORDER_SEED, limit: LIMIT, serverBinary: binary, appHead: git(repo, 'rev-parse', '--short', 'HEAD').trim(), embedder: EMBEDDER, window: WINDOW,
    router: { spawns: (routerText.match(new RegExp(`spawning server instance with name=${EMBEDDER.replaceAll('.', '\\.')} `, 'g')) ?? []).length,
      errorLines: routerText.split(/\r?\n/).filter((l) => /\d+\.\d+\.\d+\.\d+ E /.test(l)).length,
      tooLarge: (routerText.match(/too large to process|larger than the max context size|exceed/gi) ?? []).length },
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
    ...(r.fixture === 'embed' ? [['short targets', (x) => x.position === 'short'], ['over-window targets', (x) => x.position === 'over']] : [])];
  console.log(`\n== writes (ms per remember_fact, 判断 off) and what they left ==`);
  for (const a of r.arms) {
    const w = (pos) => a.writes.filter((x) => pos === null || x.position === pos);
    const line = (pos) => { const xs = w(pos); return xs.length ? `${pos ?? 'all'} ${xs.length}: median ${med(xs.map((x) => x.ms))} ms (max ${Math.max(...xs.map((x) => x.ms))}), vectors ${xs.filter((x) => x.vector).length}` : ''; };
    console.log(`  ${a.key.padEnd(8)} ${[line('short'), line('over')].filter(Boolean).join(' · ')}; refused lines ${a.refusedLines}, failed embeds ${a.embedFailures}, claude-cli ${a.cliCalls}, warnings ${a.migrationWarnings.length}`);
  }
  if (r.fixture === 'capability') {
    console.log('\n== the capability check: where each question put the target ==');
    for (const a of r.arms) for (const x of a.rows)
      console.log(`  ${a.key.padEnd(6)} ${x.control ? 'control' : 'target '} ${x.set.padEnd(6)} pos ${x.pos} (${x.ranked}${x.matched ? `, matched ${x.matched}` : ''}) of ${x.page.length} · ${x.ms} ms`);
    return;
  }
  console.log(`\n== recall: top-1 / found@8 of n ==`);
  for (const [g, where] of groups) console.log(`  ${g.padEnd(20)} ` + r.arms.map((a) => { const s = stat(a.rows.filter(where)); return `${a.key} ${s.top1}/${s.found} of ${s.n}${s.err ? ` (${s.err} err)` : ''}`; }).join(' · '));
  const pairsOf = [['sems', 'sem'], ['sem2', 'sem'], ['sem', 'formula'], ['sems', 'formula']].filter(([x, y]) => by[x] && by[y]);
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
  // Identity (the short fixture's clause): every row's position and whole page.
  if (by.sems && by.sem) {
    const B = new Map(by.sem.rows.map((x) => [x.seq, x]));
    const differ = by.sems.rows.filter((x) => { const q = B.get(x.seq); return !q || q.pos !== x.pos || JSON.stringify(q.page) !== JSON.stringify(x.page); });
    const differA = by.sem2 ? by.sem2.rows.filter((x) => { const q = B.get(x.seq); return !q || q.pos !== x.pos || JSON.stringify(q.page) !== JSON.stringify(x.page); }).length : null;
    r.identity = { semsVsSem: differ.length, sem2VsSem: differA };
    console.log(`\n== identity: rows whose position or page differ — sems vs sem ${differ.length} of ${by.sems.rows.length}${differA === null ? '' : `; sem2 vs sem (A/A) ${differA}`} ==`);
  }
  console.log(`\n== time per recall (median ms) ==  ${r.arms.map((a) => `${a.key} ${med(a.rows.map((x) => x.ms))}`).join(' · ')}`);
  console.log(`router: ${r.router.spawns} spawn(s), ${r.router.errorLines} error line(s), ${r.router.tooLarge} too-large line(s)`);
}

if (argv.find((a) => a.startsWith('--report-only='))) report(JSON.parse(fs.readFileSync(arg('report-only'), 'utf8')));
else main().catch((e) => { console.error(e); stopAll(); process.exit(1); });
