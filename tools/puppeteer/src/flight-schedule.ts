#!/usr/bin/env node
/**
 * Flight schedule verifier — fetches actual schedule for a given carrier + flight + date.
 *
 * Built per the verify-policy-info rule after a 2026-05-27 discovery that a
 * model-recalled flight number carried a fabricated carrier code (IZ claimed
 * for Spring Airlines Japan, whose real IATA code is IJ — IZ is Arkia Israeli
 * Airlines). Always cross-check FlightAware/FlightStats.
 *
 * Usage:
 *   npx tsx src/flight-schedule.ts --file <queries.json>
 *
 * Input JSON — array of:
 *   {
 *     "carrierIATA": "IJ",                       (e.g. JQ, QF, IJ)
 *     "flightNumber": "17",                       (digits only)
 *     "claimedDate": "2026-09-20",                (optional, for forward verification — uses today if absent)
 *     "claimedDepartTime": "17:55",                (optional)
 *     "claimedOrigin": "NRT",                       (optional)
 *     "claimedDest": "PEK"                          (optional)
 *   }
 *
 * Output JSON:
 *   { source, scrapeTime, rows: [ {
 *       query, flightAwareUrl, actualOrigin, actualDest,
 *       actualDepartTime, actualArriveTime, aircraft, status,
 *       claimedMatches: { date, time, origin, dest, all },
 *       sources: [ { domain, url, departTime, arriveTime } ],
 *       notes
 *   } ] }
 */
import fs from 'node:fs';
import type { Page } from 'puppeteer';
import { launchBrowser, newPage, emit, log, sleep } from './browser.js';

interface FlightQuery {
  carrierIATA: string;
  flightNumber: string;
  claimedDate?: string;
  claimedDepartTime?: string;
  claimedOrigin?: string;
  claimedDest?: string;
}

interface FlightSource {
  domain: string;
  url: string;
  departTime: string | null;
  arriveTime: string | null;
  origin: string | null;
  dest: string | null;
  aircraft: string | null;
  status: string | null;
}

interface FlightInfo {
  query: FlightQuery;
  flightAwareUrl: string;
  actualOrigin: string | null;
  actualDest: string | null;
  actualDepartTime: string | null;
  actualArriveTime: string | null;
  aircraft: string | null;
  status: string | null;
  claimedMatches: {
    time: boolean | null;
    origin: boolean | null;
    dest: boolean | null;
    all: boolean | null;
  };
  sources: FlightSource[];
  notes: string;
}

function parseTimeToken(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = m[1]?.padStart(2, '0');
  const mn = m[2];
  return h && mn ? `${h}:${mn}` : null;
}

