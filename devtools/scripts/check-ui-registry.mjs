#!/usr/bin/env node
// check-ui-registry.mjs — the component vocabulary lives in TWO languages: an IUiNodeSchema per
// component in C# (the enforcement point) and a renderer per component in TypeScript. Nothing but
// this check would notice them drifting apart — the compiler cannot see across the wire, and a
// component in the schema with no renderer is a blank space in the user's page.
//
// Static, not a live request: it must run in CI and pre-merge without a server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const appCs = path.join(repo, 'src', 'server', 'Gatherlight.Server', 'GatherlightApp.cs');
const registryTs = path.join(repo, 'src', 'client', 'src', 'ui', 'blocks', 'registry.ts');

const errors = [];

// Server side: every AddSingleton<IUiNodeSchema, XSchema>() registration.
const serverTypes = (() => {
  if (!fs.existsSync(appCs)) { errors.push(`missing ${path.relative(repo, appCs)}`); return []; }
  const body = fs.readFileSync(appCs, 'utf8');
  return [...body.matchAll(/AddSingleton<IUiNodeSchema,\s*([A-Za-z0-9_]+)Schema>/g)]
    .map((m) => m[1]).sort();
})();

// Client side: the exported UI_COMPONENTS list, read from the RENDERERS map's keys.
const clientTypes = (() => {
  if (!fs.existsSync(registryTs)) { errors.push(`missing ${path.relative(repo, registryTs)}`); return []; }
  const body = fs.readFileSync(registryTs, 'utf8');
  const block = /export const RENDERERS[^{]*{([\s\S]*?)\n};/.exec(body);
  if (!block) { errors.push('could not find the RENDERERS map in registry.ts'); return []; }
  return [...block[1].matchAll(/(?:^|[\s,{])([A-Z][A-Za-z0-9_]*)\s*(?:,|$|:)/gm)]
    .map((m) => m[1])
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
})();

if (serverTypes.length === 0) errors.push('no IUiNodeSchema registrations found — did the DI block move?');

const onlyServer = serverTypes.filter((t) => !clientTypes.includes(t));
const onlyClient = clientTypes.filter((t) => !serverTypes.includes(t));
for (const t of onlyServer) errors.push(`'${t}' has a server schema but no client renderer`);
for (const t of onlyClient) errors.push(`'${t}' has a client renderer but no server schema`);

if (errors.length) {
  console.error('\x1b[31m✖ UI registry drift\x1b[0m');
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`check-ui-registry: clean — ${serverTypes.length} components, schema and renderer agree.`);
process.exit(0);
