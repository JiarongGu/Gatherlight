#!/usr/bin/env node
// build-production.mjs — produce the shippable Gatherlight desktop bundle.
//
// Output: dist/  (self-contained single-file management host + loose resources + update manifest)
//   Gatherlight.Host.exe   the tray management console; hosts the server in-process + monitors health
//   wwwroot/               the built React planner (served to browsers)
//   Assets/DataTemplate/   knowledge-base template (ZhikuSeeder scaffolds new data folders from it)
//   playwright.ps1         one-time chromium install for the scraper tools
//   manifest.json          sha256 of every file (version + rid) — for update verification
// plus a sibling zip:  dist/Gatherlight-<version>-<rid>.zip
//
//   node devtools/scripts/build-production.mjs [rid] [--skip-client]
// The .NET runtime is embedded (target machine needs nothing). The authenticated `claude` CLI and
// (for scrapers) a Playwright chromium remain host prerequisites — see docs/DEPLOYMENT.md.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../project.config.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const rid = args.find((a) => !a.startsWith('--')) ?? 'win-x64';
const skipClient = args.includes('--skip-client');
const version = config.version ?? '0.0.0';
const outDir = path.join(repo, 'dist');

const step = (n, msg) => console.log(`\x1b[36m[${n}]\x1b[0m ${msg}`);
const die = (msg) => { console.error(`\x1b[31m✖ ${msg}\x1b[0m`); process.exit(1); };
const runOr = (exe, argv, opts, err) => {
  const r = spawnSync(exe, argv, { stdio: 'inherit', cwd: repo, ...opts });
  if (r.status !== 0) die(err);
};

console.log(`\n\x1b[1mGatherlight production build\x1b[0m  v${version} · ${rid} · self-contained\n`);

// 1. client → src/server/Gatherlight.Server/wwwroot
if (!skipClient) {
  step(1, 'building client…');
  runOr('npm', ['run', 'build'], { cwd: path.join(repo, config.clientDir), shell: true }, 'client build failed');
}
if (!fs.existsSync(path.join(repo, config.serverProject, 'wwwroot', 'index.html'))) {
  die('client build missing (wwwroot/index.html) — run without --skip-client');
}

// 2. clean + publish the Host (single file embeds assemblies + native libs; wwwroot / DataTemplate /
//    playwright.ps1 land loose beside the exe via AppContext.BaseDirectory).
step(2, 'publishing host (self-contained single-file)…');
fs.rmSync(outDir, { recursive: true, force: true });
runOr('dotnet', ['publish', config.hostProject, '-c', 'Release', '-r', rid, '-o', outDir,
  '--self-contained',
  '-p:PublishSingleFile=true',
  '-p:IncludeNativeLibrariesForSelfExtract=true',
  '-p:EnableCompressionInSingleFile=true',
  '-p:PublishReadyToRun=true',
  '-p:DebugType=none',
  `-p:Version=${version}`,
], {}, 'dotnet publish failed');

// 3. tidy: drop the referenced Server's stray apphost + debug/doc files — the one obvious app exe
//    is Gatherlight.Host.exe.
step(3, 'tidying output…');
for (const stray of ['Gatherlight.Server.exe', 'Gatherlight.Server.pdb', 'Gatherlight.Host.pdb',
  'Gatherlight.Server.runtimeconfig.json']) {
  fs.rmSync(path.join(outDir, stray), { force: true });
}
for (const f of fs.readdirSync(outDir)) {
  if (f.endsWith('.xml') || f.endsWith('.pdb')) fs.rmSync(path.join(outDir, f), { force: true });
}
for (const need of ['Gatherlight.Host.exe', 'wwwroot/index.html', 'Assets/DataTemplate']) {
  if (!fs.existsSync(path.join(outDir, need))) die(`expected in bundle but missing: ${need}`);
}

// 4. update manifest — sha256 of every file (relative), written last so it doesn't hash itself.
step(4, 'writing update manifest…');
const files = {};
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs);
    else {
      const rel = path.relative(outDir, abs).split(path.sep).join('/');
      if (rel === 'manifest.json') continue;
      files[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  }
};
walk(outDir);
fs.writeFileSync(path.join(outDir, 'manifest.json'),
  JSON.stringify({ product: config.name, version, rid, files }, null, 2) + '\n');

// 5. zip the bundle for distribution (PowerShell Compress-Archive — Windows target).
step(5, 'zipping…');
const zip = path.join(repo, 'dist', `${config.name}-${version}-${rid}.zip`);
fs.rmSync(zip, { force: true });
const zr = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  `Compress-Archive -Path '${outDir}\\*' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' });
const zipped = zr.status === 0 && fs.existsSync(zip);

// summary
const exe = path.join(outDir, 'Gatherlight.Host.exe');
const mb = (fs.statSync(exe).size / 1048576).toFixed(0);
const fileCount = Object.keys(files).length;
console.log(`\n\x1b[32m✔ built\x1b[0m  dist/  (${fileCount} files, exe ${mb} MB, manifest sha256 x${fileCount})`);
if (zipped) console.log(`  package:  dist/${path.basename(zip)}  (${(fs.statSync(zip).size / 1048576).toFixed(0)} MB)`);
else console.log('  (zip step skipped/failed — the dist/ folder is still complete)');
console.log(`  run:      dist/Gatherlight.Host.exe   (tray management console; hosts the web app)`);
console.log('  scrapers: pwsh dist/playwright.ps1 install chromium   (once)');
console.log('  see docs/DEPLOYMENT.md\n');
