#!/usr/bin/env node
// check-layering.mjs — enforces the one architectural rule of the platform track:
//
//     Platform/ must never reference Product/.
//
// A module is Platform if it survives the planner being replaced by a different site — i.e. it
// knows nothing about plans, trips, budgets, household or travel. The map below is the record of
// that judgement; a module missing from it is an error, because "unclassified" is exactly the
// state this check exists to prevent. See docs/superpowers/specs/2026-08-04-site-model-container-design.md
//
// The reference check is a plain textual match, so a mention of the Product namespace inside a
// comment or string trips it too — deliberate: a checker that is too strict is safe, one that is
// too loose is not.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverSrc = path.join(repo, 'src', 'server', 'Gatherlight.Server');

// group → modules. Every module must appear exactly once.
export const LAYERS = {
  'Platform/Kernel': [''],
  'Platform/Site': ['Seed'],
  'Platform/Hosting': ['Security', 'Update', 'Resources', 'Migration', 'Settings', 'Fluent'],
  'Platform/Agent': ['Llm', 'Chat'],
  'Platform/Capabilities': ['Tools', 'McpClient', 'Documents'],
  'Platform/Storage': ['Library', 'Knowledge', 'Memory', 'Files', 'DataRepo', 'Backup'],
  'Platform/Ops': ['Jobs', 'Trace', 'Scoring', 'Eval', 'Playground', 'Cortex'],
  'Product/Planner': ['PlanIndex', 'Scrapers'],
};

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'obj' && e.name !== 'bin') walk(abs, out); }
    else if (e.name.endsWith('.cs')) out.push(abs);
  }
  return out;
};

const errors = [];
const files = walk(path.join(serverSrc, 'Platform')).concat(walk(path.join(serverSrc, 'Product')));

if (files.length === 0) {
  errors.push('no files under Platform/ or Product/ — the reshuffle has not run yet');
}

for (const abs of files) {
  const rel = path.relative(serverSrc, abs).split(path.sep).join('/');
  const body = fs.readFileSync(abs, 'utf8');
  if (!rel.startsWith('Platform/')) continue;
  // A Platform file may not name the Product namespace root or any sub-namespace, in a using or
  // fully qualified.
  const hit = body.match(/\bGatherlight\.Server\.Product\b/);
  if (hit) errors.push(`${rel} references ${hit[0]} — Platform must never reference Product`);
}

// Every remaining Modules/ folder is unclassified.
const legacy = path.join(serverSrc, 'Modules');
if (fs.existsSync(legacy)) {
  for (const e of fs.readdirSync(legacy, { withFileTypes: true }))
    if (e.isDirectory()) errors.push(`Modules/${e.name} is unclassified — place it under Platform/ or Product/`);
}

if (errors.length) {
  console.error('\x1b[31m✖ layering violations\x1b[0m');
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`check-layering: clean — ${files.length} files, Platform never references Product.`);
process.exit(0);
