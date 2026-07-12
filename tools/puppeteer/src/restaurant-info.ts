#!/usr/bin/env node
/**
 * Restaurant verification + search tool.
 *
 * Given a list of restaurant claims (name + area + optional URL),
 * verifies whether the claimed URL actually corresponds to the named
 * restaurant. If the URL is broken / mismatched / missing, searches
 * DuckDuckGo for a trusted-domain replacement (Tabelog English /
 * TableCheck / Michelin Guide) and verifies that too.
 *
 * Built per .claude/rules/tool-first.md — restaurant facts in trip
 * plans should be verified against live sources, not recalled from
 * training data. Discovered 2026-05-27 that model-fabricated Tabelog
 * IDs were widespread (e.g. claimed Sushi Sakai → actually a closed
 * teppanyaki place; claimed Yoshikawa Kyoto → 404).
 *
 * Usage:
 *   npx tsx src/restaurant-info.ts --file <queries.json>
 *
 * Input JSON — array of:
 *   {
 *     "name": "Sushi Sakai",
 *     "area": "Osaka",          (optional, helps disambiguate)
 *     "cuisine": "omakase",      (optional, helps disambiguate)
 *     "claimedUrl": "https://tabelog.com/en/osaka/..." (optional)
 *   }
 *
 * Output JSON (stdout):
 *   { source, scrapeTime, rows: [ { query, claimedUrl, claimedNameMatches,
 *                                   verifiedUrl, actualName, cuisine, area,
 *                                   priceRange, hours, status, candidates,
 *                                   notes } ] }
 */
import fs from 'node:fs';
import type { Page } from 'puppeteer';
import { launchBrowser, newPage, emit, log, sleep } from './browser.js';

interface RestaurantQuery {
  name: string;
  area?: string;
  cuisine?: string;
  claimedUrl?: string;
}

interface Candidate {
  title: string;
  url: string;
  domain: string;
}

type Status = 'active' | 'closed' | '404' | 'unknown';

interface RestaurantInfo {
  query: RestaurantQuery;
  claimedUrl: string | null;
  claimedNameMatches: boolean | null;
  verifiedUrl: string | null;
  actualName: string | null;
  cuisine: string | null;
  area: string | null;
  priceRange: string | null;
  hours: string | null;
  status: Status;
  candidates: Candidate[];
  notes: string;
}

// Domains we trust to host real restaurant info.
// Order = preference for fallback search.
const TRUSTED_DOMAINS = [
  'tabelog.com',
  'tablecheck.com',
  'guide.michelin.com',
  'opentable.co.jp',
  'opentable.com',
  'savorjapan.com'
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

async function ddgSearch(page: Page, query: string): Promise<Candidate[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(600);
  const raw = await page.$$eval('.result__a', (els) =>
    els.slice(0, 12).map((el) => ({
      title: (el.textContent || '').trim(),
      href: (el as HTMLAnchorElement).href
    }))
  );
  const candidates: Candidate[] = [];
  for (const r of raw) {
    const real = decodeDDGLink(r.href);
    try {
      const u = new URL(real);
      candidates.push({
        title: r.title,
        url: real,
        domain: u.hostname.replace(/^www\./, '')
      });
    } catch {
      // skip malformed URLs
    }
  }
  return candidates;
}

async function verifyTabelog(page: Page, url: string): Promise<Partial<RestaurantInfo>> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(800);
  const title = await page.title();
  if (/このページを表示することができません|page is not displayed|page not found/i.test(title)) {
    return {
      actualName: null,
      status: '404',
      notes: `Tabelog: page not displayed (title="${title}")`
    };
  }
  const data = await page.evaluate(() => {
    const h1Text = (document.querySelector('h1') as HTMLElement | null)?.innerText?.trim() || '';
    let name = '';
    let cuisine = '';
    let address = '';
    let hours = '';
    let price = '';
    let listingOnHold = false;
    const rows = Array.from(document.querySelectorAll('table tr'));
    for (const row of rows) {
      const th = (row.querySelector('th')?.textContent || '').trim();
      const tdEl = row.querySelector('td') as HTMLTableCellElement | null;
      const td = (tdEl?.innerText || tdEl?.textContent || '').trim();
      if (!th || !td) continue;
      if (/^restaurant name/i.test(th) && !name) {
        const lines = td.split('\n');
        const firstLine = lines.find((s: string) => s.trim() && !/掲載保留|listing/i.test(s));
        name = (firstLine || lines[0] || '').trim();
        if (/掲載保留|on hold|closure period|relocated|permanently closed/i.test(td)) {
          listingOnHold = true;
        }
      } else if (/^categor/i.test(th) && !cuisine) {
        cuisine = (td.split('\n')[0] || '').trim();
      } else if (/^address/i.test(th) && !address) {
        address = td
          .split('\n')
          .map((s: string) => s.trim())
          .filter((s: string) => s && !/Show larger map|Find nearby/i.test(s))
          .slice(0, 1)
          .join('');
      } else if (/business hours/i.test(th) && !hours) {
        hours = td
          .split('\n')
          .map((s: string) => s.trim())
          .filter((s: string) => s && !/^■/.test(s))
          .slice(0, 3)
          .join(' / ');
      } else if (/^average price/i.test(th) && !price) {
        const lines = td.split('\n');
        const firstNumeric = lines.find((s: string) => /JPY|¥|\d/.test(s));
        price = (firstNumeric || lines[0] || '').trim();
      }
    }
    return { h1Text, name, cuisine, address, hours, price, listingOnHold };
  });
  const status: Status = data.listingOnHold ? 'closed' : 'active';
  return {
    actualName: data.name || data.h1Text || null,
    cuisine: data.cuisine || null,
    area: data.address || null,
    priceRange: data.price || null,
    hours: data.hours || null,
    status,
    notes: data.listingOnHold ? 'Tabelog: listing on hold / closed / relocated' : ''
  };
}

