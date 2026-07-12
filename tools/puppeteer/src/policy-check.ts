#!/usr/bin/env node
/**
 * Policy / visa rule checker — fetches official source(s) for a passport-country
 * + destination-country combo, extracts rules (visa-required y/n, validity,
 * lead time hints, passport validity rule).
 *
 * Built per .claude/rules/verify-policy-info.md after 2026-05-27 discovery
 * of fabricated "中国护照日本免签 30 天" claim (Japan has NOT granted
 * visa-free entry to Chinese passport holders).
 *
 * Currently supports: destination=Japan via MOFA topic pages.
 * Future: add per-destination URL routing for more countries.
 *
 * Usage:
 *   npx tsx src/policy-check.ts --file <queries.json>
 *
 * Input JSON — array of:
 *   {
 *     "passportCountry": "China",   (e.g. China, Australia, USA)
 *     "destinationCountry": "Japan", (currently only Japan supported)
 *     "purpose": "tourism"          (optional: tourism / business / transit)
 *   }
 *
 * Output JSON:
 *   { source, scrapeTime, rows: [ {
 *       query, visaRequired, visaTypes, maxStayDays,
 *       passportValidityRule, applicationLeadTimeDays,
 *       evisaAvailable, officialSources, notes
 *   } ] }
 */
import fs from 'node:fs';
import type { Page } from 'puppeteer';
import { launchBrowser, newPage, emit, log, sleep } from './browser.js';

interface PolicyQuery {
  passportCountry: string;
  destinationCountry: string;
  purpose?: string;
}

interface PolicyInfo {
  query: PolicyQuery;
  visaRequired: boolean | null;
  visaTypes: string[];
  maxStayDays: number | null;
  passportValidityRule: string | null;
  applicationLeadTimeDays: number | null;
  evisaAvailable: boolean | null;
  officialSources: { url: string; title: string }[];
  rawExcerpts: string[];
  notes: string;
}

// Destination-specific URL routing.
// Each destination maps to a set of MOFA / government URLs to fetch.
const DESTINATION_URLS: Record<string, { passportPattern: RegExp; urls: { url: string; tag: string }[] }[]> = {
  japan: [
    {
      passportPattern: /china/i,
      urls: [
        { url: 'https://www.mofa.go.jp/ca/fna/page23e_000539.html', tag: 'mofa-china-en' },
        { url: 'https://www.mofa.go.jp/j_info/visit/visa/topics/china.html', tag: 'mofa-china-jp' }
      ]
    },
    {
      passportPattern: /australia|usa|united states|uk|united kingdom|canada/i,
      urls: [
        { url: 'https://www.mofa.go.jp/j_info/visit/visa/short/novisa.html', tag: 'mofa-visa-exemption' }
      ]
    },
    {
      passportPattern: /./,
      urls: [
        { url: 'https://www.mofa.go.jp/j_info/visit/visa/short/other_visa.html', tag: 'mofa-short-general' },
        { url: 'https://www.mofa.go.jp/j_info/visit/visa/visaonline.html', tag: 'mofa-evisa' }
      ]
    }
  ]
};

function detectVisaRequired(allText: string): boolean | null {
  const visaFreeCues = /visa exemption|no visa|visa-free|short[ -]term stay.*not.*require|免签/i;
  const visaRequiredCues = /must apply for a visa|need a visa|visa.*required|need.*to apply|短期签证.*办理|need.*tourist visa/i;
  const noFreeCues = /not.*visa.*exempt|not.*on.*list/i;

  if (visaRequiredCues.test(allText) || noFreeCues.test(allText)) return true;
  if (visaFreeCues.test(allText)) return false;
  return null;
}

function detectVisaTypes(allText: string): string[] {
  const types: string[] = [];
  if (/group tour/i.test(allText)) types.push('Group Tour');
  if (/individual.*tourist|tourist.*individual|single[- ]entry/i.test(allText)) types.push('Individual Tourist (single-entry)');
  if (/multiple[- ]entry/i.test(allText)) types.push('Multiple-entry');
  if (/business visa|business purpose/i.test(allText)) types.push('Business');
  if (/transit/i.test(allText)) types.push('Transit');
  return types;
}

