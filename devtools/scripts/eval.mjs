#!/usr/bin/env node
// Prompt/agent playground — an eval harness against a RUNNING Gatherlight server (Mastra's runEvals).
// Runs each scenario through a DRY plan (read-only, no commit), auto-scores the output on the quality
// dimensions, and prints a per-scenario + aggregate table. Run it before + after tuning the cortex
// (校准 tab / settings) to see whether a prompt/model change actually improves the scores.
//
//   node devtools/scripts/eval.mjs [scenarios.json] [--model haiku] [--port 5317]
//   node devtools/dev.mjs eval [...]
// Scenarios default to devtools/eval-scenarios.json: [{ "name": "...", "message": "..." }, ...].
// Needs an authenticated claude CLI (it spawns a real plan per scenario) — this is a deliberate,
// occasionally-run tuning tool, not part of the app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const model = flag('--model');
const port = flag('--port') || process.env.GATHERLIGHT_PORT || '5317';
const file = args.find((a) => !a.startsWith('--') && a !== model && a !== port) || path.join(repo, 'devtools', 'eval-scenarios.json');
const base = `http://127.0.0.1:${port}`;

if (!fs.existsSync(file)) { console.error(`scenarios file not found: ${file}`); process.exit(1); }
let scenarios;
try { scenarios = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('bad scenarios JSON:', e.message); process.exit(1); }
if (!Array.isArray(scenarios) || scenarios.length === 0) { console.error('scenarios must be a non-empty array of { name, message }'); process.exit(1); }

console.log(`\n\x1b[1meval\x1b[0m  ${scenarios.length} scenario(s)${model ? ` · model ${model}` : ''} · ${base}\n`);
console.log('  running dry plans + scoring (spawns claude per scenario — this takes a while)…\n');

const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), Math.max(120000, scenarios.length * 180000));
let run;
try {
  const res = await fetch(`${base}/api/manage/eval/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenarios, model }), signal: ctrl.signal,
  });
  if (!res.ok) { console.error(`eval failed — server responded ${res.status}. Is it running on ${base}?`); process.exit(1); }
  run = await res.json();
} catch (e) {
  console.error(`eval failed — is the server running on ${base}? (${e.message})`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}

const SHORT = { 'plan-structure': 'struct', citations: 'cite', 'answer-relevancy': 'relev', faithfulness: 'faith' };
const cols = [...new Set(run.results.flatMap((r) => Object.keys(r.scores)))].sort();
const cell = (v) => (v == null ? '  —  ' : v.toFixed(2).padStart(5));
const nameW = Math.max(10, ...run.results.map((r) => r.name.length));

const header = 'scenario'.padEnd(nameW) + '  ' + cols.map((c) => (SHORT[c] ?? c).padStart(6)).join(' ') + '   dur     tok';
console.log('  ' + header);
console.log('  ' + '─'.repeat(header.length));
for (const r of run.results) {
  const scores = cols.map((c) => cell(r.scores[c]).padStart(6)).join(' ');
  const dur = r.durationMs >= 1000 ? `${(r.durationMs / 1000).toFixed(1)}s` : `${r.durationMs}ms`;
  const tok = (r.inputTokens + r.outputTokens).toLocaleString();
  const line = r.name.padEnd(nameW) + '  ' + scores + `   ${dur.padStart(5)}  ${tok.padStart(6)}`;
  console.log('  ' + (r.error ? `\x1b[31m${r.name.padEnd(nameW)}  ERROR: ${r.error}\x1b[0m` : line));
}
console.log('  ' + '─'.repeat(header.length));
const agg = 'AGGREGATE'.padEnd(nameW) + '  ' + cols.map((c) => cell(run.aggregate[c]).padStart(6)).join(' ');
console.log('  \x1b[1m' + agg + '\x1b[0m');
console.log(`\n  model: ${run.model}\n  tip: tune the cortex (校准 tab / settings.json), then re-run to compare the aggregate.\n`);
