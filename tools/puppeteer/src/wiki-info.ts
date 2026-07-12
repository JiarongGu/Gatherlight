#!/usr/bin/env node
/**
 * Wikipedia article batch info fetcher.
 *
 * Given a list of attractions (with Wikipedia URL OR search term),
 * extracts for each:
 *   - First paragraph (summary)
 *   - Main image URL (from infobox / first figure)
 *   - Official website URL (from infobox "Website" row)
 *   - Coordinates (if available, from infobox)
 *
 * Built per .claude/rules/tool-first.md — reference libraries
 * (e.g. JAPAN_ATTRACTIONS.md) should be generated from this
 * tool's output, NOT hand-curated.
 *
 * Usage:
 *   npx tsx src/wiki-info.ts <json>
 *
 * <json> is a JSON array of attractions:
 *   [
 *     {"name": "Osaka Aquarium Kaiyukan", "wikipediaUrl": "https://en.wikipedia.org/wiki/Osaka_Aquarium_Kaiyukan"},
 *     {"name": "Nara Park", "wikipediaUrl": "https://en.wikipedia.org/wiki/Nara_Park"}
 *   ]
 *
 * Or via file:
 *   npx tsx src/wiki-info.ts --file ./attractions.json > .tmp-japan-attractions.json
 *
 * Output (stdout JSON):
 *   {
 *     "source": "Wikipedia (English)",
 *     "scrapeTime": "2026-05-20T...",
 *     "rows": [
 *       {
 *         "name": "...",
 *         "wikipediaUrl": "...",
 *         "summary": "First paragraph of the article...",
 *         "imageUrl": "https://upload.wikimedia.org/...",
 *         "officialUrl": "https://...",
 *         "coordinates": "34.6549°N, 135.4286°E",
 *         "notes": "..."
 *       }
 *     ]
 *   }
 */
import fs from 'node:fs';
import type { Page } from 'puppeteer';
import { launchBrowser, newPage, emit, log, sleep } from './browser.js';

interface Attraction {
  name: string;
  wikipediaUrl: string;
}

interface AttractionInfo {
  name: string;
  wikipediaUrl: string;
  summary: string | null;
  imageUrl: string | null;
  officialUrl: string | null;
  coordinates: string | null;
  notes: string;
}

function parseArgs(argv: string[]): Attraction[] {
  if (argv.length === 0) {
    console.error('Usage: wiki-info <json-array> | --file <path>');
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
    console.error('JSON must be an array of attractions');
    process.exit(1);
  }
  for (const a of parsed) {
    if (!a.name || !a.wikipediaUrl) {
      console.error(`Missing required fields in attraction: ${JSON.stringify(a)}`);
      process.exit(1);
    }
  }
  return parsed;
}

async function fetchWikiInfo(page: Page, attraction: Attraction): Promise<AttractionInfo> {
  const result: AttractionInfo = {
    name: attraction.name,
    wikipediaUrl: attraction.wikipediaUrl,
    summary: null,
    imageUrl: null,
    officialUrl: null,
    coordinates: null,
    notes: ''
  };

  try {
    await page.goto(attraction.wikipediaUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(800);

    const title = await page.title();
    if (/wikipedia does not have an article|search results/i.test(title)) {
      result.notes = `URL did not resolve to an article (title=${title.slice(0, 80)})`;
      return result;
    }

    // Run all extractions in one page.evaluate to minimize round-trips
    const extracted = await page.evaluate(() => {
      // Summary: first non-empty <p> inside .mw-parser-output, skipping infobox / hatnote paragraphs
      let summary = '';
      const paragraphs = document.querySelectorAll('.mw-parser-output > p');
      for (const p of paragraphs) {
        const text = (p as HTMLElement).innerText.trim();
        if (text.length > 50) {
          summary = text;
          break;
        }
      }

      // Image: infobox image first; fall back to first figure
      let imageUrl: string | null = null;
      const infoboxImg = document.querySelector('.infobox img');
      if (infoboxImg) {
        imageUrl = (infoboxImg as HTMLImageElement).src;
      }
      if (!imageUrl) {
        const figImg = document.querySelector('figure img');
        if (figImg) imageUrl = (figImg as HTMLImageElement).src;
      }

      // Official URL: infobox "Website" row → first external link
      let officialUrl: string | null = null;
      const infoboxRows = document.querySelectorAll('.infobox tr');
      for (const row of infoboxRows) {
        const header = row.querySelector('th');
        if (header && /website/i.test(header.textContent || '')) {
          const link = row.querySelector('a.external');
          if (link) {
            officialUrl = (link as HTMLAnchorElement).href;
            break;
          }
        }
      }

      // Coordinates: typically in #coordinates or .geo-dec
      let coordinates: string | null = null;
      const coordEl = document.querySelector('#coordinates .geo-dec, .geo-dec');
      if (coordEl) coordinates = (coordEl as HTMLElement).innerText.trim();

      return { summary, imageUrl, officialUrl, coordinates };
    });

    result.summary = extracted.summary || null;
    result.imageUrl = extracted.imageUrl;
    result.officialUrl = extracted.officialUrl;
    result.coordinates = extracted.coordinates;

    if (!result.summary) {
      result.notes = 'No summary paragraph extracted (article may use unusual layout)';
    } else {
      result.notes = `ok (summary ${result.summary.length} chars${result.imageUrl ? ', has image' : ''}${result.officialUrl ? ', has official URL' : ''})`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.notes = `error: ${msg}`;
  }

  return result;
}

async function main() {
  const attractions = parseArgs(process.argv.slice(2));
  log(`wiki-info: ${attractions.length} attraction(s)`);

  const browser = await launchBrowser();
  const rows: AttractionInfo[] = [];
  try {
    const page = await newPage(browser);

    for (const a of attractions) {
      log(`  ${a.name} | ${a.wikipediaUrl}`);
      const info = await fetchWikiInfo(page, a);
      rows.push(info);
      await sleep(1200); // polite spacing — Wikipedia is fine with this
    }

    emit({
      source: 'Wikipedia (English)',
      scrapeTime: new Date().toISOString(),
      rows,
      note: 'Per .claude/rules/tool-first.md — use this output to regenerate fact libraries instead of hand-curating.'
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
