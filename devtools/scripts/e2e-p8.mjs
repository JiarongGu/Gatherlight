#!/usr/bin/env node
// e2e P8 — zero-LLM ICS export + tool coverage. Trip plan → one VEVENT per dated Day heading;
// changelog headings that merely cite a date are ignored; daily plan → one event; the six
// puppeteer verifiers + fill_itinerary are registered on both surfaces.
import path from 'node:path';
import fs from 'node:fs';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy } from './_e2e-common.mjs';

const dataDir = dataDirFor('p8');
const { ok, fail, done } = makeReporter('p8');

makeTestData(dataDir);

// Overwrite the fixture trip with a known heading set: a changelog heading (a date that must NOT
// become an event) + exactly 3 dated Day headings — covers day-vs-note discrimination.
fs.writeFileSync(path.join(dataDir, 'plans', 'trips', '2026-08-kyoto.md'), [
  '# 京都 3 天(fixture)', '',
  '## 📋 更新记录(2026-05-20)', '- 初版', '',
  '### 🛫 Day 1 — 2026-08-10(Mon) — 抵达', '- KIX',
  '### 🍵 Day 2 — 2026-08-11(Tue) — 東山', '- 清水寺',
  '### 🦌 Day 3 — 2026-08-12(Wed) — 奈良', '- 東大寺', '',
].join('\n'));
// A daily plan (date only in the filename + H1).
fs.mkdirSync(path.join(dataDir, 'plans', 'daily'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'plans', 'daily', '2026-08-01.md'), '# 2026-08-01 — 周六\n\n- 验证\n');

const srv = startServer({ dataDir, port: 5398 });
const base = srv.base;

const text = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, ctype: res.headers.get('content-type') ?? '', body: await res.text() };
};

try {
  await waitHealthy(srv.base);

  // --- ICS: trip → 3 day events, changelog date excluded --------------------------------
  const trip = await text('/api/plans/ics?path=plans/trips/2026-08-kyoto.md');
  ok('ics 200 + calendar content-type', trip.status === 200 && trip.ctype.includes('text/calendar'), trip.ctype);
  const vevents = (trip.body.match(/BEGIN:VEVENT/g) ?? []).length;
  ok('one event per Day heading (3)', vevents === 3, `got ${vevents}`);
  ok('correct dates present', ['20260810', '20260811', '20260812'].every((d) => trip.body.includes(`DTSTART;VALUE=DATE:${d}`)));
  ok('changelog date (2026-05-20) excluded', !trip.body.includes('20260520'));
  ok('valid VCALENDAR envelope', trip.body.startsWith('BEGIN:VCALENDAR') && trip.body.trimEnd().endsWith('END:VCALENDAR'));
  ok('CRLF line endings (RFC5545)', trip.body.includes('\r\n'));

  // --- ICS: daily plan → single event from filename/H1 ----------------------------------
  const daily = await text('/api/plans/ics?path=plans/daily/2026-08-01.md');
  ok('daily plan → 1 event', (daily.body.match(/BEGIN:VEVENT/g) ?? []).length === 1
    && daily.body.includes('DTSTART;VALUE=DATE:20260801'));

  // --- ICS: guards ----------------------------------------------------------------------
  const noDates = await text('/api/plans/ics?path=household/people.md');
  ok('no-dates plan → 404', noDates.status === 404);
  const badPath = await text('/api/plans/ics?path=../CLAUDE.md');
  ok('traversal guarded', badPath.status === 400 || badPath.status === 404);

  // --- tool coverage: 11 tools on both surfaces -----------------------------------------
  const tools = await (await fetch(`${base}/api/tools`)).json();
  const names = tools.tools.map((t) => t.name);
  const expected = ['extract', 'scrape', 'wiki_info', 'policy_check', 'hotel_info', 'restaurant_info',
    'flight_schedule', 'flight_prices', 'hotel_prices', 'fill_itinerary', 'remember_fact', 'recall_facts',
    'library_upsert', 'library_search', 'library_delete'];
  ok('all built-in tools registered (HTTP)', expected.every((n) => names.includes(n)),
    expected.filter((n) => !names.includes(n)).join(',') || 'ok');
  const mcp = await (await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })).json();
  const mcpNames = mcp.result.tools.map((t) => t.name);
  ok('all tools on MCP', expected.every((n) => mcpNames.includes(n)));
  const fi = tools.tools.find((t) => t.name === 'fill_itinerary');
  ok('fill_itinerary schema requires paths', ['templatePath', 'dataPath', 'outPath'].every((k) => fi?.inputSchema?.required?.includes(k)));
} catch (err) {
  fail('e2e-p8 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
