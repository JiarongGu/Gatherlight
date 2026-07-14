// project.config.mjs — the ONLY project-specific inputs for the devtools dispatcher.
//
// The dispatcher (dev.mjs) and the scripts under scripts/ are otherwise generic (pattern shared
// with sibling projects). To reuse this toolkit elsewhere, copy devtools/ and edit THIS file.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Version is sourced from src/Directory.Build.props (the single source of truth the .NET assemblies
// also use), so the zip name + manifest never drift from what the built app reports.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const propsVersion =
  (readFileSync(join(repoRoot, 'src', 'Directory.Build.props'), 'utf8')
    .match(/<VersionPrefix>([^<]+)<\/VersionPrefix>/) || [])[1] || '0.0.0';

export default {
  name: 'Gatherlight',
  /** Product version (major.minor.patch) — read from src/Directory.Build.props; the single source. */
  version: propsVersion,
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
