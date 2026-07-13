#!/usr/bin/env node
// build-production.mjs — produce the shippable Gatherlight desktop bundle in a clear layout:
//
//   dist/Gatherlight/
//     Gatherlight.cmd     launcher — double-click to run (sets data path + optional memory seed)
//     README.txt          how to run / transfer memory / prerequisites
//     manifest.json       sha256 of every shipped file (for update verification)
//     libs/               the self-contained single-file host (runtime + assemblies) + playwright.ps1
//     res/                wwwroot (web planner) + template (knowledge-base seed)
//     data/               the data folder — user data lands here (back this up)
//   dist/Gatherlight-<version>-<rid>.zip   the whole bundle, zipped
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
// GATHERLIGHT_VERSION lets CI stamp the release tag without editing project.config.mjs.
const version = process.env.GATHERLIGHT_VERSION || config.version || '0.0.0';

const dist = path.join(repo, 'dist');
const bundle = path.join(dist, 'Gatherlight');
const stage = path.join(dist, '_stage');
const libs = path.join(bundle, 'libs');
const res = path.join(bundle, 'res');
const data = path.join(bundle, 'data');

const step = (n, msg) => console.log(`\x1b[36m[${n}]\x1b[0m ${msg}`);
const die = (msg) => { console.error(`\x1b[31m✖ ${msg}\x1b[0m`); process.exit(1); };
const runOr = (exe, argv, opts, err) => {
  const r = spawnSync(exe, argv, { stdio: 'inherit', cwd: repo, ...opts });
  if (r.status !== 0) die(err);
};

// Locate MSBuild via vswhere (VS2022+/Build Tools). Returns null when no C++ toolchain is installed.
const findMsBuild = () => {
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = path.join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return null;
  const r = spawnSync(vswhere, ['-latest', '-prerelease', '-requires', 'Microsoft.Component.MSBuild',
    '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'], { encoding: 'utf8' });
  const hit = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((s) => s.endsWith('MSBuild.exe') && fs.existsSync(s));
  return hit ?? null;
};

console.log(`\n\x1b[1mGatherlight production bundle\x1b[0m  v${version} · ${rid}\n`);

// 1. client → src/server/Gatherlight.Server/wwwroot
if (!skipClient) {
  step(1, 'building client…');
  runOr('npm', ['run', 'build'], { cwd: path.join(repo, config.clientDir), shell: true }, 'client build failed');
}
if (!fs.existsSync(path.join(repo, config.serverProject, 'wwwroot', 'index.html'))) {
  die('client build missing (wwwroot/index.html) — run without --skip-client');
}

// 2. publish the host (self-contained single-file) into a staging dir
step(2, 'publishing host (self-contained single-file)…');
fs.rmSync(dist, { recursive: true, force: true });
runOr('dotnet', ['publish', config.hostProject, '-c', 'Release', '-r', rid, '-o', stage,
  '--self-contained',
  '-p:PublishSingleFile=true',
  '-p:IncludeNativeLibrariesForSelfExtract=true',
  '-p:EnableCompressionInSingleFile=true',
  '-p:PublishReadyToRun=true',
  '-p:DebugType=none',
  `-p:Version=${version}`,
], {}, 'dotnet publish failed');

// 3. reorganize the flat publish into libs/ res/ data/
step(3, 'arranging libs / res / data…');
fs.mkdirSync(libs, { recursive: true });
fs.mkdirSync(res, { recursive: true });
fs.mkdirSync(data, { recursive: true });

const move = (from, to) => { if (fs.existsSync(from)) fs.renameSync(from, to); };
move(path.join(stage, 'Gatherlight.Host.exe'), path.join(libs, 'Gatherlight.Host.exe'));
move(path.join(stage, 'playwright.ps1'), path.join(libs, 'playwright.ps1'));
move(path.join(stage, 'wwwroot'), path.join(res, 'wwwroot'));
move(path.join(stage, 'Assets', 'DataTemplate'), path.join(res, 'template'));
fs.writeFileSync(path.join(data, '.gitkeep'), '');
fs.rmSync(stage, { recursive: true, force: true });

for (const need of [path.join(libs, 'Gatherlight.Host.exe'), path.join(res, 'wwwroot', 'index.html'), path.join(res, 'template', 'CLAUDE.md')]) {
  if (!fs.existsSync(need)) die(`expected in bundle but missing: ${path.relative(bundle, need)}`);
}

