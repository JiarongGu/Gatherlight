#!/usr/bin/env node
/**
 * Hotel info verifier — cross-checks hotel address + phone across multiple sources.
 *
 * Built per .claude/rules/verify-policy-info.md after 2026-05-27 discovery
 * that hotel addresses/phones in trip plans needed live verification
 * (Granvia: OK on scrape; Vista/Mitsui: had to fallback to model recall).
 *
 * Usage:
 *   npx tsx src/hotel-info.ts --file <queries.json>
 *
 * Input JSON — array of:
 *   {
 *     "name": "Hotel Granvia Osaka",
 *     "city": "Osaka",                  (optional, helps disambiguate)
 *     "claimedPhone": "+81-6-6344-1235", (optional)
 *     "claimedAddress": "3-1-1 Umeda"     (optional)
 *   }
 *
 * Output JSON:
 *   { source, scrapeTime, rows: [ {
 *       query, claimedPhone, claimedAddress,
 *       verifiedPhone, verifiedAddress, postalCode,
 *       checkInTime, checkOutTime,
 *       sources: [ { domain, phone, address, postalCode } ],
 *       mismatch: boolean,
 *       notes
 *   } ] }
 */
import fs from 'node:fs';
import type { Page } from 'puppeteer';
import { launchBrowser, newPage, emit, log, sleep } from './browser.js';

interface HotelQuery {
  name: string;
  city?: string;
  claimedPhone?: string;
  claimedAddress?: string;
}

interface Source {
  url: string;
  domain: string;
  phone: string | null;
  address: string | null;
  postalCode: string | null;
  checkInTime: string | null;
  checkOutTime: string | null;
}

interface HotelInfo {
  query: HotelQuery;
  claimedPhone: string | null;
  claimedAddress: string | null;
  verifiedPhone: string | null;
  verifiedAddress: string | null;
  postalCode: string | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  sources: Source[];
  mismatch: boolean;
  notes: string;
}

const TRUSTED_DOMAINS = [
  'booking.com',
  'tripadvisor.com',
  'agoda.com',
  'expedia.com',
  'rakutentravel.com'
  // Official hotel sites are auto-detected by name-token overlap (added at runtime)
];

function decodeDDGLink(href: string): string {
  const m = href.match(/uddg=([^&]+)/);
  if (!m || !m[1]) return href;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return href;
  }
}

async function ddgSearch(page: Page, query: string): Promise<{ title: string; url: string; domain: string }[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(600);
  const raw = await page.$$eval('.result__a', (els) =>
    els.slice(0, 15).map((el) => ({
      title: (el.textContent || '').trim(),
      href: (el as HTMLAnchorElement).href
    }))
  );
  const out: { title: string; url: string; domain: string }[] = [];
  for (const r of raw) {
    const real = decodeDDGLink(r.href);
    try {
      const u = new URL(real);
      out.push({ title: r.title, url: real, domain: u.hostname.replace(/^www\./, '') });
    } catch {
      // skip
    }
  }
  return out;
}

function extractContactInfo(text: string): {
  phones: string[];
  postalCodes: string[];
  addresses: string[];
  checkIn: string | null;
  checkOut: string | null;
} {
  // Japanese postal code: 〒\d{3}-\d{4} or just \d{3}-\d{4}
  const zipRegex = /[〒]?\b(\d{3}-\d{4})\b/g;
  // Japanese phone patterns: +81-X-XXXX-XXXX, +81 X XXXX XXXX, 0X-XXXX-XXXX, 0XX-XXX-XXXX
  const phoneRegex = /(?:\+81[-\s]?|0)(\d{1,4}[-\s]\d{2,4}[-\s]\d{3,4})/g;
  // Address heuristic: line containing 都/府/県/区/市/町/通 + alphanumeric (Japanese)
  // or English: contains numeric + Japan / Tokyo / Osaka / Kyoto / Chiyoda / etc.
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l);
  const addressKeywords = /(?:Tokyo|Osaka|Kyoto|Kobe|Nara|Chiyoda|Chuo|Minato|Shibuya|Shinjuku|Nakagyo|Kita-ku|Naka-ku|Otemachi|Umeda|Kawaramachi|Marunouchi|Ginza)/i;
  const jpAddrKeywords = /[都府県区市町]/;

  const phones: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = phoneRegex.exec(text)) !== null) {
    const raw = m[0];
    if (raw && phones.indexOf(raw) === -1) phones.push(raw);
  }
  const postalCodes: string[] = [];
  while ((m = zipRegex.exec(text)) !== null) {
    if (m[1] && postalCodes.indexOf(m[1]) === -1) postalCodes.push(m[1]);
  }
  const addresses: string[] = [];
  for (const ln of lines) {
    if (ln.length < 10 || ln.length > 200) continue;
    if (addressKeywords.test(ln) || jpAddrKeywords.test(ln)) {
      if (/\d/.test(ln) || jpAddrKeywords.test(ln)) {
        if (addresses.indexOf(ln) === -1) addresses.push(ln);
      }
    }
  }
  // Check-in/check-out time
  const ciMatch = text.match(/check[\s-]?in[^\n]{0,40}?(\d{1,2}:\d{2})/i);
  const coMatch = text.match(/check[\s-]?out[^\n]{0,40}?(\d{1,2}:\d{2})/i);
  return {
    phones,
    postalCodes,
    addresses: addresses.slice(0, 5),
    checkIn: ciMatch ? ciMatch[1] || null : null,
    checkOut: coMatch ? coMatch[1] || null : null
  };
}

