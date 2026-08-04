# Link Verification

**Every URL written into a plan file must be verified to actually serve content to the user. For JS-rendered / SPA / search-deeplink URLs, verification REQUIRES the `scrape` MCP tool (`mcp__planner-tools__scrape`) — `WebFetch` is INSUFFICIENT and will report false positives.**

## Why

Kayak, Booking.com, Google Flights, and similar search deeplinks all rely on client-side JavaScript to populate results. `WebFetch` does NOT execute JS — it just downloads the HTML shell, sees nav + footer + "loading…" placeholders, and (because the title is still set) appears to "succeed". A plan citing such a URL looks fine to the agent but **shows the user a blank page**.

Past user feedback that created this rule (paraphrased): "the flight links you gave contain nothing — you must audit the content you generate; use the browser tool for deeplinks."

The cost: every search-deeplink cited without verification is a broken citation. A plan riddled with "trust me, here's a link" that doesn't load wastes the user's time worse than no link at all.

## How to Apply

### Step 1 — classify the URL

| URL type | Loads in WebFetch? | Verification tool |
|---|---|---|
| Static HTML page (museum / restaurant homepage, gov sites) | usually yes | `WebFetch` OK |
| Wikipedia / docs / blog post | yes | `WebFetch` OK |
| Search-engine **portal** (e.g. `kayak.com/`, `booking.com/`) | partial — page renders, no results | `WebFetch` OK to confirm portal exists |
| **Search-engine deeplink** (Kayak `/flights/AAA-BBB/…`, Booking `/searchresults.html?…`, Google Flights `/travel/flights?q=…`) | **NO** — blank / results missing | **MUST use `scrape` — never WebFetch** |
| Booking confirmation / cart / login-walled | no | `scrape` (anonymous) or skip |
| AI-chat share links | no | neither — ask user to paste |

### Step 2 — verify before writing

Before pasting any deeplink into a plan file, call the scrape tool:

```
mcp__planner-tools__scrape { "url": "<URL>", "waitFor": "body" }
```

Read the returned text. **If the text does NOT contain prices / results / the thing you're citing the URL for**, the link is broken — do not cite it.

### Step 3 — preferred citation format

**Cite a verified deeplink — don't fall back to a portal-only URL if the deeplink works.** A portal URL forces the user to re-enter dates. Order of preference:

1. **Verified-loadable deeplink** (scrape confirmed it shows results):
   `[Kayak AAA-BBB 08-01/08-15](https://www.kayak.com/flights/AAA-BBB/2026-08-01/2026-08-15)` — dates in path, no fragile filter params
2. **Airline / hotel booking entry URL** (the search form, not a marketing route page).
3. **The scraped price** as ground truth, citing the date the tool ran:
   `USD 1,148/per (scrape tool, 2026-05-19) — verify on link before booking`

**Only fall back to a portal-only URL if every deeplink format fails verification.**

Format for any flight/hotel price row:

```markdown
| 2026-08-01 → 08-15 | USD 1,148/per (scrape 2026-05-19) | [Kayak AAA-BBB 08-01/08-15](https://www.kayak.com/flights/AAA-BBB/2026-08-01/2026-08-15) · [Airline booking form](https://www.example-airline.com/flights) |
```

— the price has a **date-stamp**, the deeplink has **dates in the path**, and both URLs are verified-loadable.

### Step 3b — known broken URL patterns (verify before reusing)

| Pattern | Why broken | Working alternative |
|---|---|---|
| Kayak deeplink with filter query (`?fs=stops%3D~0`) | Non-stop filter can render "0 of N flights" / "No matching results" page-side while the scraper still returns a cheapest 1-stop price, masking the issue | Drop the `?fs=…` query — the base path works. Read the "Stops" sidebar to know what's actually direct |
| Airline **marketing route pages** (`<airline>.com/<locale>/flights/<country>/<city>`) | Frequently 404 as routes get restructured | Link the airline's booking **search form** entry page instead |
| Airline booking URLs with search params (`…/search-flights?adults=3&origin=…`) | Some airlines 404 or **silently ignore the params** — the form loads blank while the URL looks right | Use the booking entry URL + spell out the search criteria in the plan text so the user knows what to enter |
| `booking.com/searchresults.html?ss=<hotel>&checkin=…` | Works in a browser session but timestamps go stale + anti-bot blocks | Verify with `scrape` first; if broken, cite the hotel's own homepage |
| `google.com/travel/flights?q=<natural+language>` | **WORKS** — loads real flight results with prices/airlines when scraped. Use natural-language query format `q=Flights+from+AAA+to+BBB+on+2026-08-01+returning+2026-08-15` | This IS a working deeplink format; use for cross-verification + price-checks |