async function verifyGeneric(page: Page, url: string): Promise<Partial<RestaurantInfo>> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(700);
  const data = await page.evaluate(() => {
    const title = document.title.trim();
    const h1 = (document.querySelector('h1')?.textContent || '').trim();
    const bodyText = document.body.innerText.slice(0, 1500);
    return { title, h1, bodyText };
  });
  const splitParts = data.title.split(/\s*[|\-—–]\s*/);
  const baseName = data.h1 || (splitParts[0] || '').trim() || null;
  const looks404 = /404|not found|page not found|お探しのページ/i.test(data.title);
  return {
    actualName: baseName,
    status: looks404 ? '404' : 'active',
    notes: `generic-verify (h1="${data.h1.slice(0, 60)}", title="${data.title.slice(0, 60)}")`
  };
}

async function verifyUrl(page: Page, url: string): Promise<Partial<RestaurantInfo>> {
  try {
    if (/(^|\.)tabelog\.com\//.test(url)) {
      return await verifyTabelog(page, url);
    }
    return await verifyGeneric(page, url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'unknown', notes: `verify-error: ${msg}` };
  }
}

function normalizeName(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[\(\)（）\[\]【】「」『』,\.\-—–_/]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t.length >= 2);
}

function nameSimilarity(claimed: string, actual: string): number {
  const a = new Set(normalizeName(claimed));
  const b = new Set(normalizeName(actual));
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap++;
  return overlap / Math.max(a.size, b.size);
}

