// Gatherlight devtools dispatcher (family pattern: one entry, allow-listed once).
//   node devtools/dev.mjs server [port]     - run the headless server (dotnet; data folder ./local)
//   node devtools/dev.mjs vite              - run the client dev server (HMR, proxies /api)
//   node devtools/dev.mjs build             - client build -> wwwroot + dotnet build
//   node devtools/dev.mjs e2e [p1..|all]    - API-level end-to-end suites (isolated data folders)
//   node devtools/dev.mjs test-data         - regenerate the synthetic fixture data folder
//   node devtools/dev.mjs install-hooks     - git core.hooksPath -> devtools/hooks (pre-commit guard)
//   node devtools/dev.mjs check-sensitive   - scan staged changes (--tree for all tracked files)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './project.config.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...args] = process.argv.slice(2);

const run = (exe, argv, opts = {}) => {
  const r = spawnSync(exe, argv, { stdio: 'inherit', cwd: repo, shell: false, ...opts });
  process.exitCode = r.status ?? 1;
};

switch (cmd) {
  case 'server': {
    const port = args[0] ?? String(config.serverPort);
    run('dotnet', ['run', '--project', config.serverProject], {
      env: { ...process.env, GATHERLIGHT_PORT: port },
    });
    break;
  }

  case 'vite':
    run('npm', ['run', 'dev'], { cwd: path.join(repo, config.clientDir), shell: true });
    break;

  case 'build': {
    const clientDir = path.join(repo, config.clientDir);
    if (fs.existsSync(path.join(clientDir, 'package.json'))) {
      const c = spawnSync('npm', ['run', 'build'], { cwd: clientDir, stdio: 'inherit', shell: true });
      if (c.status !== 0) { process.exitCode = c.status ?? 1; break; }
    } else {
      console.log(`(no client at ${config.clientDir} yet — building server only)`);
    }
    run('dotnet', ['build', config.solution, '-v', 'minimal']);
    break;
  }

  case 'test-data':
    run('node', [path.join(repo, 'devtools', 'scripts', 'make-test-data.mjs'), ...args]);
    break;

  case 'fetch-tools': {
    // Playwright chromium for the browser-backed tools (web_fetch + scraper ports).
    // One-time per machine; the server NEVER downloads browsers at startup.
    const script = path.join(repo, config.serverProject, 'bin', 'Debug', 'net10.0', 'playwright.ps1');
    if (!fs.existsSync(script)) {
      console.error('build first (dotnet build) — playwright.ps1 lands in the server bin.');
      process.exitCode = 1;
      break;
    }
    run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'install', 'chromium']);
    break;
  }

  case 'install-hooks':
    // Point git at the tracked hooks dir so the sensitive-info pre-commit guard runs (a clone only
    // needs this once — core.hooksPath is local config, the hook script itself is versioned).
    run('git', ['config', 'core.hooksPath', 'devtools/hooks']);
    console.log('git hooks installed (core.hooksPath = devtools/hooks). Pre-commit runs check-sensitive.');
    break;

  case 'check-sensitive':
    run('node', [path.join(repo, 'devtools', 'scripts', 'check-sensitive.mjs'), ...args]);
    break;

  case 'e2e': {
    const which = args[0] ?? 'all';
    const all = fs.readdirSync(path.join(repo, 'devtools', 'scripts'))
      .filter((f) => /^e2e-p\d+\.mjs$/.test(f))
      .map((f) => f.slice(4, -4))
      .sort();
    const suites = which === 'all' ? all : [which];
    if (suites.length === 0) { console.log('no e2e suites yet'); break; }
    for (const suite of suites) {
      const r = spawnSync('node', [path.join(repo, 'devtools', 'scripts', `e2e-${suite}.mjs`)],
        { stdio: 'inherit', cwd: repo });
      if (r.status !== 0) { process.exitCode = r.status ?? 1; break; }
    }
    break;
  }

  default:
    console.log('usage: node devtools/dev.mjs <server|vite|build|e2e|test-data|install-hooks|check-sensitive>');
    process.exitCode = cmd ? 1 : 0;
}
