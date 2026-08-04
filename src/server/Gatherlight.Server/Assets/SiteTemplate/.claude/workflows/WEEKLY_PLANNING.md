# Weekly Planning Workflow

Used by `/plan-week`. Produces a file at `plans/weekly/YYYY-Www.md`.

## Two modes

| Mode | When | Output |
|---|---|---|
| **Review** | End of week (Fri/Sat/Sun) | Look back at the week that ended: what shipped, what slipped, what to learn. |
| **Plan** | Start of week (Sun/Mon) | Set priorities for the upcoming week. |

The user usually wants both in one session: review the just-ended week, then plan the new one.

## Inputs

1. **Which ISO week** — defaults to "the current week". `YYYY-Www`.
2. **For review**: scan the matching daily files (`plans/daily/YYYY-MM-DD.md` for the 7 days of that week). What was planned vs done.
3. **For plan**: top 3-5 priorities, fixed commitments, deadlines landing in the week.

## Steps

### Review
1. Read each daily file in the week.
2. Summarise: completed, slipped, surprises.
3. Capture lessons — anything worth remembering for future weeks.

### Plan
1. Copy [`.claude/templates/weekly.md`](../templates/weekly.md).
2. Fill in the top priorities (max 5 — anything more is noise).
3. List fixed commitments by day.
4. Note any deadlines or anchored dates.
5. Leave space for daily files — the daily skill will fill them in.

## Don't

- Pre-fill daily plans for the whole week. Each day's plan is best made on or just before the day.
- Carry over "should-do" items more than twice. If something keeps slipping, decide explicitly: do it, defer with a date, or drop it.
