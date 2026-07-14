#!/usr/bin/env node
// e2e P12 — the four remaining native scraper ports (flight_prices, hotel_prices, hotel_info,
// restaurant_info). A local fixture server serves canned Kayak / Booking / DuckDuckGo / Tabelog
// pages; the server runs with GATHERLIGHT_FIXTURE_ORIGIN pointing at it, so PlaywrightScraper
// rewrites every real-domain navigation (tabelog.com, booking.com, …) to `{origin}/{host}{path}`
// while the tools still classify/report the original URL. Exercises the full navigate + parse path.
import http from 'node:http';
import { dataDirFor, makeReporter, makeTestData, startServer, until, makeClient, skipUnlessChromium } from './_e2e-common.mjs';

const dataDir = dataDirFor('p12');
const { ok, fail, done } = makeReporter('p12');
const PORT = 5392;
const FIXTURE_PORT = 5391;

makeTestData(dataDir);

const html = (body) => `<html><head><title>${body.title ?? ''}</title></head><body>${body.html}</body></html>`;
const ddgLink = (title, realUrl) =>
  `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(realUrl)}">${title}</a>`;
const tabelogPage = (name) =>
  html({
    title: `${name} - Tabelog`,
    html: `<h1>${name}</h1><table>
      <tr><th>Restaurant name</th><td>${name}</td></tr>
      <tr><th>Categories</th><td>Sushi, Omakase</td></tr>
      <tr><th>Address</th><td>1-2-3 Namba, Chuo-ku, Osaka</td></tr>
      <tr><th>Business hours</th><td>17:00 - 22:00</td></tr>
      <tr><th>Average price</th><td>JPY 20,000</td></tr></table>`,
  });

// --- fixture site (routes on `/{host}{path}` produced by the fixture rewrite) -------------------
const fixture = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url ?? '');
  res.setHeader('content-type', 'text/html; charset=utf-8');

  // DuckDuckGo HTML search results — branch on the query intent.
  if (url.startsWith('/html.duckduckgo.com/')) {
    if (/address phone official/i.test(url)) {
      res.end(html({ title: 'DDG', html:
        ddgLink('Fixture Grand Hotel Osaka - Official', 'https://fixture-grand.example.jp/access/') +
        ddgLink('Fixture Grand Hotel Osaka - Booking.com', 'https://www.booking.com/hotel/jp/fixture-grand.html') }));
    } else {
      // restaurant search → one trusted Tabelog individual page for the real name
      res.end(html({ title: 'DDG', html:
        ddgLink('Fixture Sushi Beta - Tabelog', 'https://tabelog.com/en/osaka/A2701/A270102/27123456/') }));
    }
    return;
  }

  // Kayak flight prices
  if (url.startsWith('/www.kayak.com.au/flights/')) {
    res.end(html({ title: 'SYD to KIX flights', html: '<div>from A$1,148</div><div>A$1,320</div>' }));
    return;
  }

  // Booking hotel prices (searchresults) — branch on the searched hotel name
  if (url.startsWith('/www.booking.com/searchresults.html')) {
    if (/Fixture%20Grand|Fixture Grand/i.test(req.url ?? '')) {
      res.end(html({ title: 'Booking', html:
        '<div>Search results</div><div>Fixture Grand Hotel Osaka</div>' +
        '<div>Price for 3 nights AUD 60 - AUD 900+</div><div>AU$810</div>' }));
    } else {
      res.end(html({ title: 'Booking', html: '<div>No properties found for your search.</div>' }));
    }
    return;
  }

  // Hotel official site + Booking property page (hotel_info sources)
  if (url.startsWith('/fixture-grand.example.jp/') || url.startsWith('/www.booking.com/hotel/')) {
    res.end(html({ title: 'Fixture Grand Hotel Osaka', html:
      '<h1>Fixture Grand Hotel Osaka</h1>' +
      '<div>Tel: +81-6-5555-0100</div>' +
      '<div>〒530-8790</div>' +
      '<div>1-2-3 Testville, Naka-ku, Osaka</div>' +
      '<div>Check-in 15:00 / Check-out 11:00</div>' }));
    return;
  }

  // Tabelog restaurant pages (restaurant_info verify)
  if (url.startsWith('/tabelog.com/en/osaka/A2701/A270101/27000001/')) { res.end(tabelogPage('Fixture Sushi Alpha')); return; }
  if (url.startsWith('/tabelog.com/en/osaka/A2701/A270101/27999999/')) { res.end(tabelogPage('Fixture Teppan Gamma')); return; }
  if (url.startsWith('/tabelog.com/en/osaka/A2701/A270102/27123456/')) { res.end(tabelogPage('Fixture Sushi Beta')); return; }

  res.statusCode = 404;
  res.end(html({ title: 'Not Found', html: 'not found' }));
});
await new Promise((r) => fixture.listen(FIXTURE_PORT, r));
const fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;

const srv = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_FIXTURE_ORIGIN: fixtureBase } });
const { call } = makeClient(srv.base);

