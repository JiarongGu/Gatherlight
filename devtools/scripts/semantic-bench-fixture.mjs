#!/usr/bin/env node
// semantic-bench-fixture.mjs — writes devtools/fixtures/recall-bilingual-embed.json: the SAME 60 facts and the SAME 240
// questions as recall-bilingual.json, HALF of them kept as they are (short, ≤ 101 characters) and half turned into
// OVER-WINDOW NOTES — longer than the llama.cpp embedder's 2,048-token window, with the fact's own content (the answer)
// as the note's LAST text, past the window. Deterministic and model-free: re-running it reproduces the committed file
// byte for byte, and semantic-bench refuses the fixture when it does not (docs/judge-bench.md Run 14).
//
// WHY. EmbeddingGemma on llama.cpp embeds an input in one physical batch of 2,048 tokens and REFUSES a longer one whole,
// so a fact past it keeps no vector (FactIndex's classifier) and 语义 cannot find it. Lyntai's D177 segmentation, the
// knob GATHERLIGHT_EMBED_SEGMENTATION=d177 (EmbedSegmentation), embeds it in pieces pooled into one vector. Whether that
// vector finds the fact by a paraphrase of what it says PAST the old window is the question; the answer sits there here.
//
// THE CONSTRUCTION:
//   - short/long alternates through each language's facts in fixture order, zh and ja starting short and en long — the
//     mixed fixture's assignment (judge-bench-mixed-fixture.mjs), so each language is half short, half long (zh 20/20,
//     en 8/8, ja 2/2) and a near-duplicate group sits on both lengths;
//   - an over-window note is filler FIRST and the fact's content LAST. The filler is the long fixture's neutral pools
//     (judge-bench-long-fixture.mjs: invented household sentences naming no fixture subject), taken in PASSES — each a
//     fresh shuffle of the pool by the fact's own seed and the pass number — until the run reaches BEFORE[lang]
//     characters; the pools are too small for one pass, so a sentence REPEATS within a note, once per pass, and never
//     twice in one pass. The fact's mentions of other facts BY TOPIC (the long fixture's mentionsOf, never their content)
//     are spread through the first pass;
//   - BEFORE[lang] puts the answer's first token past the window by the SLOWEST rate the long fixture's own notes read on
//     EmbeddingGemma (tokens per character: zh 0.774, ja 0.628, en 0.204 — docs/judge-bench.md Run 14's design): 2,300 tokens
//     ÷ that rate. `--measure` tokenizes every note on the pinned GGUF and reports where each answer starts.
// Every fact's original content occurs EXACTLY ONCE in the whole corpus, in its own text, at its declared offset (a second
// copy would make another text a correct answer); NFKC preserves every text's length. The build fails otherwise.
//
// Usage:
//   node devtools/scripts/semantic-bench-fixture.mjs            write the fixture
//   node devtools/scripts/semantic-bench-fixture.mjs --check    exit 1 unless the committed file is what this writes
//   node devtools/scripts/semantic-bench-fixture.mjs --measure --resources=devtools/_rr-res [--port=7820]
//       tokenize every text on a dedicated CPU llama-server (EmbeddingGemma, the catalogue's pinned file)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FILLER, JOIN, shuffled, seedOf, languageOf, byLanguage, mentionsOf, validatePools, serialise, readBase, MENTION_EXCLUDED }
  from './judge-bench-long-fixture.mjs';
import { groupsOf } from './judge-bench-mixed-fixture.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EMBED_FIXTURE = path.join(repo, 'devtools', 'fixtures', 'recall-bilingual-embed.json');
export const EMBED_POSITIONS = ['short', 'over'];

/** The embedder's window (GgufCatalog: EmbeddingGemma's ContextTokens) and what llama.cpp adds (EmbedSegmentation). */
export const EMBED_WINDOW = 2048;
export const SPECIAL_TOKENS = 2;
/** The slowest tokens per character the long fixture's notes read on EmbeddingGemma, per language (Run 14's sweep). */
const SLOWEST_RATE = { zh: 0.774, ja: 0.628, en: 0.204 };
/** Where the answer's first token should sit at the slowest rate: well past the window's 2,046 content tokens. */
const ANSWER_AT_TOKENS = 2300;
export const BEFORE = Object.fromEntries(Object.entries(SLOWEST_RATE).map(([k, r]) => [k, Math.ceil(ANSWER_AT_TOKENS / r)]));
const PHASE = { zh: 'short', en: 'long', ja: 'short' };

