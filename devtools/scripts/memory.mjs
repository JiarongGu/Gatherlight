#!/usr/bin/env node
// Memory export/import against a RUNNING Gatherlight server (dev/admin helper).
//   node devtools/scripts/memory.mjs export [outfile] [port]
//   node devtools/scripts/memory.mjs import <infile>  [port]
// The bundle is the DB half of memory (knowledge library + learned facts + entity store); markdown
// plans/household travel with the data folder's git repo. Transfer it to a new install, or load it
// at startup with GATHERLIGHT_SEED_MEMORY.
import fs from 'node:fs';

const [sub, arg, portArg] = process.argv.slice(2);
const port = portArg || process.env.GATHERLIGHT_PORT || '5317';
const base = `http://127.0.0.1:${port}`;

if (sub === 'export') {
  const out = arg || `gatherlight-memory-${new Date().toISOString().slice(0, 10)}.json`;
  const res = await fetch(`${base}/api/memory/export`).catch(() => null);
  if (!res || !res.ok) {
    console.error(`export failed — is the server running on ${base}? (${res?.status ?? 'no response'})`);
    process.exit(1);
  }
  const text = await res.text();
  fs.writeFileSync(out, text, 'utf8');
  const b = JSON.parse(text);
  console.log(`✔ exported → ${out}  (library ${b.library.length}, knowledge ${b.knowledge.length}, entities ${b.entities.length})`);
} else if (sub === 'import') {
  if (!arg) { console.error('usage: memory import <infile> [port]'); process.exit(1); }
  const body = fs.readFileSync(arg, 'utf8');
  const res = await fetch(`${base}/api/memory/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  }).catch(() => null);
  const j = res ? await res.json().catch(() => null) : null;
  if (!res || !res.ok) { console.error('import failed:', j?.error ?? res?.status ?? 'no response'); process.exit(1); }
  console.log('✔ imported', JSON.stringify(j.imported));
} else {
  console.error('usage: memory <export [outfile] | import <infile>> [port]');
  process.exit(1);
}
