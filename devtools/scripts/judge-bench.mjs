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
//     equivalent state, which is the precondition for comparing anything ACROSS runs.
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
// HOW TO READ IT. Every arm answers the same queries, so arms are compared PAIRED, per query: McNemar's exact
// test on top-1 hits and on found@8 hits, against `content` and against `formula` when they ran. A difference
// is a FINDING when its paired p < 0.05 AND its direction agrees across the question sets. The A/A twins —
// `formula2` beside `formula` (no model in the loop) and `content2` beside `content` (the LLM's verdicts vary
// run to run) — are the SANITY CHECK that the test stays quiet on no effect: an A/A pair must show p ≥ 0.05,
// and if it does not, the run is suspect (it is flagged as a WARNING).
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
// Flags: --arms= --rerankers= --n= --port-base= --llama-port= --resources= --seed= --latency-sample=
//        --reuse-seed | --reseed
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { makeTestData, startServer, waitHealthy, makeClient, until, repo, git } from './e2e/_e2e-common.mjs';
import { resolveClaude, QUESTION_SETS } from './recall-questions.mjs';

// ---- flags: known ones only ------------------------------------------------------------------------------
const VALUED = ['arms', 'rerankers', 'n', 'port-base', 'llama-port', 'resources', 'seed', 'latency-sample'];
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

// A deterministic stride sample, so --n=20 covers every cluster rather than the first twenty rows.
const all = FIXTURE.facts.filter((f) => f.questions);
const N = Math.min(int('n', all.length, 1), all.length);
const stride = all.length / N;
const facts = Array.from({ length: N }, (_, i) => all[Math.floor(i * stride)]);

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

// ---- the seed decision, before anything is started or deleted ------------------------------------------------
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

const claude = resolveClaude();
// shell:false always. A .cmd cannot be spawned directly (Node refuses since the batch-file CVE fix), so it goes
// through cmd.exe explicitly; anything that still yields no version is recorded as unknown WITH the reason.
const claudeVersion = (() => {
  const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(claude);
  const r = viaCmd
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `""${claude}" --version"`], { encoding: 'utf8', shell: false, windowsVerbatimArguments: true })
    : spawnSync(claude, ['--version'], { encoding: 'utf8', shell: false });
  const out = (r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
  if (r.status === 0 && out) return out;
  return `unknown (${r.error ? (r.error.code ?? r.error.message) : `exit ${r.status}`} running ${viaCmd ? 'cmd.exe /c ' : ''}${claude} --version)`;
})();
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

