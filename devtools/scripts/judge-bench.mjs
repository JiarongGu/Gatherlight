#!/usr/bin/env node
// judge-bench.mjs — what each way of JUDGING a recall is worth, on the committed bilingual fixture.
//
// WHY SNAPSHOTS. A recall reinforces what it returns and links it, so a run mutates what it measures. The
// combination and the reranker are STARTUP choices, so the within-run pairing recall-bench uses is
// impossible here. Instead ONE data folder is seeded, copied once per arm, and every arm answers the SAME
// questions in the SAME order from the SAME starting graph. Each arm's own drift is part of its effect.
//
// PRIVACY. The fixture is invented and committed; this touches no household data. Reranker arms READ the
// llama.cpp binary and GGUFs from --resources (default local/state/resources) and nothing else there.
//
// Usage:
//   node devtools/dev.mjs judge-bench                                 # formula, topic, content, contentonly, fuse
//   node devtools/dev.mjs judge-bench --arms=formula,content --n=20
//   node devtools/dev.mjs judge-bench --arms=formula --rerankers=LAMAR-600m.Q5_K_M,bge-reranker-v2-m3-Q5_K_M
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTestData, startServer, waitHealthy, makeClient, until, repo } from './e2e/_e2e-common.mjs';
import { resolveClaude, QUESTION_SETS } from './recall-questions.mjs';

const arg = (name, dflt) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const FIXTURE = JSON.parse(fs.readFileSync(path.join(repo, 'devtools', 'fixtures', 'recall-bilingual.json'), 'utf8'));
const LIMIT = 8;
const PORT_BASE = Number(arg('port-base', '5620'));
const LLAMA_PORT = Number(arg('llama-port', '5660'));
const WORK = path.join(repo, 'devtools', '_judge-bench');
const RESOURCES = path.resolve(arg('resources', path.join(repo, 'local', 'state', 'resources')));

// A deterministic stride sample, so --n=20 covers every cluster rather than the first twenty rows.
const all = FIXTURE.facts.filter((f) => f.questions);
const N = Math.min(Number(arg('n', String(all.length))), all.length);
const stride = all.length / N;
const facts = Array.from({ length: N }, (_, i) => all[Math.floor(i * stride)]);

