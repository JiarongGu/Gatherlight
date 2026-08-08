#!/usr/bin/env node
// e2e P19 (part 1) — auto-update APPLY phase (the C++ launcher). Stage a fake update in a sandbox
// install and run `Gatherlight.exe --apply-and-exit`, then assert the overlay + manifest-diff removals
// + staging cleanup, and that the launcher never overwrites itself. Server-side check/download/stage
// is covered by e2e-p20. Skips gracefully where the launcher exe isn't built (no MSVC).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { repo, makeReporter } from './_e2e-common.mjs';

const sandbox = path.join(repo, 'devtools', '_e2e-p19-install');
let launcher = path.join(repo, 'src', 'launcher', 'bin', 'x64', 'Release', 'Gatherlight.exe');

const { ok, fail, done } = makeReporter('p19');

// Build the launcher if it isn't there yet + MSVC is available; otherwise skip the whole suite.
const findMsBuild = () => {
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = path.join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return null;
  const r = spawnSync(vswhere, ['-latest', '-prerelease', '-requires', 'Microsoft.Component.MSBuild',
    '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'], { encoding: 'utf8' });
  return (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((s) => s.endsWith('MSBuild.exe') && fs.existsSync(s)) ?? null;
};

if (!fs.existsSync(launcher)) {
  const msbuild = findMsBuild();
  if (!msbuild) {
    console.log('  · launcher exe not built and no MSVC found — skipping (no failures).');
    console.log('\ne2e-p19 PASS (skipped)');
    process.exit(0);
  }
  spawnSync(msbuild, [path.join(repo, 'src', 'launcher', 'Gatherlight.Launcher.vcxproj'),
    '/p:Configuration=Release', '/p:Platform=x64', '/t:Build', '/v:minimal', '/nologo'], { stdio: 'inherit' });
}

const write = (rel, content) => {
  const abs = path.join(sandbox, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
const manifest = (paths) => JSON.stringify({ product: 'Gatherlight', version: '9.9.9', files: paths.map((p) => ({ path: p, sha256: '', size: 0 })) }, null, 2);

try {
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandbox, { recursive: true });
  fs.copyFileSync(launcher, path.join(sandbox, 'Gatherlight.exe'));

  // Current install: keep.txt (will be updated), old.txt (dropped by the new manifest), a nested file.
  write('keep.txt', 'old-content');
  write('old.txt', 'remove-me');
  write('libs/placeholder.txt', 'x'); // stand-in so libs/ exists
  write('manifest.json', manifest(['Gatherlight.exe', 'keep.txt', 'old.txt', 'libs/placeholder.txt']));

  // Staged update: keep.txt updated, new.txt + a nested new file added, old.txt gone from the manifest.
  write('.update/staged/keep.txt', 'new-content');
  write('.update/staged/new.txt', 'brand-new');
  write('.update/staged/res/deep.txt', 'nested');
  write('.update/staged/manifest.json', manifest(['Gatherlight.exe', 'keep.txt', 'new.txt', 'res/deep.txt']));
  write('.update/ready.json', JSON.stringify({ version: '9.9.9' }));

  const r = spawnSync(path.join(sandbox, 'Gatherlight.exe'), ['--apply-and-exit'], { cwd: sandbox, timeout: 30000 });
  ok('launcher --apply-and-exit ran', r.status === 0, `status ${r.status}`);

  const read = (rel) => { try { return fs.readFileSync(path.join(sandbox, rel), 'utf8'); } catch { return null; } };
  ok('overlay: keep.txt updated to new content', read('keep.txt') === 'new-content', read('keep.txt') ?? '(missing)');
  ok('overlay: new.txt added', read('new.txt') === 'brand-new');
  ok('overlay: nested res/deep.txt added', read('res/deep.txt') === 'nested');
  ok('removal: old.txt deleted (dropped from new manifest)', read('old.txt') === null);
  ok('manifest.json replaced by the staged one', (read('manifest.json') ?? '').includes('"new.txt"') && !(read('manifest.json') ?? '').includes('"old.txt"'));
  ok('launcher not overwritten / still present', fs.existsSync(path.join(sandbox, 'Gatherlight.exe')));
  ok('staging dir cleared', !fs.existsSync(path.join(sandbox, '.update')));

  // Idempotent: a second run with nothing staged is a clean no-op.
  const r2 = spawnSync(path.join(sandbox, 'Gatherlight.exe'), ['--apply-and-exit'], { cwd: sandbox, timeout: 30000 });
  ok('second run is a no-op (nothing staged)', r2.status === 0 && read('new.txt') === 'brand-new');

  // A FAILING overlay must still RETURN. The failure path raised a modal MessageBox, which waits for a
  // click that never comes when nothing is attended — so the launcher hung instead of falling back to
  // the current version, and a harness could only ever report a timeout, never the failure it exists
  // to catch.
  //
  // Failing it deterministically is fussier than it looks: robocopy answers a file/directory collision
  // with 4 (MISMATCH) and a read-only destination with 0, both of which are < 8 and therefore SUCCESS
  // here. A test built on those would pass while proving nothing. What does fail is a staged path that
  // is not a directory — rc 16 — which is also a REAL corruption case, because the "marker without
  // staged files" guard above uses PathFileExistsW: that tests existence, not type, so a staged FILE
  // walks straight past it into the overlay.
  fs.mkdirSync(path.join(sandbox, '.update'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, '.update', 'staged'), 'corrupt: a file where the staged tree should be');
  write('.update/ready.json', JSON.stringify({ version: '9.9.10' }));

  const started = Date.now();
  const r3 = spawnSync(path.join(sandbox, 'Gatherlight.exe'), ['--apply-and-exit'], { cwd: sandbox, timeout: 30000 });
  const elapsed = Date.now() - started;
  ok('a failed overlay still returns (no blocking modal)', r3.status === 0,
    r3.status === null ? `timed out after ${elapsed}ms — the failure path is blocking again` : `status ${r3.status}`);
  ok('the failed overlay returned promptly', elapsed < 20000, `${elapsed}ms`);
  ok('staging cleared even when the overlay failed', !fs.existsSync(path.join(sandbox, '.update')));
  // Anti-vacuity control: this only holds if the overlay REALLY failed. The corrupt staging carries no
  // readable manifest, so had it been counted a success the removal step would have run with an empty
  // new-manifest and deleted every file the old one listed. Their survival is the proof.
  ok('the failed overlay skipped removals (proves the failure path ran)',
    read('new.txt') === 'brand-new' && read('keep.txt') === 'new-content',
    `new.txt=${JSON.stringify(read('new.txt'))} keep.txt=${JSON.stringify(read('keep.txt'))}`);
} catch (err) {
  fail('e2e-p19 fatal: ' + err.message);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

done();
