---
name: plan-trip
description: Plan a multi-day trip. Creates plans/trips/YYYY-MM-<slug>.md from the trip template, factoring in household profile, past trips, and web-searched logistics. Optionally scaffolds matching budget and packing files.
---

# Plan Trip

**Format**: `/plan-trip <destination> <dates>` — both can be vague; the skill asks for missing inputs.

## Action

1. Run `/doc-loader trip` — loads [TRIP_PLANNING.md](../../workflows/TRIP_PLANNING.md), household profile, rules.
2. **Gather inputs** (see workflow §Inputs). Ask 2-3 at a time; rest can be TBD.
3. **Grep `plans/trips/`** for the destination keyword. Surface past nuggets if found.
4. **Generate slug**: `YYYY-MM-<destination-kebab>` (e.g. `2026-08-kyoto`). For same-destination **variants** (parallel candidate plans), use a different month prefix: `2026-08-kyoto.md` + `2026-10-kyoto.md`, and add a `## 🗺️ Variants` section at the top of each linking its siblings (see [filename-conventions.md](../../rules/filename-conventions.md)).
5. **Copy template** `.claude/templates/trip.md` to `plans/trips/<slug>.md`.
6. **Fill header** — dates, travelers (from `household/people.md`), budget tier, base currency.
7. **Draft day-by-day skeleton** — one ## per day with date, location, empty bullets. Don't over-fill yet.
8. **Web-search the load-bearing facts** — visa, weather, transit, must-see hours. Cite inline. See [WEB_SEARCH.md](../../workflows/WEB_SEARCH.md).
9. **Surface flags** — visa lead time, school-term conflicts (`constraints.md`), peak-season pricing, religious holidays.
10. **Present 2-3 alternatives** for big choices (city order, transport between legs). Let the user pick before committing them to the file.
11. **Offer to scaffold paired files**: budget at `plans/budgets/<slug>.md`, packing at `plans/packing/<slug>.md`. Don't auto-create.
12. **Currency + link conventions**: prices use the household's home currency as primary, source currency in parens. See [BUDGET_TRACKING.md](../../workflows/BUDGET_TRACKING.md) and [money-format.md](../../rules/money-format.md).
13. **🔧 Verify data with tools, not memory**: flight prices/schedules, hotel prices, and venue existence/hours/prices must come from live sources — `WebSearch` + the `scrape` MCP tool (`mcp__planner-tools__scrape`) for JS-rendered pages — never from model recall or estimation. See [verify-policy-info.md](../../rules/verify-policy-info.md).
14. **Every URL written to the plan must open for the user** — see [link-verification.md](../../rules/link-verification.md). Search deeplinks (Kayak / Booking / Google Flights) frequently render blank without JS; scrape-verify first, and date-stamp every quoted price (e.g. `(scrape 2026-05-19)`) so future sessions know when it was last checked.
15. **Overnight flights don't count as destination nights**: on a red-eye, the departure date is spent on the plane — Day 1 is the **arrival** day. Mark the departure date as a "🛫 journey begins" preamble, not a Day, and don't book a hotel for that night.
16. **Check-out days are light days**: luggage is in hand — avoid major sights / long walks. Morning = pack + transit; afternoon = light activity after check-in. Mark such days `🧳` in the day header.

## What to put in `Open questions / TBD`

Anything you couldn't resolve: lodging not booked yet, restaurant suggestions for a day, exact train choice. Keep this section as a working list — it shrinks as decisions get made.

## When the trip file already exists

- User asks to re-plan: ask whether to overwrite (git keeps history via the review flow) or to edit specific parts.
- User asks to add/move a day: edit in place. See [edit-in-place.md](../../rules/edit-in-place.md).

## Cross-cutting rules

- [absolute-dates.md](../../rules/absolute-dates.md)
- [filename-conventions.md](../../rules/filename-conventions.md)
- [money-format.md](../../rules/money-format.md)
- [no-fabrication.md](../../rules/no-fabrication.md)
- [link-verification.md](../../rules/link-verification.md)
- [past-plans-first.md](../../rules/past-plans-first.md)
- [household-profile-first.md](../../rules/household-profile-first.md)
