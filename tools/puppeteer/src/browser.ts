/**
 * Shared puppeteer helpers used by every command in this tool.
 * Wraps puppeteer with the stealth plugin to bypass basic bot detection
 * (Skyscanner / Cloudflare / etc.).
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page } from 'puppeteer';

puppeteer.use(StealthPlugin());

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

export async function launchBrowser(options: { headless?: boolean } = {}): Promise<Browser> {
  // puppeteer-extra returns its own Browser type that's compatible with puppeteer's.
  const browser = await puppeteer.launch({
    headless: options.headless ?? true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });
  return browser as unknown as Browser;
}

export async function newPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setUserAgent(DEFAULT_USER_AGENT);
  await page.setViewport({ width: 1440, height: 900 });
  await page.setExtraHTTPHeaders({ 'accept-language': 'en-AU,en;q=0.9' });
  return page;
}

/** Emit a JSON result to stdout (machine-readable). One per invocation. */
export function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/** Log a line to stderr (human-readable, doesn't pollute stdout JSON). */
export function log(msg: string): void {
  process.stderr.write(`[puppeteer-tool] ${msg}\n`);
}

/** Sleep helper for polite spacing between requests. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
