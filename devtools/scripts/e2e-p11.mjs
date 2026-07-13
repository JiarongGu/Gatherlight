#!/usr/bin/env node
// e2e P11 — native C#/Playwright scraper ports. Points the scraper base URLs at a local fixture
// server serving canned FlightAware/FlightStats HTML, so the full navigate + parse path is tested
// deterministically (no live sites). Verifies the schedule is extracted and claims cross-checked.
import http from 'node:http';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient } from './_e2e-common.mjs';

const dataDir = dataDirFor('p11');
const FIXTURE_PORT = 5388;
const { ok, fail, done } = makeReporter('p11');

makeTestData(dataDir);

// --- fixture site: FlightAware + FlightStats pages for a fictional flight XY99 -------------------
const fixture = http.createServer((req, res) => {
  const url = req.url ?? '';
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (url.startsWith('/live/flight/XY99')) {
    // FlightAware-style: title has the flight, body has route + Departure/Arrival + aircraft.
    res.end(`<html><head><title>XY99 / XYZ99 Airline Flight Tracking</title></head>
      <body><h1>AAA / KAAA - BBB / KBBB</h1>
      <div>Aircraft Airbus A320</div>
      <div>Departure 17:55</div><div>Arrival 21:10</div></body></html>`);
  } else if (url.startsWith('/live/flight/ZZ313')) {
    // Fabricated code → a "not found"-ish page (a different carrier owns ZZ). No dep/arr/flight.
    res.end(`<html><head><title>Flight Not Found</title></head><body>No flight found for ZZ313.</body></html>`);
  } else if (url.startsWith('/v2/flight-tracker/XY/99')) {
    res.end(`<html><head><title>XY 99</title></head><body>
      <div>Departure 17:55 Tokyo</div><div>Arrival 21:10 Beijing</div></body></html>`);
  } else if (url.includes('page23e_000539') || url.includes('topics/china')) {
    // MOFA China page: Chinese nationals need a visa (NOT visa-free) — the incident case.
    res.end(`<html><body>${'padding '.repeat(40)}
      Chinese nationals must apply for a visa to enter Japan for short-term stay.
      Individual tourist single-entry visa allows a period of stay up to 15 days.
      Multiple-entry visas are also available. The passport must be valid for the duration of stay.
      </body></html>`);
  } else if (url.includes('novisa')) {
    res.end(`<html><body>${'padding '.repeat(40)}
      Visa exemption arrangements: nationals of these countries enjoy visa-free short-term stay
      of up to 90 days. No visa is required for tourism.</body></html>`);
  } else {
    res.statusCode = 404;
    res.end('<html><body>flight not found</body></html>');
  }
});
await new Promise((r) => fixture.listen(FIXTURE_PORT, r));
const fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;

const srv = startServer({
  dataDir, port: 5389,
  env: {
    GATHERLIGHT_BASE_FLIGHTAWARE: fixtureBase,
    GATHERLIGHT_BASE_FLIGHTSTATS: fixtureBase,
    GATHERLIGHT_BASE_MOFA: fixtureBase,
  },
});
const { call } = makeClient(srv.base);

try {
  await waitHealthy(srv.base);

  // native tool registered (not the leaf)
  const tools = (await (await fetch(`${srv.base}/api/tools`)).json()).tools;
  const fsTool = tools.find((t) => t.name === 'flight_schedule');
  ok('flight_schedule registered', !!fsTool);
  ok('native single-flight schema', fsTool?.inputSchema?.required?.includes('carrierIATA')
    && fsTool?.inputSchema?.required?.includes('flightNumber'));

  // correct flight XY99 → schedule extracted from both sources, claim matches
  const good = await call('flight_schedule', {
    carrierIATA: 'XY', flightNumber: '99', claimedDepartTime: '17:55', claimedOrigin: 'AAA', claimedDest: 'BBB',
  });
  ok('extracts actual depart 17:55', good.result.actualDepartTime === '17:55', good.result.actualDepartTime);
  ok('extracts actual arrive 21:10', good.result.actualArriveTime === '21:10', good.result.actualArriveTime);
  ok('extracts route AAA→BBB', good.result.actualOrigin === 'AAA' && good.result.actualDest === 'BBB',
    `${good.result.actualOrigin}→${good.result.actualDest}`);
  ok('both sources hit', good.result.sources.length === 2, good.result.notes);
  ok('claimed time/origin/dest all match', good.result.claimedMatches.all === true, JSON.stringify(good.result.claimedMatches));

  // fabricated code ZZ313 → no schedule found (the incident case)
  const fake = await call('flight_schedule', { carrierIATA: 'ZZ', flightNumber: '313' });
  ok('fabricated code → no schedule', fake.result.actualDepartTime === null && fake.result.sources.length === 0,
    JSON.stringify({ dep: fake.result.actualDepartTime, sources: fake.result.sources.length }));

  // no more Node flight-schedule leaf behind the same name (it's the native one)
  ok('single-flight (not batch queries) schema', !fsTool.inputSchema.properties.queries);

  // --- policy_check (native) ---
  const pc = await call('policy_check', { passportCountry: 'China', destinationCountry: 'Japan' });
  ok('policy_check: China→Japan needs a visa', pc.result.visaRequired === true, JSON.stringify(pc.result.visaRequired));
  ok('policy_check: max stay 15 days', pc.result.maxStayDays === 15, String(pc.result.maxStayDays));
  ok('policy_check: detects visa types', (pc.result.visaTypes ?? '').includes('single-entry'), pc.result.visaTypes);
  ok('policy_check: cites MOFA sources', pc.result.officialSources.length >= 1);
  const pcTool = tools.find((t) => t.name === 'policy_check');
  ok('policy_check native single-query schema', pcTool && !pcTool.inputSchema.properties.queries
    && pcTool.inputSchema.required.includes('passportCountry'));
} catch (err) {
  fail('e2e-p11 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
  fixture.close();
}
done();
