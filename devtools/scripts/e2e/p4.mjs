#!/usr/bin/env node
// e2e P4 — knowledge-base seeder: fresh empty data folder scaffolds fully (seed commit),
// user-modified files survive upgrades, template changes upgrade untouched files.
import path from 'node:path';
import fs from 'node:fs';
import { repo, dataDirFor, makeReporter, startServer, waitHealthy, makeClient, claudeStubCmd, gitLog } from './_e2e-common.mjs';

const dataDir = dataDirFor('p4');
const PORT = 5394;
const base = `http://127.0.0.1:${PORT}`;
const binTemplate = path.join(repo, 'src', 'server', 'Gatherlight.Server', 'bin', 'Debug', 'net10.0', 'Assets', 'DataTemplate');

const { ok, fail, done } = makeReporter('p4');
const { j } = makeClient(base);

const bootServer = () => startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const stop = (srv) => new Promise((r) => { srv.server.on('exit', r); srv.stop(); });

// pick a template rule file to play with
const ruleRel = '.claude/rules/absolute-dates.md';
const binRuleAbs = path.join(binTemplate, ...ruleRel.split('/'));
const dataRuleAbs = path.join(dataDir, ...ruleRel.split('/'));
let savedTemplateBytes = null;

let srv = null;
try {
  if (!fs.existsSync(binTemplate)) throw new Error(`template not in build output: ${binTemplate} — run dotnet build`);

  // --- boot 1: brand-new EMPTY data folder --------------------------------------------
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  srv = bootServer();
  await waitHealthy(base);

  ok('CLAUDE.md scaffolded', fs.existsSync(path.join(dataDir, 'CLAUDE.md')));
  ok('rules scaffolded', fs.existsSync(dataRuleAbs));
  const status1 = await j('/api/zhiku/status');
  ok('status reports seeded files', status1.body?.seeded?.length > 10, JSON.stringify(status1.body)?.slice(0, 200));
  ok('no skips on fresh folder', (status1.body?.skipped?.length ?? 0) === 0);
  ok('seed commit in data repo', gitLog(dataDir).some((l) => l.includes('zhiku: seed')));
  const plans1 = await j('/api/plans');
  ok('seeded zhiku indexed', plans1.body.files.some((f) => f.category === 'Rules'));
  await stop(srv); srv = null;

  // --- boot 2: user modifies a seeded rule → never overwritten -------------------------
  fs.appendFileSync(dataRuleAbs, '\n<!-- user customization -->\n');
  srv = bootServer();
  await waitHealthy(base);
  const status2 = await j('/api/zhiku/status');
  ok('modified rule reported skipped', status2.body?.skipped?.includes(ruleRel), JSON.stringify(status2.body?.skipped));
  ok('modified rule content intact', fs.readFileSync(dataRuleAbs, 'utf8').includes('user customization'));
  await stop(srv); srv = null;

  // --- boot 3: template ships an update → untouched files upgrade, modified stay -------
  savedTemplateBytes = fs.readFileSync(binRuleAbs);
  const claudeMdBin = path.join(binTemplate, 'CLAUDE.md');
  const savedClaudeMd = fs.readFileSync(claudeMdBin);
  fs.appendFileSync(binRuleAbs, '\n<!-- template v2 -->\n');       // modified locally → must NOT apply
  fs.appendFileSync(claudeMdBin, '\n<!-- template v2 -->\n');      // untouched locally → must apply
  srv = bootServer();
  await waitHealthy(base);
  const status3 = await j('/api/zhiku/status');
  ok('untouched file upgraded', status3.body?.upgraded?.includes('CLAUDE.md'), JSON.stringify(status3.body));
  ok('modified file still skipped', status3.body?.skipped?.includes(ruleRel));
  ok('upgrade landed on disk', fs.readFileSync(path.join(dataDir, 'CLAUDE.md'), 'utf8').includes('template v2'));
  ok('user file untouched by upgrade', !fs.readFileSync(dataRuleAbs, 'utf8').includes('template v2'));
  await stop(srv); srv = null;
  fs.writeFileSync(binRuleAbs, savedTemplateBytes); savedTemplateBytes = null;
  fs.writeFileSync(claudeMdBin, savedClaudeMd);
} catch (err) {
  fail('e2e-p4 fatal: ' + err.message);
  if (srv) console.error(srv.log().slice(-3000));
} finally {
  if (srv) srv.stop();
  if (savedTemplateBytes) fs.writeFileSync(binRuleAbs, savedTemplateBytes);
}
done();
