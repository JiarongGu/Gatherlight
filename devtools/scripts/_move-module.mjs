#!/usr/bin/env node
// _move-module.mjs — one-shot Phase A helper. git-mv a module folder and rewrite its namespace
// plus every reference to it across the server sources. Deleted when Phase A completes.
//
//   node devtools/scripts/_move-module.mjs Core Platform/Kernel
//   node devtools/scripts/_move-module.mjs Security Platform/Hosting/Security
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverRoot = path.join(repo, 'src', 'server', 'Gatherlight.Server');
// The rewrite must also cover Gatherlight.Host — a separate project (its own .csproj) that
// references these namespaces but doesn't build as part of Gatherlight.Server. Walk both roots
// when rewriting; module path resolution (from/to) stays scoped to serverRoot only.
const rewriteRoots = [serverRoot, path.join(repo, 'src', 'server', 'Gatherlight.Host')];
const [module, dest] = process.argv.slice(2);
if (!module || !dest) { console.error('usage: _move-module.mjs <ModuleName> <Dest/Path>'); process.exit(1); }

const from = path.join(serverRoot, 'Modules', module);
const to = path.join(serverRoot, ...dest.split('/'));
if (!fs.existsSync(from)) { console.error(`no such module: Modules/${module}`); process.exit(1); }
if (fs.existsSync(to)) {
  console.error(`destination already exists: ${dest}\nif a previous run failed, recover with: git reset --hard  (then remove the stale folder)`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(to), { recursive: true });
execFileSync('git', ['mv', from, to], { cwd: repo, stdio: 'inherit' });

const oldNs = `Gatherlight.Server.Modules.${module}`;
const newNs = `Gatherlight.Server.${dest.split('/').join('.')}`;

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'obj' && e.name !== 'bin') walk(abs, out); }
    else if (e.name.endsWith('.cs')) out.push(abs);
  }
  return out;
};

let touched = 0;
try {
  for (const root of rewriteRoots) {
    if (!fs.existsSync(root)) continue;
    for (const abs of walk(root)) {
      const body = fs.readFileSync(abs, 'utf8');
      const next = body.split(oldNs).join(newNs);
      if (next !== body) { fs.writeFileSync(abs, next); touched++; }
    }
  }
} catch (err) {
  console.error(`namespace rewrite failed after the move: ${err.message}`);
  console.error(`the folder moved but only ${touched} file(s) were rewritten — recover with: git reset --hard`);
  process.exit(1);
}
console.log(`moved Modules/${module} → ${dest}  (${oldNs} → ${newNs}, ${touched} files touched)`);
