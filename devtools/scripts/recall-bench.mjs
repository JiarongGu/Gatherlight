#!/usr/bin/env node
// recall-bench.mjs — measure what 判断 actually recovers ON THIS HOUSEHOLD'S OWN FACTS.
//
// WHY THIS EXISTS. 记忆检索 tells the household that 判断 matters more than 语义, and cites Lyntai's
// measurement: "0% of misses are retrieval failures — the answer was already in the candidate set, just
// ranked below the cut" (miss 0.54 → 0.19 with a judge). That is a real measurement, but it was taken on
// LYNTAI's corpus, and the panel says so in as many words. This closes that gap: the same question, asked
// of the corpus the advice is actually about.
//
// HOW IT GETS GROUND TRUTH. A household's facts carry no labelled queries, so it makes them: for each
// sampled fact, one model call writes a question that fact answers — deliberately WITHOUT reusing its
// wording, which is exactly the job recall has to do. The fact's own id is then the correct answer, so the
// label is self-evident rather than a judgement call.
//
// PRIVACY. It reads the household's real facts and asks a model to write questions about them, so:
//   · the generated set is cached in the DATA folder ({data}/state/recall-bench.json), never in this repo,
//     because it is household content and household content lives in one place.
//   · this script prints NUMBERS and fact IDs. It never prints a fact or a question. Paste its output
//     anywhere you like; that is the point of it printing nothing else.
//   · the question generation goes through the app's own configured CLI, so nothing new leaves the machine
//     that a normal chat turn would not.
//
// WHAT IT CANNOT DO. This cannot A/B 语义 in one run — it REPORTS which backend was live and leaves the
// comparison to two runs. 判断 is an app_config switch read per call, which is why that one can be
// measured properly here.
//
// The reason 语义 needs two runs is NOT "it is a startup registration" — that was stated for the whole
// layer and is true of only half of it. An EMBEDDER arm is consumed at DI registration and does need a
// restart; the Claude CLI rephrasing arm registers nothing (TakesEffectOnRestart:false) and is read per
// write. What that arm needs instead is a REINDEX, because phrasings are written when a fact is written —
// bind it over an existing corpus and every fact still has none, so a re-run would compare the same
// material to itself and report, honestly and uselessly, no difference.
//
// Usage:
//   node devtools/dev.mjs recall-bench                 # 20 facts, against a server on :5317
//   node devtools/dev.mjs recall-bench --n=40
//   node devtools/dev.mjs recall-bench --regen         # throw away the cached questions and rebuild
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';

const arg = (name, dflt) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const flag = (name) => process.argv.slice(2).includes(`--${name}`);

const BASE = process.env.GATHERLIGHT_URL || 'http://127.0.0.1:5317';
const DATA = path.resolve(process.env.GATHERLIGHT_DATA || 'local');
const N = Number(arg('n', '20'));
const LIMIT = Number(arg('limit', '8'));
const CACHE = path.join(DATA, 'state', 'recall-bench.json');

const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const callTool = async (name, args) => {
  const r = await post('/api/tools/call', { name, arguments: args });
  if (r.status !== 200) throw new Error(`${name} → ${r.status}`);
  return JSON.parse(r.body.result);
};

// ---- 0. is anything listening, and what is 语义 doing? ------------------------------------------------
let memory;
try {
  memory = await (await fetch(`${BASE}/api/manage/memory`)).json();
} catch {
  console.log(`no server at ${BASE} — start one with \`node devtools/dev.mjs server\` first.`);
  process.exit(1);
}
const semantic = (memory.layers ?? []).find((l) => l.id === 'semantic');
const judge = (memory.layers ?? []).find((l) => l.id === 'judge');
const semanticLabel = semantic?.activeSource
  ? `${semantic.activeSource} / ${semantic.activeModel}`
  : 'off';

