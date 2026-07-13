# Storage Conventions

How files are named and where they go. Always read this first — every other workflow assumes it.

## Directory map

```
plans/
├── trips/      YYYY-MM-<slug>.md       e.g. 2026-08-kyoto.md
├── daily/      YYYY-MM-DD.md           e.g. 2026-05-18.md
├── weekly/     YYYY-Www.md (ISO week)  e.g. 2026-W21.md
├── budgets/    <scope>.md              e.g. 2026-08-kyoto.md OR 2026-05-monthly.md
└── packing/    <slug>.md               e.g. 2026-08-kyoto.md
```

Server-managed directories (`state/`, `uploads/`, `cache/`) are **not** plan storage — never place plans there. `uploads/` is read only via the `extract` tool; `cache/` is the only place for agent scratch files.

## Naming rules

- **Slug = kebab-case, no diacritics, no spaces.** `2026-08-kyoto-osaka.md` is fine; `2026-08-Kyoto (fun trip).md` is not.
- **Trip date prefix = `YYYY-MM` of departure.** Even if the trip spans months, use the start month.
- **Daily files = the date they describe**, not the date you wrote them. `daily/2026-05-18.md` is "the plan for May 18", not "what I wrote on May 18".
- **Weekly files use ISO week numbers.** `2026-W21` = the ISO week that starts Monday 2026-05-18. Ask if ambiguous.
- **Budgets and packing lists mirror the trip slug** so they're trivially linkable. A budget for `trips/2026-08-kyoto.md` is `budgets/2026-08-kyoto.md`.

## Cross-linking

Inside any plan file, link related files with relative paths:

```markdown
- Budget: [budgets/2026-08-kyoto.md](../budgets/2026-08-kyoto.md)
- Packing: [packing/2026-08-kyoto.md](../packing/2026-08-kyoto.md)
```

The trip file is the **hub** — it links to its budget, packing list, and any daily files generated for the trip days.

## When a file already exists

- **Editing a daily/weekly plan that already exists**: edit in place. Don't rename, don't suffix with `-v2`.
- **Re-planning a trip that already has a file**: ask the user — they may want a clean rewrite, or they may want to preserve history (which git does anyway via the server's review flow, not filename suffixes).
- **Conflicting trips in the same `YYYY-MM`**: disambiguate by location, e.g. `2026-08-kyoto.md` and `2026-08-iceland.md`. Don't number them.

## Past plans are a resource

When the user asks "what did we do in Kyoto last time", grep `plans/trips/` for `kyoto` before saying "I don't know". Past plans inform future ones — restaurants liked, transit gotchas, packing regrets.
