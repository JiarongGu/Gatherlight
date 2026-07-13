# Money Format

**Every monetary amount in a plan file has an explicit currency code. Conversions go in parentheses with the rate.**

## Why

A plan that says "lodging: 14000" is ambiguous — JPY 14000 (~USD 90) reads very differently from USD 14000. Worse, the same number a year later cannot be reconstructed: was the conversion correct, what rate was used? Putting the rate inline makes the budget auditable.

## How to Apply

- Format: `<CCY> <amount>` — e.g. `USD 120`, `JPY 14000`, `EUR 85`.
- Source-currency stays primary; conversion in parens: `JPY 14000 (~USD 90 @ 155)`.
- The rate (e.g. `@ 155`) is the JPY-per-USD rate at the time of writing. Auditable later.
- Multi-currency budget: don't normalise to one currency — preserve source, add conversions. The totals row may sum in a chosen base currency, noted at the top of the file.
- Receipts/photos: link, don't embed.

## Examples

✓ `Hotel: JPY 14000/night (~USD 90 @ 155)`
✓ `Flight: USD 612`
✗ `Hotel: 14000`
✗ `Hotel: ¥14000` (use ISO code `JPY`, not symbol — greppable)
✗ `Total: ~$5000` (no `~` on plain USD amounts; the `~` belongs only with conversions)

## Related

- [.claude/workflows/BUDGET_TRACKING.md](../workflows/BUDGET_TRACKING.md) — full budget workflow.
