#!/usr/bin/env node
/**
 * Kayak.com.au multi-date flight price comparison (AUD).
 *
 * Why Kayak (not Skyscanner): as of 2026-05, Skyscanner's anti-bot
 * (`/transport/flights/...` SPA) blocks puppeteer-extra-stealth too. Kayak's
 * `/flights/<O>-<D>/<date>/<date>` URL serves usable SSR'd content.
 *
 * Usage:
 *   npx tsx src/flight-prices.ts <origin IATA> <dest IATA> <depart YYYY-MM-DD> <return YYYY-MM-DD> [--also <D1>:<D2>]*
 *
 * Output:
 *   stdout — JSON: { origin, destination, currency, source, rows: [{...}], note }
 *   stderr — log lines
 */
import type { Page } from 'puppeteer';
import { launchBrowser, newPage, emit, log, sleep } from './browser.js';

interface DatePair {
  depart: string;
  return: string;
}

interface PriceRow {
  depart: string;
  return: string;
  cheapestAUD: number | null;
  notes: string;
  url: string;
}

function parseArgs(argv: string[]): { origin: string; destination: string; pairs: DatePair[]; nonStop: boolean } {
  const positional: string[] = [];
  const flagged: string[] = [];
  let nonStop = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--non-stop') {
      nonStop = true;
    } else if (argv[i] === '--also') {
      flagged.push('--also', argv[++i] ?? '');
    } else {
      positional.push(argv[i] ?? '');
    }
  }
  const [origin, destination, depart, ret] = positional;
  if (!origin || !destination || !depart || !ret) {
    console.error(
      'Usage: flight-prices <origin IATA> <dest IATA> <YYYY-MM-DD depart> <YYYY-MM-DD return> [--also D1:D2]* [--non-stop]'
    );
    process.exit(1);
  }
  const pairs: DatePair[] = [{ depart, return: ret }];
  for (let i = 0; i < flagged.length; i++) {
    if (flagged[i] === '--also') {
      const next = flagged[++i];
      if (!next) continue;
      const [d1, d2] = next.split(':');
      if (d1 && d2) pairs.push({ depart: d1, return: d2 });
    }
  }
  return { origin: origin.toUpperCase(), destination: destination.toUpperCase(), pairs, nonStop };
}

function kayakUrl(origin: string, dest: string, depart: string, ret: string, nonStop: boolean): string {
  // Kayak.com.au defaults to AUD for the AU region; prices on page rendered as "$X,XXX".
  // `fs=stops=~0` filters to non-stop only (URL-encoded `=~` → `%3D~`)
  const base = `https://www.kayak.com.au/flights/${origin.toUpperCase()}-${dest.toUpperCase()}/${depart}/${ret}`;
  return nonStop ? `${base}?fs=stops%3D~0` : base;
}

async function getPrice(page: Page, url: string): Promise<{ price: number | null; notes: string }> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Skyscanner is heavy SPA — initial wait for JS to populate prices
    await sleep(8000);

    // Then wait up to 25s for any price-like text to appear
    try {
      await page.waitForFunction(
        () => {
          const t = document.body.innerText;
          return /(A\$|AUD|\$)\s?\d{3,}/i.test(t);
        },
        { timeout: 25000 }
      );
    } catch {
      // continue — maybe still some prices, or maybe nothing
    }

    const title = await page.title();
    if (/captcha|verify|robot|are you human/i.test(title)) {
      return { price: null, notes: 'CAPTCHA hit — verify manually on site' };
    }

    const text: string = await page.evaluate(() => document.body.innerText);

    // Try multiple price patterns Skyscanner may use
    const patterns: RegExp[] = [
      /A\$\s?([\d,]+)/g,           // AUD with A$ prefix
      /AUD\s*\$?\s*([\d,]+)/gi,    // explicit AUD
      /\$\s?([\d,]+)(?!\s*USD)/g   // plain $ (but not USD)
    ];

    const allPrices: number[] = [];
    for (const re of patterns) {
      const matches = text.match(re) ?? [];
      for (const m of matches) {
        const n = parseInt(m.replace(/[A$,\sAUDaud]/g, ''), 10);
        if (Number.isFinite(n) && n >= 200 && n <= 20000) allPrices.push(n);
      }
    }

    if (allPrices.length === 0) {
      // Surface page state for debugging
      log(`debug title: ${title}`);
      log(`debug body-snippet (first 400 chars): ${text.slice(0, 400).replace(/\s+/g, ' ')}`);
      return { price: null, notes: `No prices parsed (title=${title.slice(0, 60)})` };
    }
    return { price: Math.min(...allPrices), notes: `cheapest of ${allPrices.length} prices on page` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { price: null, notes: `error: ${msg}` };
  }
}

async function main() {
  const { origin, destination, pairs, nonStop } = parseArgs(process.argv.slice(2));
  log(`flight-prices ${origin}→${destination}, ${pairs.length} date pair(s)${nonStop ? ' [non-stop only]' : ''}`);

  const browser = await launchBrowser();
  const rows: PriceRow[] = [];
  try {
    const page = await newPage(browser);

    for (const pair of pairs) {
      const url = kayakUrl(origin, destination, pair.depart, pair.return, nonStop);
      log(`  ${pair.depart} → ${pair.return}`);
      const { price, notes } = await getPrice(page, url);
      rows.push({ depart: pair.depart, return: pair.return, cheapestAUD: price, notes, url });
      await sleep(2500); // polite spacing
    }

    emit({
      origin,
      destination,
      currency: 'AUD',
      source: `Kayak.com.au (economy, 1 adult${nonStop ? ', non-stop only' : ''})`,
      rows,
      note: 'Indicative prices — verify on Kayak before booking.'
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
