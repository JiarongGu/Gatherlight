#!/usr/bin/env node
// e2e P37 — site manifest + platform seam (S1). Proves the manifest DRIVES the agent's jail rather
// than merely existing: the shipped template's site.json (Assets/SiteTemplate, copied by the
// knowledge-base seeder) wins over SiteManifestStep's on-disk-inference fallback, the generated
// .claude/hooks/scope-guard.mjs derives WRITE_DIRS from the manifest's declared records, the manifest
// itself sits outside the agent's write scope (PROTECTED can't be widened by editing the manifest),
// platform state/ is unreachable through a real HTTP tool call (both the nested and bare-directory
// forms), and changing records + restarting regenerates the guard to match while leaving PROTECTED
// and the manifest itself untouched.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, onDisk } from './_e2e-common.mjs';

const dataDir = dataDirFor('p37');
const { ok, fail, done } = makeReporter('p37');
makeTestData(dataDir);

// Free ports — not used by any other suite (checked against every `startServer({ port: ... })` /
// `const PORT = ...` in devtools/scripts/e2e/*.mjs).
const PORT_A = 5464;
const PORT_B = 5465;

const manifestPath = path.join(dataDir, 'site.json');
const guardPath = path.join(dataDir, '.claude', 'hooks', 'scope-guard.mjs');
const settle = () => new Promise((r) => setTimeout(r, 800));

// Pipe a synthetic PreToolUse payload to the GENERATED guard on disk — the real bytes a boot just
// wrote, not an extracted template — and read back the permission decision. Same shape as p24.
function guardDecision(toolName, toolInput, cwd = dataDir) {
  const r = spawnSync('node', [guardPath], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd }),
    encoding: 'utf8',
  });
  return { denied: r.stdout.includes('"permissionDecision":"deny"'), raw: r.stdout, err: r.stderr };
}

let srv;
try {
  srv = startServer({ dataDir, port: PORT_A });
  await waitHealthy(srv.base);

  // --- A: the manifest is seeded from the shipped template, not the migration step's fallback ----
  ok('site.json exists after boot', fs.existsSync(manifestPath));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // Load-bearing distinction: "0.0.0" is the SiteTemplateRef model default that SiteManifestStep's
  // fallback (Records inferred from what's already on disk) would carry; "1.0.0" is only reachable
  // if the shipped Assets/SiteTemplate/site.json actually won the race.
  ok('template.version is "1.0.0" (shipped template won, not the 0.0.0 fallback default)',
    manifest.template?.version === '1.0.0', JSON.stringify(manifest.template));
  ok('records = ["plans", "household"]',
    JSON.stringify(manifest.records) === JSON.stringify(['plans', 'household']), JSON.stringify(manifest.records));
  ok('capabilities.deny is []',
    Array.isArray(manifest.capabilities?.deny) && manifest.capabilities.deny.length === 0, JSON.stringify(manifest.capabilities));
  ok('capabilities.enabled is []',
    Array.isArray(manifest.capabilities?.enabled) && manifest.capabilities.enabled.length === 0, JSON.stringify(manifest.capabilities));

  // --- B: the declared record directories exist ---------------------------------------------------
  ok('plans/ exists on disk', onDisk(dataDir, 'plans'));
  ok('household/ exists on disk', onDisk(dataDir, 'household'));

  // --- C: the guard is GENERATED from the manifest -------------------------------------------------
  ok('guard file exists after boot', fs.existsSync(guardPath));
  const guardSrc = fs.readFileSync(guardPath, 'utf8');
  ok("WRITE_DIRS rendered from records + '.claude'",
    guardSrc.includes("const WRITE_DIRS = ['plans', 'household', '.claude'];"),
    guardSrc.match(/const WRITE_DIRS.*/)?.[0]);
  ok("PROTECTED still hardcoded, beginning '.claude/hooks'",
    guardSrc.includes("const PROTECTED = ['.claude/hooks'"), guardSrc.match(/const PROTECTED.*/)?.[0]);
  ok('no __WRITE_DIRS__ placeholder survives', !guardSrc.includes('__WRITE_DIRS__'));

  // --- D: the jail cannot widen itself ---------------------------------------------------------------
  const denySite = guardDecision('Write', { file_path: 'site.json' });
  ok('Write to site.json denied (the manifest is not agent-writable)', denySite.denied, denySite.raw || denySite.err);
  const denyGuard = guardDecision('Write', { file_path: '.claude/hooks/scope-guard.mjs' });
  ok('Write to the guard itself denied (PROTECTED)', denyGuard.denied, denyGuard.raw || denyGuard.err);
  const allowPlan = guardDecision('Write', { file_path: 'plans/x.md' });
  ok('Write to plans/x.md allowed (positive control — a deny-everything guard cannot pass this)',
    !allowPlan.denied, allowPlan.raw || allowPlan.err);

  // --- E: platform state is unreachable from the site, via a real HTTP tool call --------------------
  const { call } = makeClient(srv.base);
  const nested = await call('pdf_inspect', { path: 'state/gatherlight.db' });
  ok('pdf_inspect on state/gatherlight.db refused (4xx)',
    nested.status >= 400 && nested.status < 500, JSON.stringify(nested));
  const bare = await call('pdf_inspect', { path: 'state' });
  ok('pdf_inspect on bare "state" refused (4xx — exact-match was a real hole once)',
    bare.status >= 400 && bare.status < 500, JSON.stringify(bare));

  // --- F: changing the manifest changes the jail -------------------------------------------------------
  srv.stop();
  await settle();
  srv = null;

  fs.writeFileSync(manifestPath, JSON.stringify({
    name: 'Gatherlight',
    template: { id: 'planner', version: '1.0.0' },
    agent: { model: null, promptPack: 'planner' },
    records: ['notes'],
    capabilities: { deny: [], enabled: [] },
    ui: { spec: 'ui/', specVersion: 1 },
  }, null, 2) + '\n', 'utf8');
  fs.unlinkSync(guardPath);

  srv = startServer({ dataDir, port: PORT_B });
  await waitHealthy(srv.base);

  const guardSrc2 = fs.readFileSync(guardPath, 'utf8');
  ok('regenerated guard WRITE_DIRS matches the new records',
    guardSrc2.includes("const WRITE_DIRS = ['notes', '.claude'];"), guardSrc2.match(/const WRITE_DIRS.*/)?.[0]);
  ok('notes/ was created', onDisk(dataDir, 'notes'));
  ok('PROTECTED is unchanged', guardSrc2.includes("const PROTECTED = ['.claude/hooks'"), guardSrc2.match(/const PROTECTED.*/)?.[0]);
  const manifest2 = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  ok('manifest still reads ["notes"] (the step did not revert it)',
    JSON.stringify(manifest2.records) === JSON.stringify(['notes']), JSON.stringify(manifest2.records));
} catch (err) {
  fail('e2e-p37 fatal: ' + err.message);
  console.error(srv?.log?.().slice(-3000) ?? '');
} finally {
  try { srv?.stop(); } catch {}
}
done();
