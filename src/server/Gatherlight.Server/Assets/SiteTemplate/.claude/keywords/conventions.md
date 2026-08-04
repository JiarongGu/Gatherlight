# Keywords — Conventions

Used by `/doc-loader` when the task is about "how we write things" — filenames, dates, money, citations.

## Cross-cutting rules

| Topic | Rule |
|---|---|
| Dates | [absolute-dates.md](../rules/absolute-dates.md) |
| Filenames + slugs + pairing | [filename-conventions.md](../rules/filename-conventions.md) |
| Money + currency + conversions | [money-format.md](../rules/money-format.md) |
| Editing existing plans | [edit-in-place.md](../rules/edit-in-place.md) |
| Citing web sources / TBD | [no-fabrication.md](../rules/no-fabrication.md) |
| Storing memory | [no-global-memory.md](../rules/no-global-memory.md) |

## How we name things — quick reference

```
plans/trips/    YYYY-MM-<slug>.md            2026-08-kyoto.md
plans/daily/    YYYY-MM-DD.md                2026-05-18.md
plans/weekly/   YYYY-Www.md (ISO)            2026-W21.md
plans/budgets/  <scope>.md                   2026-08-kyoto.md  (mirrors trip slug)
plans/packing/  <slug>.md                    2026-08-kyoto.md  (mirrors trip slug)
```

## How we format dates and money — quick reference

- Dates: `YYYY-MM-DD`, optionally with weekday `Fri 2026-05-22`. Convert "next Friday" before writing.
- Money: `<CCY> <amount>` (`JPY 14000`). Conversion in parens: `JPY 14000 (~USD 90 @ 155)`.

## Workflow doc for the full picture

[workflows/STORAGE.md](../workflows/STORAGE.md) — directory layout, naming, cross-linking.
