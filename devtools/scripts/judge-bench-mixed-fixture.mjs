#!/usr/bin/env node
// judge-bench-mixed-fixture.mjs — writes devtools/fixtures/recall-bilingual-mixed.json: the SAME 60 facts and the SAME
// 240 questions as recall-bilingual.json, HALF of them kept as they are (short, ≤ 101 characters) and half turned into
// LONG NOTES by Run 6's construction (judge-bench-long-fixture.mjs, `longNote`), with the answer at `end` or `beyond`.
// Deterministic and model-free: re-running it reproduces the committed file byte for byte, and `judge-bench
// --fixture=mixed` refuses to run when it does not (docs/judge-bench.md Run 9).
//
// WHY. Chunked reranking (ChunkedScoreProvider, the default since Run 6c) scores a long candidate in up to five windows
// and keeps its BEST window's score; a short fact is one window, sent as it is. So when long and short facts compete in
// one recall, a long note has several chances at a high score and a short fact has one. Runs 6–8 never showed that
// case: every candidate of a recall was long, or every one was short. Here half are each, in every recall.
//
// THE ASSIGNMENT, pre-registered by being committed (each fact carries its `position` and its near-duplicate `group`):
//   - short/long ALTERNATES through each language's facts in fixture order, so each language is half short, half long
//     (zh 20/20, en 8/8, ja 2/2). A near-duplicate group sits next to itself in the fixture, so alternation splits it
//     and a short fact competes with its own group's long note. zh and en must start on OPPOSITE lengths (PHASE): the
//     allergy pair (zh 花生过敏, en Shellfish allergy) is one fact in each, both at an even index, so otherwise it falls on
//     one length. zh starts SHORT, as plain alternation would, en LONG, and ja SHORT (either splits its group). Four of
//     the eight phase choices split all twelve groups; this is one. The build fails unless every group has a short AND a
//     long member.
//   - each language's LONG facts cycle end → beyond in fixture order: 15 each (zh 10/10, en 4/4, ja 1/1).
//   - a long note is `longNote(fact, position, mentionsOf(facts))` — byte for byte the note Run 6's generator builds for
//     that fact at that position: the same filler pool shuffled by the same seed, the same mentions of other facts BY
//     TOPIC at the same strides. A SHORT fact carries no mentions (it is its original text), so each fact is named only
//     by the long notes among its three mentioners: with the strides' parities, a short fact's topic by up to two long
//     notes, a long fact's by up to one. That is what puts a SHORT target's subject into long notes that do not answer
//     it — the case the question is about — and it is stated rather than balanced away.
//
// WHAT IS ENFORCED (validateMixed; the build fails otherwise): the facts, kinds, topics and questions are the base
// fixture's; every fact's original content occurs EXACTLY ONCE in the whole corpus, in its own text, at its declared
// offset; NFKC preserves every text's length; a short fact is one window for every reranker and every question (it
// fits mMiniLMv2's per-question budget, so chunking sends it whole, as the cut does); an `end` answer is past
// mMiniLMv2's cut for every question and inside 1,000 characters; a `beyond` answer starts past 1,000; the filler pools
// name no fixture subject; the balance above; every near-duplicate group split.
//
// Usage:
//   node devtools/scripts/judge-bench-mixed-fixture.mjs            write the fixture, and print the design's numbers
//   node devtools/scripts/judge-bench-mixed-fixture.mjs --check    exit 1 unless the committed file is what this writes
//   node devtools/scripts/judge-bench-mixed-fixture.mjs --measure --resources=devtools/_rr-res [--port=6250]
//       tokenize every text on dedicated CPU llama-servers (judge-bench-long-fixture.mjs's `measure`); scratch output
//       goes to devtools/_judge-bench-mixed/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MAX_CHARS, MENTION_EXCLUDED, minilmBudget, languageOf, byLanguage, mentionsOf, longNote, validatePools, serialise,
  readBase, measure,
} from './judge-bench-long-fixture.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MIXED_FIXTURE = path.join(repo, 'devtools', 'fixtures', 'recall-bilingual-mixed.json');

