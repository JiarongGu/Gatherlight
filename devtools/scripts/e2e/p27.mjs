#!/usr/bin/env node
// e2e-p27 — knowledge-base upgrade migration. When a customized .claude/ file has shipped
// improvements (which ZhikuSeeder skips), detect it, run the opt-in LLM merge (stubbed), stage the
// diff, and approve → commit. Simulates an "app shipped a new template since" by rewinding the
// stored shipped-hash for one file (node:sqlite), so detection sees modified-AND-template-changed.
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, gitLog } from './_e2e-common.mjs';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = dataDirFor('p27');
const { ok, fail, done } = makeReporter('p27');
makeTestData(dataDir);
const srv = startServer({ dataDir, port: 5397, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { post, getJson } = makeClient(srv.base);

const REL = '.claude/rules/money-format.md';

try {
  await waitHealthy(srv.base);
  console.log('server up');

  const file = path.join(dataDir, REL);
  ok('kb file seeded on boot', fs.existsSync(file));

  // 1) user customizes the file
  fs.appendFileSync(file, '\n<!-- user note: keep JPY primary -->\n');

  // 2) simulate "a newer template was shipped since" — rewind this file's shipped-hash so detection
  //    sees current != shipped AND template != shipped.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'state', 'gatherlight.db'));
  const changed = db.prepare('UPDATE zhiku_state SET value = ? WHERE key = ?').run('stalehash0000', 'shipped:' + REL);
  db.close();
  ok('rewound shipped-hash', Number(changed.changes) === 1);

  // 2b) no-baseline path (the 合并升级 fix): a diverged file with NO shipped record — the case on
  //     workspaces that predate upgrade-tracking (imported / the original prototype KB) — must STILL
  //     be offered, not silently skipped. Delete the record, assert still detected, restore for below.
  {
    const db2 = new DatabaseSync(path.join(dataDir, 'state', 'gatherlight.db'));
    db2.prepare('DELETE FROM zhiku_state WHERE key = ?').run('shipped:' + REL);
    const stNb = await getJson('/api/manage/kb-upgrades');
    ok('no-baseline customized file still detected (the 合并升级 fix)',
      (stNb.available ?? []).some((u) => u.path === REL), JSON.stringify(stNb.available));
    db2.prepare('INSERT INTO zhiku_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('shipped:' + REL, 'stalehash0000');
    db2.close();
  }

  // 3) detect the upgrade
  const st1 = await getJson('/api/manage/kb-upgrades');
  ok('upgrade detected', (st1.available ?? []).some((u) => u.path === REL), JSON.stringify(st1.available));

  // 4) run the opt-in merge → staged for review
  const run = await post('/api/manage/kb-upgrades/run');
  ok('migration staged', run.body?.staged === true && run.body?.merged >= 1, JSON.stringify(run.body));

  // 5) status now carries the staged diff
  const st2 = await getJson('/api/manage/kb-upgrades');
  ok('status has staged review', st2.hasStaged === true && (st2.staged ?? []).some((f) => f.path === REL));

  // 6) approve → applied + committed to the data repo
  const before = gitLog(dataDir).length;
  const appr = await post('/api/manage/kb-upgrades/approve');
  ok('approve committed', appr.status === 200 && !!appr.body?.sha, JSON.stringify(appr.body));
  ok('data repo grew by a commit', gitLog(dataDir).length === before + 1);

  // 7) cleared: no longer detected, no staged review
  const st3 = await getJson('/api/manage/kb-upgrades');
  ok('upgrade cleared after approve', st3.hasStaged === false && !(st3.available ?? []).some((u) => u.path === REL));
} catch (err) {
  fail('e2e-p27 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
