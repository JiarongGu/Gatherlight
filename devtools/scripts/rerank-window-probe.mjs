#!/usr/bin/env node
// rerank-window-probe — re-measures what the mMiniLMv2 row's 512-token window rests on, on the real model through a
// dedicated llama-server. The figures it reproduces are quoted in code comments (RerankInputCap, GgufCatalog's
// mMiniLMv2 row, LlamaCppSource.Description) and recorded with their method in docs/self-managed-llm-runtime.md,
// "2026-09-24 — mMiniLMv2's 512 window". They existed only in those comments until this script: a measured claim
// nobody can reproduce decays into an opinion with a number on it (the reason embed-bench and judge-bench exist).
//
//   node devtools/dev.mjs rerank-window [--resources=<dir>] [--model=<file.gguf>] [--port=6120] [--workers=16]
//                                       [--skip-sweep] [--skip-pairs] [--skip-latency] [--any-model]
//
// THREE PARTS, each skippable:
//   1. THE NFKC BOUND (the sweep). RerankInputCap counts a declared-window pair on its NFKC-normalised text, on the
//      claim that on this tokenizer family (XLM-R SentencePiece, nmt_nfkc, no byte fallback) such a text costs at
//      most its UTF-16 length + 1 tokens. This asks the model's own /tokenize, for every assigned BMP scalar and every
//      astral scalar .NET's FormKC changes — normalised by .NET 10 itself (a file-based `dotnet run`, the exact call
//      the app makes), and compared with Node's NFKC. Reported: scalars over the bound (the claim says 0), scalars
//      whose raw and normalised token ids differ, the worst raw tokens per UTF-16 unit, and .NET-vs-Node mismatches.
//   2. THE PAIR AT THE LIMIT. A (query, document) pair dense in compatibility characters, fitted to the 512 window by
//      the OLD rule (raw UTF-16 count) and by the NEW one (NFKC first), then sent to /v1/rerank on a server launched
//      at 512: the old fit overflows and the whole call is refused, the new one is served.
//   3. THE LAUNCH. The mMiniLMv2 row's whole-recall latency was measured by judge-bench Run 4 under a 4096 launch,
//      and the product launches it at its declared 512 — so the rerank CALL is timed under both, same GPU, same
//      pairs: 4096, 512, 4096 again (the second 4096 is the run-to-run spread the 512 figure is read against).
//      12 fixture questions × all 60 fixture facts per call, 3 rounds, after a warm-up; serial, wall-clock.
//
// RESOURCES. Like judge-bench, it reads the llama.cpp binary and the GGUF from --resources (default
// local/state/resources — a household's data folder, so pass a scratch folder unless reading that one is intended):
// <res>/llama-cpp/llama-server.exe and <res>/gguf/<id>.gguf or <res>/gguf/<id>/*.gguf. --model names the file
// directly. The file must be the catalogue's pinned bytes: its sha256 is checked against GgufCatalog.cs, and a
// mismatch refuses to run unless --any-model says the measurement is of something else on purpose.
//
// Every server it starts is its own child, on its own port (never a port something else holds), killed when its part
// ends. Scratch output (the .NET dump, a results JSON) goes to devtools/_rerank-window-probe/.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const MODEL_ID = 'mmarco-mMiniLMv2-L12-H384-v1-Q8_0';
const WINDOW = 512;
const WIDE = 4096;
/** RerankInputCap.PairOverheadTokens: 4 special tokens around a pair + at most one leading ▁ per text. */
const PAIR_OVERHEAD = 6;
/** RerankInputCap.MaxChars. */
const MAX_CHARS = 1000;

const scratch = path.join(repo, 'devtools', '_rerank-window-probe');
fs.mkdirSync(scratch, { recursive: true });
const RESOURCES = path.resolve(arg('resources', path.join(repo, 'local', 'state', 'resources')));
const BASE_PORT = Number(arg('port', '6120'));
const WORKERS = Math.max(1, Number(arg('workers', '16')));

const exe = path.join(RESOURCES, 'llama-cpp', 'llama-server.exe');
if (!fs.existsSync(exe)) throw new Error(`no llama-server at ${exe} — pass --resources=<a folder holding llama-cpp/ and gguf/>`);