/** ONE fact's over-window note: filler passes to BEFORE[lang] characters, then the fact's content. Pure. */
export function overWindowNote(f, ms) {
  const lang = languageOf(f);
  const join = JOIN[lang];
  const target = BEFORE[lang];
  const parts = [];
  let len = 0;
  const add = (s) => { len += (parts.length ? join.length : 0) + s.length; parts.push(s); };
  // The mentions go into the first pass at even fractions of it.
  const pending = ms.map((m, k) => ({ text: m.text, at: Math.floor(((k + 0.5) / ms.length) * Math.min(target, FILLER[lang].join(join).length) * 0.9) }));
  for (let pass = 0; len < target; pass++) {
    if (pass > 10) throw new Error(`${f.id}: cannot reach ${target} characters`);
    for (const s of shuffled(FILLER[lang], seedOf(`${f.id}#${pass}`))) {
      while (pending.length && len >= pending[0].at) add(pending.shift().text);
      if (len >= target) break;
      add(s);
    }
  }
  while (pending.length) add(pending.shift().text);
  const offset = len + join.length;
  return { note: parts.join(join) + join + f.content, offset };
}

/** The fixture, from the bilingual fixture's parsed JSON and its raw bytes. Pure: same input, same output. */
export function buildEmbedFixture(base, baseBytes) {
  const facts = base.facts;
  const position = new Map();
  for (const [lang, group] of Object.entries(byLanguage(facts)))
    group.forEach((f, i) => position.set(f.id, (i % 2 === 0) === (PHASE[lang] === 'long') ? 'over' : 'short'));
  const mentions = mentionsOf(facts);
  const groups = groupsOf(facts);
  const out = facts.map((f) => {
    const pos = position.get(f.id);
    if (pos === 'short')
      return { id: f.id, kind: f.kind, topic: f.topic, content: f.content, questions: f.questions, position: pos,
        answer: { text: f.content, offset: 0, length: f.content.length }, mentions: [], group: groups.get(f.id) };
    const ms = mentions.get(f.id);
    const { note, offset } = overWindowNote(f, ms);
    return { id: f.id, kind: f.kind, topic: f.topic, content: note, questions: f.questions, position: pos,
      answer: { text: f.content, offset, length: f.content.length }, mentions: ms.map((m) => m.id), group: groups.get(f.id) };
  });
  const fixture = {
    generatedBy: 'devtools/scripts/semantic-bench-fixture.mjs',
    derivedFrom: { file: 'devtools/fixtures/recall-bilingual.json', sha256: crypto.createHash('sha256').update(baseBytes).digest('hex') },
    sets: base.sets,
    positions: {
      short: 'the fact\'s original text (≤ 101 characters): one piece, embedded as it is in either mode',
      over: `an over-window note — neutral filler to ${BEFORE.zh} (zh) / ${BEFORE.ja} (ja) / ${BEFORE.en} (en) characters, then the fact's content as its last text, whose first token sits past EmbeddingGemma's 2,048-token window`,
    },
    assignment: 'short and over alternate through each language\'s facts in fixture order — zh and ja start short, en starts over (the mixed fixture\'s phase)',
    mentionExcluded: MENTION_EXCLUDED,
    facts: out,
  };
  validateEmbed(base, fixture);
  return fixture;
}