/** Where a fact's answer sits: its whole short text, or a long note's end / past 1,000 characters. */
export const MIXED_POSITIONS = ['short', 'end', 'beyond'];
const LONG_POSITIONS = ['end', 'beyond'];
/** The length each language's FIRST fact gets; the rest alternate. zh and en opposite, so every group is split (the header). */
const PHASE = { zh: 'short', en: 'long', ja: 'short' };

/** The fixture's near-duplicate groups exactly as judge-bench reads them (its `groupOf`, Run 7): a shared id prefix
 *  (mkt-east / mkt-west / mkt-harbor, …) and the three `-bill` facts; every other fact is a group of its own. */
export const groupsOf = (facts) => {
  const prefixOf = (id) => id.split('-')[0];
  const count = facts.reduce((m, f) => m.set(prefixOf(f.id), (m.get(prefixOf(f.id)) ?? 0) + 1), new Map());
  return new Map(facts.map((f) => [f.id, /-bill$/.test(f.id) ? '*-bill' : count.get(prefixOf(f.id)) > 1 ? `${prefixOf(f.id)}-*` : f.id]));
};

// ---- the build -----------------------------------------------------------------------------------------------------
/** The mixed fixture, from the bilingual fixture's parsed JSON and its raw bytes. Pure: same input, same output. */
export function buildMixedFixture(base, baseBytes) {
  const facts = base.facts;
  const position = new Map();
  for (const [lang, group] of Object.entries(byLanguage(facts))) {
    let k = 0;
    group.forEach((f, i) => {
      const long = (i % 2 === 0) === (PHASE[lang] === 'long');
      position.set(f.id, long ? LONG_POSITIONS[k++ % LONG_POSITIONS.length] : 'short');
    });
  }
  const mentions = mentionsOf(facts);
  const groups = groupsOf(facts);
  const out = facts.map((f) => {
    const pos = position.get(f.id);
    if (pos === 'short') {
      return {
        id: f.id, kind: f.kind, topic: f.topic, content: f.content, questions: f.questions,
        position: pos, answer: { text: f.content, offset: 0, length: f.content.length }, mentions: [], group: groups.get(f.id),
      };
    }
    const ms = mentions.get(f.id);
    const { note, offset } = longNote(f, pos, ms);
    return {
      id: f.id, kind: f.kind, topic: f.topic, content: note, questions: f.questions,
      position: pos, answer: { text: f.content, offset, length: f.content.length }, mentions: ms.map((m) => m.id),
      group: groups.get(f.id),
    };
  });
  const fixture = {
    generatedBy: 'devtools/scripts/judge-bench-mixed-fixture.mjs',
    derivedFrom: { file: 'devtools/fixtures/recall-bilingual.json', sha256: crypto.createHash('sha256').update(baseBytes).digest('hex') },
    sets: base.sets,
    positions: {
      short: 'the fact\'s original text (≤ 101 characters): one window for every reranker, read whole, sent as it is',
      end: 'a long note whose answer is its last text, at 880–960 characters — past mMiniLMv2\'s cut (≤ 490 characters) for every question, inside the 1,000-character cap',
      beyond: 'a long note whose answer starts at 1,060–1,120 characters and is its last text — past every reranker\'s cut',
    },
    assignment: 'short and long alternate through each language\'s facts in fixture order — zh and ja start short, en starts long, the phase that splits every near-duplicate group; each language\'s long facts cycle end → beyond; a long note is judge-bench-long-fixture.mjs\'s note for that fact at that position',
    mentionExcluded: MENTION_EXCLUDED,
    facts: out,
  };
  validateMixed(base, fixture);
  return fixture;
}