const findModel = () => {
  const explicit = arg('model', null);
  if (explicit) return path.resolve(explicit);
  const flat = path.join(RESOURCES, 'gguf', `${MODEL_ID}.gguf`);
  if (fs.existsSync(flat)) return flat;
  const nested = path.join(RESOURCES, 'gguf', MODEL_ID);
  const inner = fs.existsSync(nested) ? fs.readdirSync(nested).find((f) => f.toLowerCase().endsWith('.gguf')) : null;
  if (inner) return path.join(nested, inner);
  throw new Error(`${MODEL_ID} is in neither gguf/${MODEL_ID}.gguf nor gguf/${MODEL_ID}/*.gguf under ${RESOURCES} — or pass --model=<file>`);
};
const model = findModel();

// The pinned checksum, read from the catalogue row rather than restated here — one writer.
const catalogue = fs.readFileSync(path.join(repo, 'src', 'server', 'Gatherlight.Platform', 'Agent', 'Llm', 'Services', 'GgufCatalog.cs'), 'utf8');
const pinned = (catalogue.match(new RegExp(`"${MODEL_ID.replaceAll('.', '\\.')}\\.gguf",\\s*"([0-9a-f]{64})"`)) ?? [])[1];
const actual = crypto.createHash('sha256').update(fs.readFileSync(model)).digest('hex');
if (!pinned) throw new Error(`could not find ${MODEL_ID}'s sha256 in GgufCatalog.cs`);
if (actual !== pinned && !flag('any-model'))
  throw new Error(`${model} is not the catalogue's pinned file (sha256 ${actual}, pinned ${pinned}) — pass --any-model to measure it anyway`);

const version = (() => {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.split(/\r?\n/).find((l) => /version/i.test(l))?.trim() ?? 'unknown';
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {
  date: new Date().toISOString(), llamaServer: version, model: path.basename(model), sha256: actual,
  pinned: actual === pinned,
};
console.log(`rerank-window-probe · ${results.date}\n  llama-server: ${version}\n  model: ${model}\n  sha256 ${actual} (${results.pinned ? 'the pinned file' : 'NOT the pinned file'})`);

/** A dedicated llama-server for this model: reranking, all layers on the GPU, ctx/batch/ubatch = n — the section
 *  LlamaServerRuntime.WritePresets writes for a reranker, as flags. */
async function withServer(port, n, fn) {
  const child = spawn(exe, ['-m', model, '--port', String(port), '--host', '127.0.0.1', '--reranking',
    '--n-gpu-layers', '99', '-c', String(n), '-b', String(n), '-ub', String(n)], { stdio: 'ignore', windowsHide: true });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 240 && !up; i++) {
      try { up = (await fetch(`${base}/health`)).ok; } catch { /* not yet */ }
      if (!up) await sleep(250);
    }
    if (!up) throw new Error(`llama-server on ${port} did not become healthy`);
    return await fn(base);
  } finally {
    child.kill();
    await sleep(1500);
  }
}

