#!/usr/bin/env node
/**
 * Generic puppeteer scraper.
 *
 * Usage:
 *   npx tsx src/scrape.ts <url> [options]
 *
 * Output:
 *   stdout — JSON: { url, result } or { url, error }
 *   stderr — log lines
 *
 * See README.md for full option list.
 */
import { launchBrowser, newPage, emit, log } from './browser.js';

interface Args {
  url: string;
  selector?: string;
  waitFor?: string;
  format: 'text' | 'html' | 'json';
  timeout: number;
}

function parseArgs(argv: string[]): Args {
  const url = argv[0];
  if (!url) {
    console.error(
      'Usage: scrape <url> [--selector <css>] [--wait-for <css>] [--text|--html|--json] [--timeout <ms>]'
    );
    process.exit(1);
  }
  const args: Args = { url, format: 'text', timeout: 30000 };
  for (let i = 1; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--selector') args.selector = argv[++i];
    else if (f === '--wait-for') args.waitFor = argv[++i];
    else if (f === '--text') args.format = 'text';
    else if (f === '--html') args.format = 'html';
    else if (f === '--json') args.format = 'json';
    else if (f === '--timeout') args.timeout = parseInt(argv[++i] ?? '30000', 10);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log(`scrape ${args.url} (format=${args.format}${args.selector ? `, selector=${args.selector}` : ''})`);

  const browser = await launchBrowser();
  try {
    const page = await newPage(browser);
    await page.goto(args.url, { waitUntil: 'networkidle2', timeout: args.timeout });
    if (args.waitFor) {
      await page.waitForSelector(args.waitFor, { timeout: args.timeout });
    }

    let result: unknown;
    if (args.selector) {
      result = await page.$$eval(
        args.selector,
        (els, format) =>
          els.map((el) => {
            if (format === 'html') return el.outerHTML;
            if (format === 'json') {
              const e = el as HTMLElement;
              return {
                tag: e.tagName.toLowerCase(),
                text: (e.innerText ?? '').trim(),
                href: (e as HTMLAnchorElement).href || undefined,
                src: (e as HTMLImageElement).src || undefined
              };
            }
            return ((el as HTMLElement).innerText ?? '').trim();
          }),
        args.format
      );
    } else {
      if (args.format === 'html') {
        result = await page.content();
      } else if (args.format === 'json') {
        result = {
          title: await page.title(),
          url: page.url(),
          text: await page.evaluate(() => document.body.innerText)
        };
      } else {
        result = await page.evaluate(() => document.body.innerText);
      }
    }

    emit({ url: args.url, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`failed: ${msg}`);
    emit({ url: args.url, error: msg });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