// True if URL looks like an INDIVIDUAL restaurant page on a trusted domain.
function isIndividualRestaurantPage(url: string, domain: string): boolean {
  if (domain.endsWith('tabelog.com')) {
    // /<area>/A\d+/A\d+/<restaurant_id>/ — restaurant_id is digits, NOT a path keyword.
    // Reject: /en/ (homepage), /rstLst/, /matome/, /A\d+/A\d+/rstLst/, etc.
    return /\/[a-z]+\/A\d+\/A\d+\/\d+\/?(?:[?#]|$)/.test(url);
  }
  if (domain.endsWith('tablecheck.com')) {
    return /\/shops\/[^/]+(?:\/|$)/.test(url);
  }
  if (domain.endsWith('guide.michelin.com')) {
    return /\/restaurant\/[^/]+/.test(url);
  }
  if (domain.endsWith('opentable.co.jp') || domain.endsWith('opentable.com')) {
    return /\/r\/|\/restref\//.test(url);
  }
  return false;
}

// True if URL is a curated editorial list (acceptable fallback, but flag it).
function isCuratedListPage(url: string, domain: string): boolean {
  if (domain.endsWith('tabelog.com')) {
    return /\/matome\/\d+/.test(url);
  }
  if (domain.endsWith('guide.michelin.com')) {
    return /\/restaurants(?:\/|$)/.test(url);
  }
  return false;
}

function pickBestCandidate(candidates: Candidate[], query: RestaurantQuery): { cand: Candidate; tier: 'individual-named' | 'individual' | 'curated-list' } | null {
  const nameTokens = normalizeName(query.name);
  // Pass 1: trusted-domain individual page, name token in title
  for (const domain of TRUSTED_DOMAINS) {
    const inDomain = candidates.filter(
      (c) => c.domain.endsWith(domain) && isIndividualRestaurantPage(c.url, c.domain)
    );
    if (inDomain.length === 0) continue;
    const titleMatch = inDomain.find((c) => {
      const t = c.title.toLowerCase();
      return nameTokens.some((tok) => t.includes(tok));
    });
    if (titleMatch) return { cand: titleMatch, tier: 'individual-named' };
  }
  // Pass 2: trusted-domain individual page, any title
  for (const domain of TRUSTED_DOMAINS) {
    const inDomain = candidates.filter(
      (c) => c.domain.endsWith(domain) && isIndividualRestaurantPage(c.url, c.domain)
    );
    if (inDomain[0]) return { cand: inDomain[0], tier: 'individual' };
  }
  // Pass 3: trusted-domain curated list / matome / Michelin area page (flagged)
  for (const domain of TRUSTED_DOMAINS) {
    const inDomain = candidates.filter(
      (c) => c.domain.endsWith(domain) && isCuratedListPage(c.url, c.domain)
    );
    if (inDomain[0]) return { cand: inDomain[0], tier: 'curated-list' };
  }
  // No verified candidate — caller decides what to do
  return null;
}

async function processQuery(page: Page, q: RestaurantQuery): Promise<RestaurantInfo> {
  const info: RestaurantInfo = {
    query: q,
    claimedUrl: q.claimedUrl || null,
    claimedNameMatches: null,
    verifiedUrl: null,
    actualName: null,
    cuisine: null,
    area: null,
    priceRange: null,
    hours: null,
    status: 'unknown',
    candidates: [],
    notes: ''
  };
  const notes: string[] = [];

  // Step 1: verify claimed URL (if any)
  if (q.claimedUrl) {
    log(`  verify-claimed: ${q.claimedUrl}`);
    const claimedResult = await verifyUrl(page, q.claimedUrl);
    if (claimedResult.actualName) {
      const sim = nameSimilarity(q.name, claimedResult.actualName);
      info.claimedNameMatches = sim >= 0.4 && claimedResult.status === 'active';
      notes.push(
        `claimed: name="${claimedResult.actualName}" sim=${sim.toFixed(2)} status=${claimedResult.status}`
      );
      if (info.claimedNameMatches) {
        info.verifiedUrl = q.claimedUrl;
        Object.assign(info, claimedResult);
        info.notes = notes.join(' | ');
        return info;
      }
    } else {
      info.claimedNameMatches = false;
      notes.push(`claimed: no name extracted, status=${claimedResult.status}`);
    }
    if (claimedResult.notes) notes.push(claimedResult.notes);
    await sleep(1200);
  }

  // Step 2: search for replacement
  const queryParts = [q.name, q.area, q.cuisine, 'tabelog OR tablecheck OR michelin'].filter(Boolean);
  const queryStr = queryParts.join(' ');
  log(`  search: ${queryStr}`);
  let candidates: Candidate[] = [];
  try {
    candidates = await ddgSearch(page, queryStr);
    info.candidates = candidates;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(`search-error: ${msg}`);
    info.notes = notes.join(' | ');
    return info;
  }
  if (candidates.length === 0) {
    notes.push('no search results');
    info.notes = notes.join(' | ');
    return info;
  }

  const pick = pickBestCandidate(candidates, q);
  if (!pick) {
    notes.push('no verified candidate (no individual restaurant page on trusted domains)');
    info.notes = notes.join(' | ');
    return info;
  }
  const { cand: best, tier } = pick;

  await sleep(1500);
  log(`  verify-candidate (${tier}): ${best.url}`);
  const candResult = await verifyUrl(page, best.url);
  info.verifiedUrl = best.url;
  Object.assign(info, {
    actualName: candResult.actualName ?? null,
    cuisine: candResult.cuisine ?? null,
    area: candResult.area ?? null,
    priceRange: candResult.priceRange ?? null,
    hours: candResult.hours ?? null,
    status: candResult.status ?? 'unknown'
  });
  notes.push(`candidate-tier=${tier}`);
  notes.push(`candidate-domain=${best.domain}`);
  if (candResult.actualName) {
    const sim = nameSimilarity(q.name, candResult.actualName);
    notes.push(`candidate: name="${candResult.actualName}" sim=${sim.toFixed(2)}`);
  }
  if (candResult.notes) notes.push(candResult.notes);
  info.notes = notes.join(' | ');
  return info;
}

function parseArgs(argv: string[]): RestaurantQuery[] {
  if (argv[0] !== '--file') {
    console.error('Usage: restaurant-info --file <queries.json>');
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
    console.error('JSON must be an array of {name, area?, cuisine?, claimedUrl?}');
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
  log(`restaurant-info: ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}`);
  const browser = await launchBrowser();
  const rows: RestaurantInfo[] = [];
  try {
    const page = await newPage(browser);
    for (const q of queries) {
      log(`[${q.name}${q.area ? ` / ${q.area}` : ''}]`);
      try {
        const info = await processQuery(page, q);
        rows.push(info);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rows.push({
          query: q,
          claimedUrl: q.claimedUrl || null,
          claimedNameMatches: null,
          verifiedUrl: null,
          actualName: null,
          cuisine: null,
          area: null,
          priceRange: null,
          hours: null,
          status: 'unknown',
          candidates: [],
          notes: `top-level error: ${msg}`
        });
      }
      await sleep(2000);
    }
    emit({
      source: 'tools/puppeteer/restaurant-info',
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
