---
name: scrape
description: Render a JS/SPA page in a real headless browser via the Gatherlight scrape MCP tool and return its text. The mandatory verification step for search deeplinks and dynamic pages that WebFetch cannot load.
---

# Scrape

**Format**: `/scrape <url> [hint about what to extract]`

Wraps the **`scrape` MCP tool** (`mcp__planner-tools__scrape`) provided by the Gatherlight server, for use when `WebFetch` cannot see the content (SPA, dynamic content, login wall).

## Action

1. Call the tool:
   ```
   mcp__planner-tools__scrape {
     "url": "<url>",              // required
     "selector": "<css>",         // optional — only extract content matching this selector
     "waitFor": "<css>",          // optional — wait for this selector before extracting (default "body")
     "timeout": 30000             // optional — navigation timeout in ms
   }
   ```
2. Infer parameters from the hint:
   - "just the page" → `{url}` only (full text)
   - "the hours table" / "links in main content" → add `selector` (best CSS guess) + `waitFor`
3. Read the returned text, summarize the relevant part for the user, and cite the source URL.
4. If the tool reports an error (timeout, SSL, navigation failure), surface it and suggest a fallback (`WebFetch` for static pages, or ask the user to paste content). Treat SSL-cert errors on venue sites as "possibly closed or moved".

## When to use vs WebFetch

| Page type | Use |
|---|---|
| Static HTML, public, no JS-required content | **WebFetch** (faster) |
| SPA / React app / JS-rendered (most modern booking sites) | **scrape** |
| **Search-engine deeplinks** (Kayak `/flights/…`, Booking `/searchresults.html?…`, Google Flights `/travel/flights?q=…`) | **scrape — MANDATORY**. WebFetch reports false positives (page shell loads, results don't). |
| Behind login | **scrape** (anonymous — no session/cookies) or skip |
| AI-chat share links | Neither works; ask the user to paste |

## Deeplink verification (per [link-verification.md](../../rules/link-verification.md))

**Before citing a search-engine deeplink in a plan file**, scrape it first. Read the returned text — if it doesn't contain the prices/results you're citing it for, the deeplink is broken for the end user. Substitute a working deeplink format or a portal URL + a date-stamped scraped price instead.

## When NOT to use

- One-line lookups the model already knows reliably (capital city, basic geography).
- Repeated polling of the same page (rate-limit / anti-bot risk; reuse the earlier result).

## Output handling

Use the returned text inline and discard. If a large result genuinely must persist for later reference (e.g. cited from a plan), save it under `cache/` with a descriptive filename — never to OS temp paths. `/cleanup` prunes `cache/` later.

## Rules

- [no-fabrication.md](../../rules/no-fabrication.md) — scraped content still needs the source URL citation in any plan file.
- [link-verification.md](../../rules/link-verification.md) — the rule this skill enforces.

## Related

- [.claude/workflows/BROWSER_AUTOMATION.md](../../workflows/BROWSER_AUTOMATION.md) — full decision tree (WebFetch vs WebSearch vs scrape vs extract).