// 3.5 native C++ launcher → top-level Gatherlight.exe (carries the app icon; launches libs/host).
// Needs the MSVC toolchain; where it's absent (a dev box without C++ tools) we fall back to the
// Gatherlight.cmd launcher written below — the bundle still works, just without a native exe.
step(3.5, 'building native launcher (C++)…');
let launcherBuilt = false;
if (rid === 'win-x64') {
  const msbuild = findMsBuild();
  if (!msbuild) {
    console.log('  \x1b[33m⚠ MSBuild not found — skipping the native launcher (Gatherlight.cmd will be the launcher).\x1b[0m');
  } else {
    const proj = path.join(repo, 'src', 'launcher', 'Gatherlight.Launcher.vcxproj');
    const r = spawnSync(msbuild, [proj, '/p:Configuration=Release', '/p:Platform=x64', '/t:Rebuild', '/m', '/v:minimal', '/nologo'],
      { stdio: 'inherit', cwd: repo });
    const built = path.join(repo, 'src', 'launcher', 'bin', 'x64', 'Release', 'Gatherlight.exe');
    if (r.status === 0 && fs.existsSync(built)) {
      fs.copyFileSync(built, path.join(bundle, 'Gatherlight.exe'));
      launcherBuilt = true;
      console.log(`  \x1b[32m✔\x1b[0m Gatherlight.exe  (${(fs.statSync(built).size / 1024).toFixed(0)} KB)`);
    } else {
      die('native launcher build failed');
    }
  }
} else {
  console.log(`  (native launcher is win-x64 only; ${rid} uses Gatherlight.cmd)`);
}

// 4. launcher + README
step(4, 'writing launcher + README…');
fs.writeFileSync(path.join(bundle, 'Gatherlight.cmd'),
  '@echo off\r\n' +
  'setlocal\r\n' +
  'set "ROOT=%~dp0"\r\n' +
  'set "GATHERLIGHT_DATA=%ROOT%data"\r\n' +
  'if exist "%ROOT%seed-memory.json" set "GATHERLIGHT_SEED_MEMORY=%ROOT%seed-memory.json"\r\n' +
  'start "" "%ROOT%libs\\Gatherlight.Host.exe" %*\r\n');

const runLine = launcherBuilt ? 'Gatherlight.exe' : 'Gatherlight.cmd';
fs.writeFileSync(path.join(bundle, 'README.txt'), [
  'Gatherlight · 拾光 — 桌面管理端 / Desktop management host',
  '',
  '启动 / Run:',
  `  双击 ${runLine}。托盘出现「拾」图标 + 管理控制台窗口;规划界面在浏览器中打开。`,
  `  Double-click ${runLine}. A tray icon + the management console open; the planner opens in a browser.`,
  '',
  '结构 / Layout:',
  '  Gatherlight.exe   启动器(原生,带图标) / native launcher (with icon)',
  '  Gatherlight.cmd   启动器(备用) / launcher (fallback)',
  '  libs\\             程序(自包含,含 .NET 运行时) / the self-contained app',
  '  res\\              资源:网页客户端 + 知识库模板 / web client + knowledge-base template',
  '  data\\             你的数据(计划/家庭/知识库/SQLite)—— 备份这个文件夹 / your data — back this up',
  '',
  '迁移记忆 / Transfer memory:',
  '  把导出的记忆文件改名为 seed-memory.json 放在本目录,启动时自动导入;或在控制台点「导入记忆」。',
  '  Put an exported memory bundle here as seed-memory.json → auto-imported on startup; or use the console.',
  '',
  '前置(不随包分发) / Prerequisites (not bundled):',
  '  · 已登录的 claude CLI —— AI 规划 / an authenticated claude CLI for AI planning',
  '  · chromium(仅网页抓取工具,一次性): pwsh libs\\playwright.ps1 install chromium',
  '',
  `v${version} · ${rid}`,
  '',
].join('\r\n'));

// 5. manifest — sha256 of every shipped file (excludes data/ + the manifest itself)
step(5, 'writing manifest…');
const files = {};
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(bundle, abs).split(path.sep).join('/');
    if (rel === 'manifest.json' || rel === 'data' || rel.startsWith('data/')) continue;
    if (e.isDirectory()) walk(abs);
    else files[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  }
};
walk(bundle);
fs.writeFileSync(path.join(bundle, 'manifest.json'),
  JSON.stringify({ product: config.name, version, rid, files }, null, 2) + '\n');

// 6. zip the bundle folder
step(6, 'zipping…');
const zip = path.join(dist, `${config.name}-${version}-${rid}.zip`);
const zr = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  `Compress-Archive -Path '${bundle}' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' });
const zipped = zr.status === 0 && fs.existsSync(zip);

// summary
const exeMb = (fs.statSync(path.join(libs, 'Gatherlight.Host.exe')).size / 1048576).toFixed(0);
console.log(`\n\x1b[32m✔ bundle\x1b[0m  dist/Gatherlight/  (exe ${exeMb} MB, ${Object.keys(files).length} files, sha256 manifest)`);
console.log(`  layout:   ${launcherBuilt ? 'Gatherlight.exe · ' : ''}Gatherlight.cmd · libs/ · res/ · data/`);
if (zipped) console.log(`  package:  dist/${path.basename(zip)}  (${(fs.statSync(zip).size / 1048576).toFixed(0)} MB)`);
console.log(`  run:      dist/Gatherlight/${launcherBuilt ? 'Gatherlight.exe' : 'Gatherlight.cmd'}`);
console.log('  seed:     drop an exported memory bundle as dist/Gatherlight/seed-memory.json');
console.log('  see docs/DEPLOYMENT.md\n');
