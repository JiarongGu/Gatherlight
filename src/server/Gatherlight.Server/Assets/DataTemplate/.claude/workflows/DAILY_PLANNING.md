# Daily Planning Workflow

Used by `/plan-day`. Produces a file at `plans/daily/YYYY-MM-DD.md`.

## Inputs to gather

1. **Date** — defaults to today (in session context). Explicit date overrides.
2. **Fixed commitments** — meetings, appointments, calls with times.
3. **Top priorities** — what *must* land today (1-3 items).
4. **Energy/constraints** — tired, short day, half-day off, etc.

## Steps

1. **Check if a file already exists** for the date. If yes, edit in place; surface what's already there.
2. **Check the weekly plan** — `plans/weekly/YYYY-Www.md` for the week this day falls in. Pull priorities forward.
3. **Copy the template** — [`.claude/templates/daily.md`](../templates/daily.md).
4. **Fill fixed commitments first** — anchored times come before discretionary work.
5. **Block top priorities into the calendar** — give them real time slots, not just a list. Morning for deep work unless the user says otherwise.
6. **Add a maybe/stretch section** — things to do *if* time permits, separate from must-do.
7. **End with a one-line shutdown question** — "what should tomorrow's plan inherit from today?"

## Format

The template uses a simple time-block format. Don't over-engineer — this is a daily plan, not a project plan.

## Carrying things forward

If a task wasn't done, the next day's plan should pick it up. When generating tomorrow's daily, scan today's file for unchecked items and propose them — don't silently re-create.

## What doesn't belong here

- Long-running project plans (those are weekly or their own doc).
- Trip itinerary (those are trip files; the daily file can *link* to the trip day).
- Permanent reference info (move to `.claude/workflows/` if it's truly permanent).
