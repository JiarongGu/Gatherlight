---
name: budget-track
description: Plan or track a budget. Creates plans/budgets/<scope>.md from the budget template (planning phase), or appends actuals to an existing budget file (tracking phase). Surfaces variance against caps.
---

# Budget Track

**Format**: `/budget-track <scope>` where `<scope>` is a trip slug (`2026-08-kyoto`), month (`2026-05-monthly`), or named scope (`home-renovation`).

## Action

1. Run `/doc-loader budget` — loads [BUDGET_TRACKING.md](../../workflows/BUDGET_TRACKING.md), household preferences, rules.
2. **Resolve scope** to a filename: `plans/budgets/<scope>.md`.
3. **Check if file exists**:
   - **No** → planning phase: copy template, fill estimates, link back to related trip if applicable.
   - **Yes** → tracking phase: read it, ask what to log.

### Planning phase
1. Copy `.claude/templates/budget.md` → `plans/budgets/<scope>.md`.
2. Set base currency (ask if not obvious from scope; for trips, default to the household's home currency with destination currency in parens).
3. Pre-fill estimates per category (sensible defaults; `TBD` for unknowns).
4. If linked to a trip file: add `Trip: [trips/<slug>.md](../trips/<slug>.md)` link near the top.
5. Reality-check: sum vs. cap, flag if over.

### Tracking phase
1. Ask the user what to log (date, category, item, amount + currency).
2. Append rows to the **Actuals** table.
3. Recompute the **Running totals** table.
4. Flag any category that just crossed its cap (don't bury this).

## When the user asks "how am I doing"

Produce the running totals table, plus a one-line verdict (e.g. *"On track — 13% consumed at 30% through trip"* or *"Over on lodging by USD 200, 50% consumed at 30% through trip"*). Don't editorialise beyond facts.

## Rules

- [money-format.md](../../rules/money-format.md)
- [filename-conventions.md](../../rules/filename-conventions.md)
- [edit-in-place.md](../../rules/edit-in-place.md)
