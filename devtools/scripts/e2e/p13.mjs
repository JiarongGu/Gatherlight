#!/usr/bin/env node
// e2e P13 — the DB-backed knowledge library. Agent tools (library_upsert/search/delete) write to
// the library_item table; the browse read side (/api/library) serves it zero-LLM. No claude, no
// browser — pure DB round-trips.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { dataDirFor, makeReporter, makeTestData, startServer, until, waitHealthy, makeClient } from './_e2e-common.mjs';

const dataDir = dataDirFor('p13');
const { ok, fail, done } = makeReporter('p13');
const PORT = 5393;
const IMG_PORT = 5394;

makeTestData(dataDir);

// Fixture upstream for the image-cache proxy: a 1x1 PNG (counting hits) + a non-image route.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
let imgHits = 0;
const imgFixture = http.createServer((req, res) => {
  if ((req.url ?? '').startsWith('/img.png')) {
    imgHits++;
    res.setHeader('content-type', 'image/png');
    res.end(PNG_1x1);
  } else if ((req.url ?? '').startsWith('/not-image')) {
    res.setHeader('content-type', 'text/plain');
    res.end('nope');
  } else {
    res.statusCode = 404;
    res.end('nf');
  }
});
await new Promise((r) => imgFixture.listen(IMG_PORT, r));
const imgBase = `http://127.0.0.1:${IMG_PORT}`;

// allow the loopback fixture through the SSRF guard (production keeps it on).
const srv = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_IMAGE_ALLOW_PRIVATE: '1' } });
const { call, getJson } = makeClient(srv.base);

