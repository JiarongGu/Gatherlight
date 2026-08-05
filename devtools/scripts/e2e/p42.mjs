#!/usr/bin/env node
// e2e P42 — the site authoring loop (S3b). The agent may write pages and only pages; a page change
// is reviewed as a RENDERED page; an invalid page cannot be committed. Every denial here sits beside
// a positive control, the discipline p38/p39/p41 established.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p42');
const { ok, fail, done } = makeReporter('p42');
makeTestData(dataDir);

// Free port — suites use up to 5484 (p43); this one is clear.
const PORT = 5486;

const server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const base = server.base ?? `http://127.0.0.1:${PORT}`;
const { j, post } = makeClient(base);

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
  const pageWrite = wouldAllow('ui/tokyo.json');
  ok('a page file is writable', pageWrite.allowed, pageWrite.out.slice(0, 160));
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

  // --- navigation ---------------------------------------------------------------------------
  const uiDir = path.join(dataDir, 'ui');
  fs.mkdirSync(uiDir, { recursive: true });
  const page = (name, body) => fs.writeFileSync(path.join(uiDir, `${name}.json`), JSON.stringify(body, null, 2), 'utf8');
  const leaf = (text) => ({ type: 'Text', text });

  page('zzz-ordered', { title: 'Ordered page', nav: { label: '第一', order: 1 }, root: leaf('a') });
  page('aaa-plain', { title: 'Plain page', root: leaf('b') });
  page('secret', { title: 'Hidden page', nav: { hidden: true }, root: leaf('c') });

  const pages = (await j('/api/ui/pages')).body ?? [];
  const named = (n) => pages.find((p) => p.name === n);
  ok('a page with nav.order sorts first despite its name',
    pages.filter((p) => !p.hidden)[0]?.name === 'zzz-ordered', pages.map((p) => p.name).join(','));
  ok('nav.label wins over the title', named('zzz-ordered')?.label === '第一', named('zzz-ordered')?.label ?? '');
  ok('a page with no nav falls back to its title', named('aaa-plain')?.label === 'Plain page');
  ok('a hidden page is marked hidden', named('secret')?.hidden === true);
  ok('a hidden page is still fetchable by name',
    (await j('/api/ui/pages/secret')).body?.status === 'ready');

  // --- the preview gate ---------------------------------------------------------------------
  const runToGate = async (message) => {
    const started = await post('/api/chat', { message, mode: 'plan' });
    const id = started.body?.id;
    await until(async () => (await j(`/api/chat/${id}`)).body?.phase === 'awaiting-plan-approval', 60000);
    await post(`/api/chat/${id}/plan/approve`);
    await until(async () => {
      const p = (await j(`/api/chat/${id}`)).body?.phase;
      return p === 'awaiting-diff-approval' || p === 'error' || p === 'rejected';
    }, 60000);
    return id;
  };

  const goodId = await runToGate('PAGE_CASE:GOOD 给行程做个面板');
  const goodReview = (await j(`/api/chat/${goodId}`)).body?.review;
  const goodPage = (goodReview?.pages ?? [])[0];
  ok('a page change carries a page preview', Boolean(goodPage), JSON.stringify(goodReview?.pages ?? null));
  ok('the preview is ready', goodPage?.status === 'ready', goodPage?.reason ?? '');
  ok('the preview carries the validated tree', goodPage?.root?.type === 'Stack');
  ok('the summary is computed, not empty', (goodPage?.summary ?? '').length > 0, goodPage?.summary ?? '');
  ok('a new page says so in the summary', /新页面/.test(goodPage?.summary ?? ''), goodPage?.summary ?? '');
  // POSITIVE CONTROL: a valid page COMMITS.
  await post(`/api/chat/${goodId}/diff/approve`);
  await until(async () => (await j(`/api/chat/${goodId}`)).body?.phase === 'committed', 60000);
  ok('a valid page commits', (await j(`/api/chat/${goodId}`)).body?.phase === 'committed');

  const badId = await runToGate('PAGE_CASE:BAD 再来一个');
  const badPage = ((await j(`/api/chat/${badId}`)).body?.review?.pages ?? [])[0];
  ok('an invalid page is marked invalid', badPage?.status === 'invalid', JSON.stringify(badPage ?? null));
  ok('the reason names the unknown component', /Gantt/.test(badPage?.reason ?? ''), badPage?.reason ?? '');
  await post(`/api/chat/${badId}/diff/approve`);
  const stillAtGate = (await j(`/api/chat/${badId}`)).body?.phase;
  ok('approving an invalid page is REFUSED', stillAtGate === 'awaiting-diff-approval', String(stillAtGate));
  await post(`/api/chat/${badId}/diff/reject`);
} catch (e) {
  fail(e?.stack || String(e));
  console.error(server.log().slice(-3000));
} finally {
  server.stop();
}

done();
