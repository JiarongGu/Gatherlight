---
name: plan-day
description: Plan a single day. Creates or edits plans/daily/YYYY-MM-DD.md from the daily template, pulling priorities from the weekly plan and carry-overs from yesterday.
---

# Plan Day

**Format**: `/plan-day` (defaults to today) or `/plan-day YYYY-MM-DD`.

## Action

1. Run `/doc-loader daily` — loads [DAILY_PLANNING.md](../../workflows/DAILY_PLANNING.md), household constraints/recurring, rules.
2. **Resolve date** from input (today's date is in session context).
3. **Check `plans/daily/<date>.md`** — exists? Read it and ask whether to edit/extend.
4. **Pull weekly priorities** — read `plans/weekly/<iso-week>.md` if it exists; surface relevant items.
5. **Check yesterday's `Carry to tomorrow`** — `plans/daily/<date-1>.md`. Propose carry-overs.
6. **Check `household/constraints.md`** and **`household/recurring.md`** — pull any standing commitments for this weekday.
7. **Ask** for: top 3 priorities, fixed commitments (meetings/calls with times), energy/constraints.
8. **Copy template** (if new file) `.claude/templates/daily.md` → `plans/daily/<date>.md`.
9. **Lay out time blocks**: fixed commitments first; then top priorities into real time slots; then maybe/stretch separately.
10. **End-of-day** ("shutdown"): when the user reports back, fill in `Done today / Slipped / Carry to tomorrow`.

## Rules

- [absolute-dates.md](../../rules/absolute-dates.md)
- [edit-in-place.md](../../rules/edit-in-place.md)
- [household-profile-first.md](../../rules/household-profile-first.md)