const ARMS = {
  formula: { label: '公式 only (判断 off)', enrichment: false, env: {} },
  topic: { label: 'Claude judge · topic only', enrichment: true, judgeInput: 'headline',
    env: { GATHERLIGHT_JUDGE_INPUT: 'headline' }, knob: /judge input = headline \(/ },
  content: { label: 'Claude judge · topic — content · partition', enrichment: true, judgeInput: 'both', env: {} },
  // How Lyntai's upcoming LlmVerificationOptions.ContentChars renders a candidate: content ALONE (Part 276 / D170).
  contentonly: { label: 'Claude judge · content only · partition', enrichment: true, judgeInput: 'content',
    env: { GATHERLIGHT_JUDGE_INPUT: 'content' }, knob: /judge input = content \(/ },
  fuse: { label: 'Claude judge · topic — content · fuse', enrichment: true, judgeInput: 'both',
    env: { GATHERLIGHT_VERDICT_COMBINATION: 'fuse' }, knob: /verdict combination = Fuse/ },
};
const arms = arg('arms', 'formula,topic,content,contentonly,fuse').split(',').filter(Boolean).map((k) => {
  if (!ARMS[k]) throw new Error(`unknown arm '${k}' — one of ${Object.keys(ARMS).join(', ')}`);
  return { key: k, ...ARMS[k] };
});
const rerankers = arg('rerankers', '').split(',').filter(Boolean);
for (const m of rerankers) {
  arms.push({ key: `rr:${m}`, label: `reranker ${m} · partition`, enrichment: true, env: {}, reranker: m });
  arms.push({ key: `rrf:${m}`, label: `reranker ${m} · fuse`, enrichment: true,
    env: { GATHERLIGHT_VERDICT_COMBINATION: 'fuse' }, knob: /verdict combination = Fuse/, reranker: m });
}

const claude = resolveClaude();
const servers = [];
let router = null;
const stopAll = () => {
  for (const s of servers) try { s.stop(); } catch { /* best effort */ }
  try { router?.kill(); } catch { /* best effort */ }
};

try {
  // ---- 1. seed ONE folder (real CLI, so annotation writes subject tags) ------------------------------------
  fs.rmSync(WORK, { recursive: true, force: true });
  const seedDir = path.join(WORK, 'seed');
  makeTestData(seedDir);
  const seed = startServer({ dataDir: seedDir, port: PORT_BASE, env: { GATHERLIGHT_CLAUDE_CMD: claude } });
  servers.push(seed);
  await waitHealthy(seed.base);
  const sc = makeClient(seed.base);
  const idOf = new Map();
  for (const [i, f] of FIXTURE.facts.entries()) {
    const w = await sc.call('remember_fact', {
      kind: f.kind, topic: f.topic, content: f.content, source: `https://example.test/${f.id}`, confidence: 0.8,
    });
    if (w.result?.ok !== true) throw new Error(`seed: ${f.id} → ${JSON.stringify(w.result)}`);
    idOf.set(f.id, Number(w.result.id));
    process.stdout.write(`\r  seeding ${i + 1}/${FIXTURE.facts.length}   `);
  }
  seed.stop();
  servers.length = 0;
  await until(async () => { try { await fetch(`${seed.base}/api/health`); return false; } catch { return true; } }, 60000);

  // ---- 2. the reranker arms share ONE real router, started here ---------------------------------------------
  // Each arm's own resources get EMPTY stand-ins for the runtime and the model, which is all IsConfigured asks;
  // the arm then ADOPTS this router at GATHERLIGHT_LLAMACPP_URL (EnsureServingAsync probes before it spawns).
  if (rerankers.length > 0) {
    const exe = path.join(RESOURCES, 'llama-cpp', 'llama-server.exe');
    const gguf = path.join(RESOURCES, 'gguf');
    if (!fs.existsSync(exe)) throw new Error(`no llama-server at ${exe} — download llama.cpp in 资源 first`);
    for (const m of rerankers)
      if (!fs.existsSync(path.join(gguf, `${m}.gguf`))) throw new Error(`${m}.gguf is not in ${gguf} — download it in 资源 first`);
    const preset = path.join(WORK, 'presets.ini');
    fs.writeFileSync(preset, rerankers.map((m) =>
      `[${m}]\nn-gpu-layers = 99\nreranking = true\nctx-size = 4096\nbatch-size = 4096\nubatch-size = 4096\n`).join('\n'));
    router = spawn(exe, ['--models-dir', gguf, '--models-preset', preset, '--models-max', '2',
      '--host', '127.0.0.1', '--port', String(LLAMA_PORT)], { cwd: path.dirname(exe), stdio: 'ignore' });
    await until(async () => (await fetch(`http://127.0.0.1:${LLAMA_PORT}/v1/models`)).ok, 60000);
  }

  // ---- 3. one snapshot + one server per arm ------------------------------------------------------------------
  for (const [i, arm] of arms.entries()) {
    const dir = path.join(WORK, `arm-${i}`);
    fs.cpSync(seedDir, dir, { recursive: true });
    fs.rmSync(path.join(dir, 'state', 'logs'), { recursive: true, force: true });
    const env = { GATHERLIGHT_CLAUDE_CMD: claude, ...arm.env };
    if (arm.reranker) {
      const res = path.join(dir, 'state', 'resources');
      fs.mkdirSync(path.join(res, 'llama-cpp'), { recursive: true });
      fs.mkdirSync(path.join(res, 'gguf'), { recursive: true });
      fs.writeFileSync(path.join(res, 'llama-cpp', 'llama-server.exe'), '');
      fs.writeFileSync(path.join(res, 'gguf', `${arm.reranker}.gguf`), '');
      const settingsPath = path.join(dir, 'state', 'settings.json');
      const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
      settings.memory = { ...(settings.memory ?? {}), judgeSource: 'llama-cpp', judgeModel: arm.reranker };
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      env.GATHERLIGHT_LLAMACPP_URL = `http://127.0.0.1:${LLAMA_PORT}`;
    }
    arm.srv = startServer({ dataDir: dir, port: PORT_BASE + 1 + i, env });
    servers.push(arm.srv);
  }
  for (const arm of arms) {
    await waitHealthy(arm.srv.base);
    // NON-VACUITY: an arm whose knob or binding did not take would silently duplicate another arm.
    if (arm.knob && !arm.knob.test(arm.srv.log())) throw new Error(`arm ${arm.key}: its knob did not announce itself`);
    if (arm.reranker) {
      const judge = ((await makeClient(arm.srv.base).getJson('/api/manage/memory')).layers ?? []).find((l) => l.id === 'judge');
      if (judge?.activeModel !== arm.reranker) throw new Error(`arm ${arm.key}: judge is running ${judge?.activeModel}, not ${arm.reranker}`);
    }
    await makeClient(arm.srv.base).post('/api/manage/memory/enrichment', { enabled: arm.enrichment });
  }

  // ---- 4. identical questions, identical order, every arm in parallel ----------------------------------------
  const queries = facts.flatMap((f) => QUESTION_SETS.map((s) => ({ fact: f.id, set: s.key, q: f.questions[s.key] })));
  await Promise.all(arms.map(async (arm) => {
    const c = makeClient(arm.srv.base);
    arm.rows = [];
    for (const x of queries) {
      const t0 = Date.now();
      const r = await c.call('recall_facts', { query: x.q, limit: LIMIT });
      const ids = (r.result?.facts ?? []).map((f) => Number(f.id));
      arm.rows.push({ ...x, pos: ids.indexOf(idOf.get(x.fact)), ms: Date.now() - t0, answered: r.result?.answered ?? null });
    }
  }));

  // ---- 5. report — numbers and ids only ---------------------------------------------------------------------
  const stat = (rows) => ({
    n: rows.length,
    top1: rows.filter((r) => r.pos === 0).length,
    found: rows.filter((r) => r.pos >= 0).length,
    mrr: rows.reduce((a, r) => a + (r.pos >= 0 ? 1 / (r.pos + 1) : 0), 0) / Math.max(1, rows.length),
    ms: Math.round(rows.reduce((a, r) => a + r.ms, 0) / Math.max(1, rows.length)),
    judged: rows.filter((r) => r.answered !== null).length,
  });
  const base = arms.find((a) => a.key === 'formula');
  const report = { fixture: 'devtools/fixtures/recall-bilingual.json', facts: N, limit: LIMIT, at: new Date().toISOString(), sets: {} };
  for (const set of [...QUESTION_SETS.map((s) => s.key), 'all']) {
    console.log(`\n== ${set} ==`);
    console.log('arm'.padEnd(46) + 'top-1   found@8  MRR     ms     judged  vs 公式 (top-1 / found)');
    report.sets[set] = {};
    for (const arm of arms) {
      const s = stat(arm.rows.filter((r) => set === 'all' || r.set === set));
      report.sets[set][arm.key] = s;
      let delta = '';
      if (base && arm !== base) {
        const b = stat(base.rows.filter((r) => set === 'all' || r.set === set));
        delta = `${s.top1 - b.top1 >= 0 ? '+' : ''}${s.top1 - b.top1} / ${s.found - b.found >= 0 ? '+' : ''}${s.found - b.found}`;
      }
      console.log(arm.label.padEnd(46)
        + `${s.top1}/${s.n}`.padEnd(8) + `${s.found}/${s.n}`.padEnd(9) + s.mrr.toFixed(3).padEnd(8)
        + String(s.ms).padEnd(7) + String(s.judged).padEnd(8) + delta);
    }
  }
  // WHAT THE JUDGE IS SHOWN PER RECALL — latency alone cannot price it (on the CLI arm a 9–17 s spawn dominates
  // and the cost is quota). Estimated from the fixture: the judge sees min(4 × min(3 × limit, 100), corpus)
  // candidates (Lyntai's 4× VerificationDepth over FactIndex's over-ask). On a large corpus a KIND-filtered recall
  // asks for 100 and would show up to 400 — this fixture cannot exercise that, and the doc must say so.
  const candidates = Math.min(4 * Math.min(3 * LIMIT, 100), FIXTURE.facts.length);
  const lineOf = (f, mode) => Math.min(401,
    mode === 'headline' ? f.topic.length : mode === 'content' ? f.content.length : `${f.topic} — ${f.content}`.length);
  console.log(`\njudge input per recall (estimated; ${candidates} candidates at most — the engine gathers only what matches or links):`);
  for (const arm of arms.filter((a) => a.judgeInput)) {
    const avg = FIXTURE.facts.reduce((a, f) => a + lineOf(f, arm.judgeInput), 0) / FIXTURE.facts.length;
    report.judgeChars = { ...(report.judgeChars ?? {}), [arm.key]: Math.round(avg * candidates) };
    console.log(`  ${arm.label.padEnd(44)} up to ~${Math.round(avg * candidates)} chars (${Math.round(avg)} per candidate)`);
  }
  fs.writeFileSync(path.join(WORK, 'results.json'),
    JSON.stringify({ ...report, rows: Object.fromEntries(arms.map((a) => [a.key, a.rows])) }, null, 2));
  console.log(`\nraw rows: ${path.join(WORK, 'results.json')}`);
} finally {
  stopAll();
}