/** Every property the design claims, checked on the built fixture; throws on the first failure. */
export function validateMixed(base, fixture) {
  const fail = (m) => { throw new Error(`mixed fixture: ${m}`); };
  const baseById = new Map(base.facts.map((f) => [f.id, f]));
  if (fixture.facts.length !== base.facts.length) fail(`${fixture.facts.length} facts, the base has ${base.facts.length}`);
  for (const f of fixture.facts) {
    const b = baseById.get(f.id);
    if (!b) fail(`${f.id} is not in the base fixture`);
    if (f.kind !== b.kind || f.topic !== b.topic) fail(`${f.id}: kind or topic changed`);
    if (JSON.stringify(f.questions) !== JSON.stringify(b.questions)) fail(`${f.id}: questions changed`);
    if (f.answer.text !== b.content || f.answer.length !== b.content.length) fail(`${f.id}: the answer is not the base content`);
    if (!MIXED_POSITIONS.includes(f.position)) fail(`${f.id}: unknown position ${f.position}`);
    // The answer occurs exactly once in its own text, at its declared offset …
    if (f.content.indexOf(b.content) !== f.answer.offset || f.content.lastIndexOf(b.content) !== f.answer.offset)
      fail(`${f.id}: the answer is not exactly once at offset ${f.answer.offset}`);
    // … and in NO other text: otherwise that text would also answer this fact's questions.
    const elsewhere = fixture.facts.filter((g) => g.id !== f.id && g.content.includes(b.content)).map((g) => g.id);
    if (elsewhere.length) fail(`${f.id}: its answer also occurs in ${elsewhere.join(', ')}`);
    // Offsets hold under NFKC too, so the same number is mMiniLMv2's (normalised) and the cap's (raw).
    if (f.content.normalize('NFKC').length !== f.content.length) fail(`${f.id}: NFKC changes the text's length`);
    const s = f.answer.offset, L = f.answer.length, N = f.content.length;
    if (f.position === 'short') {
      if (f.content !== b.content || s !== 0) fail(`${f.id}: a short fact is not its original text`);
      if (f.mentions.length) fail(`${f.id}: a short fact mentions ${f.mentions.join(', ')}`);
      // ONE window for every reranker and every question: chunking sends it whole, exactly as the cut does.
      for (const q of Object.values(f.questions))
        if (N > minilmBudget(q)) fail(`${f.id}: ${N} characters do not fit mMiniLMv2's ${minilmBudget(q)} for "${q}"`);
      if (N > MAX_CHARS) fail(`${f.id}: ${N} characters do not fit the 1,000-character cap`);
      continue;
    }
    // A long note's answer is its LAST text, past mMiniLMv2's cut for every question; inside 1,000 at `end`, past it
    // at `beyond`.
    if (s + L !== N) fail(`${f.id}: the answer is not the note's last text`);
    for (const q of Object.values(f.questions))
      if (s < minilmBudget(q)) fail(`${f.id}: mMiniLMv2 reads ${minilmBudget(q)} characters for "${q}", answer at ${s}–${s + L}`);
    if (f.position === 'end' && (s + L > MAX_CHARS || s + L < 880 || s + L > 960)) fail(`${f.id}: an end answer ends at ${s + L}`);
    if (f.position === 'beyond' && (s < 1060 || s > 1120)) fail(`${f.id}: a beyond answer starts at ${s}`);
    for (const id of f.mentions) {
      if (id === f.id) fail(`${f.id} mentions itself`);
      if (MENTION_EXCLUDED.includes(id)) fail(`${f.id} mentions ${id}, whose topic carries part of its answer`);
      if (!f.content.includes(baseById.get(id).topic)) fail(`${f.id}: mention of ${id} is not in the note`);
    }
  }
  validatePools(fail);
  // Balance: half short, half long, in every language; the long half split evenly between end and beyond, in every
  // language too.
  const byLang = byLanguage(fixture.facts);
  for (const [lang, fs_] of Object.entries(byLang)) {
    const n = (p) => fs_.filter((f) => f.position === p).length;
    if (2 * n('short') !== fs_.length) fail(`${lang}: ${n('short')} short of ${fs_.length}`);
    if (n('end') !== n('beyond')) fail(`${lang}: ${n('end')} end, ${n('beyond')} beyond`);
  }
  // Every near-duplicate group has a short AND a long member, so a short fact competes with its own group's long note.
  const groups = new Map();
  for (const f of fixture.facts) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
  if (JSON.stringify([...groupsOf(fixture.facts)]) !== JSON.stringify(fixture.facts.map((f) => [f.id, f.group]))) fail('a group field is not groupOf\'s');
  for (const [g, fs_] of groups)
    if (fs_.length > 1 && (!fs_.some((f) => f.position === 'short') || !fs_.some((f) => f.position !== 'short')))
      fail(`near-duplicate group ${g} (${fs_.map((f) => `${f.id}:${f.position}`).join(', ')}) is not split into short and long`);
  if (new Set(fixture.facts.map((f) => f.content)).size !== fixture.facts.length) fail('two texts are identical');
}

