#!/usr/bin/env node
// judge-bench.mjs — what each way of JUDGING a recall is worth, on the committed bilingual fixture.
//
// WHY SNAPSHOTS. A recall reinforces what it returns and links it, so a run mutates what it measures. The
// combination and the reranker are STARTUP choices, so the within-run pairing recall-bench uses is
// impossible here. Instead ONE data folder is seeded, copied once per arm, and every arm answers the SAME
// questions in the SAME order from the SAME starting graph. Each arm's own drift is part of its effect.
//
// THE SEED is kept OUTSIDE the work dir (devtools/_judge-bench-seed/: `data/` + `seed.json`), because seeding
// costs ~60 real annotation calls. It is VERIFIED, not trusted:
//   - `--reuse-seed` refuses a seed made from a different fixture (seed.json carries its sha256, the CLI version
//     that annotated it, the app's git HEAD and version, and the id map), and prints what made it.
//   - A seed is never replaced by accident: with one present, a plain run refuses; `--reseed` replaces it.
//   - The seed DB is CHECKPOINTED (wal_checkpoint TRUNCATE) once its server has exited, so every arm starts from
//     a single-file database, and whatever the seed server left uncommitted in the seed's own data repo is
//     committed, so an arm's startup warnings are its own.
//   - Every arm must start WITHOUT a claude-cli call: one at startup means the arm re-derived something (a
//     fact-index layout rebuild, say) and no longer starts from the seed, so the run aborts naming the arm.
//   - The formula arm's per-query positions are DIGESTED; two runs whose formula digests match started from
//     equivalent state, which is the precondition for comparing anything ACROSS runs (`--baseline` enforces it).
//
// WHAT MAKES A NUMBER TRUSTWORTHY HERE, each one a way this bench could otherwise lie:
//   - A FAILED recall is an ERROR, never a miss: it is counted apart and kept out of top-1/found/MRR.
//   - A FAILED JUDGE must not look like a working (or fast) one. The product fails open, so the bench is loud:
//     a WARNING when an LLM judge gave no verdict on > 2% of its graph recalls, when a RERANKER gave none on
//     any (a reranker abstains only on a fault), when any claude-cli call failed (counted from each arm's own
//     log folder, accuracy pass and latency pass separately), or when > 2% of queries errored. A judge arm's
//     serial latency counts only recalls that carried a verdict — a failed-open recall is fast and would
//     otherwise make the judge look cheap.
//   - A LOCAL arm must not reach the CLI. A local chat judge annotates AND verifies on llama.cpp, a reranker
//     annotates on the CLI only when a fact is WRITTEN, and the formula arm runs no judge — and a reused seed
//     writes nothing. So any claude-cli call from one of those arms is a WARNING (it is also spent quota), and a
//     chat-judge arm whose llama.cpp chat calls (`router: llamacpp`) never succeeded is one too.
//   - Every arm PINS both measurement knobs (blank = unset), a knob-less arm must print no `[measurement]`
//     line, and the 判断 switch is read BACK after it is set — so no arm silently duplicates another.
//   - The questions are SHUFFLED with a seeded PRNG (mulberry32, --seed) and a fact's four questions are
//     never asked back to back; every arm gets the SAME order. (The fixture has no cluster ids — its
//     near-duplicates sit next to each other in file order, and the shuffle is what separates them.)
//   - `公式 · no verification` is the baseline and it is NOT "判断 off": the seed's CLI-written subject tags
//     are in every arm, so Δ against it is the value of the recall-time VERDICT only.
//   - Accuracy is measured with every arm running in PARALLEL (so ms there is contended); LATENCY is then
//     measured SERIALLY, one arm at a time over the first --latency-sample queries. That pass recalls again
//     and so mutates each arm's graph — it runs after every accuracy row is recorded, so it cannot touch them.
//
// HOW TO READ IT. Every arm answers the same queries, so arms are compared PAIRED, per query, on top-1 hits and
// on found@8 hits: against `content` and against `formula` when they ran, every reranker against every other, each
// local chat judge against its own other input, against each reranker under partition and against every other chat
// model shown the same input, and against `--baseline=<results.json>:<arm>` from another run. Each comparison reports McNemar's exact p, the
// net difference c − b, and a 95% interval for the net rate (c − b)/pairs — the Agresti–Min adjusted Wald interval
// for a paired difference in proportions, which accounts for both how often the arms disagree and how that splits.
//   - A FINDING needs p < 0.05 on `all` AND no question set that is itself significant (p < 0.05) in the
//     opposite direction.
//   - "NO DIFFERENCE" (equivalent) needs the 95% net interval on `all` entirely inside ±3 pp — a TOST at α = 0.025
//     per side, stricter than the usual 90% / α = 0.05 — and p ≥ 0.05 alone only says the run could not tell. It is
//     judged on `all` only: a single question set's 60 pairs can essentially never reach it.
//   - The A/A twins — `formula2` beside `formula` (no model in the loop) and `content2` beside `content` (the
//     LLM's verdicts vary run to run) — are the SANITY CHECK: an A/A pair must show p ≥ 0.05 on `all`, else the
//     run is suspect (a WARNING). Per-set A/A p values are printed but not warned on: ten tests at 0.05 would
//     raise false alarms by themselves.
//
// RE-ANALYSIS. `--report-only=<results.json>` recomputes every table from a finished run's saved rows — no
// server, no model, nothing in the work dir touched — and writes `<name>.reanalysed-<iso>.json` beside it. The
// live run SAVES before it analyses and then analyses its own saved shape through the SAME functions, so an
// analysis bug costs a re-analysis rather than a re-run, and a later fix applies retroactively. What an older file
// cannot support (no router counts, no latency rows, no order seed) is said, not guessed.
// `--report-only=<rows-*.jsonl>` RECOVERS a run that never saved from its row stream: arm order from the serial
// latency pass, the order seed confirmed by regenerating the query order, the fixture from seed.json checked
// against the rows' questions, router totals recounted from arm-N folders only if they were created by that run —
// and a NOTE for everything else.
//
// OUTPUT. Rows stream to devtools/_judge-bench/rows-<iso>.jsonl as they complete (a crash keeps what was
// measured); the report goes to results-<iso>.json. Neither is ever deleted or truncated by a later run.
// Unknown flags and duplicate arms are REJECTED, so a typo cannot launch a full-cost run with the defaults.
//
// LOCAL-MODEL ARMS. `--rerankers=<m,…>` adds `rr:<m>` (partition) and `rrf:<m>` (fuse) per reranker;
// `--chat-judges=<m,…>` adds `lc:<m>` (content alone — the shipped default, no knob) and `lcb:<m>`
// (`GATHERLIGHT_JUDGE_INPUT=both`, "topic — content") per llama.cpp CHAT model, paired against each other — the
// question docs/judge-bench.md Run 3 asks — as well as against `formula`. All of them share ONE real router,
// launched with the preset section the product writes for each model's kind — for a chat model, `reasoning = off`,
// the `n-predict` generation cap and the `ctx-size` context cap; for a reranker, its declared window or 4096 (see
// presetSection, mirrorGuard, and docs/judge-bench.md Runs 5 and 5b).
//
// PRIVACY. The fixture is invented and committed; this touches no household data. Local-model arms READ the
// llama.cpp binary and GGUFs from --resources and nothing else there. Its default is local/state/resources —
// a household's data folder — so pass --resources=<a scratch folder> unless reading that one is intended.
//
// THE LONG FIXTURE (`--fixture=long`, docs/judge-bench.md Run 6). The same 60 facts and 240 questions, each fact's
// content turned into a ~900–1,200-character note with the answer at a pre-registered POSITION (start / middle / end /
// beyond 1,000 characters) — written by judge-bench-long-fixture.mjs, and REFUSED here unless the committed file is
// byte-for-byte what that generator writes. It is a different instrument, so everything it touches is its own: its seed
// (devtools/_judge-bench-seed-long/), its work dir (devtools/_judge-bench-long/), and its fixture hash, which no
// --baseline from the bilingual fixture can match. Its seed is written with 判断 OFF — no subject tags, so no annotation
// call — and every server it starts (seed and arms) points at the e2e claude STUB, so quota cannot be spent even by
// accident; the seed still asserts zero `router: claude-cli` lines, before and after its writes, and that every fact
// got its own graph node holding exactly its note. Every table gains a BY POSITION block. `--seed-only` builds (or,
// with --reuse-seed, re-verifies) the seed and stops before any arm starts.
//
// CHUNKED RERANKING (docs/judge-bench.md Run 6b). `--rerank-arms=` picks which arms each `--rerankers=` model gets:
// `rr` (partition), `rrf` (fuse) and `rrk` (partition with GATHERLIGHT_RERANK_CHUNKING=on — each long candidate scored
// in windows, its best window's score kept; ChunkedScoreProvider). The default stays `rr,rrf`, so Runs 2–6 re-launch as
// they ran. Every arm pins that knob blank, so `rr` runs the product default and `rrk` must announce itself.
// `--claude-stub` points every server at the e2e claude STUB on ANY fixture (the long fixture always does), refusing a
// Claude-judge arm, so a reranker-only run on the bilingual seed cannot spend quota even by accident.
// `--rerank-memo` puts a small proxy in front of the router for each local-model arm: during the ACCURACY pass an
// identical /v1/rerank request body gets the identical response — the first one computed — whichever arm sent it, and
// every request's body hash, document count and whether the target's answer text was among the documents is recorded on
// the row. llama.cpp's scores drift in the third decimal between identical calls (Run 4's screen), which can flip a
// candidate at the page boundary; the memo removes that noise BETWEEN arms, so two arms that send the same bytes get the
// same verdicts, and an arm that sends different bytes shows it. The serial latency pass is never memoised.
//
// Usage:
//   node devtools/dev.mjs judge-bench                     # formula, formula2, topic, content, content2, contentonly, fuse
//   node devtools/dev.mjs judge-bench --arms=formula,content --n=20 --reuse-seed
//   node devtools/dev.mjs judge-bench --arms=formula --rerankers=LAMAR-600m.Q5_K_M,bge-reranker-v2-m3-Q5_K_M
//   node devtools/dev.mjs judge-bench --reuse-seed --arms=formula --chat-judges=gemma-3-1b-it-Q4_K_M --resources=devtools/_rr-res
//   node devtools/dev.mjs judge-bench --report-only=devtools/_judge-bench/results-<iso>.json [--baseline=…]
//   node devtools/dev.mjs judge-bench --reuse-seed --arms=formula,rr… --baseline=devtools/_judge-bench/results-<iso>.json:content
//   node devtools/dev.mjs judge-bench --fixture=long --seed-only --resources=devtools/_rr-res
//   node devtools/dev.mjs judge-bench --fixture=long --reuse-seed --arms=formula,formula2 --rerankers=… --resources=devtools/_rr-res
//   node devtools/dev.mjs judge-bench --fixture=long --reuse-seed --arms=formula,formula2 --rerankers=… --rerank-arms=rr,rrk --rerank-memo --resources=devtools/_rr-res
// Flags: --arms= --rerankers= --rerank-arms=rr,rrf,rrk --chat-judges= --n= --port-base= --llama-port= --resources= --seed=
//        --latency-sample=   --fixture=bilingual|long   --reuse-seed | --reseed   --seed-only   --claude-stub   --rerank-memo
//        --report-only=<results.json | rows-*.jsonl>   --baseline=<results.json>:<arm>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { makeTestData, startServer, waitHealthy, makeClient, until, repo, git, claudeStubCmd } from './e2e/_e2e-common.mjs';
import { resolveClaude, QUESTION_SETS } from './recall-questions.mjs';
import { expectedLongBytes, POSITIONS } from './judge-bench-long-fixture.mjs';

// ---- flags: known ones only ------------------------------------------------------------------------------
const VALUED = ['arms', 'rerankers', 'rerank-arms', 'chat-judges', 'n', 'port-base', 'llama-port', 'resources', 'seed', 'latency-sample', 'report-only', 'baseline', 'fixture'];
const BOOLEAN = ['reuse-seed', 'reseed', 'seed-only', 'claude-stub', 'rerank-memo'];
const die = (msg) => { console.error(`judge-bench: ${msg}`); process.exit(2); };
const KNOWN = `known flags: ${[...VALUED.map((k) => `--${k}=…`), ...BOOLEAN.map((k) => `--${k}`)].join(' ')}`;
const opts = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z0-9-]+)(?:=([\s\S]*))?$/.exec(a);
  if (!m) die(`unexpected argument '${a}' — ${KNOWN}`);
  const [, name, value] = m;
  if (VALUED.includes(name)) {
    if (value === undefined || value === '') die(`--${name} needs a value (--${name}=…)`);
    opts[name] = value;
  } else if (BOOLEAN.includes(name)) {
    if (value !== undefined) die(`--${name} takes no value`);
    opts[name] = true;
  } else die(`unknown flag '--${name}' — ${KNOWN}`);
}
const arg = (name, dflt) => opts[name] ?? dflt;
const int = (name, dflt, min) => {
  const v = Number(arg(name, String(dflt)));
  if (!Number.isInteger(v) || v < min) die(`--${name} must be an integer ≥ ${min}, got '${arg(name)}'`);
  return v;
};
const list = (name, dflt) => {
  const xs = arg(name, dflt).split(',').filter(Boolean);
  const dup = xs.find((x, i) => xs.indexOf(x) !== i);
  if (dup) die(`--${name}: '${dup}' is listed twice — each runs once (an A/A twin is the way to repeat an arm)`);
  return xs;
};
const REPORT_ONLY = opts['report-only'] ?? null;
if (REPORT_ONLY) {
  // --fixture only matters to a RECOVERY from rows (a saved results file carries its own positions), so it is allowed.
  const extra = Object.keys(opts).filter((k) => k !== 'report-only' && k !== 'baseline' && k !== 'fixture');
  if (extra.length > 0) die(`--report-only re-analyses a saved run and takes only --baseline (and --fixture) — drop ${extra.map((k) => `--${k}`).join(' ')}`);
}
// `<file>.json:<arm>` — split at `.json:` because a Windows path has a drive colon and a reranker arm key has
// one too (`rr:<model>`), so neither the first nor the last colon is the separator.
const BASELINE = (() => {
  const v = opts.baseline;
  if (!v) return null;
  const i = v.indexOf('.json:');
  if (i < 0 || i + 6 >= v.length) die(`--baseline must be <results.json>:<arm>, got '${v}'`);
  return { file: path.resolve(v.slice(0, i + 5)), arm: v.slice(i + 6) };
})();

// ONE instrument per fixture: its own file, seed and work dir, so a run on one can never read the other's seed or wipe
// the other's arm folders (a bilingual run and a long run may even be in flight at once).
const VARIANTS = {
  bilingual: { file: 'recall-bilingual.json', seed: '_judge-bench-seed', work: '_judge-bench' },
  long: { file: 'recall-bilingual-long.json', seed: '_judge-bench-seed-long', work: '_judge-bench-long' },
};
const VARIANT = opts.fixture ?? 'bilingual';
if (!VARIANTS[VARIANT]) die(`--fixture must be one of ${Object.keys(VARIANTS).join(', ')}, got '${VARIANT}'`);
const LONG = VARIANT === 'long';
const FIXTURE_REL = `devtools/fixtures/${VARIANTS[VARIANT].file}`;
const FIXTURE_PATH = path.join(repo, 'devtools', 'fixtures', VARIANTS[VARIANT].file);
const FIXTURE_BYTES = fs.readFileSync(FIXTURE_PATH);
const FIXTURE = JSON.parse(FIXTURE_BYTES.toString('utf8'));
const FIXTURE_HASH = crypto.createHash('sha256').update(FIXTURE_BYTES).digest('hex');
// The long fixture is GENERATED; a hand-edited or stale copy would measure positions nobody registered.
if (LONG && !FIXTURE_BYTES.equals(expectedLongBytes()))
  die(`${FIXTURE_REL} is not what judge-bench-long-fixture.mjs writes — re-run it (and re-register anything that depends on it)`);
