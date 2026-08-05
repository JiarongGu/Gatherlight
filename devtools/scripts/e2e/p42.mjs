#!/usr/bin/env node
// e2e P42 — the site authoring loop (S3b). The agent may write pages and only pages; a page change
// is reviewed as a RENDERED page; an invalid page cannot be committed. Every denial here sits beside
// a positive control, the discipline p38/p39/p41 established.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, claudeStubCmd,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p42');
const { ok, fail, done } = makeReporter('p42');
makeTestData(dataDir);

// Free port — suites use up to 5484 (p43); this one is clear.
const PORT = 5486;

const server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const base = server.base ?? `http://127.0.0.1:${PORT}`;

// Ask the generated scope guard whether a write would be allowed. Mirrors p24's invocation: run the
// hook with a PreToolUse payload on stdin and read its decision.
const guardPath = path.join(dataDir, '.claude', 'hooks', 'scope-guard.mjs');
const wouldAllow = (relPath) => {
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Write',
    tool_input: { file_path: path.join(dataDir, relPath) },
  });
  const r = spawnSync('node', [guardPath], { input: payload, encoding: 'utf8', cwd: dataDir });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  return { allowed: r.status === 0 && !/Blocked/.test(out), out };
};

try {
  await waitHealthy(base);

  ok('the guard was issued into the data folder', fs.existsSync(guardPath));
  const guardBody = fs.existsSync(guardPath) ? fs.readFileSync(guardPath, 'utf8') : '';
  ok('the guard carries the bumped version', /GUARD_VERSION:\s*7/.test(guardBody),
    guardBody.match(/GUARD_VERSION:.*/)?.[0] ?? '(no guard)');
  ok('ui/ is in the write dirs', /WRITE_DIRS = \[[^\]]*'ui'/.test(guardBody),
    guardBody.match(/WRITE_DIRS = .*/)?.[0] ?? '(no guard)');

  // POSITIVE CONTROL first — if this fails, every denial below is meaningless.
  const page = wouldAllow('ui/tokyo.json');
  ok('a page file is writable', page.allowed, page.out.slice(0, 160));
  const md = wouldAllow('ui/notes.md');
  ok('a .md under ui/ is denied', !md.allowed);
  ok('the denial names the extension rule', /\.json/.test(md.out), md.out.slice(0, 160));
  const mjs = wouldAllow('ui/hack.mjs');
  ok('a .mjs under ui/ is denied', !mjs.allowed, mjs.out.slice(0, 160));
  const deep = wouldAllow('ui/sub/deep.json');
  ok('a page in a subdirectory is denied — ui/ is flat', !deep.allowed);
  ok('the flat denial says so', /flat/.test(deep.out), deep.out.slice(0, 160));
  // The other write dirs are untouched by the new rule.
  ok('plans/ is still writable', wouldAllow('plans/trips/x.md').allowed);
  ok('state/ is still denied', !wouldAllow('state/gatherlight.db').allowed);
} catch (e) {
  fail(e?.stack || String(e));
  console.error(server.log().slice(-3000));
} finally {
  server.stop();
}

done();
