// project.config.mjs — the ONLY project-specific inputs for the devtools dispatcher.
//
// The dispatcher (dev.mjs) and the scripts under scripts/ are otherwise generic (pattern shared
// with sibling projects). To reuse this toolkit elsewhere, copy devtools/ and edit THIS file.
export default {
  name: 'Gatherlight',
  /** Backend project: `server` runs it headless (dev); e2e suites spawn it. */
  serverProject: 'src/server/Gatherlight.Server',
  /** Desktop management host — hosts the server in-process + monitors health. The shippable app. */
  hostProject: 'src/server/Gatherlight.Host',
  hostProcess: 'Gatherlight.Host',
  hostTfm: 'net10.0-windows',
  /** Frontend dir (cwd for vite / npm) — lands with the Phase 4 port. */
  clientDir: 'src/client',
  /** Solution built by `build`. */
  solution: 'Gatherlight.slnx',
  /** Default headless server port + the vite dev port (proxies /api → server). */
  serverPort: 5317,
  vitePort: 5173,
};
