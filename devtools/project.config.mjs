// project.config.mjs — the ONLY project-specific inputs for the devtools dispatcher.
//
// The dispatcher (dev.mjs) and the scripts under scripts/ are otherwise generic (pattern shared
// with sibling projects). To reuse this toolkit elsewhere, copy devtools/ and edit THIS file.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Version is sourced from src/Directory.Build.props (the single source of truth the .NET assemblies
// also use), so the zip name + manifest never drift from what the built app reports. Normalized to a
// full 3-part semver so a 2-part VersionPrefix (e.g. `1.0`) becomes `1.0.0` everywhere it's derived
// (the release tag, zip name, manifest) — matching how the CLR pads the assembly version.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawVersion =
  (readFileSync(join(repoRoot, 'src', 'Directory.Build.props'), 'utf8')
    .match(/<VersionPrefix>([^<]+)<\/VersionPrefix>/) || [])[1] || '0.0.0';
/** Pad a numeric version to exactly major.minor.patch (`1` → `1.0.0`, `1.0` → `1.0.0`, `1.2.3.4` → `1.2.3`). */
export const toSemver = (v) => {
  const [core, ...rest] = String(v).trim().split(/([-+])/); // keep any -pre/+build suffix
  const parts = core.split('.').filter(Boolean).slice(0, 3);
  while (parts.length < 3) parts.push('0');
  return parts.join('.') + rest.join('');
};
const propsVersion = toSemver(rawVersion);

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
