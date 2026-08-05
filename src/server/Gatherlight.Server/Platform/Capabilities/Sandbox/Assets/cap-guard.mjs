// cap-guard.mjs — the platform's network denial for a sandboxed capability.
//
// Node's permission model has no network dimension, so this supplies one. It is loaded via
// --import BEFORE the capability's own code and is owned by the platform; a capability never
// sees it as editable content.
//
// This is airtight ONLY BECAUSE --permission already denies child_process spawn, worker_threads
// and process.binding. Those denials remove every route by which a capability could reach the
// network without going through module resolution. If any of them is ever relaxed, the
// "cannot reach the internet" promise printed on the approval card becomes false.
import { registerHooks } from 'node:module';

const BLOCKED = new Set(['net', 'http', 'https', 'tls', 'dgram', 'http2', 'dns', 'inspector']);
const bare = (s) => s.replace(/^node:/, '');

registerHooks({
  resolve(specifier, context, next) {
    if (BLOCKED.has(bare(specifier)))
      throw new Error(`network access is not granted to this capability (${specifier})`);
    return next(specifier, context);
  },
});

// Global fetch is built on internals rather than a resolvable module, so blocking modules is not
// enough — remove it and its siblings outright. With the network modules blocked there is no
// public API that restores them.
for (const k of ['fetch', 'WebSocket', 'EventSource']) {
  try { delete globalThis[k]; } catch { /* non-configurable on some runtimes; the module block still holds */ }
}
