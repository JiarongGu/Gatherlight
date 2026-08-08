#!/usr/bin/env node
// check-tool-docs.mjs — every tool the agent CAN call must be a tool the agent is TOLD about.
//
// Registering an IGatherlightTool makes it reachable; it does not make it used. `remember_fact` and
// `recall_facts` shipped, were discoverable over MCP, passed e2e — and sat at 16 stored facts with
// ZERO recalls, because nothing in the seeded knowledge base ever mentioned them. Every other tool
// had a row in the CLAUDE.md tool table; these did not, so the agent had no reason to reach for them.
// Nothing failed. That is the point: this is a silent gap, and only a check like this one closes it.
//
// Sibling of check-ui-registry: static, no server, runs in CI. Same failure shape — two lists that
// must agree with nothing but this to notice when they don't.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const appCs = path.join(repo, 'src', 'server', 'Gatherlight.Server', 'GatherlightApp.cs');
const serverDir = path.join(repo, 'src', 'server');
const template = path.join(repo, 'src', 'server', 'Gatherlight.Server', 'Assets', 'SiteTemplate');
const claudeMd = path.join(template, 'CLAUDE.md');
const toolLoader = path.join(template, '.claude', 'skills', 'tool-loader', 'SKILL.md');

const errors = [];
const rel = (p) => path.relative(repo, p).replace(/\\/g, '/');

// 1. Registered tool CLASSES: every AddSingleton<IGatherlightTool, X>() in the composition root.
const classes = (() => {
  if (!fs.existsSync(appCs)) { errors.push(`missing ${rel(appCs)}`); return []; }
  const body = fs.readFileSync(appCs, 'utf8');
  return [...body.matchAll(/AddSingleton<IGatherlightTool,\s*(?:[A-Za-z0-9_.]*\.)?([A-Za-z0-9_]+)>/g)]
    .map((m) => m[1]);
})();

// 2. Each class's advertised NAME — the string the agent actually calls. Read from the class's
//    `public string Name => "..."`, because the class name and the tool name differ by convention
//    (RememberFactTool -> remember_fact) and guessing the mapping would be its own drift.
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === 'bin' || e.name === 'obj' ? [] : walk(p);
  return p.endsWith('.cs') ? [p] : [];
});
const sources = fs.existsSync(serverDir) ? walk(serverDir) : [];

const nameOf = (cls) => {
  for (const f of sources) {
    const body = fs.readFileSync(f, 'utf8');
    const at = body.indexOf(`class ${cls}`);
    if (at === -1) continue;
    // `override`/`virtual` because the document tools declare Name on a shared base.
    const m = /public\s+(?:override\s+|virtual\s+)?string\s+Name\s*=>\s*"([^"]+)"/.exec(body.slice(at));
    if (m) return m[1];
  }
  return null;
};

const tools = [];
for (const cls of classes) {
  const name = nameOf(cls);
  if (!name) { errors.push(`could not read the tool name from class ${cls} — is its \`Name =>\` a literal?`); continue; }
  if (!tools.includes(name)) tools.push(name);
}
if (tools.length === 0) errors.push('no IGatherlightTool registrations found — did the DI block move?');

// 3. The two agent-facing docs the seeder ships. A tool must appear in BOTH: CLAUDE.md is loaded
//    every session (so the tool exists at all), and the tool-loader routing is what actually sends
//    the agent to it for a given task.
const docs = [
  { path: claudeMd, label: 'the template CLAUDE.md tool table (loaded every session)' },
  { path: toolLoader, label: 'the tool-loader skill (task -> tool routing)' },
];
for (const d of docs) {
  if (!fs.existsSync(d.path)) { errors.push(`missing ${rel(d.path)}`); d.body = ''; continue; }
  d.body = fs.readFileSync(d.path, 'utf8');
}

// Tools that legitimately need no row: internal plumbing the agent never calls by name.
const EXEMPT = new Set([]);

for (const name of tools) {
  if (EXEMPT.has(name)) continue;
  const missing = docs.filter((d) => !d.body.includes(name));
  // A family documented under a wildcard (`pdf_*`, `image_*`, `library_*`, `job_*`) counts as told:
  // the catalog rows genuinely cover the group, and demanding one row per member would be noise.
  const family = name.replace(/_.*$/, '_');
  const covered = (d) => d.body.includes(name) || d.body.includes(`${family}*`);
  const reallyMissing = missing.filter((d) => !covered(d));
  for (const d of reallyMissing) errors.push(`tool \`${name}\` is registered but absent from ${d.label} — ${rel(d.path)}`);
}

if (errors.length) {
  console.error('check-tool-docs: FAILED\n');
  for (const e of errors) console.error('  - ' + e);
  console.error('\nA registered tool the knowledge base never mentions is one the agent has no reason');
  console.error('to call. Add it to the template CLAUDE.md tool table AND the tool-loader routing');
  console.error('(say WHEN to reach for it, not just that it exists), or add it to EXEMPT with a reason.');
  process.exit(1);
}

console.log(`check-tool-docs: clean — ${tools.length} registered tools, all named in the shipped knowledge base.`);
