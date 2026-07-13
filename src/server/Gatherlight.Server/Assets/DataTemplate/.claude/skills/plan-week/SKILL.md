---
name: plan-week
description: Plan or review a week. Creates or updates plans/weekly/YYYY-Www.md. Two modes — review (look back) and plan (look ahead). Usually both in one session at the week boundary.
---

# Plan Week

**Format**: `/plan-week` (defaults to current ISO week) or `/plan-week YYYY-Www`.

## Action

1. Run `/doc-loader weekly` — loads [WEEKLY_PLANNING.md](../../workflows/WEEKLY_PLANNING.md), household, rules.
2. **Resolve the ISO week** — compute Monday and Sunday dates from the year + week number.
3. **Check `plans/weekly/<iso-week>.md`** — exists? Read.
4. **Determine mode**:
   - User says "review" / "wrap up" → review mode.
   - User says "plan" / "this week" / "ahead" → plan mode.
   - Default at week boundary (Sun/Mon) → both.

### Review mode
1. Read each `plans/daily/<date>.md` for the 7 days.
2. Summarise into the **Review** section: shipped, slipped (why), surprises, lessons.
3. Lessons that recur → suggest updating `household/preferences.md` or `household/constraints.md`.

### Plan mode
1. Copy template (if new file).
2. Fill **Top priorities** (max 5).
3. Pull **fixed commitments** from `household/recurring.md` and any known calendar events.
4. Pull **deadlines** from any open trip files (booking deadlines), budgets (bills), or projects.
5. List the seven daily files as links — they'll be created day-by-day by `/plan-day`.

## Rules

- [absolute-dates.md](../../rules/absolute-dates.md)
- [filename-conventions.md](../../rules/filename-conventions.md)
- [edit-in-place.md](../../rules/edit-in-place.md)