// ---- 1. sample the corpus -----------------------------------------------------------------------------
// Straight from the table, the way p48 reads it: this is a devtool inspecting app state, and going through
// recall_facts would need a query — which is the very thing being measured.
const dbPath = path.join(DATA, 'state', 'gatherlight.db');
if (!fs.existsSync(dbPath)) {
  console.log(`no database at ${dbPath} — is GATHERLIGHT_DATA right?`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
const total = db.prepare('SELECT COUNT(*) AS n FROM knowledge').get().n;
// Longest-content first rather than random: a one-line fact ("生日:三月") cannot support a question that
// avoids its own wording, so it would measure the question generator rather than recall. Deterministic
// too, which is what makes two runs comparable.
const facts = db.prepare(
  'SELECT id, kind, topic, content FROM knowledge WHERE LENGTH(content) >= 24 ORDER BY LENGTH(content) DESC, id LIMIT ?',
).all(N);
db.close();

if (facts.length < 4) {
  console.log(`only ${facts.length} usable fact(s) of ${total} in the knowledge base — too few to measure.`);
  process.exit(1);
}

// ---- 2. ground truth: one generated question per fact, cached ------------------------------------------
let cache = {};
if (!flag('regen') && fs.existsSync(CACHE)) {
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { cache = {}; }
}

// RESOLVED, never shelled. The prompt below contains newlines, and `shell: true` concatenates arguments
// without escaping them — the exact trap CLAUDE.md names ("ArgumentList only — never a shell"). On Windows
// the first `where` hit can also be an extensionless bash shim that CreateProcess cannot run, so prefer
// .cmd/.exe, the same order ClaudeCliRuntime.Locate uses.
const resolveClaude = () => {
  const explicit = process.env.GATHERLIGHT_CLAUDE_CMD || process.env.CLAUDE_CMD;
  if (explicit) return explicit;
  if (process.platform !== 'win32') return 'claude';
  const w = spawnSync('where.exe', ['claude'], { encoding: 'utf8' });
  const hits = (w.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  return hits.find((h) => /\.(cmd|exe)$/i.test(h)) ?? hits[0] ?? 'claude';
};
const claude = resolveClaude();
const askForQuestion = (fact) => {
  // A NEUTRAL cwd, like every other one-shot call in this codebase: run from the data folder and the
  // planner's whole knowledge base loads per call, which is both slow and irrelevant here.
  const prompt =
    'Below is one fact from a private knowledge base. Write ONE short question that this fact answers.\n'
    + 'Rules: use the same language as the fact; do NOT reuse its distinctive words (paraphrase instead);\n'
    + 'ask it the way a person would; output the question ALONE with no preamble, quotes or punctuation'
    + ' beyond the question mark.\n\nFACT: '
    + `${fact.topic} — ${fact.content}`;
  const r = spawnSync(claude, ['-p', prompt], {
    encoding: 'utf8', cwd: os.tmpdir(), maxBuffer: 1 << 20,
  });
  const out = (r.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
  return out.length >= 4 && out.length <= 200 ? out : null;
};

let generated = 0;
for (const f of facts) {
  const key = String(f.id);
  if (cache[key]?.q) continue;
  const q = askForQuestion(f);
  if (!q) { console.log(`  (could not generate a question for fact ${f.id} — skipping it)`); continue; }
  cache[key] = { q };
  generated++;
  process.stdout.write(`\r  generating questions… ${generated}`);
}
if (generated > 0) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2), 'utf8');
  process.stdout.write(`\r  generated ${generated} question(s), cached in the data folder\n`);
}

const probes = facts.filter((f) => cache[String(f.id)]?.q)
  .map((f) => ({ id: f.id, q: cache[String(f.id)].q }));
if (probes.length < 4) {
  console.log('too few usable questions — is the claude CLI available and signed in?');
  process.exit(1);
}

// ---- 3. score one configuration ------------------------------------------------------------------------
console.log(`\ncorpus     ${total} facts, ${probes.length} probed (longest content first)`);
console.log(`语义       ${semanticLabel}`);
console.log(`recall     limit ${LIMIT}\n`);

const was = judge?.on ?? true;

// PAIRED AND COUNTERBALANCED, because recall MUTATES the thing being measured.
//
// This used to run all queries with 判断 off, then all of them with it on. That is not a comparison of two
// configurations — it is a comparison of a cold graph against one the first block had just warmed. Every
// `recall_facts` call reinforces the nodes it returned and links the facts it returned TOGETHER, so the
// second block ran against a graph the first block had already reshaped. Whichever arm went second was
// measured on different material.
//
// So each query is now asked under BOTH arms back to back, and which arm goes first ALTERNATES. That fixes
// two things at once: the pair sees the graph in nearly the same state (the confound shrinks from a whole
// block to a single intervening call), and alternating cancels the residual instead of handing it to one
// arm. It is also a paired design, which is what you want at this sample size — the comparison is now
// within-query, so a hard query that both arms miss no longer adds noise to the difference between them.
//
// Same number of recalls as before. The extra cost is two enrichment toggles per query, which are
// app_config writes read per call — microseconds against a judge spawn measured in seconds.
const ARMS = [
  { key: 'off', label: '公式 only (判断 off)', enabled: false },
  { key: 'on', label: '公式 + 判断', enabled: true },
];
const acc = Object.fromEntries(ARMS.map((a) => [a.key, { top1: 0, found: 0, rr: 0, ms: 0, judged: 0, graph: 0 }]));

for (const [i, p] of probes.entries()) {
  const order = i % 2 === 0 ? ARMS : [...ARMS].reverse();
  for (const arm of order) {
    await post('/api/manage/memory/enrichment', { enabled: arm.enabled });
    const t0 = Date.now();
    const res = await callTool('recall_facts', { query: p.q, limit: LIMIT });
    const ms = Date.now() - t0;
    const ids = (res.facts ?? []).map((f) => Number(f.id));
    const pos = ids.indexOf(Number(p.id));
    const a = acc[arm.key];
    a.ms += ms;
    if (pos === 0) a.top1++;
    if (pos >= 0) { a.found++; a.rr += 1 / (pos + 1); }
    // `answered` rides ONLY on a graph result — MemoryTools suppresses it on the FTS fallback, because
    // there the judged candidates are not the facts being shown. So the denominator for "did the judge
    // run" is the graph-ranked queries, NOT every query: counting against all of them silently reports a
    // query the graph never answered as a query the judge failed on. Those call for opposite responses,
    // which is the same conflation this column was added to END.
    if (res.ranked === 'graph') a.graph++;
    if (res.answered !== undefined && res.answered !== null) a.judged++;
  }
}

const n = probes.length;
const rows = ARMS.map((arm) => {
  const a = acc[arm.key];
  return {
    label: arm.label,
    top1: a.top1, found: a.found, miss: n - a.found,
    missRate: (n - a.found) / n,
    mrr: a.rr / n,
    judged: a.judged,
    graph: a.graph,
    msPerQuery: Math.round(a.ms / n),
  };
});
// Leave the switch as it was found. A benchmark that silently changes a product setting is a benchmark
// nobody should run twice.
await post('/api/manage/memory/enrichment', { enabled: was });

console.log('| configuration | top-1 | found | miss | miss rate | MRR | judged/graph | ms/query |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.label} | ${r.top1}/${probes.length} | ${r.found}/${probes.length} | ${r.miss}`
    + ` | ${r.missRate.toFixed(3)} | ${r.mrr.toFixed(3)} | ${r.judged}/${r.graph} | ${r.msPerQuery} |`);
}

