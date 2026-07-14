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
//   node devtools/scripts/build-production.mjs [rid] [--skip-client] [--offline] [--zip]
// The .NET runtime is embedded (target machine needs nothing). By default the bundle is LEAN:
// chromium + git are provisioned at first-run setup (资源 · Resources downloads them into the data
// folder), not shipped — keeping the zip small. --offline bundles them for air-gapped installs. The
// authenticated `claude` CLI is always a host prerequisite — see docs/DEPLOYMENT.md.
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
// The zip is a release/CI artifact — `dev.mjs publish` produces the runnable folder; `--zip` (CI)
// also packages it. `--skip-chromium` skips the ~150 MB browser bundle for fast local iteration.
const doZip = args.includes('--zip');
const skipChromium = args.includes('--skip-chromium');
// LEAN by default: chromium (~120 MB) + git (~37 MB) are provisioned at SETUP (the 资源 · Resources
// panel downloads them into the data folder), NOT shipped — keeps the zip small. --offline bundles
// them for an air-gapped install where the target can't download.
const offline = args.includes('--offline');
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

// Ship the Playwright driver next to the host so the browser-backed scrapers resolve it. The
// single-file publish STRIPS the driver's native node.exe (into self-extract), leaving
// .playwright/node incomplete → "Driver not found". Copy the COMPLETE driver from the non-single-file
// Server Debug bin (build it if absent). node.exe (~80 MB) rides along.
let playwrightBundled = false;
const debugPw = path.join(repo, config.serverProject, 'bin', 'Debug', 'net10.0', '.playwright');
if (!fs.existsSync(path.join(debugPw, 'node', 'win32_x64', 'node.exe'))) {
  console.log('  (building Debug for the complete Playwright driver…)');
  spawnSync('dotnet', ['build', config.serverProject, '-c', 'Debug', '--nologo', '-v', 'q'], { stdio: 'inherit', cwd: repo });
}
if (fs.existsSync(path.join(debugPw, 'node', 'win32_x64', 'node.exe'))) {
  fs.cpSync(debugPw, path.join(libs, '.playwright'), { recursive: true });
  playwrightBundled = true;
  console.log('  \x1b[32m✔\x1b[0m libs/.playwright/  (driver + node.exe)');
} else {
  console.log('  \x1b[33m⚠ Playwright driver not bundled — scrapers will need it installed on the host.\x1b[0m');
}

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

