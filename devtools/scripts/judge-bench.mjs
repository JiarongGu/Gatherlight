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
// on found@8 hits: against `content` and against `formula` when they ran, every reranker against every other,
// and against `--baseline=<results.json>:<arm>` from another run. Each comparison reports McNemar's exact p, the
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
// PRIVACY. The fixture is invented and committed; this touches no household data. Reranker arms READ the
// llama.cpp binary and GGUFs from --resources (default local/state/resources) and nothing else there.
//
// Usage:
//   node devtools/dev.mjs judge-bench                     # formula, formula2, topic, content, content2, contentonly, fuse
//   node devtools/dev.mjs judge-bench --arms=formula,content --n=20 --reuse-seed
//   node devtools/dev.mjs judge-bench --arms=formula --rerankers=LAMAR-600m.Q5_K_M,bge-reranker-v2-m3-Q5_K_M
//   node devtools/dev.mjs judge-bench --report-only=devtools/_judge-bench/results-<iso>.json [--baseline=…]
//   node devtools/dev.mjs judge-bench --reuse-seed --arms=formula,rr… --baseline=devtools/_judge-bench/results-<iso>.json:content
// Flags: --arms= --rerankers= --n= --port-base= --llama-port= --resources= --seed= --latency-sample=
//        --reuse-seed | --reseed   --report-only=<results.json | rows-*.jsonl>   --baseline=<results.json>:<arm>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { makeTestData, startServer, waitHealthy, makeClient, until, repo, git } from './e2e/_e2e-common.mjs';
import { resolveClaude, QUESTION_SETS } from './recall-questions.mjs';

// ---- flags: known ones only ------------------------------------------------------------------------------
const VALUED = ['arms', 'rerankers', 'n', 'port-base', 'llama-port', 'resources', 'seed', 'latency-sample', 'report-only', 'baseline'];
const BOOLEAN = ['reuse-seed', 'reseed'];
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
  const extra = Object.keys(opts).filter((k) => k !== 'report-only' && k !== 'baseline');
  if (extra.length > 0) die(`--report-only re-analyses a saved run and takes only --baseline — drop ${extra.map((k) => `--${k}`).join(' ')}`);
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