/** fact id → where its answer sits in its note, or null for a fixture without positions. */
const FIXTURE_POSITIONS = FIXTURE.facts.some((f) => f.position)
  ? Object.fromEntries(FIXTURE.facts.map((f) => [f.id, f.position])) : null;
const LIMIT = 8;
const PORT_BASE = int('port-base', 5620, 1);
const LLAMA_PORT = int('llama-port', 5660, 1);
const ORDER_SEED = int('seed', 12345, 0);
const LATENCY_SAMPLE = int('latency-sample', 12, 0);
const REUSE_SEED = opts['reuse-seed'] === true;
const RESEED = opts.reseed === true;
const SEED_ONLY = opts['seed-only'] === true;
const WORK = path.join(repo, 'devtools', VARIANTS[VARIANT].work);
const SEED_ROOT = path.join(repo, 'devtools', VARIANTS[VARIANT].seed);
const SEED_DATA = path.join(SEED_ROOT, 'data');
const SEED_META = path.join(SEED_ROOT, 'seed.json');
const RESOURCES = path.resolve(arg('resources', path.join(repo, 'local', 'state', 'resources')));
const RUN_AT = new Date().toISOString();
const RUN_STAMP = RUN_AT.replace(/:/g, '');
const SET_KEYS = QUESTION_SETS.map((s) => s.key);
const SETS = [...SET_KEYS, 'all'];
const rel = (p) => path.relative(repo, p).split(path.sep).join('/');

// Every arm pins BOTH knobs; the server treats a blank value as unset. Without the pin, a knob exported in
// the shell that launched the bench would leak into every arm that did not set it.
// GATHERLIGHT_JUDGE_INPUT is deleted on the Lyntai bump that ships ContentChars, and these arms change with it —
// `topic`/`contentonly` go, `content`/`content2` become knob-less content-only arms, `fuse` keeps one knob. The
// full list is JudgeSeesContentPolicy's class comment, "ON THE BUMP"; after it, `both` cannot be reproduced.
// GATHERLIGHT_JUDGE_DEADLINE_SECONDS (VerificationDeadlinePolicy's test knob) is pinned blank for the same reason, so
// every arm runs the product's default verification deadline; startup below refuses an arm that announces it.
// GATHERLIGHT_RERANK_CHUNKING (RerankChunking, Run 6b) is pinned blank the same way: `rr` then runs the product default
// and `rrk` sets it on, announcing it or the arm is refused.
const PINNED = { GATHERLIGHT_JUDGE_INPUT: '', GATHERLIGHT_VERDICT_COMBINATION: '', GATHERLIGHT_JUDGE_DEADLINE_SECONDS: '',
  GATHERLIGHT_RERANK_CHUNKING: '' };
/** Which arms each `--rerankers=` model gets, and what each pins. `rr` pins nothing (the product default), `rrf` fuse,
 *  `rrk` chunking on. ONE writer: the live run builds reranker arms from this and armConfigFor labels them from it. */
