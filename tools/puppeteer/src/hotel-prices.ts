#!/usr/bin/env node
/**
 * Kayak.com.au hotel price scraper. Searches by hotel name + dates + guests.
 *
 * Usage:
 *   npx tsx src/hotel-prices.ts <json>
 *
 * <json> is a JSON array of stays:
 *   [
 *     {"name": "Cross Hotel Osaka", "checkin": "2026-08-22", "checkout": "2026-08-25", "guests": 3},
 *     ...
 *   ]
 *
 * Or pass via file:
 *   npx tsx src/hotel-prices.ts --file ./stays.json
 *
 * Output (stdout JSON):
 *   {
 *     "currency": "AUD",
 *     "source": "Kayak.com.au",
 *     "rows": [
 *       { "name": "...", "checkin": "...", "checkout": "...", "nights": N, "cheapestPerNight": M, "totalAUD": N*M, "notes": "...", "url": "..." }
 *     ]
 *   }
 */
import fs from 'node:fs';
import type { Page } from 'puppeteer';
import { launchBrowser, newPage, emit, log, sleep } from './browser.js';

interface Stay {
  name: string;
  checkin: string; // YYYY-MM-DD
  checkout: string;
  guests: number;
}

interface PriceRow {
  name: string;
  checkin: string;
  checkout: string;
  nights: number;
  cheapestPerNight: number | null;
  totalAUD: number | null;
  notes: string;
  url: string;
}

function parseArgs(argv: string[]): Stay[] {
  if (argv.length === 0) {
    console.error('Usage: hotel-prices <json-array> | --file <path>');
    process.exit(1);
  }
  let raw: string;
  if (argv[0] === '--file') {
    const p = argv[1];
    if (!p) {
      console.error('--file needs a path');
      process.exit(1);
    }
    raw = fs.readFileSync(p, 'utf8');
  } else {
    raw = argv.join(' ');
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    console.error('JSON must be an array of stays');
    process.exit(1);
  }
  for (const s of parsed) {
    if (!s.name || !s.checkin || !s.checkout) {
      console.error(`Missing required fields in stay: ${JSON.stringify(s)}`);
      process.exit(1);
    }
    s.guests = s.guests ?? 3;
  }
  return parsed;
}

function daysBetween(d1: string, d2: string): number {
  const a = new Date(d1);
  const b = new Date(d2);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function bookingSearchUrl(stay: Stay): string {
  // Booking.com search-results page; Booking auto-ranks the named hotel first
  const ss = encodeURIComponent(stay.name);
  return `https://www.booking.com/searchresults.html?ss=${ss}&checkin=${stay.checkin}&checkout=${stay.checkout}&group_adults=${stay.guests}&no_rooms=1&selected_currency=AUD`;
}

async function getHotelPrice(page: Page, url: string, hotelName: string, nights: number): Promise<{ pricePerNight: number | null; notes: string }> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(8000);

    try {
      await page.waitForFunction(
        () => {
          const t = document.body.innerText;
          return /(A\$|AUD)\s?[\d,]+/i.test(t) || /\$\s?[\d,]+/.test(t);
        },
        { timeout: 25000 }
      );
    } catch {
      // continue
    }

    const title = await page.title();
    if (/captcha|access denied|verify|are you human|blocked/i.test(title)) {
      return { pricePerNight: null, notes: `Blocked (title=${title.slice(0, 60)})` };
    }

    const text: string = await page.evaluate(() => document.body.innerText);

    // Booking.com shows TOTAL prices for the full stay (e.g. "AU$810" for 3 nights).
    // Find first listing block — usually the searched hotel — and extract the price near it.
    const lower = text.toLowerCase();
    const target = hotelName.toLowerCase();
    const idx = lower.indexOf(target);

    if (idx === -1) {
      log(`debug: "${hotelName}" not found in body; title: ${title.slice(0, 80)}`);
      log(`debug body (first 300): ${text.slice(0, 300).replace(/\s+/g, ' ')}`);
      return { pricePerNight: null, notes: `Hotel "${hotelName}" not on first results page` };
    }

    // Take FIRST AU$ price AFTER the hotel name (Booking lists price right after name in each card)
    // Strip filter-range patterns first ("AUD 60 - AUD 900+")
    const afterName = text.slice(idx, idx + 1500).replace(/AUD\s?\d+\s*-\s*AUD\s?\d+\+?/gi, '');

    const firstMatch = afterName.match(/(?:AU?\$|AUD\s?)\s?([\d,]+)/i);
    if (!firstMatch) {
      // Fallback: plain $ price
      const fallback = afterName.replace(/AUD\s?\d+\s*-\s*AUD\s?\d+\+?/gi, '').match(/\$\s?([\d,]+)/);
      if (!fallback || !fallback[1]) {
        return { pricePerNight: null, notes: 'Hotel name found but no price within 1500 chars after' };
      }
      const total = parseInt(fallback[1].replace(/,/g, ''), 10);
      if (!Number.isFinite(total) || total < 50 || total > 30000) {
        return { pricePerNight: null, notes: `Implausible price ${total}` };
      }
      return { pricePerNight: Math.round(total / nights), notes: `total ${total} AUD over ${nights} nights (fallback parser, plain $)` };
    }

    const raw = firstMatch[1];
    if (!raw) {
      return { pricePerNight: null, notes: 'Price regex matched but no number captured' };
    }
    const total = parseInt(raw.replace(/,/g, ''), 10);
    if (!Number.isFinite(total) || total < 50 || total > 30000) {
      return { pricePerNight: null, notes: `Implausible price ${total}` };
    }
    return { pricePerNight: Math.round(total / nights), notes: `total ${total} AUD over ${nights} nights (first price after hotel name)` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { pricePerNight: null, notes: `error: ${msg}` };
  }
}

async function main() {
  const stays = parseArgs(process.argv.slice(2));
  log(`hotel-prices: ${stays.length} stay(s)`);

  const browser = await launchBrowser();
  const rows: PriceRow[] = [];
  try {
    const page = await newPage(browser);

    for (const stay of stays) {
      const url = bookingSearchUrl(stay);
      const nights = daysBetween(stay.checkin, stay.checkout);
      log(`  ${stay.name} | ${stay.checkin} → ${stay.checkout} (${nights} nights, ${stay.guests} adults)`);
      const { pricePerNight, notes } = await getHotelPrice(page, url, stay.name, nights);
      rows.push({
        name: stay.name,
        checkin: stay.checkin,
        checkout: stay.checkout,
        nights,
        cheapestPerNight: pricePerNight,
        totalAUD: pricePerNight != null ? pricePerNight * nights : null,
        notes,
        url
      });
      await sleep(3500);
    }

    emit({
      currency: 'AUD',
      source: 'Booking.com (search results)',
      rows,
      note: 'Indicative per-night = total / nights. Verify on Booking before booking.'
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