// McNemar, exact: of the b + c DISCORDANT queries, is a b/c split this uneven plausible under a fair coin?
// Two-sided binomial p = min(1, 2 · Σ_{k ≤ min(b,c)} C(b+c, k) · 0.5^(b+c)), summed in LOG space so a few
// hundred discordant pairs cannot underflow or overflow.
const mcnemarP = (b, c) => {
  const n = b + c;
  if (n === 0) return 1;
  let logTerm = -n * Math.LN2;
  let sum = Math.exp(logTerm);
  for (let k = 0; k < Math.min(b, c); k++) {
    logTerm += Math.log((n - k) / (k + 1));
    sum += Math.exp(logTerm);
  }
  return Math.min(1, 2 * sum);
};

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
  // ---- 0. per-run cleanup: the arm folders only; earlier rows-*.jsonl and results-*.json are kept ------------
  fs.mkdirSync(WORK, { recursive: true });
  for (const e of fs.readdirSync(WORK)) if (/^arm-\d+$/.test(e)) fs.rmSync(path.join(WORK, e), { recursive: true, force: true });
  const ROWS = path.join(WORK, `rows-${RUN_STAMP}.jsonl`);
  const emit = (row) => fs.appendFileSync(ROWS, JSON.stringify({ run: RUN_AT, ...row }) + '\n');

  // ---- 1. seed ONE folder (real CLI, so annotation writes subject tags) — or reuse the last one ----------------
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
    for (const rel of ['state/settings.json', 'household/people.md'])
      if (!fs.existsSync(path.join(SEED_DATA, rel))) throw new Error(`make-test-data left no ${rel} in ${SEED_DATA}`);
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

  // ---- 2. the reranker arms share ONE real router, started here ---------------------------------------------
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

  // ---- 3. one snapshot + one server per arm ------------------------------------------------------------------
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

  // ---- 4. identical questions, identical SHUFFLED order, every arm in parallel --------------------------------
  const queries = facts.flatMap((f) => QUESTION_SETS.map((s) => ({ fact: f.id, set: s.key, q: f.questions[s.key] })));
  const rand = mulberry32(ORDER_SEED);
  for (let i = queries.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [queries[i], queries[j]] = [queries[j], queries[i]];
  }
  // Deterministic repair: a fact's questions are never adjacent (pull a later, different fact forward).
  for (let i = 1; i < queries.length; i++) {
    if (queries[i].fact !== queries[i - 1].fact) continue;
    const j = queries.findIndex((x, k) => k > i && x.fact !== queries[i - 1].fact);
    if (j > 0) [queries[i], queries[j]] = [queries[j], queries[i]];
  }
  const adjacentSameFact = queries.filter((x, i) => i > 0 && x.fact === queries[i - 1].fact).length;

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

  // ---- 5. serial latency: one arm at a time, nothing else querying (mutates state — accuracy is already in) ---
  // A judge arm's median counts only recalls that carried a verdict when graph-ranked: a failed-open recall
  // skips the judge, is fast, and would make a broken judge look cheap.
  const sample = queries.slice(0, Math.min(LATENCY_SAMPLE, queries.length));
  for (const arm of arms) {
    const c = makeClient(arm.srv.base);
    arm.latencyRows = [];
    for (const [seq, x] of sample.entries()) {
      const row = { arm: arm.key, pass: 'latency', seq, ...x, ...(await recall(c, x)) };
      arm.latencyRows.push(row);
      emit(row);
    }
    const ok = arm.latencyRows.filter((r) => r.error === null);
    arm.latencyUnjudged = arm.enrichment ? ok.filter((r) => r.ranked === 'graph' && r.answered === null).length : 0;
    arm.latencyGraph = ok.filter((r) => r.ranked === 'graph').length;
    arm.latencyErrors = arm.latencyRows.length - ok.length;
    arm.serialMedian = median(ok.filter((r) => !arm.enrichment || r.ranked !== 'graph' || r.answered !== null).map((r) => r.ms));
    arm.routerTotal = routerOutcomes(arm.dir);
    arm.positionsDigest = positionsDigest(arm.rows);
  }

  // ---- 6. report — numbers and ids only ---------------------------------------------------------------------
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
  const SETS = [...QUESTION_SETS.map((s) => s.key), 'all'];
  const inSet = (set) => (r) => set === 'all' || r.set === set;
  // Counts when both sides answered the same number of queries; otherwise rates, since errors changed n.
  const delta = (s, b) => (s.n === b.n
    ? `${signed(s.top1 - b.top1)} / ${signed(s.found - b.found)} / ${signed(s.mrr - b.mrr, 3)}`
    : `${signed(100 * (s.top1 / Math.max(1, s.n) - b.top1 / Math.max(1, b.n)), 1)}pp / `
      + `${signed(100 * (s.found / Math.max(1, s.n) - b.found / Math.max(1, b.n)), 1)}pp / ${signed(s.mrr - b.mrr, 3)} (rates: n differs)`);
  // PAIRED, per query: both arms answered query `seq`, neither errored. b = base hit & arm miss; c = the reverse.
  const HITS = { top1: (r) => r.pos === 0, found: (r) => r.pos >= 0 };
  const paired = (arm, baseArm, set) => {
    const baseBySeq = new Map(baseArm.rows.map((r) => [r.seq, r]));
    const out = { pairs: 0 };
    for (const k of Object.keys(HITS)) out[k] = { b: 0, c: 0 };
    for (const r of arm.rows.filter(inSet(set))) {
      const q = baseBySeq.get(r.seq);
      if (!q || r.error !== null || q.error !== null) continue;
      out.pairs++;
      for (const [k, hit] of Object.entries(HITS)) {
        if (hit(q) && !hit(r)) out[k].b++;
        if (!hit(q) && hit(r)) out[k].c++;
      }
    }
    for (const k of Object.keys(HITS)) out[k].p = mcnemarP(out[k].b, out[k].c);
    return out;
  };

  const base = arms.find((a) => a.key === 'formula');
  const LABEL_W = Math.max(dw('arm'), ...arms.map((a) => dw(a.label))) + 2;
  const COLS = [['n', 5], ['err', 5], ['graph', 7], ['judged', 8], ['endorsed', 10], ['top-1', 10], ['found@8', 10], ['MRR', 8], ['ms (parallel)', 15]];
  const report = {
    fixture: 'devtools/fixtures/recall-bilingual.json', fixtureHash: FIXTURE_HASH, facts: N, limit: LIMIT, at: RUN_AT,
    claudeVersion, appHead, appVersion,
    seedFolder: {
      fixtureHash: seedMeta.fixtureHash, createdAt: seedMeta.createdAt, claudeVersion: seedMeta.claudeVersion,
      appHead: seedMeta.appHead ?? null, appVersion: seedMeta.appVersion ?? null, reused: REUSE_SEED,
    },
    order: { seed: ORDER_SEED, queries: queries.length, adjacentSameFact },
    concurrency: arms.length,
    latencySample: sample.length,
    formulaDigest: base ? { digest: base.positionsDigest, queries: queries.length, orderSeed: ORDER_SEED, facts: N } : null,
    arms: arms.map((a) => ({
      key: a.key, label: a.label, enrichment: a.enrichment, judgeInput: a.judgeInput ?? null, reranker: a.reranker ?? null,
      knobs: a.pinned, judgeOn: a.judgeOn, judgeSource: a.judgeSource, judgeModel: a.judgeModel,
      migrationWarnings: a.migrationWarnings,
      router: { startup: a.routerStartup, accuracy: a.routerAccuracy, total: a.routerTotal },
      latency: { parallelMean: stat(a.rows).ms, serialMedian: a.serialMedian, graphRanked: a.latencyGraph, unjudged: a.latencyUnjudged, errors: a.latencyErrors },
      positionsDigest: a.positionsDigest,
    })),
    sets: {},
    paired: {},
    warnings: [],
  };
  console.log(`\n${facts.length} facts × ${QUESTION_SETS.length} sets = ${queries.length} queries per arm, order seed ${ORDER_SEED}`
    + ` (${adjacentSameFact} same-fact adjacencies left), ${arms.length} arms in parallel`);
  for (const set of SETS) {
    console.log(`\n== ${set} ==`);
    console.log(pad('arm', LABEL_W) + COLS.map(([h, w]) => pad(h, w)).join('') + 'Δ vs 公式 (top-1 / found / MRR)');
    report.sets[set] = {};
    for (const arm of arms) {
      const s = stat(arm.rows.filter(inSet(set)));
      report.sets[set][arm.key] = s;
      const d = base && arm !== base ? delta(s, stat(base.rows.filter(inSet(set)))) : '';
      const cells = [s.n, s.errors, s.graph, s.judged, s.endorsed, `${s.top1}/${s.n}`, `${s.found}/${s.n}`, s.mrr.toFixed(3), s.ms];
      console.log(pad(arm.label, LABEL_W) + cells.map((v, k) => pad(v, COLS[k][1])).join('') + d);
    }
  }

  // THE PAIRED TEST. A finding needs p < 0.05 AND the same direction in every question set that moved; the
  // `finding` column applies both rules, so a single lucky set cannot carry a verdict on its own.
  const pv = (p) => (p >= 0.9995 ? '1.000' : p < 0.001 ? '<0.001' : p.toFixed(3));
  const signOf = (x) => Math.sign(x.c - x.b);
  for (const baseKey of ['content', 'formula']) {
    const baseArm = arms.find((a) => a.key === baseKey);
    const others = arms.filter((a) => a !== baseArm);
    if (!baseArm || others.length === 0) continue;
    report.paired[baseKey] = {};
    console.log(`\nPAIRED vs ${baseKey} — McNemar exact per query; b = ${baseKey} hit & arm miss, c = ${baseKey} miss & arm hit`);
    console.log(pad('arm', LABEL_W) + pad('set', 8) + pad('pairs', 7) + pad('top-1 b/c', 11) + pad('p', 8)
      + pad('found@8 b/c', 13) + pad('p', 8) + 'finding (p<0.05 & sets agree)');
    for (const arm of others) {
      const bySet = Object.fromEntries(SETS.map((s) => [s, paired(arm, baseArm, s)]));
      const finding = {};
      for (const k of Object.keys(HITS)) {
        const dir = signOf(bySet.all[k]);
        const agree = dir !== 0 && QUESTION_SETS.every((s) => [0, dir].includes(signOf(bySet[s.key][k])));
        finding[k] = { significant: bySet.all[k].p < 0.05, agree, finding: bySet.all[k].p < 0.05 && agree, direction: dir };
      }
      report.paired[baseKey][arm.key] = { ...bySet, finding };
      for (const set of ['all', ...QUESTION_SETS.map((s) => s.key)]) {
        const x = bySet[set];
        const verdict = set !== 'all' ? '' : Object.keys(HITS).map((k) =>
          `${k === 'top1' ? 'top-1' : 'found'} ${finding[k].finding ? (finding[k].direction > 0 ? 'YES (arm better)' : 'YES (arm worse)') : 'no'}`).join(' · ');
        console.log(pad(set === 'all' ? arm.label : '', LABEL_W) + pad(set, 8) + pad(x.pairs, 7)
          + pad(`${x.top1.b}/${x.top1.c}`, 11) + pad(pv(x.top1.p), 8) + pad(`${x.found.b}/${x.found.c}`, 13) + pad(pv(x.found.p), 8) + verdict);
      }
    }
  }

  // THE A/A SANITY CHECK. Each twin ran the identical configuration from the identical snapshot, so the paired
  // test must stay quiet on it. The engine pair has no model in the loop and should match exactly; the judge
  // pair shows how far an LLM's verdicts wander between two runs of the same thing.
  const FLOORS = [
    { kind: 'engine', a: 'formula', b: 'formula2', what: 'engine — no model in the loop' },
    { kind: 'judge', a: 'content', b: 'content2', what: "judge — the LLM's verdicts vary run to run" },
  ];
  report.noiseFloor = { engine: null, judge: null };
  let floors = 0;
  for (const f of FLOORS) {
    const a = arms.find((x) => x.key === f.a), b = arms.find((x) => x.key === f.b);
    if (!a || !b) continue;
    if (floors++ === 0) {
      console.log('\nA/A SANITY CHECK — each pair ran the identical configuration from the identical snapshot, so every p must');
      console.log('stay ≥ 0.05; if one does not, the paired test is seeing something that is not there and the run is suspect.');
    }
    console.log(`\n${f.a} vs ${f.b} (${f.what}):   Δ top-1 / found / MRR   ·   paired p (top-1, found@8)`);
    report.noiseFloor[f.kind] = { arms: [f.a, f.b], sets: {} };
    for (const set of SETS) {
      const sa = stat(a.rows.filter(inSet(set))), sb = stat(b.rows.filter(inSet(set)));
      const p = paired(b, a, set);
      report.noiseFloor[f.kind].sets[set] = {
        top1: sb.top1 - sa.top1, found: sb.found - sa.found, mrr: sb.mrr - sa.mrr, sameN: sa.n === sb.n,
        pTop1: p.top1.p, pFound: p.found.p,
      };
      console.log(`  ${pad(set, 7)} ${pad(delta(sb, sa), 26)} ·   p ${pv(p.top1.p)}, ${pv(p.found.p)}`);
      for (const k of Object.keys(HITS))
        if (p[k].p < 0.05) report.warnings.push(`A/A pair ${f.a}/${f.b} — paired p ${pv(p[k].p)} on ${set} (${k === 'top1' ? 'top-1' : 'found@8'}): the run is suspect`);
    }
  }
  if (!report.noiseFloor.judge && arms.some((a) => a.enrichment))
    console.log('\njudge A/A: NOT run (add content,content2) — nothing shows how far the judge wanders between identical runs.');

  if (base) console.log(`\nformula positions digest: ${base.positionsDigest} (${queries.length} queries, ${N} facts, order seed ${ORDER_SEED})`
    + ' — equal digests across runs mean identical formula rows, the precondition for comparing runs');

  console.log(`\nlatency (ms) — parallel: mean over the accuracy pass, ${arms.length} arm(s) at once; serial median: one arm at a time,`
    + ` first ${sample.length} queries, judge arms counting only recalls that carried a verdict`);
  console.log(pad('arm', LABEL_W) + pad('ms (parallel)', 15) + pad('ms (serial median)', 20)
    + pad('cli ok/failed (accuracy)', 26) + pad('cli ok/failed (total)', 23) + 'judge');
  for (const arm of arms) {
    const ra = arm.routerAccuracy, rt = arm.routerTotal;
    console.log(pad(arm.label, LABEL_W) + pad(stat(arm.rows).ms, 15) + pad(arm.serialMedian ?? '—', 20)
      + pad(`${ra.ok}/${ra.failed}`, 26) + pad(`${rt.ok}/${rt.failed}`, 23)
      + `${arm.judgeOn ? 'on' : 'off'} · ${arm.judgeSource ?? '—'} · ${arm.judgeModel ?? '—'}`);
  }
  for (const arm of arms)
    if (arm.migrationWarnings.length > 0) console.log(`  startup warnings in ${arm.key}: ${arm.migrationWarnings.join(' | ')}`);

  // WHAT THE JUDGE IS SHOWN PER RECALL — latency alone cannot price it (on the CLI arm a 9–17 s spawn dominates
  // and the cost is quota). Estimated from the fixture: the judge sees min(4 × min(3 × limit, 100), corpus)
  // candidates (Lyntai's 4× VerificationDepth over FactIndex's over-ask). On a large corpus a KIND-filtered recall
  // asks for 100 and would show up to 400 — this fixture cannot exercise that, and the doc must say so.
  const candidates = Math.min(4 * Math.min(3 * LIMIT, 100), FIXTURE.facts.length);
  const lineOf = (f, mode) => Math.min(401,
    mode === 'headline' ? f.topic.length : mode === 'content' ? f.content.length : `${f.topic} — ${f.content}`.length);
  console.log(`\ncandidate text per recall (estimated; ${candidates} candidates at most — the engine gathers only what matches`
    + ' or links; numbering, instructions and the query are excluded, and chars ≠ tokens):');
  for (const arm of arms.filter((a) => a.judgeInput)) {
    const avg = FIXTURE.facts.reduce((a, f) => a + lineOf(f, arm.judgeInput), 0) / FIXTURE.facts.length;
    report.judgeChars = { ...(report.judgeChars ?? {}), [arm.key]: Math.round(avg * candidates) };
    console.log(`  ${pad(arm.label, LABEL_W)}up to ~${Math.round(avg * candidates)} chars (${Math.round(avg)} per candidate)`);
  }

  // FAIL-OPEN IS SILENT BY DESIGN in the product, so the bench has to be loud about it: a judge that never
  // produced a verdict makes its arm the formula arm under another name.
  for (const arm of arms) {
    const s = stat(arm.rows);
    if (s.errors > 0.02 * s.queries) report.warnings.push(`arm ${arm.key} — ${s.errors}/${s.queries} queries errored`);
    if (arm.reranker && s.judged < s.graph)
      report.warnings.push(`arm ${arm.key} — reranker gave no verdict on ${s.graph - s.judged}/${s.graph} graph recalls (a reranker abstains only on a fault)`);
    else if (arm.enrichment && !arm.reranker && s.judged < 0.98 * s.graph)
      report.warnings.push(`arm ${arm.key} — judge failed open on ${s.graph - s.judged}/${s.graph} graph recalls`);
    if (arm.routerAccuracy.failed > 0)
      report.warnings.push(`arm ${arm.key} — ${arm.routerAccuracy.failed} claude-cli call(s) failed during the accuracy pass`);
    if (arm.routerTotal.failed > arm.routerAccuracy.failed)
      report.warnings.push(`arm ${arm.key} — ${arm.routerTotal.failed - arm.routerAccuracy.failed} claude-cli call(s) failed during the latency pass`);
    if (arm.latencyUnjudged > 0)
      report.warnings.push(`arm ${arm.key} — ${arm.latencyUnjudged}/${arm.latencyGraph} graph-ranked latency recalls carried no verdict (left out of its serial median)`);
    if (arm.latencyErrors > 0)
      report.warnings.push(`arm ${arm.key} — ${arm.latencyErrors}/${arm.latencyRows.length} latency recalls errored (left out of its serial median)`);
  }
  if (report.warnings.length > 0) {
    console.log('');
    for (const w of report.warnings) console.log(`WARNING: ${w}`);
  }

  const out = path.join(WORK, `results-${RUN_STAMP}.json`);
  fs.writeFileSync(out, JSON.stringify({
    ...report,
    rows: Object.fromEntries(arms.map((a) => [a.key, a.rows])),
    latencyRows: Object.fromEntries(arms.map((a) => [a.key, a.latencyRows])),
  }, null, 2));
  console.log(`\nrow stream: ${ROWS}`);
  console.log(`raw rows: ${out}`);
} finally {
  stopAll();
}
