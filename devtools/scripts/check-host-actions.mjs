#!/usr/bin/env node
// check-host-actions.mjs — the desktop app's web→host protocol lives in TWO languages: a `case` per
// action in AppHost.cs (the handler) and the HostAction union in lib/host.ts (the callers). Nothing
// but this check would notice them drifting apart.
//
// The failure it exists to catch is SILENT IN BOTH DIRECTIONS. Rename a case in C# and the button
// still posts its message; `TryGetWebMessageAsString` reads it, the switch matches nothing, and the
// message is dropped with no log, no exception and no visible difference from a slow action. Add a
// case in C# with no caller and the capability simply does not exist while every check stays green.
// Neither side can see the other — the wire is a string.
//
// Static, not a live request: it must run without a server, and without the desktop host, which only
// exists on Windows.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hostCs = path.join(repo, 'src', 'server', 'Gatherlight.Host', 'AppHost.cs');
const hostTs = path.join(repo, 'src', 'client', 'src', 'lib', 'host.ts');

const errors = [];

// C# side: the `case "x":` labels of OnHostMessage's switch. Bounded to that method so an unrelated
// switch elsewhere in the file cannot contribute actions.
const serverActions = (() => {
  if (!fs.existsSync(hostCs)) { errors.push(`missing ${path.relative(repo, hostCs)}`); return []; }
  const body = fs.readFileSync(hostCs, 'utf8');
  const method = /private\s+async\s+void\s+OnHostMessage\b[\s\S]*?\n    }\n/.exec(body);
  if (!method) { errors.push('could not find OnHostMessage in AppHost.cs'); return []; }
  return [...method[0].matchAll(/case\s+"([^"]+)"\s*:/g)].map((m) => m[1]).sort();
})();

// Client side: the HostAction union members.
const clientActions = (() => {
  if (!fs.existsSync(hostTs)) { errors.push(`missing ${path.relative(repo, hostTs)}`); return []; }
  const body = fs.readFileSync(hostTs, 'utf8');
  const union = /export type HostAction =([\s\S]*?);/.exec(body);
  if (!union) { errors.push('could not find the HostAction union in lib/host.ts'); return []; }
  return [...union[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
})();

if (serverActions.length === 0) errors.push('no case labels found in OnHostMessage — did the switch move?');

const onlyServer = serverActions.filter((a) => !clientActions.includes(a));
const onlyClient = clientActions.filter((a) => !serverActions.includes(a));
for (const a of onlyServer) errors.push(`'${a}' is handled by AppHost.cs but absent from the HostAction union`);
for (const a of onlyClient) errors.push(`'${a}' is in the HostAction union but AppHost.cs handles no such case`);

// The two PREFIXED messages are parsed by StartsWith rather than the switch, so they are checked by
// name: both parsers live in C# and the helpers that build them live in host.ts. A prefix renamed on
// one side is the same silent drop as a missing case.
const prefixes = [
  { wire: 'theme:', helper: 'hostTheme' },
  { wire: 'close:', helper: 'hostClose' },
];
if (fs.existsSync(hostCs) && fs.existsSync(hostTs)) {
  const cs = fs.readFileSync(hostCs, 'utf8');
  const ts = fs.readFileSync(hostTs, 'utf8');
  for (const { wire, helper } of prefixes) {
    if (!cs.includes(`StartsWith("${wire}"`)) errors.push(`AppHost.cs no longer parses the '${wire}' prefix that ${helper} posts`);
    if (!ts.includes(`\`${wire}`)) errors.push(`lib/host.ts no longer builds the '${wire}' message AppHost.cs parses`);
  }
}

// No component may bypass the module — that is how the three divergent copies happened. The seam is
// allowed exactly one implementation.
const clientRoot = path.join(repo, 'src', 'client', 'src');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
  return /\.tsx?$/.test(e.name) ? [p] : [];
});
if (fs.existsSync(clientRoot)) {
  for (const file of walk(clientRoot)) {
    if (path.resolve(file) === path.resolve(hostTs)) continue;
    const body = fs.readFileSync(file, 'utf8');
    for (const [i, line] of body.split('\n').entries()) {
      if (line.includes('//')) continue;
      if (/chrome\s*(\?)?\.\s*webview|__gatherlightHost/.test(line))
        errors.push(`${path.relative(repo, file)}:${i + 1} reaches chrome.webview directly — use lib/host.ts`);
    }
  }
}

if (errors.length) {
  console.error('check-host-actions: FAILED');
  for (const e of errors) console.error(`  · ${e}`);
  process.exit(1);
}
console.log(`check-host-actions: clean — ${serverActions.length} actions + ${prefixes.length} prefixed messages agree across AppHost.cs and lib/host.ts.`);