export const expectedMixedBytes = () => { const { base, bytes } = readBase(); return Buffer.from(serialise(buildMixedFixture(base, bytes)), 'utf8'); };

// ---- the design's numbers ------------------------------------------------------------------------------------------
// RerankInputCap.WindowSpans, restated (MaxWindows 5, a quarter's overlap, the last window at the tail) — the same
// geometry Run 6b's design table used. What the cut reads is the first window.
const MAX_WINDOWS = 5, OVERLAP_DIVISOR = 4;
const windowSpans = (length, size) => {
  if (length <= size) return [[0, length]];
  const stride = Math.max(1, size - Math.floor(size / OVERLAP_DIVISOR));
  const n = Math.min(MAX_WINDOWS, 1 + Math.floor((length - size + stride - 1) / stride));
  if (n === 1) return [[0, size]];
  const span = length - size;
  return Array.from({ length: n }, (_, i) => { const s = Math.floor((i * span) / (n - 1)); return [s, Math.min(length, s + size)]; });
};
const inside = ([a, b], [s, e]) => s <= a && b <= e;
const summarise = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? `${s[0]}–${s[s.length - 1]} (median ${s[Math.floor((s.length - 1) / 2)]})` : '—';
};
const MODELS = [
  { name: 'mMiniLMv2', size: (q) => minilmBudget(q) },
  { name: 'BGE/LAMAR', size: () => MAX_CHARS },
];

