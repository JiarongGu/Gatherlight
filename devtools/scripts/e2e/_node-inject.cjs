// Loaded ONLY through an inherited NODE_OPTIONS=--require … that a suite put in a fixture server's environment
// (_e2e-common.mjs: nodeInjection). It stands in for whatever a launcher's NODE_OPTIONS would preload, and does the
// two things such a file could do before any code of ours runs:
//   - leave a capability behind: `net` on a global, which is how a preload that runs BEFORE cap-guard.mjs hands a
//     sandboxed capability the network (measured on Node 24.15: it works — `--require` is not checked against the read
//     grant, and the preload's `require('net')` happens before cap-guard's hooks exist);
//   - say that it ran, and in which node: one JSON line per process, naming the entry script, to the file the suite
//     named. Under the sandbox the write is refused (no write grant covers it), so there the global is the evidence.
// Never throws: a preload that breaks the process would make "nothing ran" and "the process died" look alike.
try { globalThis.__zzInjected = true; } catch { /* ignore */ }
try { globalThis.__zzNet = require('net'); } catch { /* ignore */ }
try {
  const log = process.env.E2E_NODE_INJECT_LOG;
  if (log) {
    require('fs').appendFileSync(log, JSON.stringify({ pid: process.pid, argv: process.argv.slice(1), execArgv: process.execArgv }) + '\n');
  }
} catch { /* refused under the sandbox, or no log named — the global above still says it ran */ }