// 3.6 portable git (MinGit): download-at-setup by default (the server provisions it into
// {data}/state/resources/git — GitCliService resolves that first). --offline bundles it into libs/git/
// for air-gapped installs. Cached under devtools/_cache/.
step(3.6, offline ? 'bundling portable git (MinGit)…' : 'git → download-at-setup (lean bundle)');
const MINGIT_VER = '2.55.0.2';
const MINGIT_URL = `https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.2/MinGit-${MINGIT_VER}-64-bit.zip`;
let gitBundled = false;
if (!offline) {
  console.log('  (skipped — provisioned at setup via 资源 · Resources; falls back to git on PATH)');
} else if (rid === 'win-x64') {
  const cacheDir = path.join(repo, 'devtools', '_cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const zip = path.join(cacheDir, `MinGit-${MINGIT_VER}-64-bit.zip`);
  try {
    if (!fs.existsSync(zip)) {
      console.log(`  downloading ${path.basename(zip)} (~37 MB)…`);
      const dl = spawnSync('curl', ['-fsSL', '-o', zip, MINGIT_URL], { stdio: 'inherit' });
      if (dl.status !== 0 || !fs.existsSync(zip)) throw new Error('download failed');
    }
    const gitDir = path.join(libs, 'git');
    const ex = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -Path '${zip}' -DestinationPath '${gitDir}' -Force`], { stdio: 'inherit' });
    if (ex.status !== 0 || !fs.existsSync(path.join(gitDir, 'cmd', 'git.exe'))) throw new Error('extract failed');
    gitBundled = true;
    const mb = (spawnSync('powershell', ['-NoProfile', '-Command',
      `'{0:N0}' -f ((Get-ChildItem -Recurse '${gitDir}' | Measure-Object Length -Sum).Sum/1MB)`], { encoding: 'utf8' }).stdout || '').trim();
    console.log(`  \x1b[32m✔\x1b[0m libs/git/  (MinGit ${MINGIT_VER}, ~${mb} MB)`);
  } catch (e) {
    console.log(`  \x1b[33m⚠ portable git not bundled (${e.message}) — the host will need git on PATH.\x1b[0m`);
  }
} else {
  console.log(`  (portable git is win-x64 only; ${rid} needs git on PATH)`);
}

// 3.7 Playwright chromium: download-at-setup by default (the 资源 panel runs the bundled driver's
// playwright.ps1 install into {data}/state/resources/browsers — PlaywrightHost resolves that first).
// --offline bundles it into libs/browsers for air-gapped installs. Needs the bundled driver (3 above).
step(3.7, offline ? 'bundling Playwright chromium…' : 'chromium → download-at-setup (lean bundle)');
let chromiumBundled = false;
if (!offline || rid !== 'win-x64' || skipChromium || !playwrightBundled) {
  console.log(`  (skipped — ${!offline ? 'lean; provisioned at setup via 资源 · Resources' : skipChromium ? '--skip-chromium' : !playwrightBundled ? 'no bundled driver' : rid})`);
} else {
  const browsersDir = path.join(libs, 'browsers');
  const ps1 = path.join(repo, config.serverProject, 'bin', 'Debug', 'net10.0', 'playwright.ps1');
  if (!fs.existsSync(ps1)) {
    console.log('  ⚠ Playwright driver (Debug bin) unavailable — skipping chromium.');
  } else {
    console.log('  installing chromium (~150 MB download)…');
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, 'install', 'chromium'],
      { stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir } });
    if (r.status === 0 && fs.existsSync(browsersDir) && fs.readdirSync(browsersDir).some((d) => d.startsWith('chromium'))) {
      chromiumBundled = true;
      // Scraping only ever launches Headless=true → the headless shell. Drop the full (headed)
      // chromium (~280 MB) + ffmpeg (video capture) — verified the shell alone runs every scraper.
      for (const d of fs.readdirSync(browsersDir))
        if (d.startsWith('ffmpeg') || (d.startsWith('chromium-') && !d.includes('headless')))
          fs.rmSync(path.join(browsersDir, d), { recursive: true, force: true });
      const mb = (spawnSync('powershell', ['-NoProfile', '-Command',
        `'{0:N0}' -f ((Get-ChildItem -Recurse '${browsersDir}' | Measure-Object Length -Sum).Sum/1MB)`], { encoding: 'utf8' }).stdout || '').trim();
      console.log(`  \x1b[32m✔\x1b[0m libs/browsers/  (chromium, ~${mb} MB)`);
    } else {
      console.log('  \x1b[33m⚠ chromium not bundled (install failed) — run playwright.ps1 install on the host.\x1b[0m');
    }
  }
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
  '  libs\\             程序(自包含,含 .NET 运行时' + (gitBundled ? ' + 内置 git' : '') + ') / the self-contained app' + (gitBundled ? ' + bundled git' : ''),
  '  res\\              资源:网页客户端 + 知识库模板 / web client + knowledge-base template',
  '  data\\             你的数据(计划/家庭/知识库/SQLite)—— 备份这个文件夹 / your data — back this up',
  '',
  '迁移记忆 / Transfer memory:',
  '  把导出的记忆文件改名为 seed-memory.json 放在本目录,启动时自动导入;或在控制台点「导入记忆」。',
  '  Put an exported memory bundle here as seed-memory.json → auto-imported on startup; or use the console.',
  '',
  '前置 / Prerequisites:',
  '  · git —— ' + (gitBundled
    ? '已内置于 libs\\git(数据仓库引擎,无需另装) / bundled in libs\\git (the data-repo engine; no install needed)'
    : '首次在控制台「资源 · Resources」一键下载(或系统已装 git) / download once from the 资源 · Resources panel (or git on PATH)'),
  '  · 已登录的 claude CLI —— 仅 AI 规划需要,浏览/导入无需 / an authenticated claude CLI — only for AI planning (browsing/import work without it)',
  '  · chromium(仅网页抓取工具)—— ' + (chromiumBundled
    ? '已内置于 libs\\browsers,无需安装 / bundled in libs\\browsers (no install needed)'
    : '首次在控制台「资源 · Resources」一键下载 / download once from the 资源 · Resources panel'),
  '',
  `v${version} · ${rid}`,
  '',
].join('\r\n'));

// 5. manifest — { path, sha256, size } per shipped file (excludes data/, .update/, and the manifest
// itself). Array shape so the auto-updater (C++ launcher apply + C# staged-file verify) can diff it.
step(5, 'writing manifest…');
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(bundle, abs).split(path.sep).join('/');
    // Exclude user data, staging, and the bundled-once Playwright runtime (driver ~80 MB + chromium
    // ~150 MB — version-locked, changes only on a Playwright bump, i.e. a full reinstall).
    if (rel === 'manifest.json' || rel === 'data' || rel.startsWith('data/') || rel === '.update' || rel.startsWith('.update/')
      || rel.startsWith('libs/browsers/') || rel.startsWith('libs/.playwright/')) continue;
    if (e.isDirectory()) walk(abs);
    else {
      const buf = fs.readFileSync(abs);
      files.push({ path: rel, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length });
    }
  }
};
walk(bundle);
fs.writeFileSync(path.join(bundle, 'manifest.json'),
  JSON.stringify({ product: config.name, version, rid, files }, null, 2) + '\n');

// 6. zip the bundle folder — ONLY with --zip (a release/CI artifact). `dev.mjs publish` leaves the
// runnable folder; the zip is what CI uploads to a GitHub release.
let zip = null, zipped = false;
if (doZip) {
  step(6, 'zipping (release artifact)…');
  zip = path.join(dist, `${config.name}-${version}-${rid}.zip`);
  const zr = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Compress-Archive -Path '${bundle}' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' });
  zipped = zr.status === 0 && fs.existsSync(zip);
}

// summary
const exeMb = (fs.statSync(path.join(libs, 'Gatherlight.Host.exe')).size / 1048576).toFixed(0);
console.log(`\n\x1b[32m✔ bundle\x1b[0m  dist/Gatherlight/  (exe ${exeMb} MB, ${files.length} manifest files + bundled runtime, sha256 manifest)`);
console.log(`  layout:   ${launcherBuilt ? 'Gatherlight.exe · ' : ''}Gatherlight.cmd · libs/${gitBundled ? ' +git' : ''}${chromiumBundled ? ' +chromium' : ''}${playwrightBundled ? ' +driver' : ''} · res/ · data/`);
console.log(`  git:      ${gitBundled ? 'bundled (libs/git) — no host git install needed' : '⚠ NOT bundled — host needs git on PATH'}`);
console.log(`  scrapers: ${playwrightBundled && chromiumBundled ? 'bundled driver + chromium — work out of the box' : playwrightBundled ? 'driver bundled; chromium via playwright.ps1 install' : 'dev-only (no driver bundled)'}`);
if (doZip) console.log(zipped ? `  package:  dist/${path.basename(zip)}  (${(fs.statSync(zip).size / 1048576).toFixed(0)} MB)` : '  ⚠ zip failed');
else console.log('  package:  (folder only — pass --zip for the release .zip)');
console.log(`  run:      dist/Gatherlight/${launcherBuilt ? 'Gatherlight.exe' : 'Gatherlight.cmd'}`);
console.log('  see docs/DEPLOYMENT.md\n');