const FIXTURE_PATH = path.join(repo, 'devtools', 'fixtures', 'recall-bilingual.json');
const FIXTURE_BYTES = fs.readFileSync(FIXTURE_PATH);
const FIXTURE = JSON.parse(FIXTURE_BYTES.toString('utf8'));
const FIXTURE_HASH = crypto.createHash('sha256').update(FIXTURE_BYTES).digest('hex');
const LIMIT = 8;
const PORT_BASE = int('port-base', 5620, 1);
const LLAMA_PORT = int('llama-port', 5660, 1);
const ORDER_SEED = int('seed', 12345, 0);
const LATENCY_SAMPLE = int('latency-sample', 12, 0);
const REUSE_SEED = opts['reuse-seed'] === true;
const RESEED = opts.reseed === true;
const WORK = path.join(repo, 'devtools', '_judge-bench');
const SEED_ROOT = path.join(repo, 'devtools', '_judge-bench-seed');
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
const PINNED = { GATHERLIGHT_JUDGE_INPUT: '', GATHERLIGHT_VERDICT_COMBINATION: '' };
const ARMS = {
  formula: { label: '公式 · no verification (seed tags present)', enrichment: false, env: {} },
  formula2: { label: '公式 · no verification · A/A twin', enrichment: false, env: {} },
  topic: { label: 'Claude judge · topic only', enrichment: true, judgeInput: 'headline',
    env: { GATHERLIGHT_JUDGE_INPUT: 'headline' }, knob: /judge input = headline \(/ },
  content: { label: 'Claude judge · topic — content · partition', enrichment: true, judgeInput: 'both', env: {} },
  content2: { label: 'Claude judge · topic — content · partition · A/A twin', enrichment: true, judgeInput: 'both', env: {} },
  // How Lyntai's upcoming LlmVerificationOptions.ContentChars renders a candidate: content ALONE (Part 276 / D170).
  contentonly: { label: 'Claude judge · content only · partition', enrichment: true, judgeInput: 'content',
    env: { GATHERLIGHT_JUDGE_INPUT: 'content' }, knob: /judge input = content \(/ },
  fuse: { label: 'Claude judge · topic — content · fuse', enrichment: true, judgeInput: 'both',
    env: { GATHERLIGHT_VERDICT_COMBINATION: 'fuse' }, knob: /verdict combination = Fuse/ },
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
const routerOutcomes = (dataDir) => {
  let ok = 0, failed = 0;
  for (const line of readLogs(dataDir).split('\n')) {
    if (/router: claude-cli .*→ Ok/.test(line)) ok++;
    else if (/router: claude-cli .*→ (?!Ok)/.test(line)) failed++;
  }
  return { ok, failed };
};
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
    const known = ARMS[a.key] ?? {};
    return {
      key: a.key,
      label: a.label ?? known.label ?? a.key,
      enrichment: a.enrichment ?? known.enrichment ?? Boolean(a.reranker),
      judgeInput: a.judgeInput ?? known.judgeInput ?? null,
      reranker: a.reranker ?? null,
      knobs: a.knobs ?? null,
      judgeOn: a.judgeOn ?? null, judgeSource: a.judgeSource ?? null, judgeModel: a.judgeModel ?? null,
      migrationWarnings: a.migrationWarnings ?? null,
      router: a.router ?? null,
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
const pairedTest = (arm, baseArm, set) => {
  const baseBySeq = new Map(baseArm.rows.map((r) => [r.seq, r]));
  const out = { pairs: 0 };
  const counts = Object.fromEntries(Object.keys(HITS).map((k) => [k, { b: 0, c: 0 }]));
  for (const r of arm.rows.filter(inSet(set))) {
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
/** What an arm key means, when nothing else recorded it: the arm table, or a reranker key's own shape. */
const armConfigFor = (key) => {
  if (ARMS[key]) return { label: ARMS[key].label, enrichment: ARMS[key].enrichment, judgeInput: ARMS[key].judgeInput ?? null, reranker: null };
  const m = /^(rrf?):(.+)$/.exec(key);
  if (m) return { label: `reranker ${m[2]} · ${m[1] === 'rrf' ? 'fuse' : 'partition'}`, enrichment: true, judgeInput: null, reranker: m[2] };
  return { label: key, enrichment: null, judgeInput: null, reranker: null };
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
    ...run.meta, fixture: 'devtools/fixtures/recall-bilingual.json',
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
  for (const m of rerankers) {
    arms.push({ key: `rr:${m}`, label: `reranker ${m} · partition`, enrichment: true, env: {}, reranker: m });
    arms.push({ key: `rrf:${m}`, label: `reranker ${m} · fuse`, enrichment: true,
      env: { GATHERLIGHT_VERDICT_COMBINATION: 'fuse' }, knob: /verdict combination = Fuse/, reranker: m });
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

  const claude = resolveClaude();
  // shell:false always. A .cmd cannot be spawned directly (Node refuses since the batch-file CVE fix), so it goes
  // through cmd.exe explicitly; anything that still yields no version is recorded as unknown WITH the reason.
  const claudeVersion = (() => {
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
    stopRouter();
  };

  try {
    // ---- 0. per-run cleanup: the arm folders only; earlier rows-*.jsonl and results-*.json are kept ----------
    fs.mkdirSync(WORK, { recursive: true });
    for (const e of fs.readdirSync(WORK)) if (/^arm-\d+$/.test(e)) fs.rmSync(path.join(WORK, e), { recursive: true, force: true });
    const ROWS = path.join(WORK, `rows-${RUN_STAMP}.jsonl`);
    const emit = (row) => fs.appendFileSync(ROWS, JSON.stringify({ run: RUN_AT, ...row }) + '\n');

    // ---- 1. seed ONE folder (real CLI, so annotation writes subject tags) — or reuse the last one --------------
    if (seedMeta) {
      const madeBy = seedMeta.appHead ? `${seedMeta.appHead} v${seedMeta.appVersion}` : 'unrecorded (the seed predates the field)';
      console.log(`  reusing seed from ${seedMeta.createdAt}: annotated by ${seedMeta.claudeVersion ?? 'unrecorded'},`
        + ` made by app ${madeBy} — now running app ${appHead} v${appVersion}`);
      settleSeedRepo(SEED_DATA);
      await checkpoint(SEED_DATA);
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
      settleSeedRepo(SEED_DATA);
      await checkpoint(SEED_DATA);
      seedMeta = { idOf: ids, fixtureHash: FIXTURE_HASH, claudeVersion, appHead, appVersion, createdAt: new Date().toISOString() };
      fs.writeFileSync(SEED_META, JSON.stringify(seedMeta, null, 2));
    }
    const idOf = new Map(Object.entries(seedMeta.idOf));
    for (const f of facts) if (!idOf.has(f.id)) throw new Error(`seed has no id for fact ${f.id}`);

    // ---- 2. the reranker arms share ONE real router, started here -------------------------------------------
    // Each arm's own resources get EMPTY stand-ins for the runtime and the model, which is all IsConfigured asks;
    // the arm then ADOPTS this router at GATHERLIGHT_LLAMACPP_URL (EnsureServingAsync probes before it spawns).
    if (rerankers.length > 0) {
      const exe = path.join(RESOURCES, 'llama-cpp', 'llama-server.exe');
      const gguf = path.join(RESOURCES, 'gguf');
      if (!fs.existsSync(exe)) throw new Error(`no llama-server at ${exe} — download llama.cpp in 资源 first`);
      // Both layouts ResourceProvisioner.InstalledGgufIds reads: flat gguf/<m>.gguf, or gguf/<m>/<any>.gguf
      // (how 资源 installs them). The router takes the models dir either way and names both by <m>.
      const installed = (m) => fs.existsSync(path.join(gguf, `${m}.gguf`))
        || (fs.existsSync(path.join(gguf, m)) && fs.statSync(path.join(gguf, m)).isDirectory()
          && fs.readdirSync(path.join(gguf, m)).some((f) => f.toLowerCase().endsWith('.gguf')));
      for (const m of rerankers)
        if (!installed(m)) throw new Error(`${m} is in neither ${gguf}/${m}.gguf nor ${gguf}/${m}/*.gguf — download it in 资源 first`);
      const preset = path.join(WORK, 'presets.ini');
      fs.writeFileSync(preset, rerankers.map((m) =>
        `[${m}]\nn-gpu-layers = 99\nreranking = true\nctx-size = 4096\nbatch-size = 4096\nubatch-size = 4096\n`).join('\n'));
      const logFd = fs.openSync(path.join(WORK, 'router.log'), 'w');
      router = spawn(exe, ['--models-dir', gguf, '--models-preset', preset, '--models-max', String(Math.max(2, rerankers.length)),
        '--host', '127.0.0.1', '--port', String(LLAMA_PORT)], { cwd: path.dirname(exe), stdio: ['ignore', logFd, logFd] });
      fs.closeSync(logFd);
      await until(async () => (await fetch(`http://127.0.0.1:${LLAMA_PORT}/v1/models`)).ok, 60000);
    }

    // ---- 3. one snapshot + one server per arm ----------------------------------------------------------------
    for (const [i, arm] of arms.entries()) {
      arm.dir = path.join(WORK, `arm-${i}`);
      fs.cpSync(SEED_DATA, arm.dir, { recursive: true });
      fs.rmSync(path.join(arm.dir, 'state', 'logs'), { recursive: true, force: true });
      const env = { GATHERLIGHT_CLAUDE_CMD: claude, ...arm.pinned };
      if (arm.reranker) {
        const res = path.join(arm.dir, 'state', 'resources');
        fs.mkdirSync(path.join(res, 'llama-cpp'), { recursive: true });
        fs.mkdirSync(path.join(res, 'gguf'), { recursive: true });
        fs.writeFileSync(path.join(res, 'llama-cpp', 'llama-server.exe'), '');
        // Flat is enough here: InstalledGgufIds names a flat file by its stem, the same id as the nested layout.
        fs.writeFileSync(path.join(res, 'gguf', `${arm.reranker}.gguf`), '');
        const settingsPath = path.join(arm.dir, 'state', 'settings.json');
        const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
        settings.memory = { ...(settings.memory ?? {}), judgeSource: 'llama-cpp', judgeModel: arm.reranker };
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        env.GATHERLIGHT_LLAMACPP_URL = `http://127.0.0.1:${LLAMA_PORT}`;
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
      const startupCalls = arm.routerStartup.ok + arm.routerStartup.failed;
      if (startupCalls > 0)
        throw new Error(`arm ${arm.key}: ${startupCalls} claude-cli call(s) at startup — the arm re-derived something `
          + '(e.g. a fact-index layout rebuild) and no longer starts from the seed; pass --reseed');
      const c = makeClient(arm.srv.base);
      // NON-VACUITY: an arm whose knob or binding did not take would silently duplicate another arm.
      const log = arm.srv.log();
      const announced = log.split(/\r?\n/).filter((l) => l.includes('[measurement]'));
      if (arm.knob && !arm.knob.test(log)) throw new Error(`arm ${arm.key}: its knob did not announce itself`);
      if (!arm.knob && announced.length > 0) throw new Error(`arm ${arm.key}: sets no knob, yet the server printed: ${announced.join(' | ')}`);
      arm.migrationWarnings = (await c.getJson('/api/migration/status')).warnings ?? [];
      if (arm.reranker) {
        const judge = await judgeLayer(c);
        if (judge?.activeSource !== 'llama-cpp' || judge?.activeModel !== arm.reranker)
          throw new Error(`arm ${arm.key}: judge is running ${judge?.activeSource} · ${judge?.activeModel}, not llama-cpp · ${arm.reranker}`);
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
        };
      } catch (e) {
        return { status: null, ranked: null, returned: null, answered: null, error: String(e?.message ?? e), pos: null, ms: Date.now() - t0 };
      }
    };

    await Promise.all(arms.map(async (arm) => {
      const c = makeClient(arm.srv.base);
      arm.rows = [];
      for (const [seq, x] of queries.entries()) {
        const row = { arm: arm.key, pass: 'accuracy', seq, ...x, ...(await recall(c, x)) };
        arm.rows.push(row);
        emit(row);
      }
    }));
    for (const arm of arms) arm.routerAccuracy = routerOutcomes(arm.dir);

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
    }

    // ---- 6. SAVE the run, THEN analyse exactly what was saved — the path --report-only takes later -----------
    // Saving first is what makes an analysis bug cheap: the rows of an hour-long run are on disk before a single
    // table is computed, so a throw below costs a re-analysis, not a re-run.
    const saved = {
      format: 3,
      fixture: 'devtools/fixtures/recall-bilingual.json', fixtureHash: FIXTURE_HASH, facts: N, limit: LIMIT, at: RUN_AT,
      claudeVersion, appHead, appVersion,
      seedFolder: {
        fixtureHash: seedMeta.fixtureHash, createdAt: seedMeta.createdAt, claudeVersion: seedMeta.claudeVersion,
        appHead: seedMeta.appHead ?? null, appVersion: seedMeta.appVersion ?? null, reused: REUSE_SEED,
      },
      order: { seed: ORDER_SEED, queries: queries.length, adjacentSameFact },
      concurrency: arms.length,
      latencySample: sample.length,
      arms: arms.map((a) => ({
        key: a.key, label: a.label, enrichment: a.enrichment, judgeInput: a.judgeInput ?? null, reranker: a.reranker ?? null,
        knobs: a.pinned, judgeOn: a.judgeOn, judgeSource: a.judgeSource, judgeModel: a.judgeModel,
        migrationWarnings: a.migrationWarnings,
        router: { startup: a.routerStartup, accuracy: a.routerAccuracy, total: a.routerTotal },
      })),
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
