# Verify Time-Sensitive Policy Info

**Visa rules, flight numbers, opening hours, prices, eligibility, and other policy/regulatory facts go stale. Model training data is unreliable for these. Verify via web search before writing to a plan file — do not assume "I know this".**

## Why

Three concrete failure shapes, all observed in past planning audits (details genericized):

1. **Visa policy fabricated** — the model wrote "passport holders of country X enter country Y visa-free" into a plan. Wrong: that nationality required a tourist visa. Cost if undetected: a denied boarding at the airport.
2. **Flight number fabricated** — the model wrote flight "XX313" for a carrier whose real IATA code was different; the claimed code actually belonged to a wholly unrelated airline. The correct flight number was only found via FlightAware.
3. **Passport-validity rule conflated** — the model applied a generic "valid > 6 months" rule when the destination's actual rule was "valid ≥ 90 days past the exit date". The model had conflated a different country's requirement.

In all three cases the model wrote authoritative-sounding facts that were false. The cost to the user — denied visa, wrong booking, refused boarding — is far higher than the cost of one web search.

## How to Apply

### Categories that ALWAYS require live verification before writing

| Category | Why model recall fails | Verify with |
|---|---|---|
| **Visa policy** (country X → country Y, validity, lead time, eligibility) | Visa-free agreements change yearly; pilots expire; document requirements drift | Destination foreign ministry (e.g. [MOFA Japan](https://www.mofa.go.jp/j_info/visit/visa/)) / embassy site — and CITE in the file |
| **Flight numbers + schedules** | Carrier codes get confused; routes added/dropped; times shift seasonally | [FlightAware](https://www.flightaware.com) / the airline's own schedule / `scrape` on a Google Flights deeplink |
| **Hotel addresses + phones** | Hotels rebrand, relocate, change reservation lines | Hotel official site via `scrape` (check SSL cert valid) + cross-check a booking portal |
| **Restaurant existence + URLs** | Closures + fabricated directory IDs (see [link-verification.md](link-verification.md)) | `scrape` each claimed URL + web search on trusted domains |
| **Opening hours / prices** | Drift constantly; seasonal variation | Venue's own site (latest "what's on" / calendar page) |
| **Festival / event dates** | Year-by-year; formats change (4-day → 5-day expansions happen) | Official event site |
| **Passport validity rules** | Country-specific ("valid throughout stay" / 3-month / 6-month / 90-days-past-exit all exist) | Destination foreign ministry + airline check-in policy |
| **Customs / quarantine** (medications, food import) | Updated per outbreak / drug schedule | Destination government source + airline |

### Categories that DON'T need live verification (model recall OK)

- Cultural / etiquette norms ("tipping is not expected in Japan")
- Broad geography ("Kyoto is south of Tokyo on the Tokaido line")
- Historic / stable facts ("Senso-ji was founded in 645")
- The user's own household profile (already in `household/*.md`)

### Workflow when a policy fact comes up

1. **Pause before writing.** Ask: "is this in the table above?"
2. **WebSearch** with the year specified — `"<topic> 2026"` — to filter out stale results.
3. **Read the official source** — not Wikipedia for policy (Wikipedia OK for historical facts).
4. **Cite inline** when writing — `[official visa info](https://…)` after the fact.
5. **Re-verify before booking / submission** — policy can change between planning and booking; add a re-check step to the "Things to book" checklist.

### When you find an existing wrong claim

- Fix in place (per [edit-in-place.md](edit-in-place.md)).
- Note `verified <YYYY-MM-DD> via <source>` so future sessions can judge freshness.
- Surface the cost the wrong claim would have caused (denied entry, wrong flight, etc.) so the user can audit anything else that relied on it.
- If it's a recurring pattern, add a row to the table above or capture via `/remember`.

## Examples

✗ Writing "visa-free 30 days" for a passport/destination pair from memory.
✓ WebSearch "<passport country> <destination> tourist visa 2026" → official ministry page → write the requirement + citation + add the visa lead-time to the booking checklist.

✗ Writing a flight number + departure time because the model "knows" the carrier's schedule.
✓ WebSearch / FlightAware the route + time → confirm the real flight number → write it with the citation.

✗ "The festival runs Sep 18-21" from memory.
✓ WebSearch "<festival name> 2026 dates" → official site → write the confirmed dates with citation.

## Related

- [no-fabrication.md](no-fabrication.md) — generic "cite or TBD"; this rule is the **specific** category list for *which* facts go stale.
- [link-verification.md](link-verification.md) — URL-level verification for what we write.
- [tool-first.md](tool-first.md) — use tools to verify, not memory.