function detectMaxStay(allText: string): number | null {
  // Look for "up to 15 days" / "30 days" / "90 days" patterns
  const matches = [...allText.matchAll(/(?:up to|maximum of|allowed for|period of stay[^\d]{0,40})(\d{1,3})\s*days?/gi)];
  if (matches.length === 0) return null;
  // Return the LARGEST relevant value (often this is single-entry max)
  const days = matches.map((m) => parseInt(m[1] || '0', 10)).filter((d) => d > 0 && d < 365);
  if (days.length === 0) return null;
  return Math.max(...days);
}

function detectPassportValidity(allText: string): string | null {
  const m = allText.match(/passport[\s\S]{0,80}?(?:valid|validity)[\s\S]{0,80}?(\d+)\s*(?:months?|days?)/i);
  if (m) return m[0].replace(/\s+/g, ' ').slice(0, 200);
  return null;
}

function detectEvisa(allText: string): boolean | null {
  if (/eVISA|electronic visa|online visa application/i.test(allText)) return true;
  return null;
}

async function scrapeMofa(page: Page, url: string): Promise<string | null> {
  try {
    log(`  mofa: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(800);
    const text = await page.evaluate(() => document.body.innerText || '');
    if (text.length < 200) return null;
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[policy-check]   error ${url}: ${msg}\n`);
    return null;
  }
}

async function processQuery(page: Page, q: PolicyQuery): Promise<PolicyInfo> {
  const info: PolicyInfo = {
    query: q,
    visaRequired: null,
    visaTypes: [],
    maxStayDays: null,
    passportValidityRule: null,
    applicationLeadTimeDays: null,
    evisaAvailable: null,
    officialSources: [],
    rawExcerpts: [],
    notes: ''
  };

  const dest = q.destinationCountry.toLowerCase().trim();
  const rules = DESTINATION_URLS[dest];
  if (!rules) {
    info.notes = `destination "${q.destinationCountry}" not in router; only Japan supported currently`;
    return info;
  }

  const urlsToFetch: { url: string; tag: string }[] = [];
  for (const block of rules) {
    if (block.passportPattern.test(q.passportCountry)) {
      urlsToFetch.push(...block.urls);
    }
  }
  // De-dup
  const seen = new Set<string>();
  const uniq = urlsToFetch.filter((u) => {
    if (seen.has(u.url)) return false;
    seen.add(u.url);
    return true;
  });

  let allText = '';
  for (const u of uniq) {
    await sleep(1200);
    const text = await scrapeMofa(page, u.url);
    if (text) {
      info.officialSources.push({ url: u.url, title: u.tag });
      // Save first 1500 chars per source as excerpt
      info.rawExcerpts.push(`[${u.tag}] ${text.slice(0, 1500).replace(/\n+/g, ' ')}`);
      allText += '\n' + text;
    }
  }

  if (allText.length < 200) {
    info.notes = 'no MOFA text retrieved; sources may be blocking scrapers';
    return info;
  }

  info.visaRequired = detectVisaRequired(allText);
  info.visaTypes = detectVisaTypes(allText);
  info.maxStayDays = detectMaxStay(allText);
  info.passportValidityRule = detectPassportValidity(allText);
  info.evisaAvailable = detectEvisa(allText);

  info.notes = `sources=${info.officialSources.length}; allText=${allText.length} chars`;
  return info;
}

function parseArgs(argv: string[]): PolicyQuery[] {
  if (argv[0] !== '--file') {
    console.error('Usage: policy-check --file <queries.json>');
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
    console.error('JSON must be an array of {passportCountry, destinationCountry, ...}');
    process.exit(1);
  }
  for (const q of parsed) {
    if (!q.passportCountry || !q.destinationCountry) {
      console.error(`Missing passportCountry / destinationCountry: ${JSON.stringify(q)}`);
      process.exit(1);
    }
  }
  return parsed;
}

async function main() {
  const queries = parseArgs(process.argv.slice(2));
  log(`policy-check: ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}`);
  const browser = await launchBrowser();
  const rows: PolicyInfo[] = [];
  try {
    const page = await newPage(browser);
    for (const q of queries) {
      log(`[${q.passportCountry} -> ${q.destinationCountry}]`);
      try {
        const info = await processQuery(page, q);
        rows.push(info);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rows.push({
          query: q,
          visaRequired: null,
          visaTypes: [],
          maxStayDays: null,
          passportValidityRule: null,
          applicationLeadTimeDays: null,
          evisaAvailable: null,
          officialSources: [],
          rawExcerpts: [],
          notes: `top-level error: ${msg}`
        });
      }
      await sleep(2000);
    }
    emit({
      source: 'tools/puppeteer/policy-check',
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