try {
  await until(() => fetch(`${srv.base}/api/health`).then((r) => r.ok));
  await skipUnlessChromium(srv.base, 'p12'); // scrapers need the download-at-setup browser

  const tools = (await (await fetch(`${srv.base}/api/tools`)).json()).tools;
  for (const n of ['flight_prices', 'hotel_prices', 'hotel_info', 'restaurant_info'])
    ok(`${n} registered (native)`, tools.some((t) => t.name === n));
  // the old Node-leaf batch schema (a single `queries` string) is gone for flight_prices
  const fp = tools.find((t) => t.name === 'flight_prices');
  ok('flight_prices native origin/dest schema', fp?.inputSchema?.required?.includes('origin')
    && fp?.inputSchema?.required?.includes('dest'));

  // --- flight_prices: two date pairs, prices parsed off the Kayak fixture ---
  const flights = await call('flight_prices', {
    origin: 'SYD', dest: 'KIX', depart: '2026-09-10', return: '2026-09-27', also: '2026-10-05:2026-10-20',
  });
  ok('flight_prices: currency AUD', flights.result.currency === 'AUD');
  ok('flight_prices: two rows (base + also)', flights.result.rows.length === 2, String(flights.result.rows.length));
  ok('flight_prices: cheapest parsed 1148', flights.result.rows.every((r) => r.cheapestAUD === 1148),
    JSON.stringify(flights.result.rows.map((r) => r.cheapestAUD)));

  // --- hotel_prices: named hotel found → per-night = total/nights; unknown hotel → null ---
  const hp = await call('hotel_prices', {
    queries: JSON.stringify([
      { name: 'Fixture Grand Hotel Osaka', checkin: '2026-09-10', checkout: '2026-09-13', guests: 3 },
      { name: 'Nowhere Hotel ZZZ', checkin: '2026-09-10', checkout: '2026-09-12', guests: 2 },
    ]),
  });
  const stay0 = hp.result.rows[0];
  ok('hotel_prices: nights = 3', stay0.nights === 3, String(stay0.nights));
  ok('hotel_prices: per-night 270 (810/3)', stay0.cheapestPerNight === 270, String(stay0.cheapestPerNight));
  ok('hotel_prices: total 810', stay0.totalAUD === 810, String(stay0.totalAUD));
  ok('hotel_prices: unknown hotel → null', hp.result.rows[1].cheapestPerNight === null, hp.result.rows[1].notes);

  // --- hotel_info: official + aggregator scraped, phone voted, claimed phone mismatch flagged ---
  const hi = await call('hotel_info', {
    queries: JSON.stringify([
      { name: 'Fixture Grand Hotel Osaka', city: 'Osaka', claimedPhone: '+81-6-5555-9999' },
    ]),
  });
  const hrow = hi.result.rows[0];
  ok('hotel_info: verified phone extracted', hrow.verifiedPhone === '+81-6-5555-0100', hrow.verifiedPhone);
  ok('hotel_info: postal code extracted', hrow.postalCode === '530-8790', hrow.postalCode);
  ok('hotel_info: check-in time extracted', hrow.checkInTime === '15:00', hrow.checkInTime);
  ok('hotel_info: claimed-vs-verified mismatch flagged', hrow.mismatch === true, JSON.stringify(hrow.mismatch));
  ok('hotel_info: sources scraped', hrow.sources.length >= 1, String(hrow.sources.length));

  // --- restaurant_info: claimed URL matches → accepted; claimed URL mismatched → search replaces ---
  const ri = await call('restaurant_info', {
    queries: JSON.stringify([
      { name: 'Fixture Sushi Alpha', area: 'Osaka', claimedUrl: 'https://tabelog.com/en/osaka/A2701/A270101/27000001/' },
      { name: 'Fixture Sushi Beta', area: 'Osaka', cuisine: 'omakase', claimedUrl: 'https://tabelog.com/en/osaka/A2701/A270101/27999999/' },
    ]),
  });
  const good = ri.result.rows[0];
  ok('restaurant_info: matching claimed URL accepted', good.claimedNameMatches === true, JSON.stringify(good.claimedNameMatches));
  ok('restaurant_info: verifiedUrl = claimed on match', good.verifiedUrl === 'https://tabelog.com/en/osaka/A2701/A270101/27000001/', good.verifiedUrl);
  ok('restaurant_info: actual name from Tabelog table', good.actualName === 'Fixture Sushi Alpha', good.actualName);

  const bad = ri.result.rows[1];
  ok('restaurant_info: mismatched claim rejected', bad.claimedNameMatches === false, JSON.stringify(bad.claimedNameMatches));
  ok('restaurant_info: search found replacement', bad.verifiedUrl === 'https://tabelog.com/en/osaka/A2701/A270102/27123456/', bad.verifiedUrl);
  ok('restaurant_info: replacement is the real restaurant', bad.actualName === 'Fixture Sushi Beta', bad.actualName);
} catch (err) {
  fail('e2e-p12 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
  fixture.close();
}
done();