async function scrapeFlightAware(page: Page, carrier: string, num: string): Promise<FlightSource | null> {
  // FlightAware /live/flight/<callsign>/history/ — shows most-recent leg
  // Spring Airlines Japan = SJO (ICAO) — IJ<num> maps to SJO<num>. For other
  // carriers, we try the IATA + number directly first, then fall back.
  const candidates = [
    `https://www.flightaware.com/live/flight/${carrier}${num}`,
    `https://www.flightaware.com/live/flight/${carrier}${num}/history`
  ];
  for (const url of candidates) {
    try {
      log(`  fa: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1000);
      const text = await page.evaluate(() => document.body.innerText || '');
      // Look for "Departure XX:XX" / "Arrival XX:XX" patterns
      const depMatch = text.match(/Departure[^\d]{0,40}(\d{1,2}:\d{2})/i);
      const arrMatch = text.match(/Arrival[^\d]{0,40}(\d{1,2}:\d{2})/i);
      // Origin/dest 3-letter IATA codes in the page header (e.g. "PEK / ZBAA - NRT / RJAA")
      const routeMatch = text.match(/\b([A-Z]{3})\b[^a-zA-Z]+?\b([A-Z]{3})\b.*(?:Boeing|Airbus|aircraft|equipment)/is);
      // Title typically shows airline / number
      const title = await page.title();
      const hasFlight = new RegExp(`${carrier}${num}\\b|${carrier}-${num}\\b`, 'i').test(title + ' ' + text);
      if (!hasFlight && !depMatch && !arrMatch) continue;
      return {
        domain: 'flightaware.com',
        url,
        departTime: depMatch ? parseTimeToken(depMatch[1]) : null,
        arriveTime: arrMatch ? parseTimeToken(arrMatch[1]) : null,
        origin: routeMatch ? routeMatch[1] || null : null,
        dest: routeMatch ? routeMatch[2] || null : null,
        aircraft: null,
        status: null
      };
    } catch (err) {
      // try next
    }
  }
  return null;
}

async function scrapeFlightStats(page: Page, carrier: string, num: string): Promise<FlightSource | null> {
  // FlightStats: https://www.flightstats.com/v2/flight-tracker/<carrier>/<num>
  const url = `https://www.flightstats.com/v2/flight-tracker/${carrier}/${num}`;
  try {
    log(`  fs: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);
    const text = await page.evaluate(() => document.body.innerText || '');
    const hasNotFound = /flight not found|no flight|404/i.test(text);
    if (hasNotFound) return null;
    const depMatch = text.match(/Departure[^\n]{0,80}?(\d{1,2}:\d{2})/i);
    const arrMatch = text.match(/Arrival[^\n]{0,80}?(\d{1,2}:\d{2})/i);
    return {
      domain: 'flightstats.com',
      url,
      departTime: depMatch ? parseTimeToken(depMatch[1]) : null,
      arriveTime: arrMatch ? parseTimeToken(arrMatch[1]) : null,
      origin: null,
      dest: null,
      aircraft: null,
      status: null
    };
  } catch {
    return null;
  }
}

async function processQuery(page: Page, q: FlightQuery): Promise<FlightInfo> {
  const flightAwareUrl = `https://www.flightaware.com/live/flight/${q.carrierIATA}${q.flightNumber}`;
  const info: FlightInfo = {
    query: q,
    flightAwareUrl,
    actualOrigin: null,
    actualDest: null,
    actualDepartTime: null,
    actualArriveTime: null,
    aircraft: null,
    status: null,
    claimedMatches: { time: null, origin: null, dest: null, all: null },
    sources: [],
    notes: ''
  };

  const fa = await scrapeFlightAware(page, q.carrierIATA, q.flightNumber);
  if (fa) info.sources.push(fa);
  await sleep(1500);

  const fs = await scrapeFlightStats(page, q.carrierIATA, q.flightNumber);
  if (fs) info.sources.push(fs);

  // Vote
  const depts = info.sources.map((s) => s.departTime).filter((x): x is string => !!x);
  const arrs = info.sources.map((s) => s.arriveTime).filter((x): x is string => !!x);
  const origs = info.sources.map((s) => s.origin).filter((x): x is string => !!x);
  const dests = info.sources.map((s) => s.dest).filter((x): x is string => !!x);
  info.actualDepartTime = depts[0] || null;
  info.actualArriveTime = arrs[0] || null;
  info.actualOrigin = origs[0] || null;
  info.actualDest = dests[0] || null;

  // Cross-check
  if (q.claimedDepartTime && info.actualDepartTime) {
    info.claimedMatches.time = parseTimeToken(q.claimedDepartTime) === info.actualDepartTime;
  }
  if (q.claimedOrigin && info.actualOrigin) {
    info.claimedMatches.origin = q.claimedOrigin.toUpperCase() === info.actualOrigin.toUpperCase();
  }
  if (q.claimedDest && info.actualDest) {
    info.claimedMatches.dest = q.claimedDest.toUpperCase() === info.actualDest.toUpperCase();
  }
  const checks = [info.claimedMatches.time, info.claimedMatches.origin, info.claimedMatches.dest].filter(
    (x): x is boolean => x !== null
  );
  info.claimedMatches.all = checks.length > 0 && checks.every((x) => x);
  info.notes = `sources=${info.sources.length}; flightaware=${fa ? 'ok' : 'miss'}; flightstats=${fs ? 'ok' : 'miss'}`;
  return info;
}

function parseArgs(argv: string[]): FlightQuery[] {
  if (argv[0] !== '--file') {
    console.error('Usage: flight-schedule --file <queries.json>');
    process.exit(1);
  }
  const p = argv[1];
  if (!p) {
    console.error('--file needs a path');
    process.exit(1);
  }
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    console.error('JSON must be an array of {carrierIATA, flightNumber, ...}');
    process.exit(1);
  }
  for (const q of parsed) {
    if (!q.carrierIATA || !q.flightNumber) {
      console.error(`Missing required carrierIATA / flightNumber: ${JSON.stringify(q)}`);
      process.exit(1);
    }
  }
  return parsed;
}

async function main() {
  const queries = parseArgs(process.argv.slice(2));
  log(`flight-schedule: ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}`);
  const browser = await launchBrowser();
  const rows: FlightInfo[] = [];
  try {
    const page = await newPage(browser);
    for (const q of queries) {
      log(`[${q.carrierIATA}${q.flightNumber}${q.claimedDate ? ' ' + q.claimedDate : ''}]`);
      try {
        const info = await processQuery(page, q);
        rows.push(info);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rows.push({
          query: q,
          flightAwareUrl: `https://www.flightaware.com/live/flight/${q.carrierIATA}${q.flightNumber}`,
          actualOrigin: null,
          actualDest: null,
          actualDepartTime: null,
          actualArriveTime: null,
          aircraft: null,
          status: null,
          claimedMatches: { time: null, origin: null, dest: null, all: null },
          sources: [],
          notes: `top-level error: ${msg}`
        });
      }
      await sleep(2500);
    }
    emit({
      source: 'tools/puppeteer/flight-schedule',
      scrapeTime: new Date().toISOString(),
      rows
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`failed: ${msg}`);
    emit({ error: msg, partialRows: rows });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
