# Past Plans First

**Before drafting a new trip / packing list / budget for a destination or scope the user has touched before, grep `plans/` for prior context.**

## Why

The point of keeping these plans in the workspace is that the next session can learn from the last one. If the user went to Kyoto in 2024 and noted "regret: didn't pack thermals — got cold at Fushimi", that's gold for the 2026 packing list. Ignoring it makes the whole memory layer wasted.

## How to Apply

Triggers:
- New trip → grep `plans/trips/` and `plans/packing/` for the destination keyword.
- New packing list → grep `plans/packing/` for the same trip type (city / hiking / beach).
- New budget → grep `plans/budgets/` for the same destination or month-of-year.
- Daily/weekly review patterns → scan the last 2-4 of the same type for recurring "slipped" items.

Action:
1. Run the grep before writing.
2. Surface 1-3 relevant nuggets to the user: "Last time you went to Kyoto you noted X — keep relevant?"
3. Use the nuggets when drafting (e.g. pre-tick packing items the user always brings, pre-fill restaurants they liked).

Don't:
- Wholesale copy the old plan. Travel context changes (season, travelers, length).
- Surface every old detail. 1-3 most relevant > exhaustive recap.

## Examples

✓ User: "plan a Kyoto trip Aug 2026."
   Assistant: greps `plans/trips/`, finds `2024-04-kyoto.md`, surfaces: "Last time you stayed in Higashiyama and wished you'd had a JR pass for the day-trip to Nara. Want me to factor those in?"

✗ Same scenario, assistant ignores past trip and asks "first time in Kyoto?"

## Related

- [.claude/workflows/STORAGE.md](../workflows/STORAGE.md) — naming conventions enable the grep to work.
- [household profile](../../household/README.md) — also grep this for dietary / mobility / preferences.