### Step 3c — aggregator data can be misleading (cross-check with the airline source)

Aggregators (Kayak / Skyscanner / Google Flights) show **what they have access to at scrape time** — which may miss yesterday's schedule change, mis-categorise a tech-stop as "direct", or show day-of-week-dependent routes inconsistently.

**Cross-check rules for "a direct flight exists" claims**:
1. **Wikipedia airport page** — lists current scheduled carriers and routes. Static HTML, WebFetch works. Most reliable quick source.
2. **Airline's own destinations / where-we-fly page** — confirms the airline serves the city pair.
3. **Carrier timetable** — definitive if findable.
4. **Aggregator via `scrape`** — useful for **prices** + schedule snapshot; treat as approximate for route existence.
5. **User verification in the airline app** — gold standard; ask for flight number + date.

**Don't make a "direct flight exists" claim without at least 2 sources agreeing.** If only the aggregator says it, hedge: "aggregator shows direct on this date — verify on the airline's own booking flow before quoting".

### Step 4 — citation-style URLs (museum / restaurant / venue homepage)

Static pages are usually fine. Spot-check with WebFetch when:
- The URL was generated by the model (not pasted by the user)
- The fact being cited is time-sensitive (hours, prices, reservation policy)
- The page may have moved / 404'd

If WebFetch returns "blank" / "page not found" / wrong content → the URL is broken; use the venue's parent domain + a search hint, or mark TBD.

## Restaurant URLs — special case

**Pattern discovered in a past audit: model recall of restaurant directory URLs (Tabelog etc.) is systematically unreliable.** In that audit, **6 out of 6** model-recalled Tabelog restaurant URLs were broken: most pointed at a wholly different restaurant, the rest returned 404, and some of the restaurant *names themselves* were fabricated. One recommended restaurant had permanently closed years earlier (caught only by its dead SSL cert).

**Why**: numeric directory IDs (`tabelog.com/en/…/A\d+/A\d+/<8-digit-id>/`) look pattern-correct but the model assigns them at random. Wrong IDs render an *unrelated* restaurant rather than 404, so the fabrication is **silent** to WebFetch — only the page content reveals the mismatch.

**Workflow when restaurant URLs are in a plan file or being added**:

1. **Never accept a model-generated directory ID without scraping the page.** The URL pattern looks valid even when wrong.
2. `scrape` each claimed URL and confirm the page shows the **expected restaurant name** (and plausibly the expected price tier / cuisine). Mismatch = fabricated — search the web for the correct individual page on a trusted domain.
3. For restaurants without verifiable individual pages (small, local-language-only places), mark **TBD**: "ask hotel concierge to confirm at booking time".
4. Treat any SSL-cert error or timeout as "closed or moved" — search for a replacement.

**Trusted vs untrusted domains for restaurants**:

| Domain | Acceptable? | Notes |
|---|---|---|
| `tabelog.com/en/<area>/A\d+/A\d+/\d+/` (individual page) | ✅ | Only after scrape confirms expected name + price tier |
| `tabelog.com/en/…/rstLst/` (listing) | ❌ | Index page, not a restaurant |
| `tabelog.com/en/matome/<id>` (curated article) | ⚠️ | Editorial list — discovery only |
| `tablecheck.com/en/shops/<name>/` | ✅ | Official reservation page |
| `guide.michelin.com/…/restaurant/<name>` (individual) | ✅ | Authoritative for star count |
| `guide.michelin.com/…/restaurants` (area listing) | ⚠️ | Discovery aid only |
| Venue's own domain | ⚠️ | Must scrape-verify; watch for expired SSL certs and stale info |

## Examples

✗ Citing a Kayak deeplink with a `?fs=…` stops-filter as the source for a price — the filtered page shows "No matching results" to the user.

✗ Falling back to a portal-only URL when the unfiltered deeplink works fine — the user has to re-enter dates needlessly.

✓ Citing a scrape-verified deeplink + the airline's booking entry page, noting "price USD 1,148/per via scrape tool 2026-05-19".

✗ Writing a `booking.com/searchresults.html?…` URL without ever opening it — user clicks, sees a blank/error page.

✓ `scrape` the same URL, confirm it returns the hotel name + a price, THEN cite it — OR cite the hotel's own homepage instead.

## Related

- [no-fabrication.md](no-fabrication.md) — citing a broken URL is a form of fabrication.
- [/scrape skill](../skills/scrape/SKILL.md) — how to call the verification tool.
- [.claude/workflows/BROWSER_AUTOMATION.md](../workflows/BROWSER_AUTOMATION.md) — when the scrape tool is the right choice.
