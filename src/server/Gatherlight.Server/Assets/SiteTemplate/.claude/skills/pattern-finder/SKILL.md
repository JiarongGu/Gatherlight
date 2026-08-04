---
name: pattern-finder
description: Find prior plans and household-profile entries that are relevant to the current task. Core discovery skill — invoke as part of the 5-skill gate at every task start. Outputs concrete Glob/Grep commands.
---

# Pattern Finder

**Format**: `/pattern-finder <PatternType>` where PatternType is one of: `trip`, `daily`, `weekly`, `budget`, `packing`, `household`, `all`.

## Action

Run the Glob/Grep commands for the pattern type below. Show top 2-3 matching files with a one-line excerpt each. Don't write a long report — just surface what's there so the planning step can use it.

## Search Commands by Pattern Type

### Trip patterns

| Need | Glob / Grep |
|---|---|
| Past trips to a destination | `Grep` for `<destination keyword>` in `plans/trips/*.md` |
| All trip files (most recent first) | `Glob` `plans/trips/*.md`, sort by name desc |
| Trips at a certain time of year | `Glob` `plans/trips/YYYY-MM-*.md` for the target month |
| "Lessons" entries from past trips | `Grep` `^## Lessons` in `plans/trips/*.md` |

### Daily / weekly patterns

| Need | Glob / Grep |
|---|---|
| Yesterday's plan (for carry-over) | `Read` `plans/daily/<date-1>.md` |
| All daily files in a week | `Glob` `plans/daily/YYYY-MM-DD.md` for the 7 dates |
| Last 4 weekly reviews | `Glob` `plans/weekly/*.md`, sort desc, take 4 |
| Recurring slipped items | `Grep` `^- Slipped` across `plans/daily/*.md` + `plans/weekly/*.md` |

### Budget patterns

| Need | Glob / Grep |
|---|---|
| Past budget for a similar destination | `Grep` `Trip: .*<destination keyword>` in `plans/budgets/*.md` |
| All budget files | `Glob` `plans/budgets/*.md` |
| Currency precedent for a destination | `Grep` `Base currency` in `plans/budgets/*.md` and look for the destination |

### Packing patterns

| Need | Glob / Grep |
|---|---|
| Past packing list for a similar trip type | `Glob` `plans/packing/*.md`, then `Grep` `Trip type:.*<type>` |
| "Bring next time" / "leave behind" lessons | `Grep` `Bring next time\|Leave behind` in `plans/packing/*.md` |

### Household patterns

| Need | Read |
|---|---|
| Anyone with dietary restrictions | `Grep` `Dietary:` in `household/people.md` |
| Travel-style preference | `Read` `household/preferences.md` (Travel style section) |
| Hard constraint or anniversary | `Read` `household/constraints.md` |
| Recurring weekly commitment on `<day>` | `Read` `household/recurring.md` |

### All (when scope is unclear)

Run a broad `Grep` for the most salient keyword from the user's request across `plans/**/*.md` and `household/*.md`.

## Output Format

```
### Found:
- plans/trips/2024-04-kyoto.md — "Lessons: bring thermals; JR pass was worth it"
- plans/packing/2024-04-kyoto.md — has previous "Bring next time" list

### Empty / no prior:
- plans/budgets/ — no Kyoto precedent
```

If nothing is found, say so explicitly: *"No prior plans match — drafting from scratch."*

## Rules Patterns

After running file searches, scan [`.claude/rules/RULES_INDEX.md`](../../rules/RULES_INDEX.md) for matching rule rows. **Rules override generic patterns when conflicts exist.**