// THE CHANCE BASELINE, printed before any interpretation — because without it these numbers mislead in a
// specific and severe way. "found in the top LIMIT of TOTAL facts" is satisfied by RANDOM ranking at a rate
// of LIMIT/TOTAL, so on a small corpus with a generous page the metric is mostly measuring how much of the
// corpus fits on one page. Recall returning half of everything scores 0.5 while knowing nothing.
const chanceFound = Math.min(1, LIMIT / total);
const chanceTop1 = 1 / total;
console.log(`\nchance baseline: found ${chanceFound.toFixed(3)} (top ${LIMIT} of ${total} facts)`
  + ` · top-1 ${chanceTop1.toFixed(3)}`);

const [floor, withJudge] = rows;
const delta = floor.missRate - withJudge.missRate;
console.log(`判断 changed the miss rate by ${delta >= 0 ? '-' : '+'}${Math.abs(delta).toFixed(3)}`
  + ` on this corpus (Lyntai measured -0.35 on theirs: 0.54 → 0.19).`);

// A verdict on whether the run can support a conclusion AT ALL. Printing "0.667 → 0.500" without this is
// how a borrowed number gets replaced by a homegrown one that is worse: at least the borrowed one was
// measured on a corpus big enough to measure.
const tooSmall = chanceFound > 0.25 || probes.length < 15;
if (tooSmall) {
  console.log('\n\x1b[33mNOT A CONCLUSION.\x1b[0m This corpus cannot support the measurement yet:');
  if (chanceFound > 0.25) {
    console.log(`  · a page of ${LIMIT} out of ${total} facts means random ranking already "finds" `
      + `${(chanceFound * 100).toFixed(0)}% —`);
    console.log('    the found/miss columns are mostly reporting that. Re-run with a smaller --limit, or');
    console.log('    wait until the knowledge base is several hundred facts.');
  }
  if (probes.length < 15) {
    console.log(`  · ${probes.length} probes. One query landing differently moves the rate by `
      + `${(1 / probes.length).toFixed(2)}.`);
  }
  console.log('  MRR is the least corpus-sensitive column here, and even it needs more queries than this.');
}
// `judged` is now a COLUMN, not just a zero-check, and the reason is this session's central mistake.
// Seeing no difference between the arms, it is tempting to conclude the judge cannot change a result —
// but "the judge never produced a parseable verdict" and "the judge endorsed what already ranked top"
// produce the identical table and call for opposite responses. Only this count tells them apart, so it
// belongs beside the numbers rather than in a footnote that fires at zero.
if (withJudge.judged === 0) {
  console.log('NOTE: no recall reported a judgement — 判断 may not actually be reaching a model.'
    + ' Check the router lines in the log before believing the row above.');
}
console.log('\nCaveats worth carrying with the numbers:');
console.log(`  · ${probes.length} queries. Enough to see a direction, not to rank two close configurations.`);
console.log('  · the arms are PAIRED — each query is asked under both, back to back, alternating which');
console.log('    goes first. Recall reinforces what it returns and links what it returns together, so');
console.log('    running one arm to completion and then the other would compare a cold graph against a');
console.log('    warmed one. The residual is the single intervening call inside each pair, which the');
console.log('    alternation splits evenly between the arms rather than giving to one.');
console.log('  · the questions are model-written, so they are as good at paraphrasing as the model that');
console.log('    wrote them — a generator that echoes the fact makes recall look better than it is.');
// Two different answers, and stating one for both was wrong. An EMBEDDER arm is consumed at DI
// registration, so binding it really does need a restart. The CLI rephrasing arm registers nothing and
// reports TakesEffectOnRestart:false — it is read per write — so no restart is involved. What it does
// need instead is a REINDEX, because phrasings are written when a fact is written: bind it and the
// existing corpus still has none, so a re-run would measure the old facts and show no difference.
console.log('  · 语义 was ' + semanticLabel + ' throughout, so these numbers say nothing about it.');
console.log('    Comparing it means a second run, and HOW depends on which arm:');
console.log('      · an embedder (llama.cpp / 内置): bind it, RESTART, reindex, re-run.');
console.log('      · the Claude CLI rephrasing arm: no restart — but REINDEX before re-running, or the');
console.log('        existing facts still carry no phrasings and the comparison measures nothing.');