/** Every property the header claims; throws on the first failure. */
export function validateEmbed(base, fixture) {
  const fail = (m) => { throw new Error(`embed fixture: ${m}`); };
  const baseById = new Map(base.facts.map((f) => [f.id, f]));
  if (fixture.facts.length !== base.facts.length) fail('fact count');
  const counts = {};
  for (const f of fixture.facts) {
    const b = baseById.get(f.id);
    if (!b || f.kind !== b.kind || f.topic !== b.topic || JSON.stringify(f.questions) !== JSON.stringify(b.questions)) fail(`${f.id}: not the base fact`);
    if (f.answer.text !== b.content) fail(`${f.id}: the answer is not the base content`);
    if (f.content.indexOf(b.content) !== f.answer.offset || f.content.lastIndexOf(b.content) !== f.answer.offset) fail(`${f.id}: the answer is not exactly once at its offset`);
    const elsewhere = fixture.facts.filter((g) => g.id !== f.id && g.content.includes(b.content)).map((g) => g.id);
    if (elsewhere.length) fail(`${f.id}: its answer also occurs in ${elsewhere.join(', ')}`);
    if (f.content.normalize('NFKC').length !== f.content.length) fail(`${f.id}: NFKC changes the length`);
    if (f.position === 'short' && (f.content !== b.content || f.content.length > 101)) fail(`${f.id}: a short fact is not its original text`);
    if (f.position === 'over') {
      if (f.answer.offset + f.answer.length !== f.content.length) fail(`${f.id}: the answer is not the note's last text`);
      if (f.answer.offset < BEFORE[languageOf(f)]) fail(`${f.id}: the answer starts at ${f.answer.offset}, before ${BEFORE[languageOf(f)]}`);
    }
    const key = `${languageOf(f)} ${f.position}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const want = { 'zh short': 20, 'zh over': 20, 'en short': 8, 'en over': 8, 'ja short': 2, 'ja over': 2 };
  for (const [k, n] of Object.entries(want)) if (counts[k] !== n) fail(`${k}: ${counts[k]} facts, not ${n}`);
  validatePools((m) => fail(m));
}

export const expectedEmbedBytes = () => { const { base, bytes } = readBase(); return Buffer.from(serialise(buildEmbedFixture(base, bytes)), 'utf8'); };

/** Tokenize every text on EmbeddingGemma (a dedicated CPU llama-server, the pinned GGUF): where each over-window note's
 *  answer starts, and each text's length, in tokens. */
async function measureEmbed(fixture) {
  const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).slice(n.length + 3);
  const res = path.resolve(arg('resources', ''));
  if (!arg('resources', '')) throw new Error('--measure needs --resources=<a folder holding llama-cpp/ and gguf/>');
  const exe = path.join(res, 'llama-cpp', 'llama-server.exe');
  const file = path.join(res, 'gguf', 'embeddinggemma-300M-Q8_0.gguf');
  const catalogue = fs.readFileSync(path.join(repo, 'src', 'server', 'Gatherlight.Platform', 'Agent', 'Llm', 'Services', 'GgufCatalog.cs'), 'utf8');
  const pinned = /"embeddinggemma-300M-Q8_0\.gguf",\s*"([0-9a-f]{64})"/.exec(catalogue)?.[1];
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual !== pinned) throw new Error(`${file} is not the pinned file`);
  const port = Number(arg('port', '7820'));
  const child = spawn(exe, ['-m', file, '--port', String(port), '--host', '127.0.0.1', '--embeddings', '--n-gpu-layers', '0',
    '-b', String(EMBED_WINDOW), '-ub', String(EMBED_WINDOW)], { stdio: 'ignore', windowsHide: true });
  const base = `http://127.0.0.1:${port}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let up = false;
    for (let t = 0; t < 480 && !up; t++) { try { up = (await fetch(`${base}/health`)).ok; } catch { /* not yet */ } if (!up) await sleep(250); }
    if (!up) throw new Error('llama-server did not become healthy');
    const tok = async (content) => (await (await fetch(`${base}/tokenize`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, add_special: false }) })).json()).tokens.length;
    const rows = { short: [], over: [] };
    for (const f of fixture.facts) {
      const total = await tok(f.content);
      const before = f.position === 'over' ? await tok(f.content.slice(0, f.answer.offset)) : 0;
      rows[f.position].push({ id: f.id, lang: languageOf(f), chars: f.content.length, total, before });
    }
    const range = (xs) => `${Math.min(...xs)}–${Math.max(...xs)}`;
    console.log(`EmbeddingGemma (pinned, CPU llama-server pid ${child.pid}); window ${EMBED_WINDOW}, ${SPECIAL_TOKENS} specials per input`);
    console.log(`  short: ${rows.short.length} texts, ${range(rows.short.map((r) => r.chars))} characters, ${range(rows.short.map((r) => r.total))} tokens`);
    for (const lang of ['zh', 'en', 'ja']) {
      const o = rows.over.filter((r) => r.lang === lang);
      console.log(`  over · ${lang}: ${o.length} notes, ${range(o.map((r) => r.chars))} characters, ${range(o.map((r) => r.total))} tokens; the answer starts at token ${range(o.map((r) => r.before))}`);
    }
    const inside = rows.over.filter((r) => r.before + SPECIAL_TOKENS <= EMBED_WINDOW);
    console.log(`  over-window notes whose answer starts INSIDE the window: ${inside.length} (the design says 0)`);
    return inside.length === 0;
  } finally { child.kill(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bytes = expectedEmbedBytes();
  if (process.argv.includes('--check')) {
    const same = fs.existsSync(EMBED_FIXTURE) && Buffer.compare(fs.readFileSync(EMBED_FIXTURE), bytes) === 0;
    console.log(same ? 'recall-bilingual-embed.json matches the generator' : 'recall-bilingual-embed.json does NOT match the generator');
    process.exit(same ? 0 : 1);
  } else if (process.argv.includes('--measure')) {
    process.exit((await measureEmbed(JSON.parse(fs.readFileSync(EMBED_FIXTURE, 'utf8')))) ? 0 : 1);
  } else {
    fs.writeFileSync(EMBED_FIXTURE, bytes);
    const fx = JSON.parse(bytes.toString('utf8'));
    const over = fx.facts.filter((f) => f.position === 'over');
    console.log(`wrote ${path.relative(repo, EMBED_FIXTURE)}: ${fx.facts.length} facts (${over.length} over-window), BEFORE ${JSON.stringify(BEFORE)}`);
    for (const lang of ['zh', 'en', 'ja']) {
      const o = over.filter((f) => languageOf(f) === lang).map((f) => f.content.length);
      console.log(`  over · ${lang}: ${o.length} notes, ${Math.min(...o)}–${Math.max(...o)} characters`);
    }
  }
}
