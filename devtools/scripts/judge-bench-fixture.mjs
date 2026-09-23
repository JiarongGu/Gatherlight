#!/usr/bin/env node
// judge-bench-fixture.mjs — writes devtools/fixtures/recall-bilingual.json: the authored facts
// (recall-bilingual.facts.json) plus four questions each, generated through the CLI so they are written
// independently of whoever wrote the facts. Re-runnable: a fact whose topic and content are unchanged keeps
// its questions, so editing one fact costs one call, not sixty.
// The questions are written with `--model sonnet`, so the fixture does not depend on the CLI's default model.
//
// THE COMMITTED FIXTURE IS HAND-REVIEWED, not raw output: 76 of 240 questions were edited in 096add7, and the
// four Japanese facts' Chinese `third` questions were written by hand in f1771cd (the reuse guard keeps an
// unchanged fact's questions whole, so a prompt change never reaches them). So never delete
// recall-bilingual.json and regenerate to "clean it up" — that discards the review. To regenerate ONE fact,
// change its topic/content in the facts file (or delete that fact's entry from the output) and re-run; then
// re-review its four questions: answered by its own fact only, no copied distinctive words, language per key.
//
// Usage: node devtools/scripts/judge-bench-fixture.mjs      (uses the signed-in claude CLI)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askAll, resolveClaude, QUESTION_SETS } from './recall-questions.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FACTS = path.join(repo, 'devtools', 'fixtures', 'recall-bilingual.facts.json');
const OUT = path.join(repo, 'devtools', 'fixtures', 'recall-bilingual.json');

const facts = JSON.parse(fs.readFileSync(FACTS, 'utf8'));
const dup = facts.map((f) => f.id).find((id, i, a) => a.indexOf(id) !== i);
if (dup) { console.error(`duplicate fact id: ${dup}`); process.exit(1); }
const held = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { facts: [] };
const prior = new Map(held.facts.map((f) => [f.id, f]));
const claude = resolveClaude();

let asked = 0;
const failed = [];
const out = facts.map((f) => {
  const was = prior.get(f.id);
  if (was && was.topic === f.topic && was.content === f.content && was.questions) return { ...f, questions: was.questions };
  let q = null;
  for (let attempt = 0; attempt < 2 && !q; attempt++) q = askAll(claude, f, 'sonnet');
  asked++;
  process.stdout.write(`\r  questions: ${asked} fact(s) asked…   `);
  if (!q) failed.push(f.id);
  return { ...f, questions: q };
});

fs.writeFileSync(OUT, JSON.stringify({
  generatedBy: 'devtools/scripts/judge-bench-fixture.mjs',
  sets: QUESTION_SETS.map((s) => s.key),
  facts: out,
}, null, 2) + '\n', 'utf8');
console.log(`\nwrote ${out.length} facts (${asked} asked, ${failed.length} failed${failed.length ? `: ${failed.join(', ')}` : ''})`);
process.exit(failed.length ? 1 : 0);