const RERANK_ARM_KINDS = {
  rr: { suffix: 'partition', env: {}, knob: null },
  rrf: { suffix: 'fuse', env: { GATHERLIGHT_VERDICT_COMBINATION: 'fuse' }, knob: /verdict combination = Fuse/ },
  rrk: { suffix: 'partition · chunked', env: { GATHERLIGHT_RERANK_CHUNKING: 'on' }, knob: /rerank chunking = on \(/ },
};
// THE PRODUCT'S LAUNCH NUMBERS, restated here because the bench writes its own router preset — and GUARDED against the
// C# they restate (mirrorGuard, below, before anything starts), because a bench that launches a model differently
// measures a product we do not ship.
// LlamaServerRuntime.ChatMaxTokens — the chat child's generation cap.
const CHAT_MAX_TOKENS = 512;
// LlamaServerRuntime.ChatContextTokens — the chat child's context (2026-09-24). Runs 3–5b launched chat children
// UNCAPPED (their training context); the cap sits far above every fixture prompt (60 candidates, ~1.7k tokens), so a
// re-run measures the same verdicts — the setting moves GPU memory, not what the judge is shown.
const CHAT_CONTEXT_TOKENS = 16384;
// The window a reranker is launched with when its catalogue row DECLARES one — GgufCatalog.DeclaredWindow is the source
// of truth (the row's ContextTokens, read through RerankInputCap.UsableWindow); everything else gets 4096. Keyed by the
// id the arm BINDS, exactly as the product keys it: the catalogued upstream stem gets its row's window, while Run 4's
// renamed `mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0` has no row and so launches at 4096 — as Run 4 ran it, and as the
// product launches such a dropped-in file. So every reranker arm of Runs 2–5b re-launches exactly as it ran (a chat arm
// now gets the context cap, which it did not have — see CHAT_CONTEXT_TOKENS), and re-analysis never launches at all.
const DECLARED_WINDOW = { 'mmarco-mMiniLMv2-L12-H384-v1-Q8_0': 512 };
const RERANK_WINDOW = 4096;   // LlamaServerRuntime.RerankBatch
/** Fails the bench before anything starts when a restated launch number no longer matches the C# it restates. Reads
 *  the SOURCE, not a build: a cheap, dependency-free parse of constants and catalogue rows, which is all it needs. */
function mirrorGuard() {
  const src = (rel) => fs.readFileSync(path.join(repo, 'src', 'server', 'Gatherlight.Platform', 'Agent', 'Llm', 'Services', rel), 'utf8');
  const runtime = src('LlamaServerRuntime.cs');
  const constOf = (name) => Number((new RegExp(`const int ${name} = (\\d+);`).exec(runtime) ?? [])[1]);
  const drift = [];
  if (constOf('ChatMaxTokens') !== CHAT_MAX_TOKENS) drift.push(`ChatMaxTokens ${constOf('ChatMaxTokens')} ≠ ${CHAT_MAX_TOKENS}`);
  if (constOf('ChatContextTokens') !== CHAT_CONTEXT_TOKENS) drift.push(`ChatContextTokens ${constOf('ChatContextTokens')} ≠ ${CHAT_CONTEXT_TOKENS}`);
  if (constOf('RerankBatch') !== RERANK_WINDOW) drift.push(`RerankBatch ${constOf('RerankBatch')} ≠ ${RERANK_WINDOW}`);
  // Every catalogue row that declares ContextTokens, by its literal id. A declaring row whose id is not a literal cannot
  // be checked here, so it is drift too rather than a silent pass. UsableWindow's floor (> 6) is applied as the C# does.
  const declared = {};
  for (const row of src('GgufCatalog.cs').split('new GgufModel(').slice(1)) {
    const window = Number((/ContextTokens:\s*(\d+)/.exec(row) ?? [])[1]);
    if (!window) continue;
    const id = (/^\s*"([^"]+)"/.exec(row) ?? [])[1];
    if (!id) { drift.push('a GgufCatalog row declares ContextTokens under a non-literal id'); continue; }
    if (window > 6) declared[id] = window;
  }
  if (JSON.stringify(Object.entries(declared).sort()) !== JSON.stringify(Object.entries(DECLARED_WINDOW).sort()))
    drift.push(`declared windows ${JSON.stringify(declared)} ≠ ${JSON.stringify(DECLARED_WINDOW)}`);
  if (drift.length) die(`the bench's launch numbers drifted from the product's — update them together: ${drift.join('; ')}`);
}
const ARMS = {
  formula: { label: '公式 · no verification (seed tags present)', enrichment: false, env: {} },
  formula2: { label: '公式 · no verification · A/A twin', enrichment: false, env: {} },
  topic: { label: 'Claude judge · topic only', enrichment: true, judgeInput: 'headline',
    env: { GATHERLIGHT_JUDGE_INPUT: 'headline' }, knob: /judge input = headline \(/ },
  // `content` and `content2` relied on the default being `both`; content-alone became the default 2026-09-24
  // (docs/judge-bench.md Run 1), so both now pin `both` explicitly, with the knob to prove it took.
  content: { label: 'Claude judge · topic — content · partition', enrichment: true, judgeInput: 'both',
    env: { GATHERLIGHT_JUDGE_INPUT: 'both' }, knob: /judge input = both \(/ },
  content2: { label: 'Claude judge · topic — content · partition · A/A twin', enrichment: true, judgeInput: 'both',
    env: { GATHERLIGHT_JUDGE_INPUT: 'both' }, knob: /judge input = both \(/ },
  // How Lyntai's upcoming LlmVerificationOptions.ContentChars renders a candidate: content ALONE (Part 276 / D170).
  // Kept explicitly pinned (rather than left to the now-default) so the non-vacuity check below still confirms
  // the knob took, instead of this arm becoming indistinguishable from one that sets nothing.
  contentonly: { label: 'Claude judge · content only · partition', enrichment: true, judgeInput: 'content',
    env: { GATHERLIGHT_JUDGE_INPUT: 'content' }, knob: /judge input = content \(/ },
  // Two knobs: the verdict-combination knob AND the judge-input knob (pinned to `both`, since fuse is measured
  // against the pre-flip default). `knob` here is an array — see the non-vacuity check, which requires every
  // entry to announce itself.
  fuse: { label: 'Claude judge · topic — content · fuse', enrichment: true, judgeInput: 'both',
    env: { GATHERLIGHT_VERDICT_COMBINATION: 'fuse', GATHERLIGHT_JUDGE_INPUT: 'both' },
    knob: [/verdict combination = Fuse/, /judge input = both \(/] },
};

const appHead = (() => {
  try { return git(repo, 'rev-parse', '--short', 'HEAD').trim(); } catch (e) { return `unknown (${String(e.message).split('\n')[0]})`; }
})();
const appVersion = (() => {
  const m = /<VersionPrefix>([^<]+)<\/VersionPrefix>/.exec(fs.readFileSync(path.join(repo, 'src', 'Directory.Build.props'), 'utf8'));
  return m ? m[1].trim() : 'unknown (no <VersionPrefix> in src/Directory.Build.props)';
})();

// ---- helpers ------------------------------------------------------------------------------------------------
const mulberry32 = (a) => () => {
  a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Display width: a CJK / fullwidth character takes two terminal columns, so padEnd alone misaligns them.
const isWide = (cp) => (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0x303E) || (cp >= 0x3041 && cp <= 0x33FF)
  || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0xA000 && cp <= 0xA4CF)
  || (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F)
  || (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x20000 && cp <= 0x3FFFD);
const dw = (s) => [...String(s)].reduce((w, ch) => w + (isWide(ch.codePointAt(0)) ? 2 : 1), 0);
const pad = (s, w) => String(s) + ' '.repeat(Math.max(0, w - dw(s)));
const signed = (v, digits = 0) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};
const pv = (p) => (p >= 0.9995 ? '1.000' : p < 0.001 ? '<0.001' : p.toFixed(3));

// ---- exact binomial statistics, all in LOG space (a few hundred pairs cannot underflow or overflow) ---------
const logFactTable = [0];
const logFact = (k) => {
  while (logFactTable.length <= k) logFactTable.push(logFactTable[logFactTable.length - 1] + Math.log(logFactTable.length));
  return logFactTable[k];
};
/** Σ_{k=from..to} C(n,k) p^k (1-p)^(n-k), for 0 < p < 1. */
const binomSum = (from, to, n, p) => {
  const lp = Math.log(p), lq = Math.log1p(-p);
  let s = 0;
  for (let k = Math.max(0, from); k <= Math.min(n, to); k++) s += Math.exp(logFact(n) - logFact(k) - logFact(n - k) + k * lp + (n - k) * lq);
  return Math.min(1, s);
};
// McNemar, exact: of the b + c DISCORDANT queries, is a b/c split this uneven plausible under a fair coin?
// Two-sided binomial p = min(1, 2 · Σ_{k ≤ min(b,c)} C(b+c, k) · 0.5^(b+c)).
const mcnemarP = (b, c) => (b + c === 0 ? 1 : Math.min(1, 2 * binomSum(0, Math.min(b, c), b + c, 0.5)));
// The NET rate (c − b) / pairs, with a 95% Agresti–Min adjusted Wald interval for a PAIRED difference in
// proportions: add 0.5 to each discordant cell, then the Wald interval on the adjusted counts, clipped to [−1, 1].
// Two earlier versions were wrong in opposite directions. Treating the disagreement rate as KNOWN made the interval
// no wider than the observed disagreement (16 identical answers read "[0, 0], equivalent"); bounding it and the
// split separately at 97.5% each (Bonferroni over four corners) was valid but so conservative that "equivalent"
// was unreachable — at 240 pairs a single 1/1 disagreement already failed ±3 pp.
const Z975 = 1.95996;
const netInterval = (b, c, pairs) => {
  if (pairs === 0) return null;
  const b1 = b + 0.5, c1 = c + 0.5, n1 = pairs + 2;
  const diff = (c1 - b1) / n1;
  const half = Z975 * Math.sqrt(Math.max(0, (b1 + c1) - ((c1 - b1) ** 2) / n1) / (n1 * n1));
  return [Math.max(-1, diff - half), Math.min(1, diff + half)];
};
const EQUIVALENCE = 0.03;

const readLogs = (dataDir) => {
  const dir = path.join(dataDir, 'state', 'logs');
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir).filter((f) => f.endsWith('.log')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
};
// Lyntai's TextRouter logs one `router: <provider> (model …) → <verdict>` line per attempt. `claude-cli` is the
// CLI; `llamacpp` is LlamaCppSource's CHAT provider (its embedder and reranker register as `llamacpp-embed` and
// `llamacpp-rerank`, which the trailing space keeps out of this count).
const routerOutcomes = (dataDir, provider = 'claude-cli') => {
  let ok = 0, failed = 0;
  const okRe = new RegExp(`router: ${provider} .*→ Ok`), failRe = new RegExp(`router: ${provider} .*→ (?!Ok)`);
  for (const line of readLogs(dataDir).split('\n')) {
    if (okRe.test(line)) ok++;
    else if (failRe.test(line)) failed++;
  }
  return { ok, failed };
};
const LLAMA_CHAT_PROVIDER = 'llamacpp';
const judgeLayer = async (c) => ((await c.getJson('/api/manage/memory')).layers ?? []).find((l) => l.id === 'judge');

// The fixture's data repo gains a generated plans/INDEX.md on first boot, AFTER its initial commits, so every
// copy would start with "数据仓库有 1 处未提交改动" — a startup warning that means nothing here and would trip the
// reranker arms' no-warnings check. Commit whatever the seed server left (the arm regenerates the identical
// file, so it stays clean); an arm's startup warnings are then its own.
const settleSeedRepo = (dataDir) => {
  if (git(dataDir, 'status', '--porcelain').trim() === '') return;
  git(dataDir, 'add', '-A');
  git(dataDir, '-c', 'user.name=judge-bench', '-c', 'user.email=judge-bench@example.test', 'commit', '-q', '-m', 'judge-bench: settle the seed');
};

// A killed server leaves its last writes in the WAL. Fold them into the main file so a copy is one file.
const checkpoint = async (dataDir) => {
  const db = path.join(dataDir, 'state', 'gatherlight.db');
  // Opening a missing path would CREATE an empty database, and every arm would then start from nothing.
  if (!fs.existsSync(db)) throw new Error(`no seed database at ${db}`);
  const t0 = Date.now();
  for (;;) {
    let busy = 1, err = null;
    try {
      const conn = new DatabaseSync(db);
      try { busy = conn.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy; } finally { conn.close(); }
    } catch (e) { err = e; }
    if (!err && busy === 0) break;
    if (Date.now() - t0 > 30000) throw new Error(`seed DB still busy after 30 s (${err?.message ?? 'busy'}) — is a server still running on ${dataDir}?`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const wal = `${db}-wal`;
  if (fs.existsSync(wal) && fs.statSync(wal).size > 0) throw new Error(`checkpoint left a non-empty WAL at ${wal}`);
};

// Which query each row is and where the target landed — the fingerprint of an arm's answers, in query order.
const positionsDigest = (rows) => crypto.createHash('sha256')
  .update(rows.map((r) => `${r.fact}/${r.set}:${r.error === null ? r.pos : 'error'}`).join('\n')).digest('hex').slice(0, 12);

// =============================================================================================================
// ANALYSIS — shared by the live run and --report-only. Both hand it the SAME shape: a results file as saved.
// =============================================================================================================

/** A results file (any format this script has written) → { meta, arms, notes }. Says what an older file lacks. */
const loadRun = (json, source) => {
  const notes = [];
  if (!json || typeof json.rows !== 'object' || json.rows === null)
    throw new Error(`${source}: no saved rows — this file predates them, and nothing can be recomputed from it`);
  const cfg = Array.isArray(json.arms) ? json.arms : Object.keys(json.rows).map((key) => ({ key }));
  if (!Array.isArray(json.arms)) notes.push('no arm configuration saved — labels and enrichment taken from the current arm table');
  const arms = cfg.map((a) => {
    // The arm table, or what a local-model key's own shape says (`rr:`/`rrf:`/`lc:`/`lcb:`).
    const known = ARMS[a.key] ?? armConfigFor(a.key);
    return {
      key: a.key,
      label: a.label ?? known.label ?? a.key,
      enrichment: a.enrichment ?? known.enrichment ?? Boolean(a.reranker),
      judgeInput: a.judgeInput ?? known.judgeInput ?? null,
      reranker: a.reranker ?? known.reranker ?? null,
      chatJudge: a.chatJudge ?? known.chatJudge ?? null,
      knobs: a.knobs ?? null,
      judgeOn: a.judgeOn ?? null, judgeSource: a.judgeSource ?? null, judgeModel: a.judgeModel ?? null,
      migrationWarnings: a.migrationWarnings ?? null,
      router: a.router ?? null,
      localRouter: a.localRouter ?? null,
      rows: (json.rows[a.key] ?? []).filter((r) => (r.pass ?? 'accuracy') === 'accuracy'),
      latencyRows: json.latencyRows?.[a.key] ?? null,
    };
  });
  // A recovered run's own notes already say what its row stream could not carry; these are for saved files.
  if (json.format !== 'recovered') {
    if (arms.some((a) => !a.router)) notes.push('claude-cli router counts not saved — router-failure warnings cannot be recomputed');
    else if (arms.some((a) => !a.router.startup)) notes.push('startup router counts not saved (the file predates the startup check)');
    if (json.order?.seed === undefined) notes.push('order seed not saved — this run cannot be paired with another run');
    if (arms.some((a) => a.migrationWarnings === null)) notes.push('startup warnings not saved for every arm');
  }
  if (!json.latencyRows) notes.push('latency rows not saved — serial latency cannot be recomputed');
  return {
    source,
    meta: {
      format: json.format ?? null,
      fixtureHash: json.fixtureHash ?? null, facts: json.facts ?? null, limit: json.limit ?? LIMIT, at: json.at ?? null,
      orderSeed: json.order?.seed ?? null,
      queries: json.order?.queries ?? Math.max(0, ...arms.map((a) => a.rows.length)),
      adjacentSameFact: json.order?.adjacentSameFact ?? null,
      concurrency: json.concurrency ?? arms.length, latencySample: json.latencySample ?? null,
      claudeVersion: json.claudeVersion ?? null, appHead: json.appHead ?? null, appVersion: json.appVersion ?? null,
      seedFolder: json.seedFolder ?? null,
      // The fixture a run used, and where each fact's answer sat in its note (the long fixture; null before it).
      fixture: json.fixture ?? null,
      positions: json.positions ?? null,
      // `--rerank-memo`'s proxy (Run 6b): whether identical rerank bodies shared a response, and what each arm sent.
      rerankProxy: json.rerankProxy ?? null,
    },
    arms,
    notes,
  };
};

/** Can `run` be paired with `baseRun`'s arm, query by query? Every mismatch is named; none may be waived. */
const checkBaseline = (run, baseRun, armKey) => {
  const problems = [];
  const arm = baseRun.arms.find((a) => a.key === armKey);
  if (!arm) problems.push(`the baseline run has no arm '${armKey}' (it has ${baseRun.arms.map((a) => a.key).join(', ')})`);
  const short = (h) => (h ? h.slice(0, 12) : 'unrecorded');
  if (!run.meta.fixtureHash || run.meta.fixtureHash !== baseRun.meta.fixtureHash)
    problems.push(`fixtureHash ${short(run.meta.fixtureHash)} ≠ baseline ${short(baseRun.meta.fixtureHash)}`);
  if (run.meta.facts === null || run.meta.facts !== baseRun.meta.facts)
    problems.push(`fact count ${run.meta.facts ?? 'unrecorded'} ≠ baseline ${baseRun.meta.facts ?? 'unrecorded'}`);
  if (run.meta.orderSeed === null || run.meta.orderSeed !== baseRun.meta.orderSeed)
    problems.push(`order seed ${run.meta.orderSeed ?? 'unrecorded'} ≠ baseline ${baseRun.meta.orderSeed ?? 'unrecorded'}`);
  const fa = run.arms.find((a) => a.key === 'formula'), fb = baseRun.arms.find((a) => a.key === 'formula');
  if (!fa || !fb) problems.push(`formula digest cannot be compared — no formula arm in ${!fa ? 'this run' : 'the baseline run'}`);
  else if (positionsDigest(fa.rows) !== positionsDigest(fb.rows))
    problems.push(`formula digest ${positionsDigest(fa.rows)} ≠ baseline ${positionsDigest(fb.rows)} — the runs did not start from equivalent state`);
  return { problems, arm };
};

const stat = (rows) => {
  const ok = rows.filter((r) => r.error === null);
  return {
    queries: rows.length,
    errors: rows.length - ok.length,
    n: ok.length,
    graph: ok.filter((r) => r.ranked === 'graph').length,
    judged: ok.filter((r) => r.answered !== null).length,
    endorsed: ok.filter((r) => r.answered === true).length,
    top1: ok.filter((r) => r.pos === 0).length,
    found: ok.filter((r) => r.pos >= 0).length,
    mrr: ok.reduce((a, r) => a + (r.pos >= 0 ? 1 / (r.pos + 1) : 0), 0) / Math.max(1, ok.length),
    ms: Math.round(ok.reduce((a, r) => a + r.ms, 0) / Math.max(1, ok.length)),
  };
};
const inSet = (set) => (r) => set === 'all' || r.set === set;
// Counts when both sides answered the same number of queries; otherwise rates, since errors changed n.
const delta = (s, b) => (s.n === b.n
  ? `${signed(s.top1 - b.top1)} / ${signed(s.found - b.found)} / ${signed(s.mrr - b.mrr, 3)}`
  : `${signed(100 * (s.top1 / Math.max(1, s.n) - b.top1 / Math.max(1, b.n)), 1)}pp / `
    + `${signed(100 * (s.found / Math.max(1, s.n) - b.found / Math.max(1, b.n)), 1)}pp / ${signed(s.mrr - b.mrr, 3)} (rates: n differs)`);

// PAIRED, per query: both arms answered query `seq`, neither errored. b = base hit & arm miss; c = the reverse.
const HITS = { top1: (r) => r.pos === 0, found: (r) => r.pos >= 0 };
const HIT_NAMES = { top1: 'top-1', found: 'found@8' };
// `where` narrows the queries some other way than by question set (the long fixture's POSITION); `set` then only says
// whether this is the `all` row, the one row equivalence is judged on — a position's 60 pairs never are.
const pairedTest = (arm, baseArm, set, where = inSet(set)) => {
  const baseBySeq = new Map(baseArm.rows.map((r) => [r.seq, r]));
  const out = { pairs: 0 };
  const counts = Object.fromEntries(Object.keys(HITS).map((k) => [k, { b: 0, c: 0 }]));
  for (const r of arm.rows.filter(where)) {
    const q = baseBySeq.get(r.seq);
    if (!q || r.error !== null || q.error !== null) continue;
    out.pairs++;
    for (const [k, hit] of Object.entries(HITS)) {
      if (hit(q) && !hit(r)) counts[k].b++;
      if (!hit(q) && hit(r)) counts[k].c++;
    }
  }
  for (const [k, { b, c }] of Object.entries(counts)) {
    const ci = netInterval(b, c, out.pairs);
    out[k] = {
      b, c, p: mcnemarP(b, c),
      net: c - b, netPp: out.pairs ? (100 * (c - b)) / out.pairs : null,
      interval95Pp: ci ? ci.map((v) => 100 * v) : null,
      // Judged on `all` only: a single set's pairs can essentially never bound ±3 pp, so a per-set "no" says
      // nothing and would read as evidence of a difference.
      equivalent: set === 'all' && ci ? ci[0] >= -EQUIVALENCE - 1e-12 && ci[1] <= EQUIVALENCE + 1e-12 : null,
    };
  }
  return out;
};
// A significant `all` is vetoed only by a set that is ITSELF significant in the opposite direction — any
// opposite discordance at all would let one noisy query overrule a real effect.
const findingOf = (bySet, k) => {
  const a = bySet.all[k];
  const direction = Math.sign(a.c - a.b);
  const vetoedBy = SET_KEYS.filter((s) => bySet[s][k].p < 0.05 && Math.sign(bySet[s][k].c - bySet[s][k].b) === -direction);
  return {
    significant: a.p < 0.05, direction, vetoedBy,
    finding: a.p < 0.05 && direction !== 0 && vetoedBy.length === 0,
    equivalent: a.equivalent,
  };
};
const findingText = (f) => (f.finding ? `YES (arm ${f.direction > 0 ? 'better' : 'worse'})`
  : f.significant ? `vetoed by ${f.vetoedBy.join(', ')}` : 'no');

/** One paired block: every comparison, a table per hit kind. Returns { label: { ...bySet, finding } }. */
const printPaired = (title, comps) => {
  const W = Math.max(dw('arm'), ...comps.map((c) => dw(c.label))) + 2;
  const results = comps.map((c) => {
    const bySet = Object.fromEntries(SETS.map((s) => [s, pairedTest(c.arm, c.base, s)]));
    return { c, bySet, finding: Object.fromEntries(Object.keys(HITS).map((k) => [k, findingOf(bySet, k)])) };
  });
  console.log(`\n${title}`);
  for (const k of Object.keys(HITS)) {
    console.log(`  ${HIT_NAMES[k]}:`);
    console.log('  ' + pad('arm', W) + pad('set', 8) + pad('pairs', 7) + pad('b/c', 9) + pad('p', 8) + pad('net c−b', 17)
      + pad('95% net interval', 20) + pad('equiv ±3pp', 12) + 'finding');
    for (const { c, bySet, finding } of results) {
      for (const set of ['all', ...SET_KEYS]) {
        const x = bySet[set][k];
        const net = x.netPp === null ? '—' : `${signed(x.net)} (${signed(x.netPp, 1)}pp)`;
        const ci = x.interval95Pp ? `[${signed(x.interval95Pp[0], 1)}, ${signed(x.interval95Pp[1], 1)}]pp` : '—';
        const eq = x.equivalent === null ? '—' : x.equivalent ? 'YES' : 'no';
        console.log('  ' + pad(set === 'all' ? c.label : '', W) + pad(set, 8) + pad(bySet[set].pairs, 7) + pad(`${x.b}/${x.c}`, 9)
          + pad(pv(x.p), 8) + pad(net, 17) + pad(ci, 20) + pad(eq, 12) + (set === 'all' ? findingText(finding[k]) : ''));
      }
    }
  }
  return Object.fromEntries(results.map(({ c, bySet, finding }) => [c.key, { ...bySet, finding }]));
};

/** Each reranker run both unchunked (`rr:`) and chunked (`rrk:`) in one run — Run 6b's pairs, by key, so a saved run
 *  pairs the same way. */
const chunkingPairs = (arms) => arms.filter((a) => /^rr:/.test(a.key))
  .map((rr) => ({ model: rr.key.slice(3), rr, rrk: arms.find((a) => a.key === `rrk:${rr.key.slice(3)}`) }))
  .filter((p) => p.rrk);

/** Are two arms' rows the SAME, query by query? Everything a row records about the recall's outcome — the target's
 *  position, the verdict flag, graph or FTS, how many rows came back, the whole page in order — and, when the memo proxy
 *  ran, the hash of every /v1/rerank body sent. Run 6b's rule (c) asks this of chunked against unchunked on short facts,
 *  where every candidate is one window and nothing may differ. */
const identityOf = (arm, base) => {
  const bySeq = new Map(base.rows.map((r) => [r.seq, r]));
  const differ = { pos: 0, answered: 0, ranked: 0, returned: 0, error: 0, page: 0, rerankBody: 0 };
  let pairs = 0, pageCompared = 0, bodyCompared = 0;
  const seqs = [];
  for (const r of arm.rows) {
    const q = bySeq.get(r.seq);
    if (!q) continue;
    pairs++;
    let d = false;
    for (const k of ['pos', 'answered', 'ranked', 'returned']) if (r[k] !== q[k]) { differ[k]++; d = true; }
    if ((r.error === null) !== (q.error === null)) { differ.error++; d = true; }
    if (r.page && q.page) {
      pageCompared++;
      if (JSON.stringify(r.page) !== JSON.stringify(q.page)) { differ.page++; d = true; }
    }
    if (r.rerank && q.rerank) {
      bodyCompared++;
      if (r.rerank.hash !== q.rerank.hash) { differ.rerankBody++; d = true; }
    }
    if (d) seqs.push(r.seq);
  }
  const complete = pairs > 0 && pairs === arm.rows.length && pairs === base.rows.length;
  return { pairs, complete, pageCompared, bodyCompared, differ, differingQueries: seqs.length, firstDiffering: seqs.slice(0, 12),
    identical: complete && seqs.length === 0 };
};

/** THE LONG FIXTURE'S QUESTION (docs/judge-bench.md Run 6): what each arm does to a fact by WHERE its answer sits in
 *  its note. All four question sets pooled per position (4 × 15 facts = 60 queries); for every arm, accuracy and
 *  coverage; then paired, each arm against `formula` and every reranker against every other, per position. Equivalence
 *  is not judged here (60 pairs can essentially never bound ±3 pp) — the interval is printed instead. Returns what
 *  goes into the results file. */
const printByPosition = (run) => {
  const positions = run.meta.positions;
  const groups = POSITIONS.filter((p) => Object.values(positions).includes(p));
  const at = (p) => (r) => positions[r.fact] === p;
  const { arms } = run;
  const W = Math.max(dw('arm'), ...arms.map((a) => dw(a.label))) + 2;
  const out = { positions: groups, sets: {}, paired: {} };
  console.log('\nBY POSITION — where the answer sits in its note; every question set pooled (4 questions × the facts at that'
    + ' position). Cells: top-1 / found@8 / judged-of-graph');
  console.log(pad('arm', W) + groups.map((p) => pad(`${p} (n=${run.arms[0].rows.filter(at(p)).length})`, 22)).join(''));
  for (const arm of arms) {
    const cells = groups.map((p) => {
      const s = stat(arm.rows.filter(at(p)));
      out.sets[p] = { ...(out.sets[p] ?? {}), [arm.key]: s };
      return pad(`${s.top1} / ${s.found} / ${s.judged}-${s.graph}`, 22);
    });
    console.log(pad(arm.label, W) + cells.join(''));
  }
  const table = (title, comps) => {
    const res = Object.fromEntries(comps.map((c) => [c.key,
      Object.fromEntries(groups.map((p) => [p, pairedTest(c.arm, c.base, null, at(p))]))]));
    const LW = Math.max(dw('arm'), ...comps.map((c) => dw(c.label))) + 2;
    console.log(`\n${title}`);
    for (const k of Object.keys(HITS)) {
      console.log(`  ${HIT_NAMES[k]}:`);
      console.log('  ' + pad('arm', LW) + pad('position', 10) + pad('pairs', 7) + pad('b/c', 9) + pad('p', 8) + pad('net c−b', 17) + '95% net interval');
      for (const c of comps) {
        for (const [i, p] of groups.entries()) {
          const x = res[c.key][p][k];
          const net = x.netPp === null ? '—' : `${signed(x.net)} (${signed(x.netPp, 1)}pp)`;
          const ci = x.interval95Pp ? `[${signed(x.interval95Pp[0], 1)}, ${signed(x.interval95Pp[1], 1)}]pp` : '—';
          console.log('  ' + pad(i === 0 ? c.label : '', LW) + pad(p, 10) + pad(res[c.key][p].pairs, 7) + pad(`${x.b}/${x.c}`, 9)
            + pad(pv(x.p), 8) + pad(net, 17) + ci);
        }
      }
    }
    return res;
  };
  const base = arms.find((a) => a.key === 'formula');
  if (base) out.paired.formula = table('BY POSITION, PAIRED vs formula — b = formula hit & arm miss, c = the reverse',
    arms.filter((a) => a !== base).map((a) => ({ key: a.key, label: a.label, arm: a, base })));
  const rr = arms.filter((a) => a.reranker);
  const rrComps = [];
  for (let i = 0; i < rr.length; i++)
    for (let j = i + 1; j < rr.length; j++)
      rrComps.push({ key: `${rr[j].key} vs ${rr[i].key}`, label: `${rr[j].key} vs ${rr[i].key}`, arm: rr[j], base: rr[i] });
  if (rrComps.length) out.paired.rerankers = table('BY POSITION, PAIRED — every reranker against every other; b = right-hand hit'
    + ' & left-hand miss, c = the reverse', rrComps);
  // Run 6b: each reranker chunked against itself unchunked — the pairs its rule reads, printed on their own.
  const ck = chunkingPairs(arms);
  if (ck.length) out.paired.chunking = table('BY POSITION, PAIRED — chunked (rrk) against unchunked (rr), per reranker; b = rr hit'
    + ' & rrk miss, c = the reverse', ck.map((p) => ({ key: `${p.rrk.key} vs ${p.rr.key}`, label: `${p.rrk.key} vs ${p.rr.key}`, arm: p.rrk, base: p.rr })));
  // What the reranker was actually SHOWN (the memo proxy's record): of the recalls that made a rerank call, in how many
  // was the target's answer text among the documents? A cut arm cannot see an answer past its cut; a chunked arm sees it
  // whenever the target is a candidate at all.
  const proxied = arms.filter((a) => a.rows.some((r) => r.rerank));
  if (proxied.length) {
    out.answerSent = {};
    console.log('\nBY POSITION — recalls whose rerank call carried the target\'s ANSWER TEXT / recalls that made a rerank call');
    console.log(pad('arm', W) + groups.map((p) => pad(p, 22)).join(''));
    for (const arm of proxied) {
      const cells = groups.map((p) => {
        const rows = arm.rows.filter(at(p)).filter((r) => r.rerank && r.rerank.calls > 0);
        const sent = rows.filter((r) => r.rerank.answerSent === true).length;
        out.answerSent[p] = { ...(out.answerSent[p] ?? {}), [arm.key]: { sent, calls: rows.length } };
        return pad(`${sent} / ${rows.length}`, 22);
      });
      console.log(pad(arm.label, W) + cells.join(''));
    }
  }
  return out;
};

/** Every table, from a run in saved shape. Prints, and returns what goes into the results file. */
const analyse = (run, { baseline = null } = {}) => {
  const { meta, arms } = run;
  const out = { sets: {}, paired: {}, noiseFloor: { engine: null, judge: null }, crossRun: null, formulaDigest: null,
    judgeChars: null, armStats: {}, warnings: [], notes: [...run.notes] };
  const find = (k) => arms.find((a) => a.key === k);
  const base = find('formula');
  const LABEL_W = Math.max(dw('arm'), ...arms.map((a) => dw(a.label))) + 2;
  const COLS = [['n', 5], ['err', 5], ['graph', 7], ['judged', 8], ['endorsed', 10], ['top-1', 10], ['found@8', 10], ['MRR', 8], ['ms (parallel)', 15]];

  console.log(`\n${meta.facts ?? '?'} facts × ${QUESTION_SETS.length} sets = ${meta.queries} queries per arm, order seed ${meta.orderSeed ?? 'unrecorded'}`
    + `${meta.adjacentSameFact === null ? '' : ` (${meta.adjacentSameFact} same-fact adjacencies left)`}, ${meta.concurrency} arms in parallel`);
  for (const set of SETS) {
    console.log(`\n== ${set} ==`);
    console.log(pad('arm', LABEL_W) + COLS.map(([h, w]) => pad(h, w)).join('') + 'Δ vs 公式 (top-1 / found / MRR)');
    out.sets[set] = {};
    for (const arm of arms) {
      const s = stat(arm.rows.filter(inSet(set)));
      out.sets[set][arm.key] = s;
      const d = base && arm !== base ? delta(s, stat(base.rows.filter(inSet(set)))) : '';
      const cells = [s.n, s.errors, s.graph, s.judged, s.endorsed, `${s.top1}/${s.n}`, `${s.found}/${s.n}`, s.mrr.toFixed(3), s.ms];
      console.log(pad(arm.label, LABEL_W) + cells.map((v, k) => pad(v, COLS[k][1])).join('') + d);
    }
  }

  // Per-arm latency and digest. A judge arm's serial median counts only recalls that CARRIED A VERDICT: a
  // failed-open recall skips the judge, is fast, and would make a broken judge look cheap.
  for (const arm of arms) {
    const latency = { parallelMean: stat(arm.rows).ms, serialMedian: null, graphRanked: null, unjudged: null, errors: null };
    if (arm.latencyRows) {
      const ok = arm.latencyRows.filter((r) => r.error === null);
      latency.graphRanked = ok.filter((r) => r.ranked === 'graph').length;
      latency.unjudged = arm.enrichment ? ok.filter((r) => r.ranked === 'graph' && r.answered === null).length : 0;
      latency.errors = arm.latencyRows.length - ok.length;
      latency.serialMedian = median(ok.filter((r) => !arm.enrichment || r.answered !== null).map((r) => r.ms));
    }
    out.armStats[arm.key] = { latency, positionsDigest: positionsDigest(arm.rows) };
  }
  if (base) out.formulaDigest = { digest: out.armStats.formula.positionsDigest, queries: meta.queries, orderSeed: meta.orderSeed, facts: meta.facts };

  // ---- the paired tests ----
  for (const baseKey of ['content', 'formula']) {
    const baseArm = find(baseKey);
    const comps = arms.filter((a) => a !== baseArm).map((a) => ({ key: a.key, label: a.label, arm: a, base: baseArm }));
    if (!baseArm || comps.length === 0) continue;
    out.paired[baseKey] = printPaired(`PAIRED vs ${baseKey} — per query; b = ${baseKey} hit & arm miss, c = ${baseKey} miss & arm hit`, comps);
  }
  const rr = arms.filter((a) => a.reranker);
  const rrComps = [];
  for (let i = 0; i < rr.length; i++)
    for (let j = i + 1; j < rr.length; j++)
      rrComps.push({ key: `${rr[j].key} vs ${rr[i].key}`, label: `${rr[j].key} vs ${rr[i].key}`, arm: rr[j], base: rr[i] });
  if (rrComps.length > 0) out.paired.rerankers = printPaired('PAIRED — every reranker against every other; b = right-hand hit & left-hand miss', rrComps);
  // RUN 6b: each reranker chunked (`rrk:`) against itself unchunked (`rr:`), query by query — identical or not, and
  // what differed. On short facts every candidate is one window, so the rule requires IDENTICAL; on long ones this only
  // says how much chunking moved (the paired tests above and BY POSITION say which way).
  const ckPairs = chunkingPairs(arms);
  if (ckPairs.length > 0) {
    out.chunkingIdentity = {};
    console.log('\nCHUNKED vs UNCHUNKED — is every query\'s row identical? (position · verdict flag · graph/FTS · rows returned ·'
      + ' the whole page · every rerank body sent)');
    console.log('  ' + pad('model', 46) + pad('pairs', 7) + pad('differ', 8) + pad('pos/ans/rank/ret/err/page/body', 32)
      + pad('pages · bodies compared', 25) + 'identical');
    for (const p of ckPairs) {
      const x = identityOf(p.rrk, p.rr);
      out.chunkingIdentity[p.model] = x;
      const d = x.differ;
      console.log('  ' + pad(p.model, 46) + pad(x.pairs, 7) + pad(x.differingQueries, 8)
        + pad(`${d.pos}/${d.answered}/${d.ranked}/${d.returned}/${d.error}/${d.page}/${d.rerankBody}`, 32)
        + pad(`${x.pageCompared} · ${x.bodyCompared}`, 25) + (x.identical ? 'YES' : `no${x.firstDiffering.length ? ` (first: seq ${x.firstDiffering.join(', ')})` : ''}`));
    }
  }
  // THE LOCAL CHAT JUDGE'S QUESTION (docs/judge-bench.md Run 3): content alone (`lc:`, the shipped default) against
  // "topic — content" (`lcb:`), per model. Paired by KEY, so a saved or recovered run pairs the same way.
  const chatKey = (a) => /^(lcb?):(.+)$/.exec(a.key);
  const cjComps = [];
  for (const lc of arms.filter((a) => chatKey(a)?.[1] === 'lc')) {
    const lcb = arms.find((a) => a.key === `lcb:${chatKey(lc)[2]}`);
    if (lcb) cjComps.push({ key: `${lc.key} vs ${lcb.key}`, label: `${lc.key} vs ${lcb.key}`, arm: lc, base: lcb });
  }
  if (cjComps.length > 0) out.paired.chatJudges = printPaired('PAIRED — each local chat judge, content only (lc) against topic — content (lcb);'
    + ' b = lcb hit & lc miss, c = the reverse', cjComps);
  // docs/judge-bench.md Run 5: a local chat judge beside ANOTHER local model — against each reranker under partition
  // (the reference) and against every other chat model shown the same input (the first listed is the control). Both
  // are within-run pairs, and neither exists in a run with one chat model and no reranker, so Runs 2–4 re-analyse
  // exactly as they did.
  const cjArms = arms.filter((a) => chatKey(a));
  const cjVsRr = [];
  for (const c of cjArms)
    for (const r of arms.filter((a) => /^rr:/.test(a.key))) cjVsRr.push({ key: `${c.key} vs ${r.key}`, label: `${c.key} vs ${r.key}`, arm: c, base: r });
  if (cjVsRr.length > 0) out.paired.chatJudgesVsRerankers = printPaired('PAIRED — each local chat judge against each reranker under partition;'
    + ' b = reranker hit & chat-judge miss, c = the reverse', cjVsRr);
  const cjAcross = [];
  for (const input of ['lc', 'lcb']) {
    const same = cjArms.filter((a) => chatKey(a)[1] === input);
    for (let i = 0; i < same.length; i++)
      for (let j = i + 1; j < same.length; j++)
        cjAcross.push({ key: `${same[j].key} vs ${same[i].key}`, label: `${same[j].key} vs ${same[i].key}`, arm: same[j], base: same[i] });
  }
  if (cjAcross.length > 0) out.paired.chatJudgesAcross = printPaired('PAIRED — every local chat judge against every other, same input;'
    + ' b = right-hand hit & left-hand miss, c = the reverse', cjAcross);
  if (baseline) {
    const { problems, arm: bArm } = checkBaseline(run, baseline.run, baseline.arm);
    out.crossRun = { baseline: { file: rel(baseline.file), arm: baseline.arm, at: baseline.run.meta.at }, refused: problems.length ? problems : null, paired: null };
    if (problems.length) {
      console.log(`\nCROSS-RUN PAIRING vs ${baseline.arm} @ ${rel(baseline.file)} — REFUSED:`);
      for (const p of problems) console.log(`  - ${p}`);
      out.warnings.push(`cross-run pairing vs ${baseline.arm} refused: ${problems.join('; ')}`);
    } else {
      const label = `${baseline.arm}@${path.basename(baseline.file, '.json')}`;
      const comps = arms.map((a) => ({ key: a.key, label: a.label, arm: a, base: bArm }));
      out.crossRun.paired = printPaired(`PAIRED ACROSS RUNS vs ${label} — digest, order seed, facts and fixture all match;`
        + ` b = baseline hit & arm miss, c = the reverse`, comps);
    }
  }
  if (meta.positions) out.byPosition = printByPosition(run);

  // THE A/A SANITY CHECK. Each twin ran the identical configuration from the identical snapshot, so the paired
  // test must stay quiet on `all`. Per-set p is shown but not warned on (ten tests at 0.05 alarm by themselves).
  const FLOORS = [
    { kind: 'engine', a: 'formula', b: 'formula2', what: 'engine — no model in the loop' },
    { kind: 'judge', a: 'content', b: 'content2', what: "judge — the LLM's verdicts vary run to run" },
  ];
  let floors = 0;
  for (const f of FLOORS) {
    const a = find(f.a), b = find(f.b);
    if (!a || !b) continue;
    if (floors++ === 0) {
      console.log('\nA/A SANITY CHECK — each pair ran the identical configuration from the identical snapshot, so its p on `all`');
      console.log('must stay ≥ 0.05; if it does not, the paired test is seeing something that is not there and the run is suspect.');
    }
    console.log(`\n${f.a} vs ${f.b} (${f.what}):   Δ top-1 / found / MRR   ·   paired p (top-1, found@8)`);
    out.noiseFloor[f.kind] = { arms: [f.a, f.b], sets: {} };
    for (const set of SETS) {
      const sa = stat(a.rows.filter(inSet(set))), sb = stat(b.rows.filter(inSet(set)));
      const p = pairedTest(b, a, set);
      out.noiseFloor[f.kind].sets[set] = {
        top1: sb.top1 - sa.top1, found: sb.found - sa.found, mrr: sb.mrr - sa.mrr, sameN: sa.n === sb.n,
        pTop1: p.top1.p, pFound: p.found.p,
      };
      console.log(`  ${pad(set, 7)} ${pad(delta(sb, sa), 26)} ·   p ${pv(p.top1.p)}, ${pv(p.found.p)}`);
      if (set === 'all')
        for (const k of Object.keys(HITS))
          if (p[k].p < 0.05) out.warnings.push(`A/A pair ${f.a}/${f.b} — paired p ${pv(p[k].p)} on all (${HIT_NAMES[k]}): the run is suspect`);
    }
  }
  if (!out.noiseFloor.judge && arms.some((a) => a.enrichment))
    console.log('\njudge A/A: NOT run (add content,content2) — nothing shows how far the judge wanders between identical runs.');

  if (out.formulaDigest) console.log(`\nformula positions digest: ${out.formulaDigest.digest} (${meta.queries} queries, ${meta.facts ?? '?'} facts,`
    + ` order seed ${meta.orderSeed ?? 'unrecorded'}) — equal digests across runs mean identical formula rows, the precondition for comparing runs`);

  console.log(`\nlatency (ms) — parallel: mean over the accuracy pass, ${meta.concurrency} arm(s) at once; serial median: one arm at a time,`
    + ` first ${meta.latencySample ?? '?'} queries, judge arms counting only recalls that carried a verdict`);
  console.log(pad('arm', LABEL_W) + pad('ms (parallel)', 15) + pad('ms (serial median)', 20)
    + pad('cli ok/failed (accuracy)', 26) + pad('cli ok/failed (total)', 23) + 'judge');
  for (const arm of arms) {
    const l = out.armStats[arm.key].latency;
    const r = (x) => (x ? `${x.ok}/${x.failed}` : 'unrecorded');
    console.log(pad(arm.label, LABEL_W) + pad(l.parallelMean, 15) + pad(l.serialMedian ?? '—', 20)
      + pad(r(arm.router?.accuracy), 26) + pad(r(arm.router?.total), 23)
      + `${arm.judgeOn === null ? '?' : arm.judgeOn ? 'on' : 'off'} · ${arm.judgeSource ?? '—'} · ${arm.judgeModel ?? '—'}`);
  }
  for (const arm of arms)
    if (arm.migrationWarnings?.length > 0) console.log(`  startup warnings in ${arm.key}: ${arm.migrationWarnings.join(' | ')}`);
  // The memo proxy's record (Run 6b): what each arm SENT the reranker in the accuracy pass — calls, documents per call
  // (a chunked arm's documents are windows) and the longest document — and how many calls shared a response.
  if (meta.rerankProxy) {
    out.rerankSent = {};
    console.log(`\nrerank calls, accuracy pass (--rerank-memo ${meta.rerankProxy.memo ? 'on' : 'off'}) — documents are WINDOWS on a chunked arm;`
      + ' "shared" = answered from an identical body already sent');
    console.log(pad('arm', LABEL_W) + pad('calls', 8) + pad('shared', 8) + pad('docs/call (mean)', 18) + pad('docs/call (max)', 17)
      + pad('longest doc (chars)', 21) + 'forwarded · retried · failed (whole run)');
    for (const arm of arms.filter((a) => a.rows.some((r) => r.rerank))) {
      const calls = arm.rows.filter((r) => r.rerank && r.rerank.calls > 0);
      const docs = calls.map((r) => r.rerank.documents / r.rerank.calls);
      const p = meta.rerankProxy.arms?.[arm.key] ?? {};
      const x = {
        calls: calls.reduce((a, r) => a + r.rerank.calls, 0), shared: p.memoHits ?? null,
        docsMean: docs.length ? docs.reduce((a, b) => a + b, 0) / docs.length : null,
        docsMax: docs.length ? Math.max(...docs) : null, longest: calls.reduce((m, r) => Math.max(m, r.rerank.maxChars), 0),
        forwarded: p.forwarded ?? null, retried: p.retried ?? null, errors: p.errors ?? null,
      };
      out.rerankSent[arm.key] = x;
      console.log(pad(arm.label, LABEL_W) + pad(x.calls, 8) + pad(x.shared ?? '—', 8) + pad(x.docsMean === null ? '—' : x.docsMean.toFixed(1), 18)
        + pad(x.docsMax ?? '—', 17) + pad(x.longest, 21)
        + (x.forwarded === null ? 'unrecorded' : `${x.forwarded} · ${x.retried} · ${x.errors}`));
      // A request the proxy failed to deliver reads to the arm as a 502 — no verdict — and says nothing about the judge.
      if (x.errors > 0) out.warnings.push(`arm ${arm.key} — the rerank proxy failed to deliver ${x.errors} request(s): those recalls carry no verdict for a reason that is the bench's, not the judge's`);
    }
    // Every forward must have reached the router (the reconciliation the live run saved).
    const seen = meta.rerankProxy.routerProxied;
    if (seen && !seen.error) {
      out.rerankReconciled = {};
      for (const model of [...new Set(arms.filter((a) => a.reranker && meta.rerankProxy.arms?.[a.key]).map((a) => a.reranker))]) {
        const sent = arms.filter((a) => a.reranker === model).reduce((s, a) => s + (meta.rerankProxy.arms[a.key]?.forwarded ?? 0), 0);
        out.rerankReconciled[model] = { forwarded: sent, routerSaw: seen[model] ?? 0 };
        console.log(`  ${pad(model, LABEL_W - 2)}forwarded ${sent} rerank requests, the router proxied ${seen[model] ?? 0} to this model's child`);
        if (sent !== (seen[model] ?? 0))
          out.warnings.push(`${model} — the proxies forwarded ${sent} rerank requests and the router saw ${seen[model] ?? 0}: some request never reached the model`);
      }
    } else if (seen?.error) out.notes.push(`router log not reconciled: ${seen.error}`);
  }
  const chatArms = arms.filter((a) => a.chatJudge);
  if (chatArms.length > 0) {
    // The counts are cumulative from boot (they are read from the arm's log folder), so each pass is a difference.
    console.log(`\nllama.cpp chat calls (router: ${LLAMA_CHAT_PROVIDER}) — ok/failed per pass; a local chat judge's verdicts arrive through these`);
    const r = (x) => (x ? `${x.ok}/${x.failed}` : 'unrecorded');
    const minus = (x, y) => (x && y ? { ok: x.ok - y.ok, failed: x.failed - y.failed } : null);
    console.log(pad('arm', LABEL_W) + pad('startup', 12) + pad('accuracy pass', 16) + 'latency pass');
    for (const arm of chatArms) {
      const l = arm.localRouter;
      console.log(pad(arm.label, LABEL_W) + pad(r(l?.startup), 12) + pad(r(minus(l?.accuracy, l?.startup)), 16) + r(minus(l?.total, l?.accuracy)));
    }
  }
  // THE COST OF A RECALL WITH NO VERDICT, for a chat judge. The serial median above leaves such recalls out, which
  // is right for a fast fail-open and WRONG for a reply that runs away: a small chat model can generate until the
  // provider's 2-minute timeout, then fail open — slow AND verdict-less, so it would vanish from the median exactly
  // when it costs most. Printed only for a run with a chat judge beside another local model (docs/judge-bench.md
  // Run 5), so Runs 2–4 re-analyse exactly as they did.
  if (cjVsRr.length + cjAcross.length > 0) {
    out.chatJudgeLatencyAll = {};
    console.log('\nlocal chat judge latency (ms), EVERY graph-ranked recall, verdict or not — serial pass, and the accuracy pass (parallel, contended)');
    console.log(pad('arm', LABEL_W) + pad('serial median', 15) + pad('serial max', 12) + pad('no verdict: n · median', 24)
      + pad('parallel max', 14) + pad('parallel ≥ 60 s', 16) + 'parallel no-verdict median');
    for (const arm of cjArms) {
      const g = (rows) => (rows ?? []).filter((r) => r.error === null && r.ranked === 'graph');
      const lat = g(arm.latencyRows), acc = g(arm.rows);
      const none = lat.filter((r) => r.answered === null), accNone = acc.filter((r) => r.answered === null);
      const x = {
        serialMedian: median(lat.map((r) => r.ms)), serialMax: lat.length ? Math.max(...lat.map((r) => r.ms)) : null,
        serialNoVerdict: none.length, serialNoVerdictMedian: median(none.map((r) => r.ms)),
        parallelMax: acc.length ? Math.max(...acc.map((r) => r.ms)) : null, parallelOver60s: acc.filter((r) => r.ms >= 60000).length,
        parallelNoVerdictMedian: median(accNone.map((r) => r.ms)),
      };
      out.chatJudgeLatencyAll[arm.key] = x;
      console.log(pad(arm.label, LABEL_W) + pad(x.serialMedian ?? '—', 15) + pad(x.serialMax ?? '—', 12)
        + pad(`${x.serialNoVerdict} · ${x.serialNoVerdictMedian ?? '—'}`, 24) + pad(x.parallelMax ?? '—', 14)
        + pad(`${x.parallelOver60s}/${acc.length}`, 16) + (x.parallelNoVerdictMedian ?? '—'));
    }
  }

  // WHAT THE JUDGE IS SHOWN PER RECALL — latency alone cannot price it (on the CLI arm a 9–17 s spawn dominates
  // and the cost is quota). Estimated from the fixture: the judge sees min(4 × min(3 × limit, 100), corpus)
  // candidates (Lyntai's 4× VerificationDepth over FactIndex's over-ask). On a large corpus a KIND-filtered recall
  // asks for 100 and would show up to 400 — this fixture cannot exercise that, and the doc must say so.
  const candidates = Math.min(4 * Math.min(3 * meta.limit, 100), FIXTURE.facts.length);
  const lineOf = (f, mode) => Math.min(401,
    mode === 'headline' ? f.topic.length : mode === 'content' ? f.content.length : `${f.topic} — ${f.content}`.length);
  console.log(`\ncandidate text per recall (estimated; ${candidates} candidates at most — the engine gathers only what matches`
    + ' or links; numbering, instructions and the query are excluded, and chars ≠ tokens):');
  const judgeArms = arms.filter((a) => a.judgeInput);
  if (judgeArms.length > 0 && meta.fixtureHash !== FIXTURE_HASH) {
    out.notes.push('the fixture changed since this run — candidate text is not recomputed');
  } else {
    for (const arm of judgeArms) {
      const avg = FIXTURE.facts.reduce((a, f) => a + lineOf(f, arm.judgeInput), 0) / FIXTURE.facts.length;
      out.judgeChars = { ...(out.judgeChars ?? {}), [arm.key]: Math.round(avg * candidates) };
      console.log(`  ${pad(arm.label, LABEL_W)}up to ~${Math.round(avg * candidates)} chars (${Math.round(avg)} per candidate)`);
    }
  }

  // FAIL-OPEN IS SILENT BY DESIGN in the product, so the bench has to be loud about it: a judge that never
  // produced a verdict makes its arm the formula arm under another name.
  for (const arm of arms) {
    const s = stat(arm.rows);
    const l = out.armStats[arm.key].latency;
    if (s.errors > 0.02 * s.queries) out.warnings.push(`arm ${arm.key} — ${s.errors}/${s.queries} queries errored`);
    if (arm.reranker && s.judged < s.graph)
      out.warnings.push(`arm ${arm.key} — reranker gave no verdict on ${s.graph - s.judged}/${s.graph} graph recalls (a reranker abstains only on a fault)`);
    else if (arm.enrichment && !arm.reranker && s.judged < 0.98 * s.graph)
      out.warnings.push(`arm ${arm.key} — judge failed open on ${s.graph - s.judged}/${s.graph} graph recalls`);
    const startup = arm.router?.startup;
    if (startup && startup.ok + startup.failed > 0)
      out.warnings.push(`arm ${arm.key} — ${startup.ok + startup.failed} claude-cli call(s) at startup: it did not start from the seed`);
    if (arm.router?.accuracy?.failed > 0)
      out.warnings.push(`arm ${arm.key} — ${arm.router.accuracy.failed} claude-cli call(s) failed during the accuracy pass`);
    if (arm.router?.total && arm.router?.accuracy && arm.router.total.failed > arm.router.accuracy.failed)
      out.warnings.push(`arm ${arm.key} — ${arm.router.total.failed - arm.router.accuracy.failed} claude-cli call(s) failed during the latency pass`);
    if (arm.router?.total && !arm.router?.accuracy && arm.router.total.failed > 0)
      out.warnings.push(`arm ${arm.key} — ${arm.router.total.failed} claude-cli call(s) failed over the run (which pass is not recoverable)`);
    // A LOCAL arm reaching the CLI at query time: a chat judge annotates and verifies on llama.cpp, a reranker
    // annotates on the CLI only when a fact is written, the formula arm judges nothing — and a reused seed writes
    // nothing. Any call here is unexplained, and it is account quota spent by an arm meant to spend none.
    const local = arm.chatJudge || arm.reranker || arm.enrichment === false;
    const cliCalls = arm.router?.total ?? arm.router?.accuracy;
    if (local && cliCalls && cliCalls.ok + cliCalls.failed > 0)
      out.warnings.push(`arm ${arm.key} — ${cliCalls.ok + cliCalls.failed} claude-cli call(s) from an arm whose judge is local or off: nothing it did should reach the CLI`);
    if (arm.chatJudge && arm.localRouter?.accuracy) {
      const acc = { ok: arm.localRouter.accuracy.ok - (arm.localRouter.startup?.ok ?? 0),
        failed: arm.localRouter.accuracy.failed - (arm.localRouter.startup?.failed ?? 0) };
      if (acc.ok === 0) out.warnings.push(`arm ${arm.key} — no llama.cpp chat call succeeded during the accuracy pass: this judge never judged`);
      if (acc.failed > 0) out.warnings.push(`arm ${arm.key} — ${acc.failed} llama.cpp chat call(s) failed during the accuracy pass`);
    }
    if (l.unjudged > 0)
      out.warnings.push(`arm ${arm.key} — ${l.unjudged}/${l.graphRanked} graph-ranked latency recalls carried no verdict (left out of its serial median)`);
    if (l.errors > 0)
      out.warnings.push(`arm ${arm.key} — ${l.errors}/${arm.latencyRows.length} latency recalls errored (left out of its serial median)`);
  }
  if (out.warnings.length > 0) {
    console.log('');
    for (const w of out.warnings) console.log(`WARNING: ${w}`);
  }
  if (out.notes.length > 0) {
    console.log('');
    for (const n of out.notes) console.log(`NOTE: ${n}`);
  }
  return out;
};

/** Arm entries for a results file: configuration plus what the analysis measured about the arm. */
const armsWithStats = (arms, analysis) => arms.map((a) => {
  const { rows, latencyRows, ...config } = a;
  return { ...config, ...analysis.armStats[a.key] };
});
const readResults = (file) => {
  if (!fs.existsSync(file)) die(`no results file at ${file}`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return die(`${file} is not JSON: ${e.message}`); }
};
const loadOrDie = (json, source) => { try { return loadRun(json, source); } catch (e) { return die(e.message); } };

// ---- the query order: ONE implementation, used by the live run and by recovery (which re-derives it) ----------
/** A deterministic stride sample, so --n=20 covers every cluster rather than the first twenty rows. */
const sampleFacts = (n) => {
  const pool = FIXTURE.facts.filter((f) => f.questions);
  const N = Math.min(n, pool.length);
  const stride = pool.length / N;
  return Array.from({ length: N }, (_, i) => pool[Math.floor(i * stride)]);
};
/** Every (fact, set) once, SHUFFLED by a seeded PRNG, with a fact's questions never back to back. */
const queryOrder = (facts, seed) => {
  const queries = facts.flatMap((f) => QUESTION_SETS.map((s) => ({ fact: f.id, set: s.key, q: f.questions[s.key] })));
  const rand = mulberry32(seed);
  for (let i = queries.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [queries[i], queries[j]] = [queries[j], queries[i]];
  }
  // Deterministic repair: pull a later, different fact forward.
  for (let i = 1; i < queries.length; i++) {
    if (queries[i].fact !== queries[i - 1].fact) continue;
    const j = queries.findIndex((x, k) => k > i && x.fact !== queries[i - 1].fact);
    if (j > 0) [queries[i], queries[j]] = [queries[j], queries[i]];
  }
  return { queries, adjacentSameFact: queries.filter((x, i) => i > 0 && x.fact === queries[i - 1].fact).length };
};
/** What an arm key means, when nothing else recorded it: the arm table, or a local-model key's own shape —
 *  `rr:`/`rrf:`/`rrk:` a reranker under partition/fuse/partition-chunked, `lc:`/`lcb:` a llama.cpp chat judge reading content alone (the
 *  shipped default) or "topic — content". ONE writer: the live run builds those arms from this too. */
const armConfigFor = (key) => {
  if (ARMS[key]) return { label: ARMS[key].label, enrichment: ARMS[key].enrichment, judgeInput: ARMS[key].judgeInput ?? null, reranker: null, chatJudge: null };
  const m = /^(rr[fk]?):(.+)$/.exec(key);
  if (m) return { label: `reranker ${m[2]} · ${RERANK_ARM_KINDS[m[1]].suffix}`, enrichment: true, judgeInput: null, reranker: m[2], chatJudge: null };
  const c = /^(lcb?):(.+)$/.exec(key);
  if (c) return { label: `local chat judge ${c[2]} · ${c[1] === 'lcb' ? 'topic — content' : 'content only'}`, enrichment: true,
    judgeInput: c[1] === 'lcb' ? 'both' : 'content', reranker: null, chatJudge: c[2] };
  return { label: key, enrichment: null, judgeInput: null, reranker: null, chatJudge: null };
};

// =============================================================================================================
// RECOVERY from a row stream — for a run that died before it saved (or whose code analysed before saving).
// Everything the rows do not carry is either RE-DERIVED and checked, or named as not recoverable.
// =============================================================================================================
const recoverFromRows = (file) => {
  const notes = [`recovered from the row stream ${rel(file)} — not a saved results file`];
  const rows = [];
  let bad = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { bad++; }
  }
  if (bad) notes.push(`${bad} unparseable line(s) skipped (a run killed mid-write leaves a partial last line)`);
  if (rows.length === 0) die(`${rel(file)} holds no rows`);
  const runs = [...new Set(rows.map((r) => r.run ?? null))];
  const runAt = runs[runs.length - 1];
  if (runs.length > 1) notes.push(`rows from ${runs.length} runs in one stream — only the last (${runAt}) is used`);
  const mine = rows.filter((r) => (r.run ?? null) === runAt);
  const acc = mine.filter((r) => (r.pass ?? 'accuracy') === 'accuracy');
  const lat = mine.filter((r) => r.pass === 'latency');
  const keys = [...new Set(mine.map((r) => r.arm))];

  // ARM ORDER is what maps an arm to its arm-N folder. The rows do not record it, but the SERIAL latency pass
  // visits the arms in configuration order, so its first appearances are that order — if it reached every arm.
  const latOrder = [...new Set(lat.map((r) => r.arm))];
  const order = latOrder.length === keys.length ? latOrder : null;
  if (order) notes.push('arm order inferred from the serial latency pass, which visits arms in configuration order');

  // FACTS, FIXTURE, ORDER SEED — re-derived, then checked against the rows rather than assumed.
  const factIds = [...new Set(acc.map((r) => r.fact))];
  const byId = new Map(FIXTURE.facts.map((f) => [f.id, f]));
  const qMismatch = mine.filter((r) => byId.get(r.fact)?.questions?.[r.set] !== r.q).length;
  const seedMeta = fs.existsSync(SEED_META) ? JSON.parse(fs.readFileSync(SEED_META, 'utf8')) : null;
  let fixtureHash = null;
  if (qMismatch > 0) notes.push(`fixture hash not recoverable: ${qMismatch} row(s) ask a question the current fixture does not hold`);
  else if (!seedMeta) notes.push('fixture hash not recoverable: no seed.json to confirm which fixture the run used');
  else if (seedMeta.fixtureHash !== FIXTURE_HASH) notes.push('fixture hash not recoverable: the seed was made from a different fixture than the current one');
  else if (runAt && Date.parse(seedMeta.createdAt) > Date.parse(runAt)) notes.push('fixture hash not recoverable: the seed was replaced after this run started');
  else fixtureHash = FIXTURE_HASH;
  const sample = sampleFacts(factIds.length);
  const sameFacts = sample.length === factIds.length && sample.every((f) => factIds.includes(f.id));
  let orderSeed = null;
  let adjacentSameFact = null;
  if (!sameFacts) notes.push(`fact count ${factIds.length} does not reproduce the stride sample — order seed not recoverable`);
  else {
    const { queries, adjacentSameFact: adj } = queryOrder(sample, ORDER_SEED);
    const fits = acc.every((r) => queries[r.seq]?.fact === r.fact && queries[r.seq]?.set === r.set);
    if (fits) { orderSeed = ORDER_SEED; adjacentSameFact = adj; notes.push(`order seed ${ORDER_SEED} confirmed by regenerating the query order`); }
    else notes.push(`the query order does not match seed ${ORDER_SEED} — order seed not recoverable, so this run cannot be paired across runs`);
  }
  const queriesPerArm = factIds.length * QUESTION_SETS.length;
  for (const k of keys) {
    const n = acc.filter((r) => r.arm === k).length;
    if (n < queriesPerArm) notes.push(`arm ${k} has ${n}/${queriesPerArm} accuracy rows — the run did not finish it`);
  }

  // ROUTER COUNTS — recounted from arm-N folders ONLY when they provably belong to this run: every run wipes and
  // recreates them, so they must have been created after this run started and before its first row was written.
  const dir = path.dirname(file);
  const rowsBorn = fs.statSync(file).birthtimeMs;
  const router = {};
  if (!order) notes.push('arm order not recoverable (the latency pass did not reach every arm), so arm-N folders cannot be mapped — router counts not recovered');
  else {
    const folders = order.map((k, i) => [k, path.join(dir, `arm-${i}`)]);
    const missing = folders.filter(([, d]) => !fs.existsSync(d));
    const foreign = folders.filter(([, d]) => fs.existsSync(d)
      && (fs.statSync(d).birthtimeMs < Date.parse(runAt) - 5000 || fs.statSync(d).birthtimeMs > rowsBorn + 5000));
    if (missing.length) notes.push(`no ${missing.map(([, d]) => path.basename(d)).join(', ')} beside the row stream — router counts not recovered`);
    else if (foreign.length) notes.push(`${foreign.map(([, d]) => path.basename(d)).join(', ')} were not created by this run — router counts not recovered`);
    else {
      for (const [k, d] of folders) router[k] = { total: routerOutcomes(d) };
      notes.push('claude-cli router counts recounted from the arm folders — only the TOTAL; the startup/accuracy/latency split is not recoverable');
    }
  }
  notes.push('not recoverable from rows: the judge each arm ran (source · model · on), startup warnings, the CLI version');

  const byArm = (xs) => Object.fromEntries(keys.map((k) => [k, xs.filter((r) => r.arm === k).sort((a, b) => a.seq - b.seq)]));
  const json = {
    format: 'recovered',
    fixtureHash, facts: factIds.length, limit: LIMIT, at: runAt,
    // Positions only when the fixture is confirmed to be the one the rows were asked from.
    fixture: fixtureHash ? FIXTURE_REL : null, ...(fixtureHash && FIXTURE_POSITIONS ? { positions: FIXTURE_POSITIONS } : {}),
    seedFolder: seedMeta ? { fixtureHash: seedMeta.fixtureHash, createdAt: seedMeta.createdAt, claudeVersion: seedMeta.claudeVersion ?? null } : null,
    order: { seed: orderSeed, queries: queriesPerArm, adjacentSameFact },
    concurrency: keys.length,
    latencySample: lat.length ? Math.max(...keys.map((k) => lat.filter((r) => r.arm === k).length)) : null,
    arms: (order ?? keys).map((k) => ({ key: k, ...armConfigFor(k), router: router[k] ?? null })),
    rows: byArm(acc),
    ...(lat.length ? { latencyRows: byArm(lat) } : {}),
  };
  return { json, notes };
};

// =============================================================================================================
// --report-only: re-analyse a finished run. No server, no model, nothing in the work dir touched.
// =============================================================================================================
const reportOnly = () => {
  const file = path.resolve(REPORT_ONLY);
  if (!fs.existsSync(file)) die(`no file at ${file}`);
  let run;
  if (file.endsWith('.jsonl')) {
    const { json, notes } = recoverFromRows(file);
    run = loadOrDie(json, rel(file));
    run.notes = [...notes, ...run.notes];
  } else run = loadOrDie(readResults(file), rel(file));
  console.log(`re-analysing ${rel(file)} (run at ${run.meta.at ?? 'unrecorded'}, format ${run.meta.format ?? 'pre-3'}) with app ${appHead} v${appVersion}`);
  let baseline = null;
  if (BASELINE) {
    baseline = { ...BASELINE, run: loadOrDie(readResults(BASELINE.file), rel(BASELINE.file)) };
    const { problems } = checkBaseline(run, baseline.run, BASELINE.arm);
    if (problems.length) die(`--baseline refused — ${problems.join('; ')}`);
  }
  const analysis = analyse(run, { baseline });
  const { armStats, ...rest } = analysis;
  const out = path.join(path.dirname(file), `${path.basename(file).replace(/\.jsonl?$/, '')}.reanalysed-${RUN_STAMP}.json`);
  fs.writeFileSync(out, JSON.stringify({
    reanalysedAt: RUN_AT, reanalysedFrom: rel(file), reanalysedBy: { appHead, appVersion },
    ...run.meta, fixture: run.meta.fixture ?? 'devtools/fixtures/recall-bilingual.json',
    arms: armsWithStats(run.arms, analysis),
    ...rest,
  }, null, 2));
  console.log(`\nre-analysis: ${out}`);
};

// =============================================================================================================
// The live run.
// =============================================================================================================
const live = async () => {
  const facts = sampleFacts(int('n', FIXTURE.facts.length, 1));
  const N = facts.length;

  const arms = list('arms', 'formula,formula2,topic,content,content2,contentonly,fuse').map((k) => {
    if (!ARMS[k]) die(`unknown arm '${k}' — one of ${Object.keys(ARMS).join(', ')}`);
    return { key: k, ...ARMS[k] };
  });
  const rerankers = list('rerankers', '');
  const rerankKinds = list('rerank-arms', 'rr,rrf');
  for (const k of rerankKinds) if (!RERANK_ARM_KINDS[k]) die(`--rerank-arms: unknown kind '${k}' — one of ${Object.keys(RERANK_ARM_KINDS).join(', ')}`);
  for (const m of rerankers)
    for (const k of rerankKinds) {
      const kind = RERANK_ARM_KINDS[k];
      arms.push({ key: `${k}:${m}`, ...armConfigFor(`${k}:${m}`), env: { ...kind.env }, ...(kind.knob ? { knob: kind.knob } : {}) });
    }
  // A llama.cpp CHAT judge, both ways it can be shown a candidate. `lc` sets NO knob — it is the shipped default,
  // so the knob-less check below proves nothing leaked in — and `lcb` must announce the one it sets.
  const chatJudges = list('chat-judges', '');
  const both = chatJudges.find((m) => rerankers.includes(m));
  if (both) die(`'${both}' is in both --rerankers and --chat-judges — a GGUF is one kind, and the router's preset gives it one`);
  for (const m of chatJudges) {
    arms.push({ key: `lc:${m}`, ...armConfigFor(`lc:${m}`), env: {} });
    arms.push({ key: `lcb:${m}`, ...armConfigFor(`lcb:${m}`), env: { GATHERLIGHT_JUDGE_INPUT: 'both' }, knob: /judge input = both \(/ });
  }
  // The model a local-model arm binds 判断 to, whichever kind it is.
  for (const a of arms) a.llamaModel = a.reranker ?? a.chatJudge ?? null;
  // The long seed is written with 判断 off, so its formula arm has NO tags to recall over — say so in the label.
  if (LONG) for (const a of arms) a.label = a.label.replace('(seed tags present)', '(seed has no tags)');
  if (arms.length === 0) die('no arms selected');
  for (const a of arms) a.pinned = { ...PINNED, ...a.env };

  // ---- the seed decision and the baseline's preconditions, before anything is started or deleted ------------
  if (REUSE_SEED && RESEED) die('--reuse-seed and --reseed contradict each other — pick one');
  let seedMeta = null;
  if (REUSE_SEED) {
    if (!fs.existsSync(SEED_META) || !fs.existsSync(SEED_DATA)) die(`--reuse-seed: no seed at ${SEED_ROOT} — run once without it`);
    seedMeta = JSON.parse(fs.readFileSync(SEED_META, 'utf8'));
    if (seedMeta.fixtureHash !== FIXTURE_HASH)
      die(`--reuse-seed: the fixture changed since the seed was made (${seedMeta.fixtureHash.slice(0, 12)} → ${FIXTURE_HASH.slice(0, 12)}) — pass --reseed`);
    if (LONG && seedMeta.judge !== 'off') die(`--reuse-seed: ${rel(SEED_ROOT)} was not written with 判断 off — pass --reseed`);
  } else if (!RESEED && fs.existsSync(SEED_ROOT) && fs.readdirSync(SEED_ROOT).length > 0) {
    const when = fs.existsSync(SEED_META) ? JSON.parse(fs.readFileSync(SEED_META, 'utf8')).createdAt : 'an interrupted seeding (no seed.json)';
    die(`a seed exists from ${when}; pass --reuse-seed to use it or --reseed to replace it`);
  }
  // What CAN be checked before an hour is spent is checked now; the formula digest needs this run's rows.
  let baseline = null;
  if (BASELINE) {
    baseline = { ...BASELINE, run: loadOrDie(readResults(BASELINE.file), rel(BASELINE.file)) };
    const b = baseline.run;
    const pre = [];
    if (!b.arms.some((a) => a.key === BASELINE.arm)) pre.push(`it has no arm '${BASELINE.arm}' (it has ${b.arms.map((a) => a.key).join(', ')})`);
    if (b.meta.fixtureHash !== FIXTURE_HASH) pre.push('it was run on a different fixture');
    if (b.meta.facts !== N) pre.push(`it asked ${b.meta.facts ?? '?'} facts, this run asks ${N}`);
    if (b.meta.orderSeed !== ORDER_SEED) pre.push(`its order seed is ${b.meta.orderSeed ?? 'unrecorded'}, this run's is ${ORDER_SEED}`);
    if (!b.arms.some((a) => a.key === 'formula')) pre.push('it has no formula arm, so its digest cannot be compared');
    if (!arms.some((a) => a.key === 'formula')) pre.push('this run has no formula arm, so the digests cannot be compared — add formula');
    if (pre.length) die(`--baseline ${rel(BASELINE.file)} cannot be paired with this run: ${pre.join('; ')}`);
  }

  // THE LONG FIXTURE NEVER REACHES A REAL CLI: its seed is written with 判断 off and its arms are formula, rerankers or
  // local chat judges, none of which should call the CLI — so every server it starts is pointed at the e2e stub, and an
  // unexpected call is then counted (router lines) without spending quota. A Claude-judge arm would measure the stub.
  // `--claude-stub` asks the same of the bilingual fixture, for a run with no Claude-judge arm (Run 6b's short guard).
  const STUB = LONG || opts['claude-stub'] === true;
  if (STUB) {
    const cliArms = arms.filter((a) => ARMS[a.key]?.enrichment);
    if (cliArms.length) die(`${LONG ? '--fixture=long' : '--claude-stub'} runs against the claude stub, so a Claude-judge arm would measure the stub — drop ${cliArms.map((a) => a.key).join(', ')}`);
  }
  const claude = STUB ? claudeStubCmd : resolveClaude();
  // shell:false always. A .cmd cannot be spawned directly (Node refuses since the batch-file CVE fix), so it goes
  // through cmd.exe explicitly; anything that still yields no version is recorded as unknown WITH the reason.
  const claudeVersion = STUB ? 'none — the e2e claude stub (devtools/scripts/claude-stub.mjs), never a real CLI' : (() => {
    const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(claude);
    const r = viaCmd
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', `""${claude}" --version"`], { encoding: 'utf8', shell: false, windowsVerbatimArguments: true })
      : spawnSync(claude, ['--version'], { encoding: 'utf8', shell: false });
    const got = (r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (r.status === 0 && got) return got;
    return `unknown (${r.error ? (r.error.code ?? r.error.message) : `exit ${r.status}`} running ${viaCmd ? 'cmd.exe /c ' : ''}${claude} --version)`;
  })();

  const servers = [];
  let router = null;
  const stopRouter = () => {
    if (!router || router.exitCode !== null) return;
    // The router's model children live in its process tree; kill() alone would orphan them.
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/PID', String(router.pid), '/T', '/F'], { stdio: 'ignore' });
      if (r.status === 0) return;
    }
    try { router.kill(); } catch { /* best effort */ }
  };
  const stopAll = () => {
    for (const s of servers) try { s.stop(); } catch { /* best effort */ }
    for (const a of arms) if (a.proxy) try { a.proxy.server.closeAllConnections(); a.proxy.server.close(); } catch { /* best effort */ }
    stopRouter();
  };

  try {
    // ---- 0. per-run cleanup: the arm folders only; earlier rows-*.jsonl and results-*.json are kept ----------
    fs.mkdirSync(WORK, { recursive: true });
    for (const e of fs.readdirSync(WORK)) if (/^arm-\d+$/.test(e)) fs.rmSync(path.join(WORK, e), { recursive: true, force: true });
    const ROWS = path.join(WORK, `rows-${RUN_STAMP}.jsonl`);
    const emit = (row) => fs.appendFileSync(ROWS, JSON.stringify({ run: RUN_AT, ...row }) + '\n');

    // ---- 1. seed ONE folder (real CLI, so annotation writes subject tags) — or reuse the last one --------------
    // The long fixture's seed is written with 判断 OFF instead (no tags, no annotation call), against the stub.
    /** The long seed's database, checked rather than trusted: one knowledge row per fact holding EXACTLY its note (a
     *  truncated note would move the answer), and each on its own graph node (a merged node would make one fact's
     *  recall return another's row). Returns what it found. */
    const verifyLongSeed = (ids) => {
      const conn = new DatabaseSync(path.join(SEED_DATA, 'state', 'gatherlight.db'));
      try {
        const rows = conn.prepare('SELECT id, kind, topic, content, graph_ref FROM knowledge').all();
        const byId = new Map(rows.map((r) => [Number(r.id), r]));
        const problems = [];
        if (rows.length !== FIXTURE.facts.length) problems.push(`${rows.length} knowledge rows, the fixture has ${FIXTURE.facts.length}`);
        for (const f of FIXTURE.facts) {
          const r = byId.get(Number(ids[f.id]));
          if (!r) { problems.push(`no row ${ids[f.id]} for ${f.id}`); continue; }
          if (r.topic !== f.topic || r.kind !== f.kind || r.content !== f.content) problems.push(`row ${r.id} does not hold ${f.id}'s note exactly`);
          if (!r.graph_ref) problems.push(`${f.id} has no graph node`);
        }
        const refs = rows.map((r) => r.graph_ref).filter(Boolean);
        if (new Set(refs).size !== refs.length) problems.push(`${refs.length - new Set(refs).size} graph node(s) shared by two facts`);
        if (problems.length) throw new Error(`the long seed is not what the fixture says: ${problems.join('; ')}`);
        return { rows: rows.length, graphNodes: new Set(refs).size };
      } finally { conn.close(); }
    };
    if (seedMeta) {
      const madeBy = seedMeta.appHead ? `${seedMeta.appHead} v${seedMeta.appVersion}` : 'unrecorded (the seed predates the field)';
      console.log(`  reusing seed from ${seedMeta.createdAt}: annotated by ${seedMeta.claudeVersion ?? 'unrecorded'},`
        + ` made by app ${madeBy} — now running app ${appHead} v${appVersion}`);
      settleSeedRepo(SEED_DATA);
      await checkpoint(SEED_DATA);
      if (LONG) {
        const v = verifyLongSeed(seedMeta.idOf);
        console.log(`  long seed re-verified: 判断 was ${seedMeta.judge}, ${seedMeta.claudeCalls.ok + seedMeta.claudeCalls.failed} claude-cli call(s)`
          + ` while seeding, ${v.rows} rows each holding its exact note, ${v.graphNodes} distinct graph nodes`);
      }
    } else {
      fs.rmSync(SEED_ROOT, { recursive: true, force: true });
      const made = makeTestData(SEED_DATA);
      if (made.status !== 0) throw new Error(`make-test-data exited ${made.status ?? made.error?.message}`);
      for (const f of ['state/settings.json', 'household/people.md'])
        if (!fs.existsSync(path.join(SEED_DATA, f))) throw new Error(`make-test-data left no ${f} in ${SEED_DATA}`);
      const seed = startServer({ dataDir: SEED_DATA, port: PORT_BASE, env: { GATHERLIGHT_CLAUDE_CMD: claude, ...PINNED } });
      servers.push(seed);
      await waitHealthy(seed.base);
      const sc = makeClient(seed.base);
      const cliCalls = () => { const o = routerOutcomes(SEED_DATA); return { ...o, n: o.ok + o.failed }; };
      if (LONG) {
        // 判断 OFF before the first write, read back — a write with it on would be annotated (a model call, and tags).
        if (cliCalls().n > 0) throw new Error(`seed: ${cliCalls().n} claude-cli call(s) before any write`);
        const off = await sc.post('/api/manage/memory/enrichment', { enabled: false });
        if (off.status !== 200) throw new Error(`seed: switching 判断 off returned HTTP ${off.status}`);
        const judge = await judgeLayer(sc);
        if (judge?.on !== false) throw new Error(`seed: 判断 reads back ${judge?.on}, not off`);
        console.log(`  seeding with 判断 off (read back: ${judge.on}), against the claude stub`);
      }
      const ids = {};
      for (const [i, f] of FIXTURE.facts.entries()) {
        const w = await sc.call('remember_fact', {
          kind: f.kind, topic: f.topic, content: f.content, source: `https://example.test/${f.id}`, confidence: 0.8,
        });
        if (w.result?.ok !== true) throw new Error(`seed: ${f.id} → ${JSON.stringify(w.result)}`);
        ids[f.id] = Number(w.result.id);
        process.stdout.write(`\r  seeding ${i + 1}/${FIXTURE.facts.length}   `);
      }
      process.stdout.write('\n');
      seed.stop();
      servers.length = 0;
      await until(async () => { try { await fetch(`${seed.base}/api/health`); return false; } catch { return true; } }, 60000);
      // Counted AFTER the server exited, so every line it wrote is in its log.
      const seedCalls = cliCalls();
      if (LONG && seedCalls.n > 0)
        throw new Error(`seed: ${seedCalls.n} claude-cli call(s) (${seedCalls.ok} ok, ${seedCalls.failed} failed) with 判断 off — see ${rel(SEED_DATA)}/state/logs`);
      settleSeedRepo(SEED_DATA);
      await checkpoint(SEED_DATA);
      seedMeta = { idOf: ids, fixtureHash: FIXTURE_HASH, claudeVersion, appHead, appVersion, createdAt: new Date().toISOString() };
      if (LONG) {
        const v = verifyLongSeed(ids);
        Object.assign(seedMeta, { fixture: FIXTURE_REL, judge: 'off', claudeCalls: { ok: seedCalls.ok, failed: seedCalls.failed }, graphNodes: v.graphNodes });
        console.log(`  long seed: 0 claude-cli calls, ${v.rows} rows each holding its exact note, ${v.graphNodes} distinct graph nodes`);
      }
      fs.writeFileSync(SEED_META, JSON.stringify(seedMeta, null, 2));
    }
    const idOf = new Map(Object.entries(seedMeta.idOf));
    for (const f of facts) if (!idOf.has(f.id)) throw new Error(`seed has no id for fact ${f.id}`);
    if (SEED_ONLY) {
      console.log(`  --seed-only: the seed at ${rel(SEED_ROOT)} (fixture ${FIXTURE_HASH.slice(0, 12)}) is ready; no arm was started`);
      return;
    }

    // ---- 2. the local-model arms share ONE real router, started here -----------------------------------------
    // Each arm's own resources get EMPTY stand-ins for the runtime and the model, which is all IsConfigured asks;
    // the arm then ADOPTS this router at GATHERLIGHT_LLAMACPP_URL (EnsureServingAsync probes before it spawns).
    const llamaModels = [...rerankers, ...chatJudges];
    if (llamaModels.length > 0) {
      const exe = path.join(RESOURCES, 'llama-cpp', 'llama-server.exe');
      const gguf = path.join(RESOURCES, 'gguf');
      if (!fs.existsSync(exe)) throw new Error(`no llama-server at ${exe} — download llama.cpp in 资源 first`);
      // Both layouts ResourceProvisioner.InstalledGgufIds reads: flat gguf/<m>.gguf, or gguf/<m>/<any>.gguf
      // (how 资源 installs them). The router takes the models dir either way and names both by <m>.
      const installed = (m) => fs.existsSync(path.join(gguf, `${m}.gguf`))
        || (fs.existsSync(path.join(gguf, m)) && fs.statSync(path.join(gguf, m)).isDirectory()
          && fs.readdirSync(path.join(gguf, m)).some((f) => f.toLowerCase().endsWith('.gguf')));
      for (const m of llamaModels)
        if (!installed(m)) throw new Error(`${m} is in neither ${gguf}/${m}.gguf nor ${gguf}/${m}/*.gguf — download it in 资源 first`);
      // THE PRODUCT'S PRESET, per kind — LlamaServerRuntime.WritePresets, mirrored line for line, because a bench
      // that launches a model differently measures a product we do not ship. Every kind gets n-gpu-layers (launch
      // CONTRACT: without it the CPU runs the model, silently ~30× slower); a reranker adds `reranking` and its window
      // as ctx/batch/ubatch (a pair must fit one batch) — 4096, or the window its catalogue row DECLARES (DECLARED_WINDOW,
      // the bench's copy of GgufCatalog.DeclaredWindow: mMiniLMv2's 512, since Run 4 found llama.cpp serving it 512 slots
      // whatever 4096 the preset claimed); a CHAT model gets its context cap (CHAT_CONTEXT_TOKENS), and never `embeddings`
      // or `reranking`, either of which restricts the child to one route and refuses chat. mirrorGuard holds all three
      // numbers to the C#.
      // A CHAT section gets `reasoning = off` and `n-predict = 512`, exactly as WritePresets writes it since round 2's
      // Task P (LlamaServerRuntime.ChatMaxTokens). Run 5 wrote `reasoning = off` alone, ahead of the product: Lyntai's
      // OpenAI-shaped payload drops TextReasoning.Suppress, and llama-server's default `--reasoning auto` then opens a
      // thinking block for any template that supports one (Qwen3, and Qwen3.5 against its own default). The key
      // renders the template's pre-closed think block and leaves a template without thinking byte-identical (gemma-3),
      // so Run 3's control was unchanged by it. `reasoning-budget = 0` is NOT equivalent: the template stays in
      // thinking mode and the model writes its reasoning into the reply. `n-predict` caps a runaway reply (Run 5: an
      // uncapped one filled its child's shared context, and llama-server keeps decoding a request nobody waits for).
      // Runs 2–5b re-analyse identically: a preset is a launch setting, and no saved row depends on this text.
      mirrorGuard();
      const windowOf = (m) => DECLARED_WINDOW[m] ?? RERANK_WINDOW;
      const presetSection = (m, kind) => [`[${m}]`, 'n-gpu-layers = 99',
        ...(kind === 'reranking'
          ? ['reranking = true', `ctx-size = ${windowOf(m)}`, `batch-size = ${windowOf(m)}`, `ubatch-size = ${windowOf(m)}`]
          : ['reasoning = off', `n-predict = ${CHAT_MAX_TOKENS}`, `ctx-size = ${CHAT_CONTEXT_TOKENS}`]),
        ''].join('\n');
      const preset = path.join(WORK, 'presets.ini');
      fs.writeFileSync(preset, [...rerankers.map((m) => presetSection(m, 'reranking')),
        ...chatJudges.map((m) => presetSection(m, 'chat'))].join('\n'));
      const logFd = fs.openSync(path.join(WORK, 'router.log'), 'w');
      // --models-max holds every model the arms bind at once, so no arm's model is evicted by another's mid-run.
      router = spawn(exe, ['--models-dir', gguf, '--models-preset', preset, '--models-max', String(Math.max(2, llamaModels.length)),
        '--host', '127.0.0.1', '--port', String(LLAMA_PORT)], { cwd: path.dirname(exe), stdio: ['ignore', logFd, logFd] });
      fs.closeSync(logFd);
      await until(async () => (await fetch(`http://127.0.0.1:${LLAMA_PORT}/v1/models`)).ok, 60000);
    }

    // ---- 2b. `--rerank-memo`: one proxy per local-model arm, in front of the router --------------------------
    // Everything passes through untouched, except a /v1/rerank POST during the ACCURACY pass: its body is hashed and
    // recorded against the query in flight (with its document count, its longest document and whether the target's
    // answer text was among the documents), and identical bodies — from ANY arm — share the first response computed.
    // Bodies name the model, so two models never share one. The latency pass is never memoised: it is where time is
    // measured.
    const MEMO = opts['rerank-memo'] === true;
    const memo = new Map();
    const answerOf = new Map();
    for (const f of FIXTURE.facts) {
      const ans = f.answer?.text ?? f.content;
      for (const q of Object.values(f.questions ?? {})) { answerOf.set(q, ans); answerOf.set(q.normalize('NFKC'), ans); }
    }
    // A FRESH connection per forward. Node's default agent keeps sockets alive, and a socket the router has just closed
    // for idleness gets reused: the request dies before the router sees it, and the arm reads a 502 as no verdict. That
    // happened ONCE in each of Run 6b's two runs — each an abstention the router log shows it never received — and the
    // pre-registered coverage guard then left the rule unread. So no socket is reused, a forward that fails before any
    // response (the router never answered) is retried once, a failed forward is never memoised, and every failure is
    // counted on the arm and warned on.
    const upstream = new http.Agent({ keepAlive: false });
    const startProxy = () => new Promise((resolve) => {
      const state = { phase: 'startup', seq: null, records: new Map(), requests: 0, memoHits: 0, forwarded: 0, retried: 0, errors: 0 };
      const once = (req, body) => new Promise((ok, fail) => {
        const up = http.request({
          host: '127.0.0.1', port: LLAMA_PORT, method: req.method, path: req.url, agent: upstream,
          headers: { ...req.headers, host: `127.0.0.1:${LLAMA_PORT}`, 'content-length': body.length, connection: 'close' },
        }, (r) => {
          const out = [];
          r.on('data', (c) => out.push(c));
          r.on('end', () => ok({ status: r.statusCode, headers: r.headers, body: Buffer.concat(out) }));
          r.on('error', (e) => fail(Object.assign(e, { answered: true })));
        });
        up.on('error', fail);
        up.end(body);
      });
      // `forwarded` counts /v1/rerank forwards only — every one the router must then log as proxied to its model's child,
      // which is how a lost request is found (Run 6b).
      const forward = async (req, body) => {
        if (req.url === '/v1/rerank') state.forwarded++;
        try { return await once(req, body); } catch (e) {
          if (e.answered) { state.errors++; throw e; }
          state.retried++;
          try { return await once(req, body); } catch (e2) { state.errors++; throw e2; }
        }
      };
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          const body = Buffer.concat(chunks);
          try {
            let reply;
            if (req.method === 'POST' && req.url === '/v1/rerank' && state.phase === 'accuracy') {
              const hash = crypto.createHash('sha256').update(body).digest('hex');
              let parsed = {};
              try { parsed = JSON.parse(body.toString('utf8')); } catch { /* recorded as unparsed */ }
              const docs = Array.isArray(parsed.documents) ? parsed.documents.map(String) : [];
              const ans = answerOf.get(String(parsed.query ?? ''));
              const rec = {
                hash: hash.slice(0, 16), documents: docs.length, maxChars: docs.reduce((m, d) => Math.max(m, d.length), 0),
                answerSent: ans === undefined ? null : docs.some((d) => d.includes(ans) || d.includes(ans.normalize('NFKC'))),
              };
              state.requests++;
              if (!state.records.has(state.seq)) state.records.set(state.seq, []);
              state.records.get(state.seq).push(rec);
              if (MEMO) {
                if (memo.has(hash)) state.memoHits++;
                else memo.set(hash, forward(req, body).catch((e) => { memo.delete(hash); throw e; }));
                reply = await memo.get(hash);
              } else reply = await forward(req, body);
            } else reply = await forward(req, body);
            const headers = { ...reply.headers, 'content-length': reply.body.length };
            delete headers['transfer-encoding'];
            res.writeHead(reply.status, headers);
            res.end(reply.body);
          } catch (e) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 502, message: `judge-bench proxy: ${e?.message ?? e}` } }));
          }
        });
      });
      // The inbound hop too: the arm's HttpClient pools its connection to this proxy, so the proxy must not close an idle
      // one first (Node's default is 5 s).
      server.keepAliveTimeout = 10 * 60 * 1000;
      server.headersTimeout = server.keepAliveTimeout + 1000;
      server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
    });
    /** What the proxy saw for one query of one arm, for its row — or nothing, for an arm with no proxy. */
    const rerankOf = (arm, seq) => {
      if (!arm.proxy) return {};
      const recs = arm.proxy.state.records.get(seq) ?? [];
      return {
        rerank: {
          calls: recs.length, hash: recs.map((r) => r.hash).join('+'),
          documents: recs.reduce((a, r) => a + r.documents, 0), maxChars: recs.reduce((m, r) => Math.max(m, r.maxChars), 0),
          answerSent: recs.length === 0 || recs.every((r) => r.answerSent === null) ? null : recs.some((r) => r.answerSent === true),
        },
      };
    };

    // ---- 3. one snapshot + one server per arm ----------------------------------------------------------------
    for (const [i, arm] of arms.entries()) {
      arm.dir = path.join(WORK, `arm-${i}`);
      fs.cpSync(SEED_DATA, arm.dir, { recursive: true });
      fs.rmSync(path.join(arm.dir, 'state', 'logs'), { recursive: true, force: true });
      const env = { GATHERLIGHT_CLAUDE_CMD: claude, ...arm.pinned };
      if (arm.llamaModel) {
        const res = path.join(arm.dir, 'state', 'resources');
        fs.mkdirSync(path.join(res, 'llama-cpp'), { recursive: true });
        fs.mkdirSync(path.join(res, 'gguf'), { recursive: true });
        fs.writeFileSync(path.join(res, 'llama-cpp', 'llama-server.exe'), '');
        // Flat is enough here: InstalledGgufIds names a flat file by its stem, the same id as the nested layout.
        // The stem is also what GgufKind reads, so a catalogued id gets its catalogued kind — chat or reranker.
        fs.writeFileSync(path.join(res, 'gguf', `${arm.llamaModel}.gguf`), '');
        const settingsPath = path.join(arm.dir, 'state', 'settings.json');
        const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
        settings.memory = { ...(settings.memory ?? {}), judgeSource: 'llama-cpp', judgeModel: arm.llamaModel };
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        if (MEMO) arm.proxy = await startProxy();
        env.GATHERLIGHT_LLAMACPP_URL = `http://127.0.0.1:${arm.proxy ? arm.proxy.port : LLAMA_PORT}`;
      }
      arm.port = PORT_BASE + 1 + i;
      arm.srv = startServer({ dataDir: arm.dir, port: arm.port, env });
      servers.push(arm.srv);
    }
    for (const arm of arms) {
      await waitHealthy(arm.srv.base);
      // THE SEED IS WHAT THE ARM STARTS FROM, or the comparison is void: a claude call before any query means
      // startup re-derived something (a fact-index layout rebuild re-remembers every fact) from a changed app.
      arm.routerStartup = routerOutcomes(arm.dir);
      if (arm.chatJudge) arm.localStartup = routerOutcomes(arm.dir, LLAMA_CHAT_PROVIDER);
      const startupCalls = arm.routerStartup.ok + arm.routerStartup.failed;
      if (startupCalls > 0)
        throw new Error(`arm ${arm.key}: ${startupCalls} claude-cli call(s) at startup — the arm re-derived something `
          + '(e.g. a fact-index layout rebuild) and no longer starts from the seed; pass --reseed');
      const c = makeClient(arm.srv.base);
      // NON-VACUITY: an arm whose knob or binding did not take would silently duplicate another arm. `knob` may
      // be one regex or an array (an arm can pin more than one env var, e.g. `fuse` pins both the verdict
      // combination AND the judge input) — every entry must announce itself, or a second knob failing silently
      // would go unnoticed behind the first one's success.
      const log = arm.srv.log();
      const announced = log.split(/\r?\n/).filter((l) => l.includes('[measurement]'));
      const knobs = arm.knob ? (Array.isArray(arm.knob) ? arm.knob : [arm.knob]) : [];
      for (const k of knobs) if (!k.test(log)) throw new Error(`arm ${arm.key}: its knob did not announce itself (${k})`);
      if (knobs.length === 0 && announced.length > 0) throw new Error(`arm ${arm.key}: sets no knob, yet the server printed: ${announced.join(' | ')}`);
      // The deadline knob is pinned blank; one announcing itself means the product default did not apply.
      if (/Test knob set: judge verification deadline/.test(log + readLogs(arm.dir)))
        throw new Error(`arm ${arm.key}: the verification-deadline test knob is set — this arm would not run the product's deadline`);
      arm.migrationWarnings = (await c.getJson('/api/migration/status')).warnings ?? [];
      if (arm.llamaModel) {
        const judge = await judgeLayer(c);
        if (judge?.activeSource !== 'llama-cpp' || judge?.activeModel !== arm.llamaModel)
          throw new Error(`arm ${arm.key}: judge is running ${judge?.activeSource} · ${judge?.activeModel}, not llama-cpp · ${arm.llamaModel}`);
        if (/warming 判断 model .* failed/.test(readLogs(arm.dir) + log)) throw new Error(`arm ${arm.key}: warming the 判断 model failed (see ${arm.dir}/state/logs)`);
        if (arm.migrationWarnings.length > 0) throw new Error(`arm ${arm.key}: startup warnings: ${arm.migrationWarnings.join(' | ')}`);
      }
      const set = await c.post('/api/manage/memory/enrichment', { enabled: arm.enrichment });
      if (set.status !== 200) throw new Error(`arm ${arm.key}: setting 判断 → ${arm.enrichment} returned HTTP ${set.status}`);
      const judge = await judgeLayer(c);
      if (judge?.on !== arm.enrichment) throw new Error(`arm ${arm.key}: 判断 reads back ${judge?.on}, not ${arm.enrichment}`);
      arm.judgeOn = judge.on;
      arm.judgeSource = judge.activeSource ?? null;
      arm.judgeModel = judge.activeModel ?? null;
    }

    // ---- 4. identical questions, identical SHUFFLED order, every arm in parallel ------------------------------
    const { queries, adjacentSameFact } = queryOrder(facts, ORDER_SEED);

    const recall = async (c, x) => {
      const t0 = Date.now();
      try {
        const r = await c.call('recall_facts', { query: x.q, limit: LIMIT });
        const ms = Date.now() - t0;
        if (r.status !== 200) return { status: r.status, ranked: null, returned: null, answered: null, error: r.result?.error ?? `HTTP ${r.status}`, pos: null, ms };
        if (!Array.isArray(r.result?.facts)) return { status: r.status, ranked: null, returned: null, answered: null, error: 'no facts array in the result', pos: null, ms };
        const ids = r.result.facts.map((f) => Number(f.id));
        return {
          status: r.status, ranked: r.result.ranked ?? null, returned: ids.length,
          answered: typeof r.result.answered === 'boolean' ? r.result.answered : null,
          error: null, pos: ids.indexOf(idOf.get(x.fact)), ms,
          // The whole page, in order — the fingerprint two arms must share to have given the same verdicts (Run 6b).
          page: ids,
        };
      } catch (e) {
        return { status: null, ranked: null, returned: null, answered: null, error: String(e?.message ?? e), pos: null, ms: Date.now() - t0 };
      }
    };

    for (const arm of arms) if (arm.proxy) arm.proxy.state.phase = 'accuracy';
    await Promise.all(arms.map(async (arm) => {
      const c = makeClient(arm.srv.base);
      arm.rows = [];
      for (const [seq, x] of queries.entries()) {
        if (arm.proxy) arm.proxy.state.seq = seq;
        const result = await recall(c, x);
        const row = { arm: arm.key, pass: 'accuracy', seq, ...x, ...result, ...rerankOf(arm, seq) };
        arm.rows.push(row);
        emit(row);
      }
    }));
    for (const arm of arms) if (arm.proxy) arm.proxy.state.phase = 'latency';
    for (const arm of arms) {
      arm.routerAccuracy = routerOutcomes(arm.dir);
      if (arm.chatJudge) arm.localAccuracy = routerOutcomes(arm.dir, LLAMA_CHAT_PROVIDER);
    }

    // ---- 5. serial latency: one arm at a time, nothing else querying (mutates state — accuracy is already in) -
    const sample = queries.slice(0, Math.min(LATENCY_SAMPLE, queries.length));
    for (const arm of arms) {
      const c = makeClient(arm.srv.base);
      arm.latencyRows = [];
      for (const [seq, x] of sample.entries()) {
        const row = { arm: arm.key, pass: 'latency', seq, ...x, ...(await recall(c, x)) };
        arm.latencyRows.push(row);
        emit(row);
      }
      arm.routerTotal = routerOutcomes(arm.dir);
      if (arm.chatJudge) arm.localTotal = routerOutcomes(arm.dir, LLAMA_CHAT_PROVIDER);
    }

    // RECONCILE what the proxies forwarded with what the router received: every /v1/rerank forward must appear in the
    // router's log as a request proxied to that model's child. Run 6b found its two abstentions exactly this way — a
    // request recorded by the proxy that the router never saw. Read once the count stops moving (the router logs through
    // a queue), with the router still up, because a forced kill can lose what is still queued.
    let routerProxied = null;
    if (arms.some((a) => a.proxy) && router) {
      const count = () => {
        const proxied = {};
        for (const m of fs.readFileSync(path.join(WORK, 'router.log'), 'utf8').matchAll(/proxying request to model (\S+) on/g))
          proxied[m[1]] = (proxied[m[1]] ?? 0) + 1;
        return proxied;
      };
      try {
        let last = null;
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const now = count();
          if (JSON.stringify(now) === JSON.stringify(last)) break;
          last = now;
        }
        routerProxied = last;
      } catch (e) { routerProxied = { error: String(e?.message ?? e) }; }
    }

    // ---- 6. SAVE the run, THEN analyse exactly what was saved — the path --report-only takes later -----------
    // Saving first is what makes an analysis bug cheap: the rows of an hour-long run are on disk before a single
    // table is computed, so a throw below costs a re-analysis, not a re-run.
    const saved = {
      format: 3,
      fixture: FIXTURE_REL, fixtureHash: FIXTURE_HASH, facts: N, limit: LIMIT, at: RUN_AT,
      ...(FIXTURE_POSITIONS ? { positions: Object.fromEntries(facts.map((f) => [f.id, FIXTURE_POSITIONS[f.id]])) } : {}),
      claudeVersion, appHead, appVersion,
      seedFolder: {
        fixtureHash: seedMeta.fixtureHash, createdAt: seedMeta.createdAt, claudeVersion: seedMeta.claudeVersion,
        appHead: seedMeta.appHead ?? null, appVersion: seedMeta.appVersion ?? null, reused: REUSE_SEED,
        ...(seedMeta.judge ? { judge: seedMeta.judge, claudeCalls: seedMeta.claudeCalls, graphNodes: seedMeta.graphNodes } : {}),
      },
      order: { seed: ORDER_SEED, queries: queries.length, adjacentSameFact },
      concurrency: arms.length,
      latencySample: sample.length,
      arms: arms.map((a) => ({
        key: a.key, label: a.label, enrichment: a.enrichment, judgeInput: a.judgeInput ?? null, reranker: a.reranker ?? null,
        chatJudge: a.chatJudge ?? null,
        knobs: a.pinned, judgeOn: a.judgeOn, judgeSource: a.judgeSource, judgeModel: a.judgeModel,
        migrationWarnings: a.migrationWarnings,
        router: { startup: a.routerStartup, accuracy: a.routerAccuracy, total: a.routerTotal },
        ...(a.chatJudge ? { localRouter: { startup: a.localStartup, accuracy: a.localAccuracy, total: a.localTotal } } : {}),
      })),
      ...(arms.some((a) => a.proxy) ? {
        rerankProxy: {
          memo: MEMO,
          arms: Object.fromEntries(arms.filter((a) => a.proxy).map((a) => [a.key, {
            requests: a.proxy.state.requests, memoHits: a.proxy.state.memoHits,
            // Every forward to the router, all passes and startup included; retried = a connection-level failure retried
            // once; errors = a forward that still failed, which the arm read as a 502.
            forwarded: a.proxy.state.forwarded, retried: a.proxy.state.retried, errors: a.proxy.state.errors,
          }])),
          routerProxied,
        },
      } : {}),
      rows: Object.fromEntries(arms.map((a) => [a.key, a.rows])),
      latencyRows: Object.fromEntries(arms.map((a) => [a.key, a.latencyRows])),
    };
    const out = path.join(WORK, `results-${RUN_STAMP}.json`);
    fs.writeFileSync(out, JSON.stringify(saved, null, 2));
    stopAll(); // nothing below needs a server, and an analysis failure should not keep seven of them alive
    try {
      const run = loadRun(saved, 'this run');
      const analysis = analyse(run, { baseline });
      const { armStats, ...rest } = analysis;
      const { rows, latencyRows, ...head } = saved;
      fs.writeFileSync(out, JSON.stringify({ ...head, arms: armsWithStats(run.arms, analysis), ...rest, rows, latencyRows }, null, 2));
    } catch (e) {
      console.error(`\njudge-bench: the analysis failed — the run itself is SAVED (${rel(out)}).\n${e?.stack ?? e}`
        + `\nFix the analysis, then re-analyse without re-running:\n  node devtools/dev.mjs judge-bench --report-only=${rel(out)}`);
      process.exitCode = 1;
    }
    console.log(`\nrow stream: ${ROWS}`);
    console.log(`raw rows: ${out}`);
  } finally {
    stopAll();
  }
};

if (REPORT_ONLY) reportOnly();
else await live();