const tokenize = (base) => async (content) => {
  const r = await fetch(`${base}/tokenize`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, add_special: false }),
  });
  if (!r.ok) throw new Error(`tokenize ${r.status}: ${await r.text()}`);
  return (await r.json()).tokens;
};
const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- 1. the NFKC bound -------------------------------------------------------------------------------------------
async function sweep(base) {
  const dumpCs = path.join(scratch, 'nfkc-dump.cs');
  const dumpOut = path.join(scratch, 'nfkc.jsonl');
  // .NET's own FormKC, the call RerankInputCap.Prepare makes — not Node's, whose Unicode tables may differ. One line
  // per scalar: the code point, then the normalised text as UTF-16 code units in hex (a file-based app has no
  // reflection-based JSON, and hex needs no escaping). Every assigned BMP scalar; an astral one only when FormKC
  // changes it — an unchanged astral scalar is one surrogate pair, ≤ 1 token + ▁ on this tokenizer.
  fs.writeFileSync(dumpCs, [
    'using System.Globalization;',
    'using System.Text;',
    'using var w = new StreamWriter(args[0], false, new UTF8Encoding(false));',
    'int changed = 0, total = 0;',
    'for (var cp = 0; cp <= 0x10FFFF; cp++)',
    '{',
    '    if (cp is >= 0xD800 and <= 0xDFFF) continue;',
    '    if (CharUnicodeInfo.GetUnicodeCategory(cp) == UnicodeCategory.OtherNotAssigned) continue;',
    '    var s = char.ConvertFromUtf32(cp);',
    '    string n;',
    '    try { n = s.Normalize(NormalizationForm.FormKC); } catch (ArgumentException) { continue; }',
    '    var differs = !string.Equals(s, n, StringComparison.Ordinal);',
    '    if (differs) changed++;',
    '    if (cp > 0xFFFF && !differs) continue;',
    '    total++;',
    '    w.WriteLine($"{cp:x}\\t{string.Join(",", n.Select(c => ((int)c).ToString("x")))}");',
    '}',
    'Console.WriteLine($"{System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}: wrote {total} scalars, {changed} changed by FormKC");',
  ].join('\n'), 'utf8');
  const dump = spawnSync('dotnet', ['run', '--file', dumpCs, '--', dumpOut], { encoding: 'utf8', windowsHide: true });
  if (dump.status !== 0) throw new Error(`the .NET FormKC dump failed:\n${dump.stdout}\n${dump.stderr}`);
  console.log(`\n== 1. the NFKC bound ==\n  ${dump.stdout.trim().split(/\r?\n/).pop()}`);

  const tok = tokenize(base);
  const rows = fs.readFileSync(dumpOut, 'utf8').split('\n').filter(Boolean).map((l) => {
    const [cpHex, units] = l.trim().split('\t');
    const cp = parseInt(cpHex, 16);
    const s = String.fromCodePoint(cp);
    const n = String.fromCharCode(...(units ?? '').split(',').filter(Boolean).map((u) => parseInt(u, 16)));
    return { cp, s, n, differs: s !== n };
  });
  const over = [], differentIds = [], nodeDiffers = [];
  let worstRaw = { ratio: 0 }, done = 0;
  const queue = rows.slice();
  const worker = async () => {
    for (let x = queue.shift(); x; x = queue.shift()) {
      const tn = await tok(x.n);
      if (tn.length > x.n.length + 1) over.push({ cp: x.cp.toString(16), n: x.n, u16: x.n.length, tokens: tn.length });
      if (x.differs) {
        const ts = await tok(x.s);
        if (!sameIds(ts, tn)) differentIds.push({ cp: x.cp.toString(16), s: x.s, n: x.n });
        const ratio = ts.length / x.s.length;
        if (ratio > worstRaw.ratio) worstRaw = { ratio, cp: x.cp.toString(16), s: x.s, tokens: ts.length };
      }
      if (x.s.normalize('NFKC') !== x.n) nodeDiffers.push(x.cp.toString(16));
      if (++done % 10000 === 0) process.stderr.write(`  ${done}/${rows.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  const changed = rows.filter((x) => x.differs).length;
  console.log(`  scalars swept: ${rows.length} (${changed} changed by .NET FormKC)`);
  console.log(`  over the bound — tokens(NFKC) > UTF-16 length(NFKC) + 1: ${over.length}${over.length ? ' ' + JSON.stringify(over.slice(0, 10)) : ''}`);
  console.log(`  raw and normalised token ids differ: ${differentIds.length} of ${changed} (first: ${differentIds.slice(0, 5).map((d) => `U+${d.cp.toUpperCase()}`).join(' ')})`);
  console.log(`  worst RAW tokens per UTF-16 unit: ${worstRaw.tokens} (U+${String(worstRaw.cp).toUpperCase()} ${worstRaw.s})`);
  console.log(`  Node NFKC differs from .NET FormKC: ${nodeDiffers.length}`);
  results.sweep = { scalars: rows.length, changed, over, differentIds: differentIds.length, worstRaw, nodeDiffers };
}

// ---- 2. the pair at the limit ------------------------------------------------------------------------------------
/** RerankInputCap.Cap: at most n UTF-16 units, never splitting a surrogate pair. */
const cap = (s, n) => (s.length <= n ? s : s.slice(0, /[\uD800-\uDBFF]/.test(s[n - 1]) ? n - 1 : n));
/** RerankInputCap.Fit at a declared window, mirrored — with `nfkc` false it is the OLD rule, a raw count. */
const fit = (q, d, nfkc) => {
  const budget = WINDOW - PAIR_OVERHEAD;
  const query = cap(nfkc ? q.normalize('NFKC') : q, Math.floor(budget / 2));
  return { query, doc: cap(nfkc ? d.normalize('NFKC') : d, Math.min(MAX_CHARS, budget - query.length)) };
};
async function pairs(base) {
  console.log('\n== 2. a compatibility-dense pair fitted to the 512 window ==');
  const tok = tokenize(base);
  const cases = {
    '℃-dense fact': ['室温多少℃?', '室温记录:' + '℃'.repeat(600)],
    '℃㎡㎏㍿ mixed into Chinese': ['仓库面积多少㎡,室温几℃?', '㍿山田商事仓库:面积120㎡,室温18℃,单件行李上限23㎏。'.repeat(30)],
  };
  results.pairs = [];
  for (const [name, [q, d]] of Object.entries(cases)) {
    for (const nfkc of [false, true]) {
      const p = fit(q, d, nfkc);
      const tokens = (await tok(p.query)).length + (await tok(p.doc)).length + 4;
      const r = await fetch(`${base}/v1/rerank`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', query: p.query, documents: [p.doc, '无关的短句。'], top_n: 2 }),
      });
      const body = (await r.text()).slice(0, 160);
      const row = { case: name, rule: nfkc ? 'NFKC (current)' : 'raw (old)', chars: p.query.length + p.doc.length, tokens, status: r.status };
      results.pairs.push(row);
      console.log(`  ${name} · ${row.rule}: ${row.chars} chars → ${tokens} tokens → /v1/rerank ${r.status}${r.ok ? '' : ` ${body}`}`);
    }
  }
}

// ---- 3. the launch -----------------------------------------------------------------------------------------------
async function latency() {
  console.log('\n== 3. one rerank call (a fixture question × all 60 fixture facts), launched at 4096 vs 512 ==');
  const fx = JSON.parse(fs.readFileSync(path.join(repo, 'devtools', 'fixtures', 'recall-bilingual.json'), 'utf8'));
  const docs = fx.facts.map((f) => f.content);
  const sets = ['same', 'cross', 'third', 'mixed'];
  const questions = fx.facts.slice(0, 12).map((f, i) => f.questions[sets[i % 4]]);
  results.latency = [];
  let port = BASE_PORT + 1;
  for (const [label, n] of [['4096', WIDE], ['512', WINDOW], ['4096 again', WIDE]]) {
    const ms = await withServer(port++, n, async (base) => {
      const call = async (query) => {
        const t = performance.now();
        const r = await fetch(`${base}/v1/rerank`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'm', query, documents: docs, top_n: docs.length }),
        });
        const body = await r.json();
        if (!r.ok || (body.results ?? []).length !== docs.length) throw new Error(`${label}: ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
        return performance.now() - t;
      };
      await call(questions[0]);
      await call(questions[1]);
      const out = [];
      for (let round = 0; round < 3; round++) for (const q of questions) out.push(await call(q));
      return out.sort((a, b) => a - b);
    });
    const row = { launch: label, calls: ms.length, docs: docs.length,
      medianMs: +ms[Math.floor(ms.length / 2)].toFixed(1), minMs: +ms[0].toFixed(1), maxMs: +ms[ms.length - 1].toFixed(1) };
    results.latency.push(row);
    console.log(`  launched at ${label}: ${row.calls} calls — median ${row.medianMs} ms (min ${row.minMs}, max ${row.maxMs})`);
  }
}

if (!flag('skip-sweep') || !flag('skip-pairs')) {
  await withServer(BASE_PORT, WINDOW, async (base) => {
    if (!flag('skip-sweep')) await sweep(base);
    if (!flag('skip-pairs')) await pairs(base);
  });
}
if (!flag('skip-latency')) await latency();

const out = path.join(scratch, `results-${results.date.replaceAll(':', '')}.json`);
fs.writeFileSync(out, JSON.stringify(results, null, 1));
console.log(`\nresults: ${path.relative(repo, out)}`);
