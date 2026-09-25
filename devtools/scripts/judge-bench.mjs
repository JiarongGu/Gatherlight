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
//   - THE PACE MUST NOT HAVE MOVED (docs/judge-bench.md, "The bench and the pace"). A chunked reranker sizes each call
//     to the time this machine takes (RerankPace), so on a contended or slow machine what an arm SENDS depends on
//     timing — on the other arms running beside it — and two arms meant to differ only in their configuration would
//     differ in their windows too. The bench counts the pace's Information lines ("window(s) per long candidate
//     instead of", which since 2026-09-25 also opens the line of a recall the pace SKIPPED — "0 window(s) … instead of
//     N — the judge is skipped for this recall", "per candidate … (none is long)" on short facts — and "re-measured this
//     machine", a probe) in every
//     arm's log after the run and saves the counts; any count above 0 VOIDS the run — a loud banner and exit 1, the rows
//     still saved. A skip there would be worse than a sized call: the arm would have abstained where its twin judged.
//     Chosen over a pinned no-pace mode, which would measure a product nobody runs and add a knob to verify; on the
//     GPU this bench runs on, the seed allows more than the count ceiling, so the pace sizes a call only after calls
//     there ran far slower than the seed — heavy contention, exactly the run this guard voids. Runs saved before the guard carry no counts and re-analyse exactly as they
//     did.
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
// LOCAL-MODEL ARMS. `--rerankers=<m,…>` adds `rr:<m>` (partition) and `rrf:<m>` (fuse) per reranker, both over the cut
// (`--rerank-arms=` adds `rrk:<m>`, the shipped chunked input — see CHUNKED RERANKING below);
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
// THE MIXED FIXTURE (`--fixture=mixed`, docs/judge-bench.md Run 9). The same 60 facts and 240 questions, half kept as
// their original short text and half turned into Run 6's long notes (answer at `end` or `beyond`) — written by
// judge-bench-mixed-fixture.mjs and refused unless byte-for-byte its output — so every recall has long and short
// candidates. Everything the long fixture does applies (its own seed devtools/_judge-bench-seed-mixed/ and work dir
// devtools/_judge-bench-mixed/, 判断 off, the stub, the seed checks). BY POSITION reads short · long · end · beyond, and
// with `rr` and `rrk` arms of a reranker a RUN 9 block pairs chunked against cut by the TARGET's length and reads the
// run's rule: chunking costs short facts if short-target found@8 is significantly worse chunked, for any reranker.
//
// CHUNKED RERANKING (docs/judge-bench.md Runs 6b and 6c). `--rerank-arms=` picks which arms each `--rerankers=` model
// gets: `rr` (partition) and `rrf` (fuse), each over the CUT (GATHERLIGHT_RERANK_CHUNKING=off), and `rrk` (partition with
// the knob on — each long candidate scored in windows, its best window's score kept; ChunkedScoreProvider). Chunking is
// the product DEFAULT since Run 6c, so `rrk` is what ships; `rr`/`rrf` pin the cut so Runs 2–6 re-launch as they ran, and
// every reranker arm must announce the knob it sets. The default stays `rr,rrf`, so the registered commands of Runs 2–7
// re-launch as they ran; a run with rerankers and no arm measuring what ships (read from RerankChunking.Default) prints a
// WARNING before any arm starts.
// `--claude-stub` points every server at the e2e claude STUB on ANY fixture (the long fixture always does), refusing a
// Claude-judge arm, so a reranker-only run on the bilingual seed cannot spend quota even by accident.
// `--rerank-memo` puts a small proxy in front of the router for each local-model arm: during the ACCURACY pass an
// identical /v1/rerank request body gets the identical response — the first 2xx one computed; a failure is never shared —
// whichever arm sent it, and
// every request's body hash, document count and whether the target's answer text was among the documents is recorded on
// the row. llama.cpp's scores drift in the third decimal between identical calls (Run 4's screen), which can flip a
// candidate at the page boundary; the memo removes that noise BETWEEN arms, so two arms that send the same bytes get the
// same verdicts, and an arm that sends different bytes shows it. The serial latency pass is never memoised.
//
// THE LOCAL-TAG SEEDS (`--tag-seed=<chat model>`, docs/judge-bench.md Run 7). Two more seeds of the bilingual fixture,
// written through the product's own write path with 判断 on and bound to a local llama.cpp CHAT model (settings.json, as a
// household's binding is), the router launched with the product's chat preset (thinking off, the generation and context
// caps), every server on the claude STUB:
//   - the TAG seed (devtools/_judge-bench-seed-tags-<model>/), whose subject tags that model wrote;
//   - its CONTROL, the REPLAY seed (devtools/_judge-bench-seed-replay-<model>/), written the same way except that a
//     recording proxy answers every annotation request with the tags CLAUDE wrote for that fact in the default seed.
// Why the control: the default seed was written on 2026-09-23 by an older build whose decay clock advanced one unit per
// write; today's advances by 1/n. A seed written today differs from it in the clock AS WELL AS the tags, so the tag
// seed is paired with the replay, which differs from it ONLY in the tags (checked table by table), while the replay
// differs from the default seed only in the clock (its subjects and subject edges are checked identical).
// Both are built together, on their own (`--build-tag-seed --seed-only`), so the router log, the preset and a record of
// every chat request (chat-requests.jsonl) are their evidence. The build refuses to finish unless 0 claude-cli calls were
// made, every write was annotated exactly once (by the model on the tag seed, by the replay on the other), every forward
// reached the model's child, and the child was spawned with thinking off. The binding is then REMOVED from each seed
// (settings.json restored, resource stand-ins deleted), so an arm on it is configured exactly as on the default seed.
// `--tag-seed-arms=<arm keys>` runs those arms again on both, keyed `<arm>@replay` and `<arm>@tags`, in the same run, so
// all three are paired per query; the formula digest is kept PER SEED (`formula`, `formula@replay`, `formula@tags`), and
// --baseline compares each seed's digest with its own. The TAG STATISTICS — handles per fact, vocabulary, reuse within
// the fixture's near-duplicate groups, overlap with Claude's handles for the same fact — are descriptive, printed at the
// seed step and saved with the seeds and the run. `--chat-arms=` picks which arms each `--chat-judges=` model gets
// (`lc`, `lcb`; default both), as `--rerank-arms=` does for rerankers.
//
// CPU-ONLY ARMS (`--cpu-rerankers=<m,…>`, docs/judge-bench.md Run 8). What the shipped chunked scoring and its pace
// (RerankPace) do on this machine's CPU. `--cpu-rerank-arms=` picks each model's kinds as `--rerank-arms=` does (default
// `rr,rrk`); the arms are keyed `cpu-<kind>:<m>`. Each runs on its OWN, FRESH router, launched with `n-gpu-layers = 0` AND
// `device = none` (b10549 offloads a big batch's ops to any GPU it sees even at n-gpu-layers = 0 — op-offload defaults on
// — so the first alone is not a CPU run; `device = none` leaves the CPU backend alone, which is what a machine with no GPU
// has), on `--cpu-llama-port=`, killed by PID when the arm is done: llama-server keeps scoring a batch whose request the
// verification deadline abandoned, so a router shared across arms would hand the next arm the last one's queue. CPU arms
// run ONE AT A TIME, after every other arm's accuracy pass, with nothing else querying — so their accuracy pass IS the
// serial latency and they skip the latency pass. Each gets a RECORD-ONLY proxy: never memoised (a shared reply would come
// back at once and teach the pace a machine it is not), a client's abandoned request closed upstream too (as the product's
// own connection would be), and per call the windows, the fixture notes they came from, the pair tokens as RerankPace
// counts them, the wall time and whether the client abandoned it. The pace guard is RELAXED for these arms only — the
// pace's activity is what they measure — and says so per arm; every other arm keeps it. Per recall the row carries the
// deadline cut and the pace line the product logged during it, read from the arm's own log by timestamp.
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
//   node devtools/dev.mjs judge-bench --claude-stub --reuse-seed --tag-seed=Qwen3-0.6B-Q8_0 --build-tag-seed --seed-only --arms=formula --resources=devtools/_rr-res
//   node devtools/dev.mjs judge-bench --claude-stub --reuse-seed --tag-seed=Qwen3-0.6B-Q8_0 --arms=formula --chat-judges=Qwen3-0.6B-Q8_0 --chat-arms=lc --tag-seed-arms=formula,lc:Qwen3-0.6B-Q8_0 --resources=devtools/_rr-res
//   node devtools/dev.mjs judge-bench --fixture=long --reuse-seed --arms=formula,formula2 --rerankers=bge-reranker-v2-m3-Q5_K_M --rerank-arms=rrk --cpu-rerankers=bge-reranker-v2-m3-Q5_K_M,mmarco-mMiniLMv2-L12-H384-v1-Q8_0 --rerank-memo --resources=devtools/_rr-res
//   node devtools/dev.mjs judge-bench --fixture=mixed --reuse-seed --arms=formula,formula2 --rerankers=… --rerank-arms=rr,rrk --rerank-memo --resources=devtools/_rr-res
// Flags: --arms= --rerankers= --rerank-arms=rr,rrf,rrk --chat-judges= --chat-arms=lc,lcb --n= --port-base= --llama-port= --resources=
//        --seed= --latency-sample=   --fixture=bilingual|long|mixed   --reuse-seed | --reseed   --seed-only   --claude-stub   --rerank-memo
//        --tag-seed=<chat model>   --build-tag-seed   --tag-seed-arms=<arm keys>
//        --cpu-rerankers=<m,…>   --cpu-rerank-arms=rr,rrf,rrk   --cpu-llama-port=
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
import { expectedMixedBytes } from './judge-bench-mixed-fixture.mjs';

// ---- flags: known ones only ------------------------------------------------------------------------------
const VALUED = ['arms', 'rerankers', 'rerank-arms', 'chat-judges', 'chat-arms', 'n', 'port-base', 'llama-port', 'resources', 'seed',
  'latency-sample', 'report-only', 'baseline', 'fixture', 'tag-seed', 'tag-seed-arms', 'cpu-rerankers', 'cpu-rerank-arms',
  'cpu-llama-port'];
const BOOLEAN = ['reuse-seed', 'reseed', 'seed-only', 'claude-stub', 'rerank-memo', 'build-tag-seed'];
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
  mixed: { file: 'recall-bilingual-mixed.json', seed: '_judge-bench-seed-mixed', work: '_judge-bench-mixed' },
};
const VARIANT = opts.fixture ?? 'bilingual';
if (!VARIANTS[VARIANT]) die(`--fixture must be one of ${Object.keys(VARIANTS).join(', ')}, got '${VARIANT}'`);
// The GENERATED fixtures (long, and mixed — Runs 6 and 9) are one kind of instrument: seeded with 判断 OFF (no tags, no
// annotation call), every server on the claude stub, each refused unless the committed file is what its generator writes.
const NOTES = VARIANT === 'long' || VARIANT === 'mixed';
const FIXTURE_REL = `devtools/fixtures/${VARIANTS[VARIANT].file}`;
const FIXTURE_PATH = path.join(repo, 'devtools', 'fixtures', VARIANTS[VARIANT].file);
const FIXTURE_BYTES = fs.readFileSync(FIXTURE_PATH);
const FIXTURE = JSON.parse(FIXTURE_BYTES.toString('utf8'));
const FIXTURE_HASH = crypto.createHash('sha256').update(FIXTURE_BYTES).digest('hex');
// The long and mixed fixtures are GENERATED; a hand-edited or stale copy would measure positions nobody registered.
const GENERATOR = { long: ['judge-bench-long-fixture.mjs', expectedLongBytes], mixed: ['judge-bench-mixed-fixture.mjs', expectedMixedBytes] }[VARIANT];
if (GENERATOR && !FIXTURE_BYTES.equals(GENERATOR[1]()))
  die(`${FIXTURE_REL} is not what ${GENERATOR[0]} writes — re-run it (and re-register anything that depends on it)`);
/** fact id → where its answer sits in its note, or null for a fixture without positions. */
const FIXTURE_POSITIONS = FIXTURE.facts.some((f) => f.position)
  ? Object.fromEntries(FIXTURE.facts.map((f) => [f.id, f.position])) : null;
const LIMIT = 8;
const PORT_BASE = int('port-base', 5620, 1);
const LLAMA_PORT = int('llama-port', 5660, 1);
// The CPU-only routers' first port (Run 8): one fresh router per CPU arm, the n-th CPU arm's on CPU_LLAMA_PORT + n — a
// port of its own, never one a killed router just left.
const CPU_LLAMA_PORT = int('cpu-llama-port', LLAMA_PORT + 1, 1);
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

// THE LOCAL-TAG SEEDS (docs/judge-bench.md Run 7): two more seeds of the bilingual fixture, built TOGETHER through the
// product's write path with 判断 bound to one local chat model — `tags`, which that model tagged, and `replay`, its
// CONTROL, whose every annotation request was answered with the tags CLAUDE wrote for that fact in the default seed. The
// two differ only in the tags. The replay exists because the default seed was written on 2026-09-23 by an older build,
// whose decay clock advanced one unit per write (stability 20 on every node); today's advances by 1/n (position H₆₀
// after 60 writes, stability 20/√n), so an arm on the default seed and one on a seed written today differ in the clock
// as well as the tags. An arm run on one of them is keyed `<arm>@tags` / `<arm>@replay`; every other arm runs on the
// default seed (Claude's tags, or none on the long fixture).
const TAG_MODEL = opts['tag-seed'] ?? null;
const EXTRA_SEEDS = ['replay', 'tags'];
const seedRootOf = (seed) => (seed === 'default' ? SEED_ROOT : path.join(repo, 'devtools', `${VARIANTS[VARIANT].seed}-${seed}-${TAG_MODEL}`));
const seedDataOf = (seed) => path.join(seedRootOf(seed), 'data');
const seedMetaOf = (seed) => path.join(seedRootOf(seed), 'seed.json');
const SEED_NAME = { default: 'the default seed', tags: 'the tag seed', replay: 'the replay seed' };
/** Which seed an arm key ran on: 'tags' for `<arm>@tags`, 'replay' for `<arm>@replay`, else 'default'. */
const seedOfKey = (key) => /@(tags|replay)$/.exec(key)?.[1] ?? 'default';
const baseKeyOf = (key) => key.replace(/@(tags|replay)$/, '');
/** The formula arm whose digest vouches for a seed's starting state. */
const formulaKeyFor = (seed) => (seed === 'default' ? 'formula' : `formula@${seed}`);

// Every arm pins BOTH knobs; the server treats a blank value as unset. Without the pin, a knob exported in
// the shell that launched the bench would leak into every arm that did not set it.
// GATHERLIGHT_JUDGE_INPUT is deleted on the Lyntai bump that ships ContentChars, and these arms change with it —
// `topic`/`contentonly` go, `content`/`content2` become knob-less content-only arms, `fuse` keeps one knob. The
// full list is JudgeSeesContentPolicy's class comment, "ON THE BUMP"; after it, `both` cannot be reproduced.
// GATHERLIGHT_JUDGE_DEADLINE_SECONDS (VerificationDeadlinePolicy's test knob) is pinned blank for the same reason, so
// every arm runs the product's default verification deadline; startup below refuses an arm that announces it.
// GATHERLIGHT_RERANK_CHUNKING (RerankChunking, Runs 6b/6c) is pinned blank the same way, and every reranker arm then
// sets it and must announce it: chunking became the product default on 2026-09-24 (Run 6c), so `rr`/`rrf` pin it OFF —
// the cut Runs 2–6 measured, so they re-launch as they ran — and `rrk` pins it ON, which is what ships.
const PINNED = { GATHERLIGHT_JUDGE_INPUT: '', GATHERLIGHT_VERDICT_COMBINATION: '', GATHERLIGHT_JUDGE_DEADLINE_SECONDS: '',
  GATHERLIGHT_RERANK_CHUNKING: '' };
/** Which arms each `--rerankers=` model gets, and what each pins: `rr` partition over the CUT, `rrf` fuse over the cut,
 *  `rrk` partition over windows (the shipped default). ONE writer: the live run builds reranker arms from this and
 *  armConfigFor labels them from it. Runs 6b and 6c ran `rr` with the knob blank, which was the cut then too. */
