# Budget Tracking Workflow

Used by `/budget-track`. Produces a file at `plans/budgets/<scope>.md` where `<scope>` is either:

- A trip slug — `2026-08-kyoto.md` (mirrors `trips/2026-08-kyoto.md`)
- A monthly scope — `2026-05-monthly.md`
- A category scope — `2026-home-renovation.md`

## Two phases

| Phase | Purpose |
|---|---|
| **Planning** | Pre-spending estimate by category. Budget caps. Reality-check against the trip/scope. |
| **Tracking** | Actual expenses logged as they happen. Variance against plan. |

A budget file starts in planning phase and grows tracking entries over time.

## Inputs

1. **Scope** — trip slug, month, or named scope.
2. **Currency** — base currency of the budget (`USD`, `JPY`, etc.). Multi-currency budgets stay in source currency; conversions are appended.
3. **Categories** — sensible defaults exist in the template; user can edit.
4. **Caps** — total cap and/or per-category caps. Optional.

## Steps (planning)

1. Copy [`.claude/templates/budget.md`](../templates/budget.md).
2. Pre-fill categories with rough estimates. Mark unknowns as `TBD` with a note ("need to research lodging").
3. Sum estimates; flag if over cap.
4. Link back to the related plan: `Trip: [trips/2026-08-kyoto.md](../trips/2026-08-kyoto.md)`.

## Steps (tracking)

1. Open the existing budget file.
2. Add a row to the **Actuals** table: date, category, item, amount + currency, optional note.
3. Update the running totals at the bottom.
4. If a category goes over its cap, surface that in the response — don't hide it.

## Conventions

- **Currency always explicit**: `JPY 14000`, never `14000`.
- **Home currency as primary**, source currencies in parens: `USD 25 (JPY 2,500)`; or with the rate for auditability: `USD 23 (~JPY 2,500 @ 110)`.
- **One-line entries** — date, what, how much. Don't write paragraphs.
- **Every price gets a source URL** — hotel → booking portal / official site; flight → verified aggregator deeplink or airline site; restaurant → verified directory page or official site; attraction → official domain. A price with no link is treated as TBD. See [link-verification.md](../rules/link-verification.md).
- **Receipts**: if the user has a photo or PDF, link it (uploads can be read via the `extract` tool). Don't embed.

## Three-tier path strategy (planning phase)

For a "comparable experience" budget (comfortable tier), offer 3 paths and let the user pick:

| Path | Shape | Fits when |
|---|---|---|
| **A. Keep everything** (original vision) | All premium dining + all celebrations + upscale hotels | No hard cap |
| **B. Middle** ⭐ default | One premium anchor + 1-2 celebrations + mid-range hotels | Near-equivalent experience + hits the target |
| **C. Strict** | Cut premium dining + simplify celebrations + modest hotels | Hard cap must hold |

Present as a small comparison table inside the budget file.

## Reality-check price levels (avoid optimistic underestimates)

Items that model recall / generic guides consistently underestimate:
- **High-end tasting menus / starred restaurants** — often 3-5× the "guidebook" figure; check the venue's own site or a verified directory page for the real range.
- **Daily food total** — count all three meals plus snacks, not just dinner.
- **Rooms for 3+ people** — portals show the double-room base price by default; triple/family rooms often cost +30-70%.

Verify real ranges via `scrape` / official sites before the user books — don't budget from estimation.

## Variance reporting

When asked "how am I doing", produce a short table: category, planned, actual, delta, % consumed. Highlight overruns. Don't editorialise.
