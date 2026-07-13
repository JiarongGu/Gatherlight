---
name: skill-loader
description: Route a planning task to the right planning skills. Core discovery skill — invoke as part of the 5-skill gate at every task start. Returns INVOKE/SKIP lists so only relevant skill templates are loaded.
---

# Skill Loader

**Format**: `/skill-loader "task description"`

## Purpose

Reads the task description and returns only the planning skills that match. Keeps context lean — loading every skill every time is wasteful.

## Action

1. Read the task description.
2. Match against the routing table.
3. Output **INVOKE** (skills to call now) and **SKIP** (one-line reason).
4. After printing both lists, immediately invoke every skill in INVOKE via `Skill()` calls.
5. Print the rules-check reminder at the end.

## Routing Table

| Trigger (any match = INVOKE) | Skill |
|---|---|
| trip, itinerary, vacation, travel plan, flight, hotel, multi-day plan | `/plan-trip` |
| today, tomorrow, daily plan, schedule for the day | `/plan-day` |
| week, weekly, this week, week review, next week | `/plan-week` |
| budget, expense, cost, spending, money plan, track | `/budget-track` |
| packing, suitcase, bring, gear list | `/packing-list` |
| save / remember / record a household fact (person, preference, constraint, recurring) | `/household-update` |
| scrape, fetch dynamic page, verify link, extract from SPA | `/scrape` |

## Multiple matches expected

Examples:
- "Plan a Kyoto trip and start a budget for it" → `/plan-trip` + `/budget-track`.
- "Plan a Kyoto trip and a packing list" → `/plan-trip` + `/packing-list`.
- "Plan this week and the day I'll travel" → `/plan-week` + `/plan-day`.

## No matches

If nothing matches (pure information request, e.g. "what's the visa rule for Japan?"), output:
> No planning skills apply — proceed manually. Still run the rest of the gate (`/doc-loader`, `/pattern-finder`, `/caveman`) so docs and rules are loaded.

## Output Format

```
### Skills to INVOKE:
- `/plan-trip` — multi-day Kyoto trip
- `/budget-track` — paired budget for the trip

### Skills to SKIP:
- `/plan-day` — not asking for a daily plan
- `/plan-week` — not asking for a weekly review
- `/packing-list` — user can ask later
- `/household-update` — no new household fact mentioned
```

## Mandatory Rules Check

After INVOKE/SKIP, remind to read [`.claude/rules/RULES_INDEX.md`](../../rules/RULES_INDEX.md) — the single source of rule metadata. Scan the *Applies When* column.

New rule discovered during the task? Copy [`TEMPLATE.md`](../../rules/TEMPLATE.md) → `.claude/rules/<name>.md`, write it, **add a row to RULES_INDEX.md**.
