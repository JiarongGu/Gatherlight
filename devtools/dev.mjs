// Gatherlight devtools dispatcher (family pattern: one entry, allow-listed once).
//   node devtools/dev.mjs server [port]     - run the headless server (dotnet; DEV only)
//   node devtools/dev.mjs host [start|kill|restart] [--dev] - desktop console (hosts + monitors);
//                                            --dev exposes the WebView2 over CDP for UI automation
//   node devtools/dev.mjs shot [name]       - capture the desktop host window (PrintWindow) -> devtools/_shots/
//   node devtools/dev.mjs vite              - run the client dev server (HMR, proxies /api)
//   node devtools/dev.mjs build             - client build -> wwwroot + dotnet build
//   node devtools/dev.mjs publish [rid] [--zip] [--skip-chromium] - build the runnable bundle folder
//                                            (dist/Gatherlight/: host + git + Playwright driver +
//                                            chromium); --zip also packages the release .zip (CI)
//   node devtools/dev.mjs e2e [all|pN|pN-pM|p1,p3] [--build] [--parallel[=N]] - API e2e suites
//   node devtools/dev.mjs smoke             - real-claude two-gate smoke (opt-in; needs auth CLI)
//   node devtools/dev.mjs memory <export|import> [file] - transfer DB memory (needs a running server)
//   node devtools/dev.mjs test-data         - regenerate the synthetic fixture data folder
//   node devtools/dev.mjs install-hooks     - git core.hooksPath -> devtools/hooks (pre-commit guard)
//   node devtools/dev.mjs check-sensitive   - scan staged changes (--tree for all tracked files)
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

  case 'new-tool': {
    // Scaffold a hot-loadable script tool into the data folder (see docs/TOOLS.md).
    const name = args[0];
    if (!name || !/^[a-z0-9_-]+$/.test(name)) {
      console.error('usage: node devtools/dev.mjs new-tool <kebab-or-snake-name> [dataDir]');
      process.exitCode = 1;
      break;
    }
    const dataDir = path.resolve(repo, args[1] ?? process.env.GATHERLIGHT_DATA ?? 'local');
    const dir = path.join(dataDir, 'tools', name);
    if (fs.existsSync(path.join(dir, 'tool.json'))) {
      console.error(`already exists: ${dir}`);
      process.exitCode = 1;
      break;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tool.json'), JSON.stringify({
      name,
      description: `TODO: what ${name} does (shown to the agent + in /api/tools)`,
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'TODO: describe the argument' } },
        required: ['text'],
      },
      command: { exe: 'node', args: ['run.mjs'] },
      timeoutSeconds: 60,
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'run.mjs'), [
      '// Args arrive as JSON on stdin; print the result to stdout (stderr = logs). Exit 0 = ok.',
      "const chunks = [];",
      "for await (const c of process.stdin) chunks.push(c);",
      "const args = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
      "process.stdout.write(JSON.stringify({ echo: args.text }));",
      '',
    ].join('\n'));
    console.log(`scaffolded ${dir} — the running server hot-loads it (no rebuild); edit tool.json + run.mjs.`);
    break;
  }

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

  case 'smoke':
    run('node', [path.join(repo, 'devtools', 'scripts', 'smoke-real-claude.mjs')]);
    break;

  case 'memory':
    // export/import the DB memory (knowledge library + facts) against a running server.
    run('node', [path.join(repo, 'devtools', 'scripts', 'memory.mjs'), ...args]);
    break;

  case 'eval':
    // prompt/agent playground: run scenarios through a dry plan + score them (against a running server).
    run('node', [path.join(repo, 'devtools', 'scripts', 'eval.mjs'), ...args]);
    break;

  case 'host': {
    // The desktop management console (hosts the server in-process + monitors health). This is the
    // "proper" way to run Gatherlight; `server` (dotnet run) stays for dev iteration.
    const sub = args[0] ?? 'start';
    const exe = path.join(repo, config.hostProject, 'bin', 'Debug', config.hostTfm, `${config.hostProcess}.exe`);
    if (sub === 'kill' || sub === 'restart') {
      spawnSync('taskkill', ['/IM', `${config.hostProcess}.exe`, '/F'], { stdio: 'ignore' });
      if (sub === 'kill') { console.log('host stopped.'); break; }
    }
    if (!fs.existsSync(exe)) {
      console.error(`host exe not found — run \`node devtools/dev.mjs build\` first.\n  (${exe})`);
      process.exitCode = 1;
      break;
    }
    // --dev: expose the embedded WebView2 over CDP (Chrome DevTools Protocol) so the desktop UI can be
    // driven for tests. A UNIQUE user-data-folder per run is required — WebView2 shares the browser
    // process across instances with the same folder, and a pre-existing one ignores these args.
    const env = { ...process.env };
    if (args.includes('--dev')) {
      const port = 9333 + Math.floor(Math.random() * 400);
      env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
      env.GATHERLIGHT_WEBVIEW_USERDATA = path.join(repo, 'devtools', `_webview2-dev`);
      fs.writeFileSync(path.join(repo, 'devtools', '_cdp-port'), String(port));
      console.log(`host --dev: WebView2 CDP on ${port} (devtools/_cdp-port)`);
    }
    // Detached so the tray app keeps running after this command returns.
    const child = spawn(exe, args.filter((a) => a !== '--dev').slice(1), { detached: true, stdio: 'ignore', cwd: repo, env });
    child.unref();
    console.log(`launched ${config.hostProcess} (management console + in-process server). Look for the tray icon.`);
    break;
  }

  case 'shot': {
    const name = args[0] ?? `host-${new Date().toISOString().slice(11, 19).replaceAll(':', '')}`;
    run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(repo, 'devtools', 'scripts', 'shot-window.ps1'),
      '-ProcessName', config.hostProcess,
      '-OutFile', path.join(repo, 'devtools', '_shots', `${name}.png`)]);
    break;
  }

  case 'publish':
    // Full production bundle: self-contained single-file management host + loose resources +
    // sha256 update manifest + zip. See devtools/scripts/build-production.mjs.
    run('node', [path.join(repo, 'devtools', 'scripts', 'build-production.mjs'), ...args]);
    break;

  case 'e2e': {
    const scriptsDir = path.join(repo, 'devtools', 'scripts');
    const all = fs.readdirSync(scriptsDir)
      .filter((f) => /^e2e-p\d+\.mjs$/.test(f))
      .map((f) => f.slice(4, -4))
      // NUMERIC order (p2 before p10) — a plain .sort() is lexicographic, which puts p3–p9 LAST.
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

    // Selector + flags. Selector: all | pN | pN-pM (range) | p1,p3,p9 (list).
    //   --build             `dev.mjs build` first — closes the `--no-build` stale-bin footgun.
    //   --parallel[=N] / -p  run up to N suites at once (default serial). Scheduling is
    //                        port-disjoint (below), so parallel runs can't collide.
    const flags = args.filter((a) => a.startsWith('-'));
    const sel = args.find((a) => !a.startsWith('-')) ?? 'all';
    const doBuild = flags.includes('--build');
    const pFlag = flags.find((f) => f === '--parallel' || f.startsWith('--parallel=') || f === '-p' || f.startsWith('-p='));
    let limit = 1;
    if (pFlag) {
      const n = pFlag.includes('=') ? Number(pFlag.split('=')[1]) : NaN;
      limit = Number.isFinite(n) && n > 0 ? n : Math.max(2, Math.min(6, (os.cpus().length || 4) - 2));
    }

    const expand = (s) => {
      if (s === 'all') return all;
      if (s.includes(',')) return s.split(',').map((x) => x.trim());
      const range = s.match(/^p(\d+)-p?(\d+)$/);
      if (range) {
        const [lo, hi] = [Number(range[1]), Number(range[2])];
        return all.filter((x) => { const n = Number(x.slice(1)); return n >= lo && n <= hi; });
      }
      return [s];
    };
    const suites = expand(sel).filter((s) => all.includes(s));
    if (suites.length === 0) { console.log(`no e2e suites match "${sel}"`); break; }

    if (doBuild) {
      console.log('e2e: building server + client first…');
      const b = spawnSync('node', [path.join(repo, 'devtools', 'dev.mjs'), 'build'], { stdio: 'inherit', cwd: repo });
      if (b.status !== 0) { console.error('e2e: build failed — aborting'); process.exitCode = b.status ?? 1; break; }
    }

    // A suite's "port footprint" = every 5xxx literal in its source (server + fixture ports).
    // Over-inclusive on purpose: a stray non-port 5xxx only makes scheduling more conservative,
    // never causes a collision. Suites that share a port (e.g. p7/p15 both 5397) just won't run
    // at the same time — so parallel scheduling stays correct without touching any suite.
    const footprint = (suite) =>
      new Set([...fs.readFileSync(path.join(scriptsDir, `e2e-${suite}.mjs`), 'utf8').matchAll(/\b5\d{3}\b/g)].map((m) => m[0]));
    const ports = new Map(suites.map((s) => [s, footprint(s)]));

    // Run a suite as a child. Serial → inherit stdio (live output); parallel → buffer + dump on
    // finish (interleaved live logs from N servers would be unreadable). Pass only on a clean
    // exit-0 with no signal (a libuv teardown abort surfaces as a signal → counts as failure).
    const runOne = (suite, capture) => new Promise((resolve) => {
      const t0 = Date.now();
      const child = spawn('node', [path.join(scriptsDir, `e2e-${suite}.mjs`)],
        { cwd: repo, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
      let out = '';
      child.stdout?.on('data', (d) => (out += d));
      child.stderr?.on('data', (d) => (out += d));
      child.on('close', (code, signal) => resolve({ suite, passed: code === 0 && !signal, status: code, signal, out, ms: Date.now() - t0 }));
    });

    const results = [];
    const wallStart = Date.now();

    if (limit <= 1) {
      for (const suite of suites) results.push(await runOne(suite, false));
    } else {
      console.log(`e2e: ${suites.length} suites, up to ${limit} at once (port-disjoint)…`);
      const pending = [...suites];
      const running = [];       // { suite, promise }
      const busy = new Set();   // ports held by currently-running suites
      const launch = (suite) => {
        for (const p of ports.get(suite)) busy.add(p);
        const entry = { suite, promise: runOne(suite, true).then((rec) => {
          for (const p of ports.get(suite)) busy.delete(p);
          running.splice(running.findIndex((e) => e.suite === suite), 1);
          results.push(rec);
          process.stdout.write(rec.out);
          console.log(`  ${rec.passed ? '✓' : '✗'} ${rec.suite} (${(rec.ms / 1000).toFixed(0)}s)`);
          return rec;
        }) };
        running.push(entry);
      };
      while (pending.length || running.length) {
        for (let i = 0; i < pending.length && running.length < limit; i++) {
          const fp = ports.get(pending[i]);
          if ([...fp].some((p) => busy.has(p))) continue;  // a port it needs is in use → hold
          launch(pending.splice(i, 1)[0]); i--;
        }
        // Nothing running and nothing launchable would deadlock; can't happen (busy empties when
        // running does), but force the head if it ever did.
        if (running.length === 0 && pending.length) launch(pending.shift());
        if (running.length) await Promise.race(running.map((e) => e.promise));
      }
    }

    results.sort((a, b) => Number(a.suite.slice(1)) - Number(b.suite.slice(1)));
    const wall = ((Date.now() - wallStart) / 1000).toFixed(0);
    const failed = results.filter((r) => !r.passed);
    const slow = [...results].sort((a, b) => b.ms - a.ms).slice(0, 3).map((r) => `${r.suite} ${(r.ms / 1000).toFixed(0)}s`);
    console.log(`\ne2e: ${results.length - failed.length}/${results.length} suites passed in ${wall}s${limit > 1 ? ` (parallel ×${limit})` : ''}`);
    if (slow.length) console.log(`  slowest: ${slow.join(' · ')}`);
    for (const f of failed) console.log(`  ✗ ${f.suite} — ${f.signal ? `signal ${f.signal}` : `exit ${f.status}`}`);
    if (failed.length) process.exitCode = 1;
    break;
  }

  default:
    console.log('usage: node devtools/dev.mjs <server|host|vite|build|publish|e2e|smoke|memory|eval|test-data|install-hooks|check-sensitive>');
    process.exitCode = cmd ? 1 : 0;
}
