#!/usr/bin/env node
// e2e P22 — full-text search (FTS5 trigram) for the knowledge library + fact store. Verifies
// BM25-ranked matching on Latin + CJK (trigram substring), the <3-char LIKE fallback, and that the
// sync triggers keep the FTS index correct across update + delete.
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd } from './_e2e-common.mjs';

const dataDir = dataDirFor('p22');
const { ok, fail, done } = makeReporter('p22');
makeTestData(dataDir);
const srv = startServer({ dataDir, port: 5471, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { call } = makeClient(srv.base);

const lib = async (q) => (await (await fetch(`${srv.base}/api/library?q=${encodeURIComponent(q)}&limit=50`)).json()).items;
const keys = (items) => items.map((i) => i.key);

try {
  await waitHealthy(srv.base);

  // seed the library (CJK + Latin)
  await call('library_upsert', { kind: 'attraction', key: 'kinkakuji', name: 'Kinkaku-ji', nameLocal: '金阁寺', region: 'Kyoto, Japan', summary: 'The Golden Pavilion, a famous Zen temple.', tags: 'temple,zen', confidence: 0.9 });
  await call('library_upsert', { kind: 'attraction', key: 'fushimi', name: 'Fushimi Inari', nameLocal: '伏见稻荷大社', region: 'Kyoto, Japan', summary: 'Famous for thousands of vermilion torii gates.', tags: 'shrine,torii', confidence: 0.8 });
  await call('library_upsert', { kind: 'restaurant', key: 'diner', name: 'Sushi Diner', region: 'Tokyo, Japan', summary: 'A casual sushi spot.', tags: 'sushi', confidence: 0.7 });

  ok('FTS Latin ≥3: "temple" → kinkakuji (summary match)', keys(await lib('temple')).includes('kinkakuji'));
  ok('FTS Latin ≥3: "torii" → fushimi (summary/tags match)', keys(await lib('torii')).includes('fushimi'));
  ok('FTS CJK trigram ≥3: "金阁寺" → kinkakuji (nameLocal substring)', keys(await lib('金阁寺')).includes('kinkakuji'));
  ok('LIKE fallback <3 chars: "金阁" → kinkakuji', keys(await lib('金阁')).includes('kinkakuji'));
  ok('FTS misses unrelated: "temple" excludes the sushi diner', !keys(await lib('temple')).includes('diner'));

  // update trigger: change the summary so it no longer contains "temple", add "pagoda"
  await call('library_upsert', { kind: 'attraction', key: 'kinkakuji', name: 'Kinkaku-ji', nameLocal: '金阁寺', region: 'Kyoto, Japan', summary: 'The Golden Pavilion, a lakeside gilded pagoda.', tags: 'zen', confidence: 0.9 });
  ok('update trigger: "temple" no longer matches kinkakuji', !keys(await lib('temple')).includes('kinkakuji'));
  ok('update trigger: "pagoda" now matches kinkakuji', keys(await lib('pagoda')).includes('kinkakuji'));

  // delete trigger: removing the diner drops it from the FTS index
  const del = (await call('library_delete', { kind: 'restaurant', key: 'diner' })).result;
  ok('library_delete ok', del && del.deleted !== false, JSON.stringify(del));
  ok('delete trigger: "sushi" returns nothing', keys(await lib('sushi')).length === 0);

  // fact store FTS
  await call('remember_fact', { kind: 'venue-url', topic: 'Kinkaku-ji official site', content: 'https://www.shokoku-ji.jp opening hours 09:00-17:00 verified', source: 'https://www.shokoku-ji.jp', confidence: 0.95 });
  await call('remember_fact', { kind: 'policy', topic: '日本签证政策', content: '中国护照赴日需办理短期签证,有效期视类型而定。', source: 'https://mofa.go.jp', confidence: 0.9 });
  const r1 = (await call('recall_facts', { query: 'opening hours' })).result;
  ok('facts FTS Latin: "opening hours" recalls the venue fact', (r1.facts ?? []).some((f) => f.topic.includes('Kinkaku-ji')), JSON.stringify((r1.facts ?? []).map((f) => f.topic)));
  const r2 = (await call('recall_facts', { query: '签证政策' })).result;
  ok('facts FTS CJK trigram: "签证政策" recalls the visa fact', (r2.facts ?? []).some((f) => f.topic.includes('签证')));
} catch (err) {
  fail('e2e-p22 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
