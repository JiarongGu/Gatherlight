# Trip Planning Workflow

Used by `/plan-trip`. Produces a file at `plans/trips/YYYY-MM-<slug>.md` and optionally paired budget/packing files.

## Inputs to gather (ask if missing)

1. **Destination(s)** — city/region, in priority order if multiple.
2. **Dates** — start and end as `YYYY-MM-DD`. Convert anything relative.
3. **Travelers** — who's going. Affects pace, lodging type, packing.
4. **Budget tier** — shoestring / moderate / comfortable / no-cap. Not exact numbers yet.
5. **Pace** — packed / balanced / slow. Affects daily activity count.
6. **Anchors** — must-do events (a wedding, a concert, a conference) with dates.
7. **Open questions** — anything the user is unsure about (rent a car? trains only?). Capture as TBD in the plan.

Don't interrogate all at once — ask 2-3 at a time, the rest can be TBD and filled later.

## Steps

1. **Check for past plans** — grep `plans/trips/` for the destination. If found, surface relevant notes (restaurants, transit, regrets) before planning fresh.
2. **Copy the template** — start from [`.claude/templates/trip.md`](../templates/trip.md). Don't invent structure.
3. **Fill in the header** — dates, travelers, budget tier, pace.
4. **Draft the day-by-day skeleton** — one section per day, dated. Empty bullet points are fine; the daily content can come later.
5. **Web search for the load-bearing facts** — opening hours of must-see sights, transit options between cities, festivals/closures during the dates. Cite URLs inline. See [WEB_SEARCH.md](WEB_SEARCH.md).
6. **Surface flags** — visa requirements, weather warnings, religious holidays affecting closures, peak-season pricing.
7. **Propose, don't dictate** — present 2-3 alternatives for big choices (which city order, train vs flight between legs). Let the user pick.
8. **Offer to create paired files** — at the end, ask whether to scaffold `budgets/<slug>.md` and `packing/<slug>.md`. Don't auto-create.

## What goes in the trip file

See [template](../templates/trip.md). Required sections:

- **Variants section** (only if the same destination has multiple parallel plans): `## 🗺️ Variants` table at the top linking siblings. See [filename-conventions.md](../rules/filename-conventions.md) — variants use different month prefixes (`2026-08-kyoto.md` + `2026-10-kyoto.md`).
- **Summary** — one-paragraph overview, dates, travelers, total nights.
- **Logistics** — flights/transport, lodging, visas, vaccinations, insurance.
- **Day-by-day** — one ## per day with date, location, plan, food ideas.
- **Things to book** — checklist with deadlines.
- **Open questions / TBD** — kept at the bottom; reduces over time.

## Currency + link conventions

- **The household's home currency is primary**; source currencies go in parens: `USD 25 (JPY 2,500)` — or with the rate for auditability: `USD 23 (~JPY 2,500 @ 110)`. See [money-format.md](../rules/money-format.md).
- **Reality-check price levels** — model / guidebook estimates for high-end dining and multi-person hotel rooms tend to be optimistic-low. Verify real price ranges on the venue's own site / booking portals before writing them into the budget.
- **Verify data with tools, not memory**:
  - **Flight prices + schedules** → `WebSearch` + the `scrape` MCP tool on a verified deeplink (e.g. a Google Flights natural-language URL). **Never from model recall or estimation.**
  - **Hotel prices** → scrape the booking portal / hotel site. Watch for fuzzy name matches — an outlier (> 2× comparable rooms) needs a manual re-check.
  - **Attraction / restaurant / experience existence + price + hours** → `scrape` (JS pages) or `WebFetch` (static official domains).
- **Link conventions** (see [link-verification.md](../rules/link-verification.md)):
  - Every URL written to a plan file **must** open with content for the user. Search deeplinks with date/filter params often render blank without JS.
  - Prefer a scrape-verified deeplink; otherwise a portal URL + a **date-stamped scraped price**: `[Kayak](https://www.kayak.com/) — AAA-BBB 08-01 → 08-15, scraped USD 1,148/per (2026-05-19)`.
  - Also attach the airline / hotel **official booking entry** link as a fallback, with the search criteria spelled out in text.
  - After writing a URL, **test it**: scrape it and confirm the returned text contains the data you're citing — if not, the link is not trustworthy.

## Overnight flights = travel days, not destination nights

If the international leg is a red-eye/overnight flight, the departure date is spent on the plane — **it is not a destination night; don't book a hotel for it**. Day 1 is the arrival day.

- ✗ "15 days / 14 nights, City A 08-01→08-04 (3 nights)" when the 08-01 flight lands 08-02
- ✓ "14 days at destination / 13 hotel nights, City A **08-02→08-04 (2 nights)**; 08-01 marked '🛫 journey begins' preamble, not a Day"

## Check-out days are light days

Hotel check-out day = luggage in hand. **Avoid major sights / museums / long walks that day.** Suggest:
- Morning: pack + luggage storage at the hotel lobby, or a luggage-forwarding service to the next hotel where available
- Late morning–noon: transit to the next city
- Afternoon: light activity after check-in (market walk, casual dinner)
- Mark it in the day header: `### Day 6 — 2026-08-16 (Sat) — 🧳 check-out day, City A → City B`

## Venue-name spelling

Write hotel / restaurant / event **brand names exactly as the booking site spells them** (booking portals, restaurant directories, and official sites need an exact match when the user searches). Keep airport codes as codes (e.g. JFK / LHR). City and area names can follow the household's preferred language.

## What doesn't go here

- Granular packing items (those live in `packing/<slug>.md`).
- Exact expense rows (those live in `budgets/<slug>.md`).
- Generic travel advice ("bring an adapter"). Only trip-specific facts.

## When the user travels

The trip file is a living plan. During travel, the user (or Claude on their behalf) can:
- Tick off booked items.
- Add real expenses to the budget file.
- Move items between days as plans shift.
- Append a "Lessons" section at the bottom after the trip for future-trip reference.