try {
  await waitHealthy(srv.base);

  const tools = (await getJson('/api/tools')).tools;
  for (const n of ['library_upsert', 'library_search', 'library_delete'])
    ok(`${n} registered`, tools.some((t) => t.name === n));

  // upsert two attractions + one restaurant
  const up1 = await call('library_upsert', {
    kind: 'attraction', key: 'kinkaku-ji', name: 'Kinkaku-ji', nameLocal: '金閣寺',
    region: 'Kyoto, Japan', summary: 'The golden pavilion.', url: 'https://example.org/kinkakuji',
    lat: 35.0394, lng: 135.7292, tags: 'temple,unesco,garden', source: 'wikipedia', confidence: 0.95,
  });
  ok('library_upsert returns ok + id', up1.result.ok === true && up1.result.id > 0, JSON.stringify(up1.result));
  await call('library_upsert', {
    kind: 'attraction', key: 'fushimi-inari', name: 'Fushimi Inari Taisha', region: 'Kyoto, Japan',
    summary: 'Thousands of torii gates.', tags: 'shrine,torii', confidence: 0.9,
  });
  await call('library_upsert', {
    kind: 'restaurant', key: 'fixture-sushi', name: 'Fixture Sushi', region: 'Osaka, Japan',
    summary: 'Omakase counter.', confidence: 0.8,
  });

  // read side: list + facets
  const all = await getJson('/api/library');
  ok('GET /api/library returns 3 items', all.items.length === 3, String(all.items.length));
  ok('facets: total 3', all.facets.total === 3, JSON.stringify(all.facets.total));
  ok('facets: 2 kinds (attraction, restaurant)', all.facets.kinds.length === 2,
    JSON.stringify(all.facets.kinds.map((k) => k.value)));
  ok('facets: attraction count 2', all.facets.kinds.find((k) => k.value === 'attraction')?.count === 2);
  ok('confidence sort — Kinkaku-ji first', all.items[0].key === 'kinkaku-ji', all.items[0].key);
  ok('doubles materialize (lat ~35.04)', Math.abs((all.items.find((i) => i.key === 'kinkaku-ji').lat ?? 0) - 35.0394) < 0.001);

  // filter by kind + region
  const kyoto = await getJson('/api/library?kind=attraction&region=' + encodeURIComponent('Kyoto, Japan'));
  ok('filter kind+region → 2 Kyoto attractions', kyoto.items.length === 2, String(kyoto.items.length));

  // search via tool + via API
  const searched = await call('library_search', { query: 'golden' });
  ok('library_search finds "golden" → Kinkaku-ji', searched.result.count === 1 && searched.result.items[0].key === 'kinkaku-ji',
    JSON.stringify(searched.result.count));
  const apiSearch = await getJson('/api/library?q=torii');
  ok('GET /api/library?q=torii → Fushimi Inari', apiSearch.items.length === 1 && apiSearch.items[0].key === 'fushimi-inari');

  // idempotent upsert (same kind+key updates in place, no duplicate)
  await call('library_upsert', { kind: 'attraction', key: 'kinkaku-ji', name: 'Kinkaku-ji (Rokuon-ji)', confidence: 0.97 });
  const afterReupsert = await getJson('/api/library');
  ok('re-upsert updates in place (still 3 items)', afterReupsert.items.length === 3, String(afterReupsert.items.length));
  ok('re-upsert changed the name', afterReupsert.items.find((i) => i.key === 'kinkaku-ji').name === 'Kinkaku-ji (Rokuon-ji)');

  // detail endpoint
  const detail = await getJson('/api/library/item?kind=attraction&key=fushimi-inari');
  ok('detail endpoint returns the item', detail.name === 'Fushimi Inari Taisha', detail.name);

  // delete
  const del = await call('library_delete', { kind: 'restaurant', key: 'fixture-sushi' });
  ok('library_delete removes the item', del.result.removed === true, JSON.stringify(del.result));
  const afterDelete = await getJson('/api/library');
  ok('after delete → 2 items', afterDelete.items.length === 2, String(afterDelete.items.length));

  // --- markdown reference-library import (the JAPAN_ATTRACTIONS.md → DB migration) ---
  // fictional fixture in the same ## region / ### entry / bullet format, with a trip/family line
  // that MUST be dropped (适合).
  const refMd = `# Fixture Attractions Library

## 🏙️ Testville

### 🐠 测试馆 Test Aquarium / Fixture Aquarium

![Fixture Aquarium](https://example.org/aq.png)

> **Wikipedia** (verified 2026-01-01): The Fixture Aquarium is a large public aquarium in Testville, opened in 1990.

- **类型**: 水族馆(室内) · **位置**: 港区 (34.6545°N, 135.4289°E)
- **🎯 适合**: SECRET-FAMILY-NOTE should not migrate
- **🔗 Official**: [example.org](https://www.example.org/aq) · **🗺️ Wiki**: [Fixture Aquarium](https://en.wikipedia.org/wiki/Fixture_Aquarium)
- **📅 Day 2**

### 🍣 寿司太郎 Sushi Taro(米其林 ★)

> ⚠️ No Wikipedia article — hand-curated.

- **类型**: 寿司 · **位置**: 中央区
- **🔗 Official**: [example.org/sushi](https://www.example.org/sushi)

## 📖 How to Use This Library

### Regenerating

- run the wiki tool then import.

### Updating

- edit and re-import.
`;
  fs.mkdirSync(path.join(dataDir, 'reference'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'reference', 'fixture-lib.md'), refMd, 'utf8');

  const imp = await call('library_import', { path: 'reference/fixture-lib.md' });
  ok('library_import: imported 2', imp.result.imported === 2, JSON.stringify(imp.result.imported));
  ok('library_import: detects restaurant + attraction', imp.result.byKind.attraction === 1 && imp.result.byKind.restaurant === 1,
    JSON.stringify(imp.result.byKind));

  const imported = await getJson('/api/library');
  const aq = imported.items.find((i) => (i.name ?? '').includes('Aquarium') || (i.nameLocal ?? '').includes('测试馆'));
  ok('import: parsed name + local', !!aq && aq.nameLocal === '测试馆', aq?.nameLocal);
  ok('import: region from ## heading', aq?.region === 'Testville', aq?.region);
  ok('import: coordinates parsed', aq && Math.abs((aq.lat ?? 0) - 34.6545) < 0.001 && Math.abs((aq.lng ?? 0) - 135.4289) < 0.001);
  ok('import: official url (not wikipedia)', aq?.url === 'https://www.example.org/aq', aq?.url);
  ok('import: image parsed', aq?.imageUrl === 'https://example.org/aq.png', aq?.imageUrl);
  ok('import: summary from wiki blockquote', (aq?.summary ?? '').includes('aquarium'), aq?.summary);
  ok('import: DROPS family/trip lines (适合/📅)', !JSON.stringify(imported.items).includes('SECRET-FAMILY-NOTE'));
  const sushi = imported.items.find((i) => (i.name ?? '').includes('Sushi Taro'));
  ok('import: restaurant kind + warning → no summary', sushi?.kind === 'restaurant' && !sushi?.summary, `${sushi?.kind}/${sushi?.summary}`);
  ok('import: skips meta section (How to Use)', !imported.items.some((i) => ['regenerating', 'updating'].includes(i.key)));
  // idempotent — re-import doesn't duplicate
  await call('library_import', { path: 'reference/fixture-lib.md' });
  const reimport = await getJson('/api/library');
  ok('library_import idempotent (no dupes)', reimport.items.length === imported.items.length, `${imported.items.length}→${reimport.items.length}`);

  // --- image cache proxy (offline-safe cover images) ---
  const img1 = await fetch(`${srv.base}/api/library/image?url=${encodeURIComponent(imgBase + '/img.png')}`);
  ok('image proxy: 200 + image/png', img1.status === 200 && (img1.headers.get('content-type') ?? '').startsWith('image/png'),
    `${img1.status} ${img1.headers.get('content-type')}`);
  ok('image proxy: upstream hit once', imgHits === 1, `hits=${imgHits}`);
  const img2 = await fetch(`${srv.base}/api/library/image?url=${encodeURIComponent(imgBase + '/img.png')}`);
  ok('image proxy: second call served', img2.status === 200);
  ok('image proxy: cache hit (no 2nd upstream fetch)', imgHits === 1, `hits=${imgHits}`);
  const nonImg = await fetch(`${srv.base}/api/library/image?url=${encodeURIComponent(imgBase + '/not-image')}`);
  ok('image proxy: non-image → 404', nonImg.status === 404, String(nonImg.status));
} catch (err) {
  fail('e2e-p13 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
  imgFixture.close();
}
done();