const RERANK_ARM_KINDS = {
  rr: { suffix: 'partition · cut', env: { GATHERLIGHT_RERANK_CHUNKING: 'off' }, knob: /rerank chunking = off \(/ },
  rrf: { suffix: 'fuse · cut', env: { GATHERLIGHT_VERDICT_COMBINATION: 'fuse', GATHERLIGHT_RERANK_CHUNKING: 'off' },
    knob: [/verdict combination = Fuse/, /rerank chunking = off \(/] },
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
  // Every catalogue row that declares ContextTokens, by its literal id — or by a `const string` of the same file holding
  // one: since 70234f3 mMiniLMv2's row names its id as `RerankerWithoutGpu`, the no-GPU recommendation, and read as a
  // non-literal it failed this guard, so no local-model arm could start. A declaring row whose id is neither cannot be
  // checked here, so it is drift too rather than a silent pass. UsableWindow's floor (> 6) is applied as the C# does.
  const declared = {};
  const catalogue = src('GgufCatalog.cs');
  const constants = Object.fromEntries([...catalogue.matchAll(/\bconst string (\w+) = "([^"]+)";/g)].map((m) => [m[1], m[2]]));
  for (const row of catalogue.split('new GgufModel(').slice(1)) {
    const window = Number((/ContextTokens:\s*(\d+)/.exec(row) ?? [])[1]);
    if (!window) continue;
    const id = (/^\s*"([^"]+)"/.exec(row) ?? [])[1] ?? constants[(/^\s*(\w+)\s*,/.exec(row) ?? [])[1]];
    if (!id) { drift.push('a GgufCatalog row declares ContextTokens under a non-literal id'); continue; }
    if (window > 6) declared[id] = window;
  }
  if (JSON.stringify(Object.entries(declared).sort()) !== JSON.stringify(Object.entries(DECLARED_WINDOW).sort()))
    drift.push(`declared windows ${JSON.stringify(declared)} ≠ ${JSON.stringify(DECLARED_WINDOW)}`);
  if (drift.length) die(`the bench's launch numbers drifted from the product's — update them together: ${drift.join('; ')}`);
}
// RerankPace's counting rule, restated for Run 8's per-call record (pair tokens, and the rate the pace would read off an
// answered call) — and GUARDED against the C# by paceMirror, as the launch numbers are by mirrorGuard.
const PACE = { cjk: 0.83, other: 0.25, cjkFrom: 0x2E80, overheadMs: 50 };
function paceMirror() {
  const src = fs.readFileSync(path.join(repo, 'src', 'server', 'Gatherlight.Platform', 'Agent', 'Llm', 'Services', 'ChunkedScoreProvider.cs'), 'utf8');
  const num = (name) => Number((new RegExp(`const double ${name} = ([\\d.]+);`).exec(src) ?? [])[1]);
  const from = (/const char CjkFrom = '(.)';/u.exec(src) ?? [])[1];
  const drift = [];
  if (num('CjkTokensPerChar') !== PACE.cjk) drift.push(`CjkTokensPerChar ${num('CjkTokensPerChar')} ≠ ${PACE.cjk}`);
  if (num('OtherTokensPerChar') !== PACE.other) drift.push(`OtherTokensPerChar ${num('OtherTokensPerChar')} ≠ ${PACE.other}`);
  if (num('CallOverheadMs') !== PACE.overheadMs) drift.push(`CallOverheadMs ${num('CallOverheadMs')} ≠ ${PACE.overheadMs}`);
  if (!from || from.charCodeAt(0) !== PACE.cjkFrom) drift.push(`CjkFrom ${from ? `U+${from.charCodeAt(0).toString(16).toUpperCase()}` : 'unread'} ≠ U+${PACE.cjkFrom.toString(16).toUpperCase()}`);
  if (drift.length) die(`the bench's copy of RerankPace's counting drifted from the product's — update them together: ${drift.join('; ')}`);
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
// The pace's Information lines when RerankPace changes what a call sends (the header's pace guard): fewer windows per
// long candidate than the count ceiling would give ("N window(s) per long candidate instead of M" — ChunkedScoreProvider,
// in three forms: sized to the budget, after a cut, or the fewest that scores every candidate), NONE — the judge skipped,
// decided above Lyntai by RerankAdmission since 2026-09-25, because even one window per candidate is predicted past its
// limit or the router is presumed busy ("0 window(s) per long candidate instead of M — the judge is skipped for this
// recall", or "0 window(s) per candidate instead of 1 (none is long) — …" on a recall of short facts) — or a probe that
// re-measured the machine ("re-measured this machine", from either class). Each line is counted once: no line carries
// both phrases.
const PACE_LINE = /window\(s\) per (?:long )?candidate instead of|re-measured this machine/g;
const paceCutsIn = (dataDir) => (readLogs(dataDir).match(PACE_LINE) ?? []).length;
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

// ---- THE SAME-SUBJECT GROUPS and the TAG STATISTICS (docs/judge-bench.md Run 7) ----------------------------------
// The fixture has no cluster field. It marks its near-duplicate clusters by a SHARED ID PREFIX, written next to each
// other (mkt-east / mkt-west / mkt-harbor, museum-adult / museum-adult-old / museum-child, …), and its three utility
// bills by a shared `-bill` suffix (power-bill / water-bill / gas-bill). That is the grouping used here — on the
// committed fixture 12 groups of 2–3 facts, 29 facts in all — and every other fact is a group of its own. Same-ENTITY
// facts the ids do not mark (the family cat's two facts, say) stay apart: the ids are the only grouping the fixture states.
const prefixOf = (id) => id.split('-')[0];
const PREFIX_COUNT = FIXTURE.facts.reduce((m, f) => m.set(prefixOf(f.id), (m.get(prefixOf(f.id)) ?? 0) + 1), new Map());
const groupOf = (id) => (/-bill$/.test(id) ? '*-bill' : PREFIX_COUNT.get(prefixOf(id)) > 1 ? `${prefixOf(id)}-*` : id);
const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;
const scriptOf = (s) => (CJK.test(s) ? 'CJK' : 'Latin');

/** fact id → its subject handles, as the engine stored them, read from a seed's database. */
const handlesOf = (dataDir, idOf) => {
  const conn = new DatabaseSync(path.join(dataDir, 'state', 'gatherlight.db'), { readOnly: true });
  try {
    const refOf = new Map(conn.prepare('SELECT id, graph_ref FROM knowledge').all().map((r) => [Number(r.id), r.graph_ref]));
    const byNode = new Map();
    for (const s of conn.prepare('SELECT node_id, subject FROM lyntai_memory_subject').all()) {
      if (!byNode.has(Number(s.node_id))) byNode.set(Number(s.node_id), []);
      byNode.get(Number(s.node_id)).push(s.subject);
    }
    return Object.fromEntries(FIXTURE.facts.map((f) => {
      const node = Number((/#(\d+)$/.exec(refOf.get(Number(idOf[f.id])) ?? '') ?? [])[1]);
      return [f.id, [...(byNode.get(node) ?? [])].sort()];
    }));
  } finally { conn.close(); }
};

/** What a seed's tags look like, in Lyntai's annotation-drift spirit (../Lyntai/docs/memory-measurements.md): how many
 *  handles, how many distinct, whether the facts of one near-duplicate group share one, how far a handle reaches across
 *  groups — and, against a REFERENCE seed's tags (Claude's), how often the two name the same fact the same way.
 *  Descriptive only: nothing here decides anything. Writes happen in fixture order, so a group's FIRST fact is the one
 *  written first — Lyntai's drift anchor. */
const tagStatsOf = (tags, reference = null) => {
  const ids = FIXTURE.facts.map((f) => f.id);
  const contentOf = new Map(FIXTURE.facts.map((f) => [f.id, f.content]));
  const shares = (a, b) => tags[a].some((h) => tags[b].includes(h));
  const counts = ids.map((id) => tags[id].length);
  const factsOf = new Map();
  for (const id of ids) for (const h of tags[id]) factsOf.set(h, [...(factsOf.get(h) ?? []), id]);
  const groups = new Map();
  for (const id of ids) groups.set(groupOf(id), [...(groups.get(groupOf(id)) ?? []), id]);
  const multi = [...groups.values()].filter((g) => g.length > 1);
  const grouped = multi.flat();
  const later = multi.flatMap((g) => g.slice(1).map((id) => [g[0], id]));
  const widest = [...factsOf.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0] ?? null;
  const out = {
    facts: ids.length,
    tagged: counts.filter((n) => n > 0).length,
    handles: counts.reduce((a, n) => a + n, 0),
    perFactMean: counts.reduce((a, n) => a + n, 0) / ids.length,
    perFact: Object.fromEntries([0, 1, 2, 3, 4].map((k) => [k, counts.filter((n) => (k === 4 ? n >= 4 : n === k)).length])),
    distinct: factsOf.size,
    onTwoOrMore: [...factsOf.values()].filter((fs) => fs.length >= 2).length,
    widest: widest ? { handle: widest[0], facts: widest[1] } : null,
    groups: { count: multi.length, facts: grouped.length, laterMembers: later.length },
    // A grouped fact that shares at least one handle with another member of its own group.
    sharesInGroup: grouped.filter((id) => groups.get(groupOf(id)).some((o) => o !== id && shares(id, o))),
    // Lyntai's DRIFT: a later-written member that shares no handle with its group's first-written member.
    drifted: later.filter(([a, id]) => !shares(a, id)).map(([, id]) => id),
    // Every later member shares a handle with the first.
    connectedGroups: multi.filter((g) => g.slice(1).every((id) => shares(g[0], id))).map((g) => groupOf(g[0])),
    // A handle on facts of two or more groups (a singleton is its own group) — the "collapse" side of drift, though
    // here it can also be a real shared entity (one family member on three unrelated facts).
    spanning: [...factsOf.entries()].filter(([, fs]) => new Set(fs.map(groupOf)).size > 1).map(([h, fs]) => ({ handle: h, facts: fs })),
    sharesOutsideGroup: ids.filter((id) => ids.some((o) => groupOf(o) !== groupOf(id) && shares(id, o))),
    // A handle not in the script of the fact it tags — the prompt asks for subjects "in the SAME LANGUAGE as the fact".
    offScript: ids.filter((id) => tags[id].some((h) => scriptOf(h) !== scriptOf(contentOf.get(id)))),
  };
  if (reference) {
    const either = ids.filter((id) => tags[id].length + reference[id].length > 0);
    const jac = (id) => {
      const u = new Set([...tags[id], ...reference[id]]);
      return u.size ? tags[id].filter((h) => reference[id].includes(h)).length / u.size : 0;
    };
    out.vsReference = {
      identical: ids.filter((id) => tags[id].some((h) => reference[id].includes(h))),
      // Lyntai's MemorySubject.Matches reads containment for a spaceless script; reported beside exact identity.
      containment: ids.filter((id) => tags[id].some((h) => reference[id].some((r) => r.includes(h) || h.includes(r)))),
      meanJaccard: either.length ? either.reduce((a, id) => a + jac(id), 0) / either.length : null,
      over: either.length,
      sharedVocabulary: [...factsOf.keys()].filter((h) => ids.some((id) => reference[id].includes(h))).length,
    };
  }
  return out;
};

/** The tag statistics, side by side, one column per seed. */
const printTagStats = (columns) => {
  const W = 58, C = 34;
  const f = (xs, n) => `${xs.length}/${n}`;
  const rows = [
    ['facts with ≥ 1 handle', (s) => `${s.tagged}/${s.facts}`],
    ['handles per fact: mean (0 / 1 / 2 / 3 / ≥4)', (s) => `${s.perFactMean.toFixed(2)} (${[0, 1, 2, 3, 4].map((k) => s.perFact[k]).join(' / ')})`],
    ['handle vocabulary (distinct handles)', (s) => `${s.distinct} (${s.onTwoOrMore} on ≥ 2 facts)`],
    ['widest handle', (s) => (s.widest ? `${s.widest.handle} (${s.widest.facts.length} facts)` : '—')],
    ['grouped facts sharing a handle within their group', (s) => f(s.sharesInGroup, s.groups.facts)],
    ['drift: later members sharing none with the first', (s) => f(s.drifted, s.groups.laterMembers)],
    ['groups whose later members all share one with the first', (s) => f(s.connectedGroups, s.groups.count)],
    ['handles spanning ≥ 2 groups', (s) => String(s.spanning.length)],
    ['facts sharing a handle with another group\'s fact', (s) => f(s.sharesOutsideGroup, s.facts)],
    ['facts with a handle not in the fact\'s script', (s) => f(s.offScript, s.facts)],
    ['vs Claude: facts with ≥ 1 identical handle', (s) => (s.vsReference ? f(s.vsReference.identical, s.facts) : '—')],
    ['vs Claude: facts with ≥ 1 handle contained in the other', (s) => (s.vsReference ? f(s.vsReference.containment, s.facts) : '—')],
    ['vs Claude: mean Jaccard (facts either tagged)', (s) => (s.vsReference?.meanJaccard == null ? '—' : `${s.vsReference.meanJaccard.toFixed(3)} (over ${s.vsReference.over})`)],
    ['vs Claude: handles also in Claude\'s vocabulary', (s) => (s.vsReference ? `${s.vsReference.sharedVocabulary}/${s.distinct}` : '—')],
  ];
  const g = columns[0]?.stats.groups;
  console.log(`\nTAG STATISTICS — descriptive; groups = the fixture's near-duplicate clusters (shared id prefix, and the three`
    + ` \`-bill\` facts): ${g?.count ?? '?'} groups, ${g?.facts ?? '?'} facts; a group's first fact is the first written`);
  console.log(pad('', W) + columns.map((c) => pad(c.name, C)).join(''));
  for (const [label, fn] of rows) console.log(pad(label, W) + columns.map((c) => pad(fn(c.stats), C)).join(''));
};

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
      // Which seed the arm started from (Run 7); every run before it had one seed, the default.
      seed: a.seed ?? seedOfKey(a.key),
      knobs: a.knobs ?? null,
      judgeOn: a.judgeOn ?? null, judgeSource: a.judgeSource ?? null, judgeModel: a.judgeModel ?? null,
      migrationWarnings: a.migrationWarnings ?? null,
      router: a.router ?? null,
      localRouter: a.localRouter ?? null,
      // Run 8: which llama.cpp router the arm used and with what preset, and — for a CPU-only arm — its own router's
      // record. Present only when saved, so a run saved before them re-analyses exactly as it did.
      ...(a.llamaRouter ? { llamaRouter: a.llamaRouter } : {}),
      ...((a.cpu ?? known.cpu) ? { cpu: true, cpuRecord: a.cpuRecord ?? null } : {}),
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
      // The second seed a `<arm>@tags` arm started from, and its tag statistics (Run 7); null before it.
      tagSeed: json.tagSeed ?? null,
      // The pace guard's per-arm counts; ABSENT (not null) on a run saved before the guard, so a re-analysis of one
      // writes exactly what it wrote before.
      ...(json.rerankPace ? { rerankPace: json.rerankPace } : {}),
      // Run 8: the CPU-only arms, run one at a time after the parallel ones; absent on every earlier run.
      ...(json.cpuSerial ? { cpuSerial: json.cpuSerial } : {}),
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
  // A VOID run (the header's pace guard) is no baseline either: what its arms sent depended on that machine's timing.
  const paceFired = Object.entries(baseRun.meta.rerankPace ?? {}).filter(([, n]) => n > 0);
  if (paceFired.length)
    problems.push(`the baseline run is VOID — RerankPace sized rerank calls in ${paceFired.map(([k, n]) => `${k} (${n})`).join(', ')}`);
  const short = (h) => (h ? h.slice(0, 12) : 'unrecorded');
  if (!run.meta.fixtureHash || run.meta.fixtureHash !== baseRun.meta.fixtureHash)
    problems.push(`fixtureHash ${short(run.meta.fixtureHash)} ≠ baseline ${short(baseRun.meta.fixtureHash)}`);
  if (run.meta.facts === null || run.meta.facts !== baseRun.meta.facts)
    problems.push(`fact count ${run.meta.facts ?? 'unrecorded'} ≠ baseline ${baseRun.meta.facts ?? 'unrecorded'}`);
  if (run.meta.orderSeed === null || run.meta.orderSeed !== baseRun.meta.orderSeed)
    problems.push(`order seed ${run.meta.orderSeed ?? 'unrecorded'} ≠ baseline ${baseRun.meta.orderSeed ?? 'unrecorded'}`);
  // THE DIGEST IS PER SEED (Run 7): every seed either side of the pairing started an arm from — the baseline arm's, and
  // each of this run's — must carry a formula arm in BOTH runs whose digests agree. A local-tag seed must also be the
  // SAME seed (its model and when it was made), since two tag seeds of one model are two different annotations.
  const seeds = [...new Set([arm ? arm.seed : null, ...run.arms.map((a) => a.seed)].filter(Boolean))];
  for (const seed of seeds) {
    const key = formulaKeyFor(seed);
    const fa = run.arms.find((a) => a.key === key), fb = baseRun.arms.find((a) => a.key === key);
    if (!fa || !fb) problems.push(`${SEED_NAME[seed]}'s formula digest cannot be compared — no ${key} arm in ${!fa ? 'this run' : 'the baseline run'}`);
    else if (positionsDigest(fa.rows) !== positionsDigest(fb.rows))
      problems.push(`${key} digest ${positionsDigest(fa.rows)} ≠ baseline ${positionsDigest(fb.rows)} — the runs did not start from equivalent state`);
    if (seed !== 'default') {
      const id = (m) => (m?.[seed] ? `${m.model} @ ${m[seed].createdAt}` : 'none');
      if (id(run.meta.tagSeed) === 'none' || id(run.meta.tagSeed) !== id(baseRun.meta.tagSeed))
        problems.push(`${SEED_NAME[seed]}s differ (${id(run.meta.tagSeed)} ≠ baseline ${id(baseRun.meta.tagSeed)})`);
    }
  }
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
const chunkingPairs = (arms) => arms.filter((a) => /^(cpu-)?rr:/.test(a.key))
  .map((rr) => {
    // Run 8: a CPU-only arm pairs with its own CPU-only twin, never with the GPU one.
    const [, pre = '', model] = /^(cpu-)?rr:(.+)$/.exec(rr.key);
    return { model: pre ? `${model} (CPU)` : model, rr, rrk: arms.find((a) => a.key === `${pre}rrk:${model}`) };
  })
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

/** The groups a BY POSITION block reads, in order, and each one's row filter. THE MIXED FIXTURE (Run 9) adds `short` — a
 *  fact kept as its original text — beside the long positions, and a pooled `long` group (every long note, wherever its
 *  answer sits), because its question splits on the TARGET'S LENGTH: short · long · end · beyond. A fixture without
 *  `short` gets exactly the groups it always did. */
const positionGroups = (positions) => {
  const present = ['short', ...POSITIONS].filter((p) => Object.values(positions).includes(p));
  const mixed = present.includes('short') && present.length > 1;
  const groups = mixed ? ['short', 'long', ...present.filter((p) => p !== 'short')] : present;
  const at = (p) => (p === 'long' ? (r) => positions[r.fact] !== undefined && positions[r.fact] !== 'short' : (r) => positions[r.fact] === p);
  return { groups, at, mixed };
};

/** THE LONG FIXTURE'S QUESTION (docs/judge-bench.md Run 6): what each arm does to a fact by WHERE its answer sits in
 *  its note. All four question sets pooled per position (4 × 15 facts = 60 queries); for every arm, accuracy and
 *  coverage; then paired, each arm against `formula` and every reranker against every other, per position. Equivalence
 *  is not judged here (60 pairs can essentially never bound ±3 pp) — the interval is printed instead. Returns what
 *  goes into the results file. */
const printByPosition = (run) => {
  const positions = run.meta.positions;
  const { groups, at, mixed } = positionGroups(positions);
  const { arms } = run;
  const W = Math.max(dw('arm'), ...arms.map((a) => dw(a.label))) + 2;
  const out = { positions: groups, sets: {}, paired: {} };
  console.log('\nBY POSITION — where the answer sits in its note; every question set pooled (4 questions × the facts at that'
    + ' position). Cells: top-1 / found@8 / judged-of-graph');
  if (mixed) console.log('(the mixed fixture: short = a fact kept as its original text, one window for every reranker; long = every'
    + ' long note, end and beyond pooled)');
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

/** RUN 9'S QUESTION AND RULE (docs/judge-bench.md, registered before the run): on the MIXED fixture, does scoring long
 *  notes in windows cost the SHORT facts they compete with? Per reranker, chunked (`rrk`) against cut (`rr`), paired per
 *  query, on questions whose target is SHORT, on those whose target is LONG, and on `all`, both metrics. The rule reads
 *  the short row's found@8 alone: chunking "costs short facts" if it is significantly worse — exact McNemar p < 0.05 AND
 *  c − b < 0 — for ANY reranker; one test per reranker, no correction. Printed only for a fixture with short and long
 *  targets and a run with both arms of a reranker, so every earlier run re-analyses as it did. */
const printMixedRule = (run) => {
  const positions = run.meta.positions;
  const { mixed, at } = positionGroups(positions);
  const pairs = chunkingPairs(run.arms);
  if (!mixed || !pairs.length) return null;
  const out = { pairs: {}, costs: [] };
  const TW = Math.max(dw('reranker'), ...pairs.map((p) => dw(p.model))) + 2;
  console.log('\nRUN 9 — chunked (rrk) against cut (rr), per reranker, by the TARGET\'s length; b = cut hit & chunked miss, c = the reverse');
  console.log('  ' + pad('reranker', TW) + pad('target', 8) + pad('pairs', 7) + pad('found@8 cut→chunked', 21) + pad('b/c', 8) + pad('p', 8)
    + pad('net, 95%', 30) + pad('top-1 cut→chunked', 19) + pad('b/c', 8) + pad('p', 8) + 'net, 95%');
  const net = (x) => (x.netPp === null ? '—' : `${signed(x.netPp, 1)}pp${x.interval95Pp ? ` [${signed(x.interval95Pp[0], 1)}, ${signed(x.interval95Pp[1], 1)}]` : ''}`);
  for (const p of pairs) {
    const row = {};
    for (const [i, g] of ['short', 'long', 'all'].entries()) {
      const where = g === 'all' ? inSet('all') : at(g);
      const t = pairedTest(p.rrk, p.rr, g === 'all' ? 'all' : null, where);
      const cut = stat(p.rr.rows.filter(where)), ck = stat(p.rrk.rows.filter(where));
      row[g] = { pairs: t.pairs, cut: { top1: cut.top1, found: cut.found, n: cut.n }, chunked: { top1: ck.top1, found: ck.found, n: ck.n },
        found: t.found, top1: t.top1 };
      console.log('  ' + pad(i === 0 ? p.model : '', TW) + pad(g, 8) + pad(t.pairs, 7) + pad(`${cut.found} → ${ck.found}`, 21)
        + pad(`${t.found.b}/${t.found.c}`, 8) + pad(pv(t.found.p), 8) + pad(net(t.found), 30) + pad(`${cut.top1} → ${ck.top1}`, 19)
        + pad(`${t.top1.b}/${t.top1.c}`, 8) + pad(pv(t.top1.p), 8) + net(t.top1));
    }
    const f = row.short.found;
    row.costsShort = f.p < 0.05 && f.c - f.b < 0;
    if (row.costsShort) out.costs.push(p.model);
    out.pairs[p.model] = row;
  }
  for (const p of pairs) {
    const f = out.pairs[p.model].short.found;
    console.log(`RUN 9 RULE — ${p.model}: on SHORT-target questions, chunked found@8 ${out.pairs[p.model].costsShort ? 'IS' : 'is NOT'} significantly`
      + ` worse than cut (b/c ${f.b}/${f.c}, p ${pv(f.p)}, net ${signed(f.netPp, 1)}pp${f.interval95Pp ? `, 95% [${signed(f.interval95Pp[0], 1)}, ${signed(f.interval95Pp[1], 1)}]pp` : ''})`);
  }
  console.log(out.costs.length ? `RUN 9 RULE — chunking COSTS short facts: ${out.costs.join(', ')}`
    : 'RUN 9 RULE — chunking does NOT cost short facts: no reranker is significantly worse on short-target found@8');
  return out;
};

/** RUN 8 — what each CPU-only arm did, recall by recall, in the order it ran: which recalls the 60 s verification
 *  deadline cut, what each rerank call sent (windows, the fixture notes they came from, windows per note), how long it
 *  took and at what rate, and every pace line the product logged. Then each reranker chunked against itself cut, on the
 *  CPU — the pairs Run 8's rule reads. Printed only for a run that has CPU-only arms, so every earlier run re-analyses as
 *  it did. Returns what goes into the results file. */
const printCpu = (run) => {
  const cpuArms = run.arms.filter((a) => a.cpu);
  if (!cpuArms.length) return null;
  const out = { arms: {} };
  const pct = (xs, p) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  };
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const f1 = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(1));
  const ms = (v) => (v === null || v === undefined ? '—' : `${(v / 1000).toFixed(1)} s`);
  // What RerankPace would read off an ANSWERED single call, at the proxy: (wall − CallOverheadMs) per 1,000 pair tokens.
  const rateOf = (r) => (r.rerank?.calls === 1 && r.rerank.aborted === false && r.rerank.statuses === '200' && r.rerank.pairTokens > 0
    ? ((r.rerank.callMs - PACE.overheadMs) / r.rerank.pairTokens) * 1000 : null);
  const sym = (r) => (r.error !== null ? 'x' : r.answered !== null ? 'v' : r.deadlineCut === true ? 'C' : r.skip ? 'S'
    : !(r.rerank?.calls > 0) ? 'f' : '?');
  console.log('\nCPU-ONLY ARMS (Run 8) — each alone on a fresh CPU-only router, one arm at a time; its accuracy pass is the serial pass.');
  console.log('Per recall, in the order asked: v = a verdict · C = cut by the 60 s verification deadline (NoOpinion: the engine\'s own'
    + ' page) · S = skipped by the pace (nothing, or only a probe, sent: NoOpinion at once) · f = no rerank call (FTS, or nothing'
    + ' to judge) · x = the recall errored · ? = no verdict, no cut and no skip (a fault)');
  for (const arm of cpuArms) {
    const rows = [...arm.rows].sort((a, b) => a.seq - b.seq);
    const strip = rows.map(sym).join('');
    const cuts = rows.filter((r) => r.deadlineCut === true);
    const withCall = rows.filter((r) => r.rerank?.calls > 0);
    // Consecutive cuts: a cut whose previous rerank call was cut too queued behind a batch nobody was waiting for.
    let run0 = 0, longest = 0, runs = 0;
    for (const c of strip) {
      if (c === 'C') { if (run0 === 0) runs++; run0++; longest = Math.max(longest, run0); } else if (c !== 'f') run0 = 0;
    }
    const quarter = (i) => rows.filter((_, k) => Math.floor((4 * k) / rows.length) === i);
    const block = (rs) => {
      const cs = rs.filter((r) => r.rerank?.calls > 0);
      return {
        recalls: rs.length, verdicts: rs.filter((r) => r.answered !== null).length, cuts: rs.filter((r) => r.deadlineCut === true).length,
        windowsPerCall: mean(cs.map((r) => r.rerank.documents / r.rerank.calls)),
        notesPerCall: mean(cs.filter((r) => r.rerank.candidates != null).map((r) => r.rerank.candidates / r.rerank.calls)),
        windowsPerNote: mean(cs.filter((r) => r.rerank.candidates > 0).map((r) => r.rerank.documents / r.rerank.candidates)),
        maxWindowsPerNote: cs.filter((r) => r.rerank.candidates > 0).reduce((m, r) => Math.max(m, r.rerank.documents / r.rerank.candidates), 0),
        latencyMedian: median(rs.filter((r) => r.error === null).map((r) => r.ms)),
        rateMedian: pct(rs.map(rateOf).filter((v) => v !== null), 0.5),
      };
    };
    const quarters = [0, 1, 2, 3].map((i) => block(quarter(i)));
    const all = block(rows);
    const paceLines = rows.filter((r) => r.pace).map((r) => ({ seq: r.seq, ...r.pace }));
    const lat = rows.filter((r) => r.error === null).map((r) => r.ms);
    const x = {
      strip, cuts: cuts.length, firstCut: cuts[0]?.seq ?? null, lastCut: cuts.at(-1)?.seq ?? null, cutRuns: runs, longestCutRun: longest,
      recallsWithCall: withCall.length, all, quarters,
      // 'fewest' (2026-09-25) only when there was one, so a run saved before it re-analyses byte for byte.
      paceLines: { sized: paceLines.filter((p) => p.kind === 'sized').length, afterCut: paceLines.filter((p) => p.kind === 'afterCut').length,
        ...(paceLines.some((p) => p.kind === 'fewest') ? { fewest: paceLines.filter((p) => p.kind === 'fewest').length } : {}),
        first: paceLines.slice(0, 5), last: paceLines.slice(-5) },
      latency: { median: median(lat), p90: pct(lat, 0.9), max: lat.length ? Math.max(...lat) : null,
        verdictMedian: median(rows.filter((r) => r.answered !== null).map((r) => r.ms)),
        cutMedian: median(cuts.map((r) => r.ms)) },
      router: arm.cpuRecord ?? null,
    };
    out.arms[arm.key] = x;
    console.log(`\n${arm.key} — ${rows.length} recalls, ${withCall.length} with a rerank call: ${all.verdicts} verdict(s), ${x.cuts} deadline cut(s)`
      + `${x.cuts ? ` (first at seq ${x.firstCut}, last at ${x.lastCut}; ${runs} run(s) of consecutive cuts, the longest ${longest})` : ''}`);
    for (let i = 0; i < strip.length; i += 60) console.log(`  seq ${pad(i, 4)} ${strip.slice(i, i + 60)}`);
    console.log('  ' + pad('part of the run', 18) + pad('recalls', 9) + pad('verdicts', 10) + pad('cuts', 6) + pad('windows/call', 14)
      + pad('notes/call', 12) + pad('windows/note', 14) + pad('max w/note', 12) + pad('median ms', 11) + 'ms per 1k pair tokens (answered, median)');
    for (const [label, b] of [...quarters.map((b, i) => [`quarter ${i + 1}`, b]), ['whole run', all]])
      console.log('  ' + pad(label, 18) + pad(b.recalls, 9) + pad(b.verdicts, 10) + pad(b.cuts, 6) + pad(f1(b.windowsPerCall), 14)
        + pad(f1(b.notesPerCall), 12) + pad(b.windowsPerNote === null ? '—' : b.windowsPerNote.toFixed(2), 14)
        + pad(b.maxWindowsPerNote ? b.maxWindowsPerNote.toFixed(2) : '—', 12) + pad(b.latencyMedian ?? '—', 11)
        + (b.rateMedian === null ? '—' : b.rateMedian.toFixed(2)));
    console.log(`  latency, every recall: median ${ms(x.latency.median)}, p90 ${ms(x.latency.p90)}, max ${ms(x.latency.max)}; with a verdict`
      + ` ${ms(x.latency.verdictMedian)}; cut ${ms(x.latency.cutMedian)}`);
    const pl = (p) => `seq ${p.seq}: ${p.kind === 'afterCut' ? 'after a cut' : p.kind === 'fewest' ? 'the fewest' : 'sized'}, ${p.windows} window(s) instead of ${p.byCount}`
      + `${p.msPer1k != null ? ` at ${p.msPer1k} ms/1k tokens` : ''}${p.budgetS != null ? ` (budget ~${p.budgetS} s)` : ''}`;
    console.log(`  pace lines: ${x.paceLines.sized} sized · ${x.paceLines.afterCut} after a cut`
      + (x.paceLines.fewest ? ` · ${x.paceLines.fewest} the fewest past the budget` : '')
      + (paceLines.length ? `; first: ${x.paceLines.first.map(pl).join(' | ')}` : ''));
    if (paceLines.length > 5) console.log(`  pace lines, last: ${x.paceLines.last.map(pl).join(' | ')}`);
    const r = arm.cpuRecord;
    if (r) {
      console.log(`  router: port ${r.port}, preset [${(arm.llamaRouter?.preset ?? '').split('\n').filter((l) => l && !l.startsWith('[')).join('; ')}],`
        + ` child ${r.childArgs ? `--device ${r.device ?? '(absent)'} --n-gpu-layers ${r.nGpuLayers ?? '(absent)'}` : 'args unread'},`
        + ` n_threads ${r.nThreads ?? '?'}, ${r.tasks ?? '?'} tasks (largest ${r.maxTaskTokens ?? '?'} tokens, ${r.truncated ?? '?'} truncated),`
        + ` ${r.cancelled ?? '?'} "Connection handling canceled", ${r.errorLines ?? '?'} error line(s)`);
    }
  }
  // THE RULE'S PAIRS: each reranker chunked against itself cut, both on the CPU. b = cut hit & chunked miss.
  const pairs = chunkingPairs(run.arms).filter((p) => p.rr.cpu && p.rrk.cpu);
  if (pairs.length) {
    out.paired = printPaired('CPU — each reranker chunked (cpu-rrk) against itself cut (cpu-rr), both on the CPU; b = cut hit & chunked miss,'
      + ' c = the reverse', pairs.map((p) => ({ key: `${p.rrk.key} vs ${p.rr.key}`, label: `${p.rrk.key} vs ${p.rr.key}`, arm: p.rrk, base: p.rr })));
    out.rule = {};
    for (const p of pairs) {
      const f = out.paired[`${p.rrk.key} vs ${p.rr.key}`].all.found;
      const worse = f.p < 0.05 && f.c - f.b < 0;
      out.rule[p.model] = { b: f.b, c: f.c, p: f.p, netPp: f.netPp, interval95Pp: f.interval95Pp, worse };
      console.log(`RUN 8 RULE — ${p.model}: all found@8 chunked ${worse ? 'IS' : 'is NOT'} significantly worse than cut `
        + `(b/c ${f.b}/${f.c}, p ${pv(f.p)}, net ${signed(f.netPp, 1)}pp${f.interval95Pp ? `, 95% [${signed(f.interval95Pp[0], 1)}, ${signed(f.interval95Pp[1], 1)}]pp` : ''})`);
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
    + `${meta.adjacentSameFact === null ? '' : ` (${meta.adjacentSameFact} same-fact adjacencies left)`}, ${meta.concurrency} arms in parallel`
    + `${meta.cpuSerial ? `, then ${meta.cpuSerial.length} CPU-only arm(s) one at a time (${meta.cpuSerial.join(', ')})` : ''}`);
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
    // Run 8: a CPU-only arm's accuracy pass ran ONE ARM AT A TIME, so it is the serial pass — over EVERY recall, since a
    // recall the deadline cut is the cost being measured, not a failed-open judge looking cheap.
    if (arm.cpu) {
      latency.serialMedian = median(arm.rows.filter((r) => r.error === null).map((r) => r.ms));
      latency.serialFrom = 'accuracy pass, every recall';
    }
    out.armStats[arm.key] = { latency, positionsDigest: positionsDigest(arm.rows) };
  }
  if (base) out.formulaDigest = { digest: out.armStats.formula.positionsDigest, queries: meta.queries, orderSeed: meta.orderSeed, facts: meta.facts };
  // One digest PER SEED (Run 7): the default seed's `formula`, and each local-tag seed's `formula@<seed>` when it ran.
  const extraFormulas = EXTRA_SEEDS.map((s) => find(formulaKeyFor(s))).filter(Boolean);
  if (extraFormulas.length) out.formulaDigests = { default: out.formulaDigest?.digest ?? null,
    ...Object.fromEntries(extraFormulas.map((a) => [a.seed, out.armStats[a.key].positionsDigest])) };

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
  // exactly as they did. Both stay within ONE seed: a pair across seeds changes the tags as well as the judge, and the
  // tag-seed block below is where that pairing is read.
  const cjArms = arms.filter((a) => chatKey(a));
  const cjVsRr = [];
  for (const c of cjArms)
    for (const r of arms.filter((a) => /^rr:/.test(a.key) && a.seed === c.seed)) cjVsRr.push({ key: `${c.key} vs ${r.key}`, label: `${c.key} vs ${r.key}`, arm: c, base: r });
  if (cjVsRr.length > 0) out.paired.chatJudgesVsRerankers = printPaired('PAIRED — each local chat judge against each reranker under partition;'
    + ' b = reranker hit & chat-judge miss, c = the reverse', cjVsRr);
  const cjAcross = [];
  for (const input of ['lc', 'lcb']) {
    const same = cjArms.filter((a) => chatKey(a)[1] === input && a.seed === 'default');
    for (let i = 0; i < same.length; i++)
      for (let j = i + 1; j < same.length; j++)
        cjAcross.push({ key: `${same[j].key} vs ${same[i].key}`, label: `${same[j].key} vs ${same[i].key}`, arm: same[j], base: same[i] });
  }
  if (cjAcross.length > 0) out.paired.chatJudgesAcross = printPaired('PAIRED — every local chat judge against every other, same input;'
    + ' b = right-hand hit & left-hand miss, c = the reverse', cjAcross);
  // THE LOCAL-TAG SEEDS' QUESTION (docs/judge-bench.md Run 7). Each arm on the TAG seed against the same arm on the
  // REPLAY seed — the pair that differs ONLY in the tags (the model's, against Claude's written the same way) — and
  // every arm on either against the same arm on the default seed (the replay's pair differs only in the decay clock)
  // and against its own seed's formula (what the judge adds over those tags). Paired by KEY, so a saved or recovered
  // run pairs the same way.
  const tagComps = [];
  const pair = (arm, base) => base && base !== arm && tagComps.push({ key: `${arm.key} vs ${base.key}`, label: `${arm.key} vs ${base.key}`, arm, base });
  for (const seed of ['tags', 'replay'])
    for (const t of arms.filter((a) => a.seed === seed)) {
      if (seed === 'tags') pair(t, find(`${baseKeyOf(t.key)}@replay`));
      pair(t, find(baseKeyOf(t.key)));
      pair(t, find(formulaKeyFor(seed)));
    }
  if (tagComps.length > 0) out.paired.tagSeed = printPaired(`PAIRED — the local-tag seeds${meta.tagSeed ? ` (tags by ${meta.tagSeed.model})` : ''}:`
    + ' @tags against @replay differ ONLY in the tags; @replay against the default seed only in the decay clock; b = right-hand hit & left-hand miss', tagComps);
  if (meta.tagSeed?.stats) printTagStats([
    { name: 'Claude (default and replay seeds)', stats: meta.tagSeed.stats.default },
    { name: `${meta.tagSeed.model} (tag seed)`, stats: meta.tagSeed.stats.tags },
  ]);
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
  // Run 9: the mixed fixture's rule — only for a fixture with short and long targets and a run with rr and rrk arms.
  if (meta.positions) { const mr = printMixedRule(run); if (mr) out.mixedRule = mr; }

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
  if (out.formulaDigests) for (const seed of EXTRA_SEEDS) if (out.formulaDigests[seed])
    console.log(`${formulaKeyFor(seed)} positions digest: ${out.formulaDigests[seed]} — ${SEED_NAME[seed]}'s own; compared only with another`
      + ` run's ${formulaKeyFor(seed)} on the same seed`);

  console.log(`\nlatency (ms) — parallel: mean over the accuracy pass, ${meta.concurrency} arm(s) at once; serial median: one arm at a time,`
    + ` first ${meta.latencySample ?? '?'} queries, judge arms counting only recalls that carried a verdict`);
  console.log(pad('arm', LABEL_W) + pad('ms (parallel)', 15) + pad('ms (serial median)', 20)
    + pad('cli ok/failed (accuracy)', 26) + pad('cli ok/failed (total)', 23) + 'judge');
  for (const arm of arms) {
    const l = out.armStats[arm.key].latency;
    const r = (x) => (x ? `${x.ok}/${x.failed}` : 'unrecorded');
    console.log(pad(arm.label, LABEL_W) + pad(l.parallelMean, 15) + pad(`${l.serialMedian ?? '—'}${l.serialFrom ? ' (*)' : ''}`, 20)
      + pad(r(arm.router?.accuracy), 26) + pad(r(arm.router?.total), 23)
      + `${arm.judgeOn === null ? '?' : arm.judgeOn ? 'on' : 'off'} · ${arm.judgeSource ?? '—'} · ${arm.judgeModel ?? '—'}`);
  }
  if (arms.some((a) => a.cpu))
    console.log('  (*) a CPU-only arm (Run 8): no latency pass — its accuracy pass ran one arm at a time, so it IS the serial pass;'
      + ' the median is over every recall, a deadline cut included (the CPU block below splits it). Its "ms (parallel)" is that'
      + ' same serial pass\'s mean.');
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
      // A CPU-only arm's proxy never memoises, and counts the requests its client ABANDONED (the verification deadline).
      if (arm.cpu) x.abandoned = p.abandoned ?? null;
      out.rerankSent[arm.key] = x;
      console.log(pad(arm.label, LABEL_W) + pad(x.calls, 8) + pad(x.shared ?? '—', 8) + pad(x.docsMean === null ? '—' : x.docsMean.toFixed(1), 18)
        + pad(x.docsMax ?? '—', 17) + pad(x.longest, 21)
        + (x.forwarded === null ? 'unrecorded' : `${x.forwarded} · ${x.retried} · ${x.errors}`)
        + (arm.cpu ? ` · ${x.abandoned ?? '?'} abandoned by the client (CPU arm, no memo)` : ''));
      // A request the proxy failed to deliver reads to the arm as a 502 — no verdict — and says nothing about the judge.
      if (x.errors > 0) out.warnings.push(`arm ${arm.key} — the rerank proxy failed to deliver ${x.errors} request(s): those recalls carry no verdict for a reason that is the bench's, not the judge's`);
    }
    // Every forward must have reached the router (the reconciliation the live run saved). The shared router serves the
    // arms that are not CPU-only; each CPU-only arm had a router of its own, reconciled with its own log.
    const seen = meta.rerankProxy.routerProxied;
    if (seen && !seen.error) {
      out.rerankReconciled = {};
      for (const model of [...new Set(arms.filter((a) => a.reranker && !a.cpu && meta.rerankProxy.arms?.[a.key]).map((a) => a.reranker))]) {
        const sent = arms.filter((a) => a.reranker === model && !a.cpu).reduce((s, a) => s + (meta.rerankProxy.arms[a.key]?.forwarded ?? 0), 0);
        out.rerankReconciled[model] = { forwarded: sent, routerSaw: seen[model] ?? 0 };
        console.log(`  ${pad(model, LABEL_W - 2)}forwarded ${sent} rerank requests, the router proxied ${seen[model] ?? 0} to this model's child`);
        if (sent !== (seen[model] ?? 0))
          out.warnings.push(`${model} — the proxies forwarded ${sent} rerank requests and the router saw ${seen[model] ?? 0}: some request never reached the model`);
      }
    } else if (seen?.error) out.notes.push(`router log not reconciled: ${seen.error}`);
    // Run 8: each CPU-only arm against ITS OWN router's log.
    for (const arm of arms.filter((a) => a.cpu && meta.rerankProxy.arms?.[a.key])) {
      const p = meta.rerankProxy.arms[arm.key];
      const saw = p.routerProxied;
      if (saw === null || saw === undefined || typeof saw !== 'number') { out.notes.push(`${arm.key}: its CPU router's log was not reconciled (${saw?.error ?? 'no count saved'})`); continue; }
      (out.rerankReconciled ??= {})[arm.key] = { forwarded: p.forwarded, routerSaw: saw };
      console.log(`  ${pad(arm.key, LABEL_W - 2)}forwarded ${p.forwarded} rerank requests, its own CPU router proxied ${saw} to the child`);
      if (p.forwarded !== saw)
        out.warnings.push(`${arm.key} — its proxy forwarded ${p.forwarded} rerank requests and its CPU router saw ${saw}: some request never reached the model`);
    }
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

  // Run 8: the CPU-only arms, recall by recall, and the pairs its rule reads. Nothing for a run without them.
  const cpu = printCpu(run);
  if (cpu) out.cpu = cpu;

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
    // Run 8: on a CPU-only arm a recall the verification DEADLINE cut is the thing measured, not a fault — so there the
    // guard is that every abstention IS a traced deadline cut (the product's own Warning logged during that recall), and
    // that no recall carrying a verdict was also cut.
    if (arm.cpu) {
      // A pace SKIP explains an abstention too (2026-09-25) — the product's own line, placed on the recall like a cut's.
      const unexplained = arm.rows.filter((r) => r.error === null && r.ranked === 'graph' && r.answered === null && r.deadlineCut !== true
        && !r.skip);
      const contradicted = arm.rows.filter((r) => r.answered !== null && (r.deadlineCut === true || r.skip));
      if (unexplained.length)
        out.warnings.push(`arm ${arm.key} — ${unexplained.length}/${s.graph} graph recalls carried no verdict that no deadline cut or pace skip explains (seq ${unexplained.slice(0, 12).map((r) => r.seq).join(', ')}): a fault, not the pace`);
      if (contradicted.length)
        out.warnings.push(`arm ${arm.key} — ${contradicted.length} recall(s) carried a verdict AND a deadline-cut or pace-skip line (seq ${contradicted.slice(0, 12).map((r) => r.seq).join(', ')}): the log and the rows disagree`);
    } else if (arm.reranker && s.judged < s.graph)
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
  // THE PACE GUARD (header): a run in which RerankPace sized any call is VOID. Only a run that saved the counts is
  // judged; one saved before the guard prints nothing new.
  let paceVoid = null;
  if (meta.rerankPace) {
    // Run 8: a CPU-only arm is EXEMPT — the pace's activity is what it measures — and says so; every other arm is judged.
    const cpuKeys = new Set(arms.filter((a) => a.cpu).map((a) => a.key));
    const fired = Object.entries(meta.rerankPace).filter(([k, n]) => n > 0 && !cpuKeys.has(k));
    const exempt = Object.entries(meta.rerankPace).filter(([k]) => cpuKeys.has(k));
    // Its own name: the saved counts stay `rerankPace` in the file, and a re-analysis must read those, not this.
    out.paceGuard = { void: fired.length > 0, fired: Object.fromEntries(fired), ...(exempt.length ? { exempt: Object.fromEntries(exempt) } : {}) };
    if (exempt.length)
      console.log(`\nPACE GUARD — exempt, as designated CPU-only arms (the pace is what they measure): ${exempt.map(([k, n]) => `${k} (${n} line${n === 1 ? '' : 's'})`).join(', ')};`
        + ` judged: ${Object.keys(meta.rerankPace).filter((k) => !cpuKeys.has(k)).join(', ') || 'none'}`);
    for (const [k, n] of fired)
      out.warnings.push(`arm ${k} — RerankPace sized, skipped or re-measured ${n} rerank call(s) (its log: "window(s) per long candidate instead of …" or "re-measured this machine"): what the arm sent depended on this machine's timing`);
    if (fired.length) paceVoid = fired.map(([k, n]) => `${k} (${n})`).join(', ');
  }
  if (out.warnings.length > 0) {
    console.log('');
    for (const w of out.warnings) console.log(`WARNING: ${w}`);
  }
  if (out.notes.length > 0) {
    console.log('');
    for (const n of out.notes) console.log(`NOTE: ${n}`);
  }
  if (paceVoid) {
    console.log(`\nVOID: RerankPace changed what an arm sent — ${paceVoid}. Paired arms no longer differ only in their `
      + 'configuration, so no table above may be read. Every selected arm runs in parallel on one GPU, so re-run with '
      + 'nothing else on it, or split the arms across runs (fewer --arms, --rerankers or --rerank-arms per run) and pair '
      + 'within each run only.');
    process.exitCode = 1;
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
  // `<arm>@tags` / `<arm>@replay` is the same arm started from a local-tag seed (Run 7) — its own label says so.
  if (seedOfKey(key) !== 'default') {
    const base = armConfigFor(baseKeyOf(key));
    return { ...base, label: `${base.label} · on ${SEED_NAME[seedOfKey(key)]}`, seed: seedOfKey(key) };
  }
  if (ARMS[key]) return { label: ARMS[key].label, enrichment: ARMS[key].enrichment, judgeInput: ARMS[key].judgeInput ?? null, reranker: null, chatJudge: null };
  const m = /^(rr[fk]?):(.+)$/.exec(key);
  if (m) return { label: `reranker ${m[2]} · ${RERANK_ARM_KINDS[m[1]].suffix}`, enrichment: true, judgeInput: null, reranker: m[2], chatJudge: null };
  // Run 8: the same reranker arm on a CPU-only router (`cpu: true` is what exempts it from the pace guard).
  const cpu = /^cpu-(rr[fk]?):(.+)$/.exec(key);
  if (cpu) return { label: `reranker ${cpu[2]} · ${RERANK_ARM_KINDS[cpu[1]].suffix} · CPU-only router`, enrichment: true, judgeInput: null,
    reranker: cpu[2], chatJudge: null, cpu: true };
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
  // WHAT SHIPS. The default stays `rr,rrf` so every registered command of Runs 2–7 re-launches as it ran — but those two
  // pin the CUT, and the product scores long candidates in windows since Run 6c. So a run naming rerankers with no arm
  // that measures the shipped scoring says so before it starts, reading the C# default rather than restating it. Printed
  // here, in the live run only: the analysis `--report-only` shares is untouched, so every saved run re-analyses as it did.
  if (rerankers.length > 0) {
    const chunkingSrc = fs.readFileSync(path.join(repo, 'src', 'server', 'Gatherlight.Platform', 'Agent', 'Llm', 'Services',
      'ChunkedScoreProvider.cs'), 'utf8');
    const shipsChunked = /public const bool Default = (true|false);/.exec(chunkingSrc)?.[1];
    if (shipsChunked === undefined) die('could not read RerankChunking.Default from ChunkedScoreProvider.cs — the bench cannot tell which arm ships');
    const shipped = shipsChunked === 'true' ? 'rrk' : 'rr';
    if (!rerankKinds.includes(shipped))
      console.log(`WARNING: no reranker arm measures what ships — the product ${shipped === 'rrk'
        ? 'scores a long candidate in windows (RerankChunking.Default = true), which is rrk'
        : 'cuts a long candidate to its first window (RerankChunking.Default = false), which is rr'}; this run's --rerank-arms=${
        rerankKinds.join(',')} measures only ${rerankKinds.map((k) => `${k} (${RERANK_ARM_KINDS[k].suffix})`).join(', ')}. `
        + `Add ${shipped} to --rerank-arms to measure the product.`);
  }
  for (const m of rerankers)
    for (const k of rerankKinds) {
      const kind = RERANK_ARM_KINDS[k];
      arms.push({ key: `${k}:${m}`, ...armConfigFor(`${k}:${m}`), env: { ...kind.env }, ...(kind.knob ? { knob: kind.knob } : {}) });
    }
  // A llama.cpp CHAT judge, both ways it can be shown a candidate. `lc` sets NO knob — it is the shipped default,
  // so the knob-less check below proves nothing leaked in — and `lcb` must announce the one it sets.
  // Run 8: the CPU-only arms — the same reranker arms, each run alone on a CPU-only router of its own (header).
  const cpuRerankers = list('cpu-rerankers', '');
  const cpuKinds = list('cpu-rerank-arms', 'rr,rrk');
  for (const k of cpuKinds) if (!RERANK_ARM_KINDS[k]) die(`--cpu-rerank-arms: unknown kind '${k}' — one of ${Object.keys(RERANK_ARM_KINDS).join(', ')}`);
  if (!cpuRerankers.length && opts['cpu-rerank-arms']) die('--cpu-rerank-arms needs --cpu-rerankers');
  if (cpuRerankers.length && opts['tag-seed']) die('--cpu-rerankers is not for a local-tag seed run');
  if (cpuRerankers.length) paceMirror();
  for (const m of cpuRerankers)
    for (const k of cpuKinds) {
      const kind = RERANK_ARM_KINDS[k];
      arms.push({ key: `cpu-${k}:${m}`, ...armConfigFor(`cpu-${k}:${m}`), env: { ...kind.env }, ...(kind.knob ? { knob: kind.knob } : {}) });
    }
  const chatJudges = list('chat-judges', '');
  if (chatJudges.find((m) => cpuRerankers.includes(m))) die('a model is in both --cpu-rerankers and --chat-judges — a GGUF is one kind');
  const both = chatJudges.find((m) => rerankers.includes(m));
  if (both) die(`'${both}' is in both --rerankers and --chat-judges — a GGUF is one kind, and the router's preset gives it one`);
  const chatKinds = list('chat-arms', 'lc,lcb');
  for (const k of chatKinds) if (k !== 'lc' && k !== 'lcb') die(`--chat-arms: unknown kind '${k}' — one of lc, lcb`);
  for (const m of chatJudges) {
    if (chatKinds.includes('lc')) arms.push({ key: `lc:${m}`, ...armConfigFor(`lc:${m}`), env: {} });
    if (chatKinds.includes('lcb')) arms.push({ key: `lcb:${m}`, ...armConfigFor(`lcb:${m}`), env: { GATHERLIGHT_JUDGE_INPUT: 'both' }, knob: /judge input = both \(/ });
  }
  // THE LOCAL-TAG SEEDS (Run 7): each listed arm runs TWICE more, started from the replay seed (`<arm>@replay`) and from
  // the tag seed (`<arm>@tags`). Nothing else about them changes — same knobs, same binding — so the @tags/@replay pair
  // differs only in the tags.
  const tagArmKeys = list('tag-seed-arms', '');
  if (!TAG_MODEL && (tagArmKeys.length || opts['build-tag-seed'])) die('--tag-seed-arms and --build-tag-seed need --tag-seed=<chat model>');
  for (const seed of EXTRA_SEEDS)
    for (const k of tagArmKeys) {
      const base = arms.find((a) => a.key === k);
      if (!base) die(`--tag-seed-arms: '${k}' is not one of this run's arms (${arms.map((a) => a.key).join(', ')})`);
      arms.push({ ...base, key: `${k}@${seed}`, seed });
    }
  for (const a of arms) a.seed = a.seed ?? 'default';
  // The model a local-model arm binds 判断 to, whichever kind it is.
  for (const a of arms) a.llamaModel = a.reranker ?? a.chatJudge ?? null;
  // The long seed is written with 判断 off, so its formula arm has NO tags to recall over — say so in the label.
  if (NOTES) for (const a of arms) a.label = a.label.replace('(seed tags present)', '(seed has no tags)');
  // With the local-tag seeds in the run, EVERY label names whose tags its arm recalls over, and how they were written.
  if (TAG_MODEL && tagArmKeys.length) for (const a of arms) {
    const whose = { default: 'Claude tags, 2026-09-23 seed', replay: 'Claude tags replayed', tags: `${TAG_MODEL} tags` }[a.seed];
    a.label = a.label.includes('(seed tags present)') ? a.label.replace('(seed tags present)', `(${whose})`) : `${a.label} · ${whose}`;
  }
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
    if (NOTES && seedMeta.judge !== 'off') die(`--reuse-seed: ${rel(SEED_ROOT)} was not written with 判断 off — pass --reseed`);
  } else if (!RESEED && fs.existsSync(SEED_ROOT) && fs.readdirSync(SEED_ROOT).length > 0) {
    const when = fs.existsSync(SEED_META) ? JSON.parse(fs.readFileSync(SEED_META, 'utf8')).createdAt : 'an interrupted seeding (no seed.json)';
    die(`a seed exists from ${when}; pass --reuse-seed to use it or --reseed to replace it`);
  }
  // THE TAG SEED's preconditions (Run 7). It is paired against the Claude seed, which a tag-seed run never rebuilds
  // (that costs ~60 real annotation calls), and it is written against the STUB, so no quota can be spent by accident.
  // It is BUILT on its own (--seed-only), so its router log and chat-request record are nobody else's.
  const BUILD_TAG = opts['build-tag-seed'] === true;
  const extraMeta = {};   // seed → its seed.json, for the local-tag seeds
  if (TAG_MODEL) {
    if (NOTES) die(`--tag-seed is for the bilingual fixture — the ${VARIANT} seed is written with 判断 off, on purpose`);
    if (opts['claude-stub'] !== true) die('--tag-seed needs --claude-stub: the local-tag seeds are written, and their arms run, against the claude stub');
    if (!REUSE_SEED) die('--tag-seed needs --reuse-seed: the Claude-tagged seed the replay copies is never rebuilt by a tag-seed run');
    if (rerankers.includes(TAG_MODEL)) die(`--tag-seed=${TAG_MODEL} is a reranker, which scores and never writes a tag — name a chat model`);
    if (BUILD_TAG && !SEED_ONLY) die('--build-tag-seed needs --seed-only: the local-tag seeds are built on their own, so their router log is their own evidence');
    if (!BUILD_TAG) for (const seed of EXTRA_SEEDS) {
      const root = seedRootOf(seed);
      if (!fs.existsSync(seedMetaOf(seed)) || !fs.existsSync(seedDataOf(seed))) die(`no ${seed} seed at ${rel(root)} — build both with --build-tag-seed --seed-only`);
      const m = JSON.parse(fs.readFileSync(seedMetaOf(seed), 'utf8'));
      if (m.fixtureHash !== FIXTURE_HASH) die(`${SEED_NAME[seed]} was made from another fixture (${m.fixtureHash.slice(0, 12)}) — rebuild it`);
      if (m.boundModel !== TAG_MODEL) die(`${SEED_NAME[seed]} at ${rel(root)} was written with 判断 bound to ${m.boundModel}, not ${TAG_MODEL}`);
      if (m.guards?.held !== true) die(`${SEED_NAME[seed]} at ${rel(root)} did not pass its build guards — rebuild it`);
      extraMeta[seed] = m;
    }
    if (!BUILD_TAG && extraMeta.tags.builtWith !== extraMeta.replay.builtWith) die('the tag seed and the replay seed were not built together — rebuild both');
  } else if (opts['claude-stub'] === true && RESEED && !NOTES) {
    die('--claude-stub with --reseed would tag the bilingual seed with the STUB — the Claude seed is built with the real CLI');
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
  const STUB = NOTES || opts['claude-stub'] === true;
  if (STUB) {
    const cliArms = arms.filter((a) => ARMS[a.key]?.enrichment);
    if (cliArms.length) die(`${NOTES ? `--fixture=${VARIANT}` : '--claude-stub'} runs against the claude stub, so a Claude-judge arm would measure the stub — drop ${cliArms.map((a) => a.key).join(', ')}`);
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
  // Run 8: every CPU-only router started, so none outlives the run — each is killed when its arm is done, and again here.
  const cpuRouters = [];
  const killTree = (child) => {
    if (!child || child.exitCode !== null) return;
    // The router's model children live in its process tree; kill() alone would orphan them.
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      if (r.status === 0) return;
    }
    try { child.kill(); } catch { /* best effort */ }
  };
  const stopRouter = () => {
    killTree(router);
    for (const c of cpuRouters) killTree(c);
  };
  const extraProxies = [];
  const stopAll = () => {
    for (const s of servers) try { s.stop(); } catch { /* best effort */ }
    for (const p of [...arms.map((a) => a.proxy).filter(Boolean), ...extraProxies])
      try { p.server.closeAllConnections(); p.server.close(); } catch { /* best effort */ }
    stopRouter();
  };
  /** ONE real router for every llama.cpp model the caller names, launched as the product launches them; its preset and
   *  log go to `dir` — the work dir for a run, the tag seed's own folder for a tag-seed build (Run 7). With `cpu` (Run 8)
   *  it is a CPU-only router instead: `n-gpu-layers = 0` and `device = none` in place of the product's `n-gpu-layers =
   *  99`, on `port`, its preset and log named with `tag` — and it is not THE router, so the caller kills it. */
  const startRouter = async (rerankerModels, chatModels, dir, { cpu = false, port = LLAMA_PORT, tag = '' } = {}) => {
    const models = [...rerankerModels, ...chatModels];
    const exe = path.join(RESOURCES, 'llama-cpp', 'llama-server.exe');
    const gguf = path.join(RESOURCES, 'gguf');
    if (!fs.existsSync(exe)) throw new Error(`no llama-server at ${exe} — download llama.cpp in 资源 first`);
    // Both layouts ResourceProvisioner.InstalledGgufIds reads: flat gguf/<m>.gguf, or gguf/<m>/<any>.gguf
    // (how 资源 installs them). The router takes the models dir either way and names both by <m>.
    const installed = (m) => fs.existsSync(path.join(gguf, `${m}.gguf`))
      || (fs.existsSync(path.join(gguf, m)) && fs.statSync(path.join(gguf, m)).isDirectory()
        && fs.readdirSync(path.join(gguf, m)).some((f) => f.toLowerCase().endsWith('.gguf')));
    for (const m of models)
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
    // Run 8's CPU-only launch. `n-gpu-layers = 0` ALONE is not a CPU run on this build: op-offload defaults on, and b10549
    // then runs a big batch's matrix work on any GPU it can see — measured before Run 8, a 48-note BGE call took ~5 s with
    // `n-gpu-layers = 0` alone and 143–197 s with `device = none` as well. A machine with no GPU has only the CPU backend,
    // and `device = none` is what gives this one the same.
    const devices = cpu ? ['n-gpu-layers = 0', 'device = none'] : ['n-gpu-layers = 99'];
    const presetSection = (m, kind) => [`[${m}]`, ...devices,
      ...(kind === 'reranking'
        ? ['reranking = true', `ctx-size = ${windowOf(m)}`, `batch-size = ${windowOf(m)}`, `ubatch-size = ${windowOf(m)}`]
        : ['reasoning = off', `n-predict = ${CHAT_MAX_TOKENS}`, `ctx-size = ${CHAT_CONTEXT_TOKENS}`]),
      ''].join('\n');
    const preset = path.join(dir, `presets${tag}.ini`);
    const presetText = [...rerankerModels.map((m) => presetSection(m, 'reranking')),
      ...chatModels.map((m) => presetSection(m, 'chat'))].join('\n');
    fs.writeFileSync(preset, presetText);
    const log = path.join(dir, `router${tag}.log`);
    const logFd = fs.openSync(log, 'w');
    // --models-max holds every model the arms bind at once, so no arm's model is evicted by another's mid-run.
    const child = spawn(exe, ['--models-dir', gguf, '--models-preset', preset, '--models-max', String(Math.max(2, models.length)),
      '--host', '127.0.0.1', '--port', String(port)], { cwd: path.dirname(exe), stdio: ['ignore', logFd, logFd] });
    fs.closeSync(logFd);
    if (cpu) cpuRouters.push(child); else router = child;
    await until(async () => (await fetch(`http://127.0.0.1:${port}/v1/models`)).ok, 60000);
    return { child, port, preset, presetText, log };
  };

  try {
    // ---- 0. per-run cleanup: the arm folders only; earlier rows-*.jsonl and results-*.json are kept ----------
    // A --seed-only invocation starts no arm, so it leaves the last run's arm folders (its evidence) alone.
    fs.mkdirSync(WORK, { recursive: true });
    if (!SEED_ONLY) for (const e of fs.readdirSync(WORK)) if (/^arm-\d+$/.test(e)) fs.rmSync(path.join(WORK, e), { recursive: true, force: true });
    const ROWS = path.join(WORK, `rows-${RUN_STAMP}.jsonl`);
    const emit = (row) => fs.appendFileSync(ROWS, JSON.stringify({ run: RUN_AT, ...row }) + '\n');

    // ---- 1. seed ONE folder (real CLI, so annotation writes subject tags) — or reuse the last one --------------
    // The long fixture's seed is written with 判断 OFF instead (no tags, no annotation call), against the stub.
    /** The long seed's database, checked rather than trusted: one knowledge row per fact holding EXACTLY its note (a
     *  truncated note would move the answer), and each on its own graph node (a merged node would make one fact's
     *  recall return another's row). Returns what it found. */
    const verifyLongSeed = (ids) => verifySeedRows(SEED_DATA, ids, `the ${VARIANT} seed`);
    /** Any seed's knowledge rows, checked the same way (the long seed, and the tag seed of Run 7). */
    const verifySeedRows = (dataDir, ids, what) => {
      const conn = new DatabaseSync(path.join(dataDir, 'state', 'gatherlight.db'));
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
        if (problems.length) throw new Error(`${what} is not what the fixture says: ${problems.join('; ')}`);
        return { rows: rows.length, graphNodes: new Set(refs).size };
      } finally { conn.close(); }
    };
    if (seedMeta) {
      const madeBy = seedMeta.appHead ? `${seedMeta.appHead} v${seedMeta.appVersion}` : 'unrecorded (the seed predates the field)';
      console.log(`  reusing seed from ${seedMeta.createdAt}: annotated by ${seedMeta.claudeVersion ?? 'unrecorded'},`
        + ` made by app ${madeBy} — now running app ${appHead} v${appVersion}`);
      settleSeedRepo(SEED_DATA);
      await checkpoint(SEED_DATA);
      if (NOTES) {
        const v = verifyLongSeed(seedMeta.idOf);
        console.log(`  ${VARIANT} seed re-verified: 判断 was ${seedMeta.judge}, ${seedMeta.claudeCalls.ok + seedMeta.claudeCalls.failed} claude-cli call(s)`
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
      if (NOTES) {
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
      if (NOTES && seedCalls.n > 0)
        throw new Error(`seed: ${seedCalls.n} claude-cli call(s) (${seedCalls.ok} ok, ${seedCalls.failed} failed) with 判断 off — see ${rel(SEED_DATA)}/state/logs`);
      settleSeedRepo(SEED_DATA);
      await checkpoint(SEED_DATA);
      seedMeta = { idOf: ids, fixtureHash: FIXTURE_HASH, claudeVersion, appHead, appVersion, createdAt: new Date().toISOString() };
      if (NOTES) {
        const v = verifyLongSeed(ids);
        Object.assign(seedMeta, { fixture: FIXTURE_REL, judge: 'off', claudeCalls: { ok: seedCalls.ok, failed: seedCalls.failed }, graphNodes: v.graphNodes });
        console.log(`  ${VARIANT} seed: 0 claude-cli calls, ${v.rows} rows each holding its exact note, ${v.graphNodes} distinct graph nodes`);
      }
      fs.writeFileSync(SEED_META, JSON.stringify(seedMeta, null, 2));
    }
    const idOf = new Map(Object.entries(seedMeta.idOf));
    for (const f of facts) if (!idOf.has(f.id)) throw new Error(`seed has no id for fact ${f.id}`);

    // ---- 1b. THE LOCAL-TAG SEEDS (docs/judge-bench.md Run 7): built through the product's write path, or re-verified -
    /** Two seeds' databases, table by table. Everything that can move a recall is compared: the rows, the graph's nodes
     *  (every column but the timestamps, and which columns differ), its positions, its subjects and subject edges, its
     *  other edges, stored vectors and the review log. The caller decides which of them must be equal. */
    const compareSeeds = (dataA, idsA, dataB, idsB) => {
      const open = (d) => new DatabaseSync(path.join(d, 'state', 'gatherlight.db'), { readOnly: true });
      const a = open(dataA), b = open(dataB);
      try {
        const q = (conn, sql) => JSON.stringify(conn.prepare(sql).all().map((r) => Object.values(r)));
        const same = (sql) => q(a, sql) === q(b, sql);
        const NODE_COLUMNS = ['engine', 'task_key', 'scope', 'headline', 'content', 'content_hash', 'grade', 'metadata',
          'last_recalled_position', 'recall_count', 'stability', 'signals', 'salience', 'encoding_ordinal', 'encoding_chars',
          'provenance_retrievability', 'provenance_salience', 'difficulty'];
        const nodeColumnsDiffering = NODE_COLUMNS.filter((c) => !same(`SELECT id, ${c} FROM lyntai_memory_node ORDER BY id`));
        const count = (conn, sql) => conn.prepare(sql).get().n;
        return {
          idsEqual: FIXTURE.facts.every((f) => Number(idsA[f.id]) === Number(idsB[f.id])),
          knowledge: same('SELECT id, kind, topic, content, source, confidence, hits, graph_ref, aka FROM knowledge ORDER BY id'),
          nodes: nodeColumnsDiffering.length === 0 && same('SELECT COUNT(*) FROM lyntai_memory_node'),
          nodeColumnsDiffering,
          positions: same('SELECT engine, position, ordinal, chars FROM lyntai_memory_position ORDER BY engine'),
          subjects: same('SELECT node_id, subject FROM lyntai_memory_subject ORDER BY node_id, subject'),
          subjectEdges: same("SELECT from_id, to_id, weight FROM lyntai_memory_edge WHERE kind = 'subject' ORDER BY from_id, to_id"),
          nonSubjectEdges: same("SELECT from_id, to_id, kind, weight FROM lyntai_memory_edge WHERE kind <> 'subject' ORDER BY from_id, to_id, kind"),
          vectors: same('SELECT COUNT(*) FROM lyntai_vector'),
          reviews: same('SELECT COUNT(*) FROM lyntai_memory_review'),
          counts: {
            subjects: [count(a, 'SELECT COUNT(*) n FROM lyntai_memory_subject'), count(b, 'SELECT COUNT(*) n FROM lyntai_memory_subject')],
            subjectEdges: [count(a, "SELECT COUNT(*) n FROM lyntai_memory_edge WHERE kind = 'subject'"),
              count(b, "SELECT COUNT(*) n FROM lyntai_memory_edge WHERE kind = 'subject'")],
            otherEdges: [count(a, "SELECT COUNT(*) n FROM lyntai_memory_edge WHERE kind <> 'subject'"),
              count(b, "SELECT COUNT(*) n FROM lyntai_memory_edge WHERE kind <> 'subject'")],
            position: [a.prepare('SELECT position FROM lyntai_memory_position').get()?.position ?? null,
              b.prepare('SELECT position FROM lyntai_memory_position').get()?.position ?? null],
          },
        };
      } finally { a.close(); b.close(); }
    };
    const mustEqual = (found, keys, what) => {
      const bad = keys.filter((k) => found[k] !== true);
      if (bad.length) throw new Error(`${what}: ${bad.join(', ')} differ — see ${rel(seedMetaOf('tags'))}`);
    };
    /** Each chat child's spawn arguments, from a router log: the proof that thinking was off and the caps were set. */
    const childArgsOf = (logFile, model) => {
      const log = fs.readFileSync(logFile, 'utf8').split(/\r?\n/);
      const spawns = [];
      for (let i = 0; i < log.length; i++) {
        const m = /spawning server instance with name=(\S+) on port (\d+)/.exec(log[i]);
        if (!m || m[1] !== model) continue;
        const args = [];
        for (let j = i + 2; j < log.length && /load:\s{2,}\S/.test(log[j]) && !/spawning/.test(log[j]); j++) args.push(log[j].replace(/^.*load:\s+/, '').trim());
        spawns.push(args);
      }
      const val = (args, k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
      return { spawns: spawns.length, reasoning: spawns[0] ? val(spawns[0], '--reasoning') : null,
        nPredict: spawns[0] ? val(spawns[0], '--n-predict') : null, ctxSize: spawns[0] ? val(spawns[0], '--ctx-size') : null };
    };
    /** Requests the router proxied to `model`'s child, read once the count stops moving (the router logs via a queue). */
    const routerProxiedTo = async (logFile, model) => {
      let last = -1;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const n = [...fs.readFileSync(logFile, 'utf8').matchAll(/proxying request to model (\S+) on/g)].filter((m) => m[1] === model).length;
        if (n === last) return n;
        last = n;
      }
      return last;
    };
    /** A RECORDING proxy between a local-tag seed's server and the router. Every request is written to `file` — what kind
     *  it is (an annotation, recognised by the annotator's own system prompt; the startup warm; anything else), the fact
     *  it labelled, and the reply: status, finish reason, tokens generated, the text, and any reasoning the child returned
     *  (with thinking off there must be none). Everything is forwarded untouched, on a fresh connection — EXCEPT, when
     *  `replay` (fact content → handles) is given, an annotation request, which is answered here with those handles as
     *  a chat completion of the shape llama-server returns, and never reaches the model. */
    const startChatRecorder = (file, replay = null) => new Promise((resolve) => {
      const state = { forwarded: 0, annotations: 0, replayed: 0, warms: 0, other: 0, failed: 0 };
      const agent = new http.Agent({ keepAlive: false });
      const once = (req, body) => new Promise((ok, fail) => {
        const up = http.request({ host: '127.0.0.1', port: LLAMA_PORT, method: req.method, path: req.url, agent,
          headers: { ...req.headers, host: `127.0.0.1:${LLAMA_PORT}`, 'content-length': body.length, connection: 'close' } }, (r) => {
          const out = [];
          r.on('data', (c) => out.push(c));
          r.on('end', () => ok({ status: r.statusCode, headers: r.headers, body: Buffer.concat(out) }));
          r.on('error', fail);
        });
        up.on('error', fail);
        up.end(body);
      });
      /** A chat reply's text, finish reason, generated tokens and reasoning — JSON, or an SSE stream folded together. */
      const readReply = (buf) => {
        const text = buf.toString('utf8');
        try {
          const j = JSON.parse(text);
          const c = j.choices?.[0] ?? {};
          return { content: c.message?.content ?? null, finish: c.finish_reason ?? null,
            completionTokens: j.usage?.completion_tokens ?? null, reasoning: c.message?.reasoning_content ?? null };
        } catch {
          const parts = text.split(/\r?\n/).filter((l) => l.startsWith('data:') && !l.includes('[DONE]'))
            .map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);
          if (!parts.length) return { content: null, finish: null, completionTokens: null, reasoning: null, unparsed: text.slice(0, 200) };
          const delta = (k) => parts.map((p) => p.choices?.[0]?.delta?.[k] ?? '').join('');
          return { content: delta('content'), finish: parts.map((p) => p.choices?.[0]?.finish_reason).filter(Boolean).pop() ?? null,
            completionTokens: parts.map((p) => p.usage?.completion_tokens).filter((x) => x != null).pop() ?? null,
            reasoning: delta('reasoning_content') || null };
        }
      };
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          const body = Buffer.concat(chunks);
          let parsed = null;
          try { parsed = JSON.parse(body.toString('utf8')); } catch { /* not JSON: recorded as such */ }
          const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
          const system = String(msgs.find((m) => m.role === 'system')?.content ?? '');
          const user = msgs.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n');
          const kind = req.method !== 'POST' ? 'probe'
            : /^\s*You label a fact with the entities or topics it is about/.test(system) ? 'annotation'
              : msgs.length === 1 && user === 'hi' ? 'warm' : 'other';
          if (kind === 'annotation') state.annotations++;
          else if (kind === 'warm') state.warms++;
          else if (kind === 'other') state.other++;
          const rec = { at: new Date().toISOString(), method: req.method, url: req.url, kind, model: parsed?.model ?? null };
          if (kind === 'annotation') {
            rec.fact = user.split('Fact:\n').pop();
            const known = /Existing subjects[^\n]*\n((?:- [^\n]*\n?)*)/.exec(user);
            rec.knownOffered = known ? known[1].split('\n').filter((l) => l.startsWith('- ')).length : 0;
          }
          const send = (status, headers, buf) => {
            const h = { ...headers, 'content-length': buf.length };
            delete h['transfer-encoding'];
            res.writeHead(status, h);
            res.end(buf);
          };
          if (kind === 'annotation' && replay) {
            const handles = replay.get(rec.fact);
            if (!handles) {
              state.failed++;
              fs.appendFileSync(file, JSON.stringify({ ...rec, replayed: true, status: 500, error: 'no recorded handles for this fact' }) + '\n');
              send(500, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ error: { code: 500, message: 'judge-bench replay: no recorded handles for this fact' } })));
              return;
            }
            state.replayed++;
            const content = JSON.stringify({ subjects: handles });
            const reply = { id: `judge-bench-replay-${state.replayed}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
              model: parsed?.model ?? TAG_MODEL, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
            fs.appendFileSync(file, JSON.stringify({ ...rec, replayed: true, status: 200, content, finish: 'stop', completionTokens: 0, reasoning: null }) + '\n');
            send(200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(reply)));
            return;
          }
          if (req.method === 'POST' && parsed?.model === TAG_MODEL) state.forwarded++;
          let reply;
          try { reply = await once(req, body); } catch {
            try { reply = await once(req, body); } catch (e2) {
              state.failed++;
              fs.appendFileSync(file, JSON.stringify({ ...rec, status: null, error: String(e2?.message ?? e2) }) + '\n');
              send(502, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ error: { code: 502, message: `judge-bench recorder: ${e2?.message ?? e2}` } })));
              return;
            }
          }
          if (kind !== 'probe') Object.assign(rec, { status: reply.status, ...readReply(reply.body) });
          else rec.status = reply.status;
          fs.appendFileSync(file, JSON.stringify(rec) + '\n');
          send(reply.status, reply.headers, reply.body);
        });
      });
      server.keepAliveTimeout = 10 * 60 * 1000;
      server.headersTimeout = server.keepAliveTimeout + 1000;
      server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
    });

    /** ONE local-tag seed, written through the product's write path: a fresh fixture folder, 判断 bound to TAG_MODEL the
     *  way a household's binding is (settings.json, read at DI registration, plus EMPTY stand-ins for the runtime and the
     *  model, which is all IsConfigured asks — the server then ADOPTS the router, through the recorder), every write
     *  annotated by the product's own LlmMemoryAnnotationPolicy. Then the binding comes OFF (settings restored, stand-ins
     *  deleted), so an arm on the seed is configured exactly as one on the default seed. Returns the ids and the record. */
    const writeLocalSeed = async (seed, replay) => {
      const root = seedRootOf(seed), data = seedDataOf(seed), routerLog = path.join(seedRootOf('tags'), 'router.log');
      if (seed !== 'tags') { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); }
      const made = makeTestData(data);
      if (made.status !== 0) throw new Error(`make-test-data exited ${made.status ?? made.error?.message}`);
      const settingsPath = path.join(data, 'state', 'settings.json');
      const resourcesDir = path.join(data, 'state', 'resources');
      if (!fs.existsSync(settingsPath)) throw new Error(`make-test-data left no state/settings.json in ${data}`);
      if (fs.existsSync(resourcesDir)) throw new Error('make-test-data wrote state/resources, so the stand-ins could not be removed cleanly afterwards');
      const settingsBefore = fs.readFileSync(settingsPath);
      fs.mkdirSync(path.join(resourcesDir, 'llama-cpp'), { recursive: true });
      fs.mkdirSync(path.join(resourcesDir, 'gguf'), { recursive: true });
      fs.writeFileSync(path.join(resourcesDir, 'llama-cpp', 'llama-server.exe'), '');
      fs.writeFileSync(path.join(resourcesDir, 'gguf', `${TAG_MODEL}.gguf`), '');
      const bound = JSON.parse(settingsBefore.toString('utf8'));
      bound.memory = { ...(bound.memory ?? {}), judgeSource: 'llama-cpp', judgeModel: TAG_MODEL };
      fs.writeFileSync(settingsPath, JSON.stringify(bound, null, 2));

      const requestsFile = path.join(root, 'chat-requests.jsonl');
      const recorder = await startChatRecorder(requestsFile, replay);
      extraProxies.push(recorder);
      const proxiedBefore = await routerProxiedTo(routerLog, TAG_MODEL);
      const srv = startServer({ dataDir: data, port: PORT_BASE,
        env: { GATHERLIGHT_CLAUDE_CMD: claude, ...PINNED, GATHERLIGHT_LLAMACPP_URL: `http://127.0.0.1:${recorder.port}` } });
      servers.push(srv);
      await waitHealthy(srv.base);
      const sc = makeClient(srv.base);
      const cli = () => routerOutcomes(data);
      const chat = () => routerOutcomes(data, LLAMA_CHAT_PROVIDER);
      if (cli().ok + cli().failed > 0) throw new Error(`${SEED_NAME[seed]}: ${cli().ok + cli().failed} claude-cli call(s) before any write`);
      // RECORDED, not refused: a fresh fixture folder's first boot always warns about the plans/INDEX.md it generates
      // (settleSeedRepo commits it, below), exactly as the default seed's first boot did. The arms' own startup check —
      // no warning at all — runs on the settled copy.
      const startupWarnings = (await sc.getJson('/api/migration/status')).warnings ?? [];
      if (/warming 判断 model .* failed/.test(readLogs(data) + srv.log())) throw new Error(`${SEED_NAME[seed]}: warming the 判断 model failed`);
      // 判断 is ON by default and is READ, not written, so the seed's app_config stays as the default seed's was made.
      const judge = await judgeLayer(sc);
      if (judge?.on !== true || judge?.activeSource !== 'llama-cpp' || judge?.activeModel !== TAG_MODEL)
        throw new Error(`${SEED_NAME[seed]}: 判断 reads back ${judge?.on ? 'on' : 'off'} · ${judge?.activeSource} · ${judge?.activeModel}, not on · llama-cpp · ${TAG_MODEL}`);
      const before = { chat: chat(), annotations: recorder.state.annotations };
      if (before.annotations !== 0) throw new Error(`${SEED_NAME[seed]}: ${before.annotations} annotation request(s) before any write`);
      console.log(`  writing ${SEED_NAME[seed]}: 判断 reads back on · llama-cpp · ${TAG_MODEL}${replay ? ', every annotation answered with Claude\'s recorded tags' : ''}; claude stub`);
      const ids = {};
      for (const [i, f] of FIXTURE.facts.entries()) {
        const w = await sc.call('remember_fact', {
          kind: f.kind, topic: f.topic, content: f.content, source: `https://example.test/${f.id}`, confidence: 0.8,
        });
        if (w.result?.ok !== true) throw new Error(`${SEED_NAME[seed]}: ${f.id} → ${JSON.stringify(w.result)}`);
        ids[f.id] = Number(w.result.id);
        process.stdout.write(`\r  ${seed}: writing ${i + 1}/${FIXTURE.facts.length}   `);
      }
      process.stdout.write('\n');
      srv.stop();
      servers.splice(servers.indexOf(srv), 1);
      await until(async () => { try { await fetch(`${srv.base}/api/health`); return false; } catch { return true; } }, 60000);
      // Counted AFTER the server exited (every line it wrote is in its log) and with the router still up (its log queue).
      const cliCalls = cli(), chatCalls = chat();
      const proxied = (await routerProxiedTo(routerLog, TAG_MODEL)) - proxiedBefore;
      recorder.server.closeAllConnections();
      recorder.server.close();
      const records = fs.readFileSync(requestsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const annotations = records.filter((r) => r.kind === 'annotation');
      const n = FIXTURE.facts.length;
      const replies = {
        answered200: annotations.filter((r) => r.status === 200).length,
        replayed: annotations.filter((r) => r.replayed).length,
        cappedAtLength: annotations.filter((r) => r.finish === 'length').length,
        withReasoning: annotations.filter((r) => r.reasoning).length,
        withThinkTag: annotations.filter((r) => /<think>/i.test(r.content ?? '')).length,
        maxCompletionTokens: Math.max(0, ...annotations.map((r) => r.completionTokens ?? 0)),
        medianCompletionTokens: median(annotations.map((r) => r.completionTokens).filter((x) => x != null)),
        eachFactOnce: FIXTURE.facts.every((f) => annotations.filter((r) => r.fact === f.content).length === 1),
      };
      // THE BUILD GUARDS (Run 7): no CLI; one annotation per write, each answered, each through the router's log; every
      // forward seen by the router; the tag seed's annotations all from the model (none replayed), the replay seed's all
      // replayed (none reaching the model); no reasoning returned.
      const guards = {
        noClaudeCli: cliCalls.ok + cliCalls.failed === 0,
        oneAnnotationPerWrite: annotations.length === n && replies.eachFactOnce,
        everyAnnotationAnswered: replies.answered200 === n && recorder.state.failed === 0,
        everyAnnotationThroughTheRouterLog: chatCalls.ok - before.chat.ok === n && chatCalls.failed === 0,
        routerSawEveryForward: proxied === recorder.state.forwarded,
        noOtherChatRequest: recorder.state.other === 0,
        annotatedBy: replay ? replies.replayed === n && recorder.state.forwarded === recorder.state.warms
          : replies.replayed === 0 && recorder.state.forwarded === n + recorder.state.warms,
        noReasoningReturned: replies.withReasoning === 0 && replies.withThinkTag === 0,
      };
      console.log(`  ${seed}: claude-cli ${cliCalls.ok}/${cliCalls.failed} (ok/failed); llama.cpp chat calls in the seed server's log`
        + ` ${chatCalls.ok - before.chat.ok}/${chatCalls.failed} during the writes; annotation requests ${annotations.length}`
        + ` (${replies.answered200} answered 200, ${replies.replayed} replayed, ${replies.cappedAtLength} capped at ${CHAT_MAX_TOKENS},`
        + ` ${replies.withReasoning} with reasoning); warm ${recorder.state.warms}; forwarded ${recorder.state.forwarded} to ${TAG_MODEL},`
        + ` the router proxied ${proxied}`);
      fs.writeFileSync(settingsPath, settingsBefore);
      fs.rmSync(resourcesDir, { recursive: true, force: true });
      settleSeedRepo(data);
      await checkpoint(data);
      const v = verifySeedRows(data, ids, SEED_NAME[seed]);
      return { ids, record: {
        idOf: ids, fixtureHash: FIXTURE_HASH, fixture: FIXTURE_REL, claudeVersion, appHead, appVersion, createdAt: new Date().toISOString(),
        boundModel: TAG_MODEL, annotatedBy: replay ? 'replay of the default seed\'s Claude tags' : `llama-cpp · ${TAG_MODEL}`,
        judge: 'on', startupWarnings, claudeCalls: cliCalls,
        llamaChatCalls: { ok: chatCalls.ok, failed: chatCalls.failed, beforeWrites: before.chat },
        requests: { ...recorder.state, routerProxied: proxied }, replies, guards, rows: v.rows, graphNodes: v.graphNodes,
      } };
    };

    const extraIds = {};
    if (TAG_MODEL && BUILD_TAG) {
      // THE BUILD: the tag seed, then its control, on ONE router launched with the product's chat preset for TAG_MODEL.
      const tagsRoot = seedRootOf('tags');
      fs.rmSync(tagsRoot, { recursive: true, force: true });
      fs.mkdirSync(tagsRoot, { recursive: true });
      await startRouter([], [TAG_MODEL], tagsRoot);
      const claudeHandles = handlesOf(SEED_DATA, seedMeta.idOf);
      const replay = new Map(FIXTURE.facts.map((f) => [f.content, claudeHandles[f.id]]));
      const builtWith = new Date().toISOString();
      const tags = await writeLocalSeed('tags', null);
      const rep = await writeLocalSeed('replay', replay);
      const args = childArgsOf(path.join(tagsRoot, 'router.log'), TAG_MODEL);
      stopRouter();
      // What the two builds share: the one router, its child's launch, the model file.
      const routerGuards = {
        childSpawnedOnce: args.spawns === 1,
        thinkingOffInArgv: args.reasoning === 'off',
        capsInArgv: args.nPredict === String(CHAT_MAX_TOKENS) && args.ctxSize === String(CHAT_CONTEXT_TOKENS),
      };
      const file = path.join(RESOURCES, 'gguf', `${TAG_MODEL}.gguf`);
      const annotator = { source: 'llama-cpp', model: TAG_MODEL, file: rel(file), bytes: fs.statSync(file).size,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        preset: fs.readFileSync(path.join(tagsRoot, 'presets.ini'), 'utf8'), childArgs: args };
      // THE PAIRING PRECONDITIONS: the two new seeds equal beyond the tags; the replay equal to the default seed in
      // everything the tags decide (the same subjects on the same nodes, the same subject edges) — so it differs from it
      // only in the decay clock, which is recorded (which node columns, and the engine's position).
      const tagsVsReplay = compareSeeds(seedDataOf('replay'), rep.ids, seedDataOf('tags'), tags.ids);
      const replayVsDefault = compareSeeds(SEED_DATA, seedMeta.idOf, seedDataOf('replay'), rep.ids);
      const { stats, claude, local } = (() => {
        const c = handlesOf(SEED_DATA, seedMeta.idOf), l = handlesOf(seedDataOf('tags'), tags.ids);
        return { claude: c, local: l, stats: { default: tagStatsOf(c), tags: tagStatsOf(l, c) } };
      })();
      for (const [seed, built] of [['tags', tags], ['replay', rep]]) {
        const guards = { ...built.record.guards, ...routerGuards };
        guards.held = Object.values(guards).every((x) => x === true);
        extraMeta[seed] = { ...built.record, builtWith, annotator, guards, tagsVsReplay, replayVsDefault, stats };
        fs.writeFileSync(seedMetaOf(seed), JSON.stringify(extraMeta[seed], null, 2));
        extraIds[seed] = built.ids;
      }
      fs.writeFileSync(path.join(tagsRoot, 'tags.json'), JSON.stringify(Object.fromEntries(FIXTURE.facts.map((f) =>
        [f.id, { group: groupOf(f.id), claude: claude[f.id], [TAG_MODEL]: local[f.id] }])), null, 2));
      console.log(`  router: ${TAG_MODEL}'s child spawned ${args.spawns}× with --reasoning ${args.reasoning} --n-predict ${args.nPredict}`
        + ` --ctx-size ${args.ctxSize}`);
      console.log(`  tags vs replay: ${JSON.stringify({ ...tagsVsReplay, counts: undefined })}`);
      console.log(`  replay vs default: ${JSON.stringify({ ...replayVsDefault, counts: undefined })}; counts ${JSON.stringify(replayVsDefault.counts)}`);
      const failed = EXTRA_SEEDS.flatMap((s) => Object.entries(extraMeta[s].guards).filter(([k, x]) => k !== 'held' && x !== true).map(([k]) => `${s}.${k}`));
      if (failed.length) throw new Error(`the local-tag seeds FAILED their build guards: ${failed.join(', ')} — see their seed.json and chat-requests.jsonl`);
      mustEqual(tagsVsReplay, ['idsEqual', 'knowledge', 'nodes', 'positions', 'nonSubjectEdges', 'vectors', 'reviews'],
        'the tag seed and the replay seed differ beyond their tags');
      mustEqual(replayVsDefault, ['idsEqual', 'knowledge', 'subjects', 'subjectEdges', 'nonSubjectEdges', 'vectors', 'reviews'],
        'the replay seed does not carry the default seed\'s tags exactly');
      console.log('  local-tag seeds: every guard held; the tag and replay seeds are equal beyond their tags, and the replay carries'
        + ' the default seed\'s tags exactly');
    } else if (TAG_MODEL) {
      // REUSE: re-verified, never trusted — the rows, the pairing preconditions, and that no seed's tags moved.
      for (const seed of EXTRA_SEEDS) {
        const m = extraMeta[seed];
        console.log(`  reusing ${SEED_NAME[seed]} from ${m.createdAt} (built with ${m.builtWith}): ${m.annotatedBy}, 判断 bound to`
          + ` ${m.boundModel}, app ${m.appHead} v${m.appVersion}; its build: ${m.claudeCalls.ok + m.claudeCalls.failed} claude-cli call(s),`
          + ` ${m.requests.annotations} annotation request(s) (${m.replies.replayed} replayed), the router proxied ${m.requests.routerProxied}`);
        settleSeedRepo(seedDataOf(seed));
        await checkpoint(seedDataOf(seed));
        verifySeedRows(seedDataOf(seed), m.idOf, SEED_NAME[seed]);
        extraIds[seed] = m.idOf;
      }
      const tagsVsReplay = compareSeeds(seedDataOf('replay'), extraIds.replay, seedDataOf('tags'), extraIds.tags);
      const replayVsDefault = compareSeeds(SEED_DATA, seedMeta.idOf, seedDataOf('replay'), extraIds.replay);
      if (JSON.stringify(tagsVsReplay) !== JSON.stringify(extraMeta.tags.tagsVsReplay)
        || JSON.stringify(replayVsDefault) !== JSON.stringify(extraMeta.tags.replayVsDefault))
        throw new Error('the local-tag seeds no longer compare as they did when built — rebuild them');
      const stats = { default: tagStatsOf(handlesOf(SEED_DATA, seedMeta.idOf)),
        tags: tagStatsOf(handlesOf(seedDataOf('tags'), extraIds.tags), handlesOf(SEED_DATA, seedMeta.idOf)) };
      if (JSON.stringify(stats) !== JSON.stringify(extraMeta.tags.stats)) throw new Error('the seeds\' tags changed since they were built — rebuild them');
      console.log('  local-tag seeds re-verified: rows, pairing preconditions and tags unchanged since the build');
    }
    if (TAG_MODEL) printTagStats([{ name: 'Claude (default and replay seeds)', stats: extraMeta.tags.stats.default },
      { name: `${TAG_MODEL} (tag seed)`, stats: extraMeta.tags.stats.tags }]);
    const idMapOf = { default: idOf, ...Object.fromEntries(Object.entries(extraIds).map(([s, ids]) => [s, new Map(Object.entries(ids))])) };
    for (const [s, map] of Object.entries(idMapOf)) for (const f of facts) if (!map.has(f.id)) throw new Error(`${SEED_NAME[s]} has no id for fact ${f.id}`);

    if (SEED_ONLY) {
      console.log(`  --seed-only: the seed at ${rel(SEED_ROOT)} (fixture ${FIXTURE_HASH.slice(0, 12)}) is ready`
        + `${TAG_MODEL ? `, and the local-tag seeds at ${rel(seedRootOf('tags'))} and ${rel(seedRootOf('replay'))}` : ''}; no arm was started`);
      return;
    }

    // ---- 2. the local-model arms share ONE real router, started here -----------------------------------------
    // Each arm's own resources get EMPTY stand-ins for the runtime and the model, which is all IsConfigured asks;
    // the arm then ADOPTS this router at GATHERLIGHT_LLAMACPP_URL (EnsureServingAsync probes before it spawns).
    const llamaModels = [...rerankers, ...chatJudges];
    const gpuRouter = llamaModels.length > 0 ? await startRouter(rerankers, chatJudges, WORK) : null;
    /** The preset section a model was launched with, from a router's preset text (Run 8 records it per arm). */
    const sectionOf = (presetText, m) => (presetText.split(/\n(?=\[)/).find((s) => s.startsWith(`[${m}]`)) ?? '').trim();

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
    // Run 8, for a CPU-only arm's record: which fixture note each window came from (a window is a substring of its note,
    // or of the note's NFKC form under a declared window), and the pair tokens as RerankPace counts them — its ONE rule,
    // mirrored here and held to the C# by paceMirror (CJK rate from U+2E80 up, the English rate below it).
    const NOTE_TEXTS = FIXTURE.facts.map((f) => [f.content, f.content.normalize('NFKC')]);
    const notesOf = (docs) => {
      const seen = new Set();
      let unmatched = 0;
      for (const d of docs) {
        const i = NOTE_TEXTS.findIndex(([raw, nfkc]) => raw.includes(d) || nfkc.includes(d));
        if (i < 0) unmatched++; else seen.add(i);
      }
      return { candidates: seen.size, unmatched };
    };
    const tokensOf = (s) => {
      let t = 0;
      for (let i = 0; i < s.length; i++) t += s.charCodeAt(i) >= PACE.cjkFrom ? PACE.cjk : PACE.other;
      return t;
    };
    const pairTokensOf = (q, docs) => { const qt = tokensOf(String(q ?? '')); return docs.reduce((a, d) => a + qt + tokensOf(d), 0); };
    /** A proxy in front of a router. `memo` shares identical accuracy-pass bodies (--rerank-memo). `cpu` (Run 8) is a
     *  CPU-only arm's: never memoised, an abandoned request closed upstream too, and each call's windows, notes, pair
     *  tokens, wall time, status and abandonment recorded. */
    const startProxy = ({ upstreamPort = LLAMA_PORT, memo: useMemo = MEMO, cpu = false } = {}) => new Promise((resolve) => {
      const state = { phase: 'startup', seq: null, records: new Map(), requests: 0, memoHits: 0, forwarded: 0, retried: 0, errors: 0,
        ...(cpu ? { abandoned: 0 } : {}) };
      const once = (req, body, hold = null) => new Promise((ok, fail) => {
        const up = http.request({
          host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, agent: upstream,
          headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}`, 'content-length': body.length, connection: 'close' },
        }, (r) => {
          const out = [];
          r.on('data', (c) => out.push(c));
          r.on('end', () => ok({ status: r.statusCode, headers: r.headers, body: Buffer.concat(out) }));
          r.on('error', (e) => fail(Object.assign(e, { answered: true })));
        });
        if (hold) {
          hold.up = up;
          // The client left before this forward began: never send it.
          if (hold.abandoned) up.destroy(new Error('the client abandoned the request'));
        }
        up.on('error', fail);
        up.end(body);
      });
      // `forwarded` counts /v1/rerank forwards only — every one the router must then log as proxied to its model's child,
      // which is how a lost request is found (Run 6b).
      const forward = async (req, body, hold = null) => {
        if (req.url === '/v1/rerank') state.forwarded++;
        try { return await once(req, body, hold); } catch (e) {
          // A request its client abandoned is neither re-sent nor a delivery failure (Run 8's CPU arms).
          if (hold?.abandoned) throw e;
          if (e.answered) { state.errors++; throw e; }
          state.retried++;
          try { return await once(req, body, hold); } catch (e2) { if (!hold?.abandoned) state.errors++; throw e2; }
        }
      };
      const server = http.createServer((req, res) => {
        const chunks = [];
        // Run 8: when a CPU-only arm's client abandons a request — the verification deadline cancelling it — the upstream
        // request is closed as well, as the product's own connection to the router would be. What the router then does
        // with the batch is llama-server's behaviour, not this proxy's.
        const hold = cpu ? { up: null, abandoned: false } : null;
        if (hold) res.on('close', () => {
          if (res.writableFinished) return;
          hold.abandoned = true;
          if (req.url === '/v1/rerank') state.abandoned++;
          hold.up?.destroy(new Error('the client abandoned the request'));
        });
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          const body = Buffer.concat(chunks);
          const t0 = Date.now();
          let rec = null;
          try {
            let reply;
            if (req.method === 'POST' && req.url === '/v1/rerank' && state.phase === 'accuracy') {
              const hash = crypto.createHash('sha256').update(body).digest('hex');
              let parsed = {};
              try { parsed = JSON.parse(body.toString('utf8')); } catch { /* recorded as unparsed */ }
              const docs = Array.isArray(parsed.documents) ? parsed.documents.map(String) : [];
              const ans = answerOf.get(String(parsed.query ?? ''));
              rec = {
                hash: hash.slice(0, 16), documents: docs.length, maxChars: docs.reduce((m, d) => Math.max(m, d.length), 0),
                answerSent: ans === undefined ? null : docs.some((d) => d.includes(ans) || d.includes(ans.normalize('NFKC'))),
                ...(cpu ? { ...notesOf(docs), pairTokens: pairTokensOf(parsed.query, docs) } : {}),
              };
              state.requests++;
              if (!state.records.has(state.seq)) state.records.set(state.seq, []);
              state.records.get(state.seq).push(rec);
              if (cpu) reply = await forward(req, body, hold);
              else if (useMemo) {
                // ONLY A 2xx IS SHARED. A refusal or a server error is one moment's failure, and memoising it handed the
                // same failure to every later arm sending these bytes — a no-verdict that was never that arm's. So a
                // reply that is not 2xx is evicted when it arrives (a failed forward already was), and a request that
                // joined one still in flight and got a failure back forwards its own once.
                const is2xx = (r) => r.status >= 200 && r.status < 300;
                const shared = memo.get(hash);
                if (shared) state.memoHits++;
                const pending = shared ?? forward(req, body).then(
                  (r) => { if (!is2xx(r) && memo.get(hash) === pending) memo.delete(hash); return r; },
                  (e) => { if (memo.get(hash) === pending) memo.delete(hash); throw e; });
                if (!shared) memo.set(hash, pending);
                reply = await pending;
                if (shared && !is2xx(reply)) { state.memoHits--; reply = await forward(req, body); }
              } else reply = await forward(req, body);
            } else reply = await forward(req, body, hold);
            if (rec && cpu) Object.assign(rec, { ms: Date.now() - t0, status: reply.status, aborted: hold.abandoned });
            const headers = { ...reply.headers, 'content-length': reply.body.length };
            delete headers['transfer-encoding'];
            res.writeHead(reply.status, headers);
            res.end(reply.body);
          } catch (e) {
            if (rec && cpu) Object.assign(rec, { ms: Date.now() - t0, status: null, aborted: hold.abandoned });
            // The client may already be gone (an abandoned request), and then there is no one to answer.
            try {
              res.writeHead(502, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: { code: 502, message: `judge-bench proxy: ${e?.message ?? e}` } }));
            } catch { /* nobody is listening */ }
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
          // Run 8, a CPU-only arm: the notes the windows came from, the pair tokens, the call time, and the abandonment.
          ...(arm.cpu ? {
            candidates: recs.reduce((a, r) => a + r.candidates, 0), unmatched: recs.reduce((a, r) => a + r.unmatched, 0),
            pairTokens: Math.round(recs.reduce((a, r) => a + r.pairTokens, 0) * 100) / 100,
            callMs: recs.reduce((a, r) => a + (r.ms ?? 0), 0), aborted: recs.some((r) => r.aborted === true),
            statuses: recs.map((r) => String(r.status)).join('+'),
          } : {}),
        },
      };
    };

    // ---- 3. one snapshot + one server per arm ----------------------------------------------------------------
    // THE SAME SERVER BINARY FOR EVERY ARM (Run 8). A CPU-only arm's server starts in its own turn, possibly hours after the
    // others, and `dotnet run --no-build` runs whatever is built THEN — so the build is fingerprinted before the first
    // arm, each CPU-only arm refuses to start on a different one, and the fingerprint is saved.
    const binaryDir = path.join(repo, 'src', 'server', 'Gatherlight.Server', 'bin', 'Debug', 'net10.0');
    const binaryPrint = () => Object.fromEntries(['Gatherlight.Platform.dll', 'Gatherlight.Planner.dll', 'Gatherlight.Server.dll'].map((f) => {
      const p = path.join(binaryDir, f);
      return [f, fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16) : null];
    }));
    const serverBinary = binaryPrint();
    // A CPU-only arm (Run 8) is set up later, in its own turn: its router is started fresh just before it, so its server's
    // startup warm reaches the router it will run against, as an app's warm reaches the router it adopted.
    /** Copy the arm's seed, bind its judge, start its proxy and its server; `llamaPort` is the router it talks to. */
    const setupArm = async (arm, i, llamaPort) => {
      arm.dir = path.join(WORK, `arm-${i}`);
      // Each arm starts from ITS seed (Run 7): `<arm>@tags` / `<arm>@replay` from a local-tag seed, the default otherwise.
      if (!idMapOf[arm.seed]) throw new Error(`arm ${arm.key}: no ${arm.seed} seed — pass --tag-seed=<chat model>`);
      arm.idMap = idMapOf[arm.seed];
      fs.cpSync(arm.seed === 'default' ? SEED_DATA : seedDataOf(arm.seed), arm.dir, { recursive: true });
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
        // A CPU-only arm always gets its RECORD-ONLY proxy (never memoised); every other arm one only with --rerank-memo.
        if (arm.cpu) arm.proxy = await startProxy({ upstreamPort: llamaPort, memo: false, cpu: true });
        else if (MEMO) arm.proxy = await startProxy();
        env.GATHERLIGHT_LLAMACPP_URL = `http://127.0.0.1:${arm.proxy ? arm.proxy.port : llamaPort}`;
      }
      arm.port = PORT_BASE + 1 + i;
      arm.srv = startServer({ dataDir: arm.dir, port: arm.port, env });
      servers.push(arm.srv);
    };
    /** Every check an arm passes before it answers a question. */
    const checkArm = async (arm) => {
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
    };
    for (const [i, arm] of arms.entries()) if (!arm.cpu) await setupArm(arm, i, LLAMA_PORT);
    for (const arm of arms) if (!arm.cpu) await checkArm(arm);
    // Which router, and which preset section, each local-model arm ran on (Run 8; a CPU-only arm's is set in its turn).
    for (const arm of arms) if (arm.llamaModel && !arm.cpu && gpuRouter)
      arm.llamaRouter = { kind: 'gpu', port: LLAMA_PORT, preset: sectionOf(gpuRouter.presetText, arm.llamaModel), log: rel(gpuRouter.log) };

    // ---- 4. identical questions, identical SHUFFLED order: every arm in parallel, then each CPU-only arm alone --------
    const { queries, adjacentSameFact } = queryOrder(facts, ORDER_SEED);

    const recall = async (c, x, idMap) => {
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
          error: null, pos: ids.indexOf(idMap.get(x.fact)), ms,
          // The whole page, in order — the fingerprint two arms must share to have given the same verdicts (Run 6b).
          page: ids,
        };
      } catch (e) {
        return { status: null, ranked: null, returned: null, answered: null, error: String(e?.message ?? e), pos: null, ms: Date.now() - t0 };
      }
    };
    /** One arm's accuracy pass: every query, in the run's order. `t0` (when the recall began) lets Run 8 place the
     *  product's own log lines on the recall they belong to. */
    const accuracyPass = async (arm) => {
      const c = makeClient(arm.srv.base);
      arm.rows = [];
      for (const [seq, x] of queries.entries()) {
        if (arm.proxy) arm.proxy.state.seq = seq;
        const t0 = Date.now();
        const result = await recall(c, x, arm.idMap);
        // A CPU-only arm's abandoned call is closed at the proxy a moment after the product gave up on it — its record
        // (time, abandonment) is complete only then.
        if (arm.cpu) await until(() => (arm.proxy.state.records.get(seq) ?? []).every((r) => r.ms !== undefined), 5000, 20).catch(() => {});
        const row = { arm: arm.key, pass: 'accuracy', seq, ...x, ...result, ...rerankOf(arm, seq), t0 };
        arm.rows.push(row);
        emit(row);
      }
    };

    const parallel = arms.filter((a) => !a.cpu);
    for (const arm of parallel) if (arm.proxy) arm.proxy.state.phase = 'accuracy';
    await Promise.all(parallel.map(accuracyPass));
    for (const arm of parallel) if (arm.proxy) arm.proxy.state.phase = 'latency';
    for (const arm of parallel) {
      arm.routerAccuracy = routerOutcomes(arm.dir);
      if (arm.chatJudge) arm.localAccuracy = routerOutcomes(arm.dir, LLAMA_CHAT_PROVIDER);
    }

    // ---- 5. serial latency: one arm at a time, nothing else querying (mutates state — accuracy is already in) -
    // A CPU-only arm has none: its accuracy pass, next, is already serial. This pass runs FIRST, so the arms above are
    // finished before any CPU-only arm starts, and nothing of theirs runs beside one.
    const sample = queries.slice(0, Math.min(LATENCY_SAMPLE, queries.length));
    for (const arm of parallel) {
      const c = makeClient(arm.srv.base);
      arm.latencyRows = [];
      for (const [seq, x] of sample.entries()) {
        const row = { arm: arm.key, pass: 'latency', seq, ...x, ...(await recall(c, x, arm.idMap)) };
        arm.latencyRows.push(row);
        emit(row);
      }
      arm.routerTotal = routerOutcomes(arm.dir);
      if (arm.chatJudge) arm.localTotal = routerOutcomes(arm.dir, LLAMA_CHAT_PROVIDER);
    }

    // RUN 8: each CPU-only arm ALONE — a fresh CPU-only router of its own, its own server, nothing else querying — so what
    // the pace learns is this machine's CPU and not another arm's load. Its router is killed when the arm is done:
    // llama-server keeps scoring a batch whose request was abandoned, and the next arm must not inherit that queue.
    const LOG_LINE = /^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3})\] \[(\w+)\s*\] \[([^\]]*)\] (.*)$/;
    const PACE_SIZED = /(\d+) window\(s\) per long candidate instead of (\d+), so the call fits ~([\d.]+) s at the ([\d.]+) ms per 1,000 pair tokens/;
    const PACE_AFTER_CUT = /(\d+) window\(s\) per long candidate instead of (\d+), until a call answers in time.*? slower than ([\d.]+) ms per 1,000 pair tokens/;
    // 2026-09-25: one window each, past the budget a SIZED call has but inside the limit a one-window call is sent under —
    // the fewest that scores every candidate, sent as it is.
    const PACE_FEWEST = /(\d+) window\(s\) per long candidate instead of (\d+), the fewest that scores every candidate: predicted at ~([\d.]+) s at the ([\d.]+) ms per 1,000 pair tokens measured here/;
    // The pace's SKIP (2026-09-25): nothing sent, NoOpinion at once — with the probe's reading when one was sent, and the
    // presumed queue behind an abandoned call when there was one. And the probe that let the judge run.
    const PACE_SKIP = /0 window\(s\) per (?:long )?candidate instead of (\d+)(?: \(none is long\))? — the judge is skipped for this recall: (?:a probe of (\d+) of (\d+) .*?; )?one window per candidate is predicted at ~([\d.]+) s at the ([\d.]+) ms per 1,000 pair tokens measured here(?:, behind the ~([\d.]+) s the router is presumed still busy)?/;
    const PACE_REMEASURED = /re-measured this machine on (\d+) of (\d+) candidates' first windows: ([\d.]+) ms per 1,000 pair tokens/;
    const DEADLINE = /memory verification gave no verdict within [\d.]+ s/;
    /** The product's own log lines, placed on the recall during which each was written (by timestamp): the deadline cut
     *  (VerificationDeadlinePolicy's Warning) and the pace's lines (ChunkedScoreProvider's and RerankAdmission's
     *  Information, every form). */
    const attachCpuEvents = (arm) => {
      const events = [];
      for (const line of readLogs(arm.dir).split(/\r?\n/)) {
        const m = LOG_LINE.exec(line);
        if (!m) continue;
        const at = new Date(`${m[1]}T${m[2]}`).getTime();
        let p;
        if ((p = PACE_SIZED.exec(m[5]))) events.push({ at, kind: 'sized', windows: +p[1], byCount: +p[2], budgetS: +p[3], msPer1k: +p[4] });
        else if ((p = PACE_AFTER_CUT.exec(m[5]))) events.push({ at, kind: 'afterCut', windows: +p[1], byCount: +p[2], msPer1k: +p[3] });
        else if ((p = PACE_FEWEST.exec(m[5]))) events.push({ at, kind: 'fewest', windows: +p[1], byCount: +p[2], predictedS: +p[3], msPer1k: +p[4] });
        else if ((p = PACE_SKIP.exec(m[5]))) events.push({ at, kind: 'skip', byCount: +p[1], ...(p[2] ? { probed: +p[2], of: +p[3] } : {}),
          predictedS: +p[4], msPer1k: +p[5], ...(p[6] ? { queueS: +p[6] } : {}) });
        else if ((p = PACE_REMEASURED.exec(m[5]))) events.push({ at, kind: 'remeasured', probed: +p[1], of: +p[2], msPer1k: +p[3] });
        else if (DEADLINE.test(m[5])) events.push({ at, kind: 'deadline' });
      }
      for (const row of arm.rows) { row.deadlineCut = false; row.pace = null; row.skip = null; row.remeasured = null; }
      let unplaced = 0, doubled = 0;
      // The recalls ran back to back, so a line belongs to the LAST recall that had begun when it was written — the next
      // one's pace line can come within 10 ms of the previous recall's end (the smoke's did), so no slack after a recall
      // may be given to it. A line written more than a second after that recall ended belongs to none.
      const byStart = [...arm.rows].sort((a, b) => a.t0 - b.t0);
      for (const e of events) {
        const row = byStart.filter((r) => r.t0 <= e.at).at(-1);
        if (!row || e.at > row.t0 + row.ms + 1000) { unplaced++; continue; }
        if (e.kind === 'deadline') { if (row.deadlineCut) doubled++; row.deadlineCut = true; continue; }
        // A skipped recall and a re-measured one each carry their own line, apart from the sizing line the same recall
        // may also log after a probe let it run.
        if (e.kind === 'skip' || e.kind === 'remeasured') {
          const { at: _at, kind, ...rest } = e;
          if (row[kind]) doubled++;
          row[kind] = rest;
          continue;
        }
        if (row.pace) doubled++;
        row.pace = { kind: e.kind, windows: e.windows, byCount: e.byCount, msPer1k: e.msPer1k, ...(e.budgetS !== undefined ? { budgetS: e.budgetS } : {}),
          ...(e.predictedS !== undefined ? { predictedS: e.predictedS } : {}) };
      }
      return { deadlineLines: events.filter((e) => e.kind === 'deadline').length, paceLines: events.filter((e) => e.kind !== 'deadline').length,
        unplaced, doubled };
    };
    /** A CPU-only router's own record, from its log: how its child was launched, how many threads, what it scored, and
     *  every abandoned request it noticed. */
    const cpuRouterRecord = (logFile, model) => {
      const text = fs.readFileSync(logFile, 'utf8');
      const lines = text.split(/\r?\n/);
      const spawns = [];
      for (let i = 0; i < lines.length; i++) {
        const m = /spawning server instance with name=(\S+) on port (\d+)/.exec(lines[i]);
        if (!m || m[1] !== model) continue;
        const args = [];
        for (let j = i + 2; j < lines.length && /load:\s{2,}\S/.test(lines[j]) && !/spawning/.test(lines[j]); j++) args.push(lines[j].replace(/^.*load:\s+/, '').trim());
        spawns.push(args);
      }
      const a = spawns[0] ?? null;
      const val = (...ks) => { for (const k of ks) if (a && a.includes(k)) return a[a.indexOf(k) + 1]; return null; };
      let tasks = 0, maxTaskTokens = 0, truncated = 0;
      for (const m of text.matchAll(/stop processing: n_tokens = (\d+), truncated = (\d)/g)) { tasks++; maxTaskTokens = Math.max(maxTaskTokens, +m[1]); truncated += +m[2]; }
      const level = (l) => /\d+\.\d+\.\d+\.\d+ ([IWE]) /.exec(l)?.[1] ?? null;
      return {
        spawns: spawns.length, childArgs: a, device: val('--device', '-dev'), nGpuLayers: val('--n-gpu-layers', '-ngl', '--gpu-layers'),
        nThreads: Number(/n_threads = (\d+)/.exec(text)?.[1]) || null,
        tasks, maxTaskTokens, truncated,
        cancelled: (text.match(/Connection handling canceled/g) ?? []).length,
        errorLines: lines.filter((l) => level(l) === 'E' && !/Connection handling canceled/.test(l)).length,
        vulkanLines: lines.filter((l) => /vulkan/i.test(l)).length,
      };
    };
    let cpuSlot = 0;
    for (const [i, arm] of arms.entries()) {
      if (!arm.cpu) continue;
      if (JSON.stringify(binaryPrint()) !== JSON.stringify(serverBinary))
        throw new Error(`arm ${arm.key}: the server binary changed since the run began (${JSON.stringify(serverBinary)} → ${JSON.stringify(binaryPrint())}) — its arms would not run one build`);
      const port = CPU_LLAMA_PORT + cpuSlot++;
      const startedAt = new Date().toISOString();
      console.log(`  ${arm.key}: its own CPU-only router on ${port}, then its server — ${queries.length} recalls, alone`);
      const r = await startRouter([arm.reranker], [], WORK, { cpu: true, port, tag: `-cpu-${i}` });
      arm.llamaRouter = { kind: 'cpu', port, preset: sectionOf(r.presetText, arm.reranker), log: rel(r.log) };
      await setupArm(arm, i, port);
      await checkArm(arm);
      arm.proxy.state.phase = 'accuracy';
      const accuracyFrom = new Date().toISOString();
      await accuracyPass(arm);
      arm.proxy.state.phase = 'done';
      const accuracyTo = new Date().toISOString();
      arm.routerAccuracy = routerOutcomes(arm.dir);
      // No latency pass: the accuracy pass WAS the serial one (header, CPU-ONLY ARMS).
      arm.routerTotal = arm.routerAccuracy;
      arm.latencyRows = [];
      const events = attachCpuEvents(arm);
      // Reconciled with its OWN router's log, before that router goes (it logs through a queue).
      arm.cpuProxied = await routerProxiedTo(r.log, arm.reranker);
      arm.cpuRecord = { ...cpuRouterRecord(r.log, arm.reranker), port, startedAt, accuracyFrom, accuracyTo, events };
      killTree(r.child);
      await until(async () => { try { await fetch(`http://127.0.0.1:${port}/v1/models`); return false; } catch { return true; } }, 30000).catch(() => {});
      console.log(`  ${arm.key}: ${arm.rows.filter((x) => x.answered !== null).length}/${arm.rows.length} with a verdict, `
        + `${arm.rows.filter((x) => x.deadlineCut).length} cut by the deadline, ${events.paceLines} pace line(s); router on ${port} stopped`);
    }

    // THE PACE GUARD: how many rerank calls the pace sized below the count ceiling, per arm, over both passes.
    for (const arm of arms) arm.paceCuts = paceCutsIn(arm.dir);

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
      // The local-tag seeds (Run 7): what made each, its build guards, how the seeds compare, the tag statistics.
      ...(TAG_MODEL ? {
        tagSeed: {
          model: TAG_MODEL, annotator: extraMeta.tags.annotator, builtWith: extraMeta.tags.builtWith,
          ...Object.fromEntries(EXTRA_SEEDS.map((s) => {
            const { idOf: _ids, annotator: _a, stats: _s, tagsVsReplay: _t, replayVsDefault: _r, ...record } = extraMeta[s];
            return [s, { folder: rel(seedRootOf(s)), ...record }];
          })),
          tagsVsReplay: extraMeta.tags.tagsVsReplay, replayVsDefault: extraMeta.tags.replayVsDefault, stats: extraMeta.tags.stats,
        },
      } : {}),
      order: { seed: ORDER_SEED, queries: queries.length, adjacentSameFact },
      // The arms that ran in PARALLEL; the CPU-only arms (Run 8) ran one at a time after them.
      concurrency: parallel.length,
      ...(arms.some((a) => a.cpu) ? { cpuSerial: arms.filter((a) => a.cpu).map((a) => a.key), serverBinary } : {}),
      latencySample: sample.length,
      arms: arms.map((a) => ({
        key: a.key, label: a.label, enrichment: a.enrichment, judgeInput: a.judgeInput ?? null, reranker: a.reranker ?? null,
        chatJudge: a.chatJudge ?? null, seed: a.seed,
        knobs: a.pinned, judgeOn: a.judgeOn, judgeSource: a.judgeSource, judgeModel: a.judgeModel,
        migrationWarnings: a.migrationWarnings,
        router: { startup: a.routerStartup, accuracy: a.routerAccuracy, total: a.routerTotal },
        ...(a.chatJudge ? { localRouter: { startup: a.localStartup, accuracy: a.localAccuracy, total: a.localTotal } } : {}),
        // Run 8: the llama.cpp router and preset section each local-model arm ran on; a CPU-only arm's own router record.
        ...(a.llamaRouter ? { llamaRouter: a.llamaRouter } : {}),
        ...(a.cpu ? { cpu: true, cpuRecord: a.cpuRecord ?? null } : {}),
      })),
      ...(arms.some((a) => a.proxy) ? {
        rerankProxy: {
          memo: MEMO,
          arms: Object.fromEntries(arms.filter((a) => a.proxy).map((a) => [a.key, {
            requests: a.proxy.state.requests, memoHits: a.proxy.state.memoHits,
            // Every forward to the router, all passes and startup included; retried = a connection-level failure retried
            // once; errors = a forward that still failed, which the arm read as a 502.
            forwarded: a.proxy.state.forwarded, retried: a.proxy.state.retried, errors: a.proxy.state.errors,
            // A CPU-only arm's (Run 8): never memoised; the requests its client abandoned; and what its OWN router proxied.
            ...(a.cpu ? { memo: false, abandoned: a.proxy.state.abandoned, routerProxied: a.cpuProxied ?? null } : {}),
          }])),
          routerProxied,
        },
      } : {}),
      // The pace guard's counts (header) — only when a reranker ran, the only arms a pace exists for.
      ...(arms.some((a) => a.reranker) ? { rerankPace: Object.fromEntries(arms.map((a) => [a.key, a.paceCuts])) } : {}),
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