function printReport(fixture) {
  const facts = fixture.facts;
  console.log('\nposition  n   by language      answer offset (chars)          answer end (chars)             text length (chars)            mMiniLMv2 reads, per question');
  for (const p of MIXED_POSITIONS) {
    const fs_ = facts.filter((f) => f.position === p);
    const langs = Object.entries(byLanguage(fs_)).map(([l, xs]) => `${l} ${xs.length}`).join(', ');
    console.log(`${p.padEnd(9)} ${String(fs_.length).padEnd(3)} ${langs.padEnd(16)} ${summarise(fs_.map((f) => f.answer.offset)).padEnd(30)} `
      + `${summarise(fs_.map((f) => f.answer.offset + f.answer.length)).padEnd(30)} ${summarise(fs_.map((f) => f.content.length)).padEnd(30)} `
      + `${summarise(fs_.flatMap((f) => Object.values(f.questions).map(minilmBudget)))}`);
  }
  console.log('\nassignment (fixture order within each language):');
  for (const p of MIXED_POSITIONS) console.log(`  ${p.padEnd(7)} ${facts.filter((f) => f.position === p).map((f) => f.id).join(', ')}`);
  console.log('\nnear-duplicate groups (judge-bench\'s groupOf), each split into short and long:');
  const groups = new Map();
  for (const f of facts) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
  for (const [g, fs_] of groups) if (fs_.length > 1) console.log(`  ${g.padEnd(10)} ${fs_.map((f) => `${f.id} (${languageOf(f)}, ${f.position})`).join(' · ')}`);
  const mentioned = (f) => facts.filter((g) => g.mentions.includes(f.id)).length;
  const dist = (xs) => [0, 1, 2, 3].map((k) => `${k}: ${xs.filter((x) => x === k).length}`).join(', ');
  console.log(`\nhow many long notes name a fact's topic — short facts: ${dist(facts.filter((f) => f.position === 'short').map(mentioned))};`
    + ` long facts: ${dist(facts.filter((f) => f.position !== 'short').map(mentioned))}`);

  // WHAT CHUNKING SHOWS THAT THE CUT HID (measuring rule 1: can the instrument express the effect?). Per question: the
  // cut reads each candidate's first `size` characters; chunked, every window of it. For a SHORT target: does some long
  // note of its own group carry that note's ANSWER (a near-duplicate of the target's) outside the cut but inside a window,
  // and does some long note NAME the target's topic outside the cut but inside a window? For a LONG target: its own answer
  // inside the cut, and inside some window.
  console.log('\nwhat chunking shows a reranker that the cut hid, per question (240 questions; a window = RerankInputCap.WindowSpans):');
  for (const m of MODELS) {
    const shortQ = [], longQ = [];
    const windowsPerNote = { end: [], beyond: [] };
    for (const f of facts) for (const q of Object.values(f.questions)) {
      const size = m.size(q);
      const cut = [0, size];
      const wins = (g) => windowSpans(g.content.length, size);
      if (f.position !== 'short') windowsPerNote[f.position].push(wins(f).length);
      if (f.position === 'short') {
        const dups = facts.filter((g) => g.position !== 'short' && g.group === f.group && g.id !== f.id);
        const dupShown = dups.filter((g) => {
          const a = [g.answer.offset, g.answer.offset + g.answer.length];
          return !inside(a, cut) && wins(g).some((w) => inside(a, w));
        });
        const namers = facts.filter((g) => g.mentions.includes(f.id));
        const topicShown = namers.filter((g) => {
          const i = g.content.indexOf(f.topic);
          const a = [i, i + f.topic.length];
          return !inside(a, cut) && wins(g).some((w) => inside(a, w));
        });
        shortQ.push({ dups: dups.length, dupShown: dupShown.length, namers: namers.length, topicShown: topicShown.length });
      } else {
        const a = [f.answer.offset, f.answer.offset + f.answer.length];
        longQ.push({ position: f.position, inCut: inside(a, cut), inWindow: wins(f).some((w) => inside(a, w)) });
      }
    }
    const k = (xs, fn) => xs.filter(fn).length;
    console.log(`  ${m.name}: windows per long note — end ${summarise(windowsPerNote.end)}, beyond ${summarise(windowsPerNote.beyond)}; a short fact 1`);
    console.log(`    SHORT targets (${shortQ.length} questions): with a long near-duplicate in the recall's corpus ${k(shortQ, (x) => x.dups > 0)};`
      + ` whose near-duplicate's answer the cut hides and a window shows ${k(shortQ, (x) => x.dupShown > 0)};`
      + ` whose topic a long note names ${k(shortQ, (x) => x.namers > 0)}, outside the cut but inside a window ${k(shortQ, (x) => x.topicShown > 0)}`);
    for (const p of LONG_POSITIONS) {
      const xs = longQ.filter((x) => x.position === p);
      console.log(`    LONG targets at ${p.padEnd(6)} (${xs.length} questions): own answer inside the cut ${k(xs, (x) => x.inCut)}, inside some window ${k(xs, (x) => x.inWindow)}`);
    }
  }
}

// ---- CLI -----------------------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const want = expectedMixedBytes();
  if (process.argv.includes('--check')) {
    const have = fs.existsSync(MIXED_FIXTURE) ? fs.readFileSync(MIXED_FIXTURE) : Buffer.alloc(0);
    if (!have.equals(want)) { console.error('recall-bilingual-mixed.json is not what the generator writes — re-run it'); process.exit(1); }
    console.log('recall-bilingual-mixed.json matches the generator');
  } else if (!process.argv.includes('--measure')) {
    fs.writeFileSync(MIXED_FIXTURE, want);
    console.log(`wrote ${path.relative(repo, MIXED_FIXTURE).split(path.sep).join('/')} (sha256 ${crypto.createHash('sha256').update(want).digest('hex')})`);
  }
  const fixture = JSON.parse(want.toString('utf8'));
  printReport(fixture);
  if (process.argv.includes('--measure'))
    await measure(fixture, { fixtureFile: MIXED_FIXTURE, positions: MIXED_POSITIONS, dir: path.join(repo, 'devtools', '_judge-bench-mixed') });
}