async function scrapeForContactInfo(page: Page, url: string): Promise<Source | null> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(800);
    const text = await page.evaluate(() => document.body.innerText || '');
    const u = new URL(url);
    const domain = u.hostname.replace(/^www\./, '');
    const info = extractContactInfo(text);
    return {
      url,
      domain,
      phone: info.phones[0] || null,
      address: info.addresses[0] || null,
      postalCode: info.postalCodes[0] || null,
      checkInTime: info.checkIn,
      checkOutTime: info.checkOut
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[hotel-info]   scrape error ${url}: ${msg}\n`);
    return null;
  }
}

function normalizePhone(p: string | null | undefined): string {
  if (!p) return '';
  return p.replace(/[^\d]/g, '');
}

function pickBest<T>(values: (T | null)[]): T | null {
  // Most common non-null value
  const counts = new Map<string, { value: T; count: number }>();
  for (const v of values) {
    if (v == null) continue;
    const key = JSON.stringify(v);
    const cur = counts.get(key);
    if (cur) cur.count++;
    else counts.set(key, { value: v, count: 1 });
  }
  let best: { value: T; count: number } | null = null;
  for (const e of counts.values()) {
    if (!best || e.count > best.count) best = e;
  }
  return best ? best.value : null;
}

async function processQuery(page: Page, q: HotelQuery): Promise<HotelInfo> {
  const info: HotelInfo = {
    query: q,
    claimedPhone: q.claimedPhone || null,
    claimedAddress: q.claimedAddress || null,
    verifiedPhone: null,
    verifiedAddress: null,
    postalCode: null,
    checkInTime: null,
    checkOutTime: null,
    sources: [],
    mismatch: false,
    notes: ''
  };
  const queryStr = `${q.name} ${q.city || ''} address phone official`;
  log(`  search: ${queryStr}`);
  let candidates: { title: string; url: string; domain: string }[];
  try {
    candidates = await ddgSearch(page, queryStr);
  } catch (err) {
    info.notes = `search-error: ${err instanceof Error ? err.message : String(err)}`;
    return info;
  }

  // Pick up to 3 sources: 1 trusted aggregator (booking) + 1 likely-official + 1 alternate
  const aggregators = candidates.filter((c) => TRUSTED_DOMAINS.some((d) => c.domain.endsWith(d)));
  const nameTokens = q.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4);
  const officialCandidates = candidates.filter((c) => {
    const dom = c.domain.toLowerCase();
    return nameTokens.some((t) => dom.includes(t)) && !TRUSTED_DOMAINS.some((d) => dom.endsWith(d));
  });

  const toScrape: { title: string; url: string; domain: string }[] = [];
  if (officialCandidates[0]) toScrape.push(officialCandidates[0]);
  if (aggregators[0]) toScrape.push(aggregators[0]);
  if (aggregators[1] && aggregators[1].domain !== aggregators[0]?.domain) toScrape.push(aggregators[1]);

  for (const c of toScrape) {
    await sleep(1200);
    log(`  scrape: ${c.url}`);
    const src = await scrapeForContactInfo(page, c.url);
    if (src) info.sources.push(src);
  }

  // Vote across sources
  info.verifiedPhone = pickBest(info.sources.map((s) => s.phone));
  info.verifiedAddress = pickBest(info.sources.map((s) => s.address));
  info.postalCode = pickBest(info.sources.map((s) => s.postalCode));
  info.checkInTime = pickBest(info.sources.map((s) => s.checkInTime));
  info.checkOutTime = pickBest(info.sources.map((s) => s.checkOutTime));

  // Cross-check claimed vs verified
  const claimedDigits = normalizePhone(q.claimedPhone);
  const verifiedDigits = normalizePhone(info.verifiedPhone);
  if (claimedDigits && verifiedDigits && claimedDigits !== verifiedDigits) {
    info.mismatch = true;
  }

  info.notes = `sources=${info.sources.length}; phones=[${info.sources.map((s) => s.phone || '?').join(' | ')}]`;
  return info;
}

function parseArgs(argv: string[]): HotelQuery[] {
  if (argv[0] !== '--file') {
    console.error('Usage: hotel-info --file <queries.json>');
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
    console.error('JSON must be an array of {name, city?, claimedPhone?, claimedAddress?}');
    process.exit(1);
  }
  for (const q of parsed) {
    if (!q.name) {
      console.error(`Missing required "name": ${JSON.stringify(q)}`);
      process.exit(1);
    }
  }
  return parsed;
}

async function main() {
  const queries = parseArgs(process.argv.slice(2));
  log(`hotel-info: ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}`);
  const browser = await launchBrowser();
  const rows: HotelInfo[] = [];
  try {
    const page = await newPage(browser);
    for (const q of queries) {
      log(`[${q.name}${q.city ? ` / ${q.city}` : ''}]`);
      try {
        const info = await processQuery(page, q);
        rows.push(info);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rows.push({
          query: q,
          claimedPhone: q.claimedPhone || null,
          claimedAddress: q.claimedAddress || null,
          verifiedPhone: null,
          verifiedAddress: null,
          postalCode: null,
          checkInTime: null,
          checkOutTime: null,
          sources: [],
          mismatch: false,
          notes: `top-level error: ${msg}`
        });
      }
      await sleep(2000);
    }
    emit({
      source: 'tools/puppeteer/hotel-info',
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
