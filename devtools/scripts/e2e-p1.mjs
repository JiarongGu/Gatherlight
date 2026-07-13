#!/usr/bin/env node
// e2e P1 — read side: plan index, content, search, assets, fs ops (retitle/rename/delete),
// data-repo auto-commits, traversal + scope guards.
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, gitLog } from './_e2e-common.mjs';

const dataDir = dataDirFor('p1');
const { ok, fail, done } = makeReporter('p1');
makeTestData(dataDir);
const srv = startServer({ dataDir, port: 5391 });
const { j } = makeClient(srv.base);

try {
  await waitHealthy(srv.base);
  console.log('server up');

  // --- index ---
  const plans = await j('/api/plans');
  ok('GET /api/plans 200', plans.status === 200);
  const trip = plans.body.files.find((f) => f.path === 'plans/trips/2026-08-kyoto.md');
  ok('trip indexed', !!trip);
  ok('trip category/subgroup', trip?.category === 'Trips' && trip?.subgroup === 'kyoto');
  ok('trip title from H1', (trip?.title ?? '').includes('京都'));
  ok('trip planDate', trip?.planDate === '2026-08');
  const tmpl = plans.body.files.find((f) => f.path === '.claude/templates/trip.md');
  ok('zhiku template indexed', tmpl?.category === 'Templates');
  const asset = plans.body.assets.find((a) => a.path === 'plans/visa/2026-08-kyoto/applicant-data.json');
  ok('visa asset indexed', asset?.slug === '2026-08-kyoto' && asset?.kind === 'json');

  // --- content + asset + search ---
  const content = await j('/api/plans/content?path=plans/trips/2026-08-kyoto.md');
  ok('content fetch', content.status === 200 && content.body.content.includes('Hotel Fixture Kyoto'));
  const assetRes = await fetch(`${srv.base}${asset.url}`);
  ok('asset fetch', assetRes.status === 200 && (await assetRes.json()).applicationDate.year === '2026');
  const search = await j('/api/plans/search?q=' + encodeURIComponent('京都'));
  ok('search hits', search.status === 200 && search.body.results.length >= 2);

  // --- guards ---
  const traversal = await j('/api/plans/content?path=../CLAUDE.md');
  ok('traversal guarded', traversal.status === 404 || traversal.status === 400);
  const scope = await j('/api/fs/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: ['.claude/templates/trip.md'] }),
  });
  ok('fs scope guard (.claude blocked)', scope.status === 400);

  // --- fs ops + auto-commit ---
  const commitsBefore = gitLog(dataDir).length;
  const retitle = await j('/api/fs/retitle', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'plans/trips/2026-08-kyoto.md', title: '京都 5 天 v2(fixture)' }),
  });
  ok('retitle 200 + sha', retitle.status === 200 && !!retitle.body.sha);
  ok('retitle committed', gitLog(dataDir).length === commitsBefore + 1);
  const afterRetitle = await j('/api/plans');
  const tripV2 = afterRetitle.body.files.find((f) => f.path === 'plans/trips/2026-08-kyoto.md');
  ok('index reflects new title', (tripV2?.title ?? '').includes('v2'));

  const rename = await j('/api/fs/rename', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ renames: [{ from: 'plans/budgets/2026-08-kyoto.md', to: 'plans/budgets/2026-09-kyoto.md' }] }),
  });
  ok('rename 200', rename.status === 200 && !!rename.body.sha);
  const afterRename = await j('/api/plans');
  ok('index reflects rename',
    !afterRename.body.files.some((f) => f.path === 'plans/budgets/2026-08-kyoto.md') &&
    afterRename.body.files.some((f) => f.path === 'plans/budgets/2026-09-kyoto.md'));

  const del = await j('/api/fs/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: ['plans/budgets/2026-09-kyoto.md'] }),
  });
  ok('delete 200', del.status === 200 && !!del.body.sha);
  const afterDelete = await j('/api/plans');
  ok('index reflects delete', !afterDelete.body.files.some((f) => f.path.startsWith('plans/budgets/')));
} catch (err) {
  fail('e2e-p1 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
