# Absolute Dates

**Every date written to a plan file must be `YYYY-MM-DD`. Convert relative dates before writing.**

## Why

Plans are read months later by a different session (or a different person). "Next Friday" in a file written 2026-03-12 is unrecoverable later — you cannot tell whether it means 2026-03-13 or 2026-03-20 without remembering when the file was written. The whole workspace becomes a time-travel puzzle.

## How to Apply

- Today's date is in the session context.
- User says "next Friday" → resolve against today's date → write `2026-05-22` (or whatever).
- User says "in two weeks" → add 14 days → write the absolute date.
- User says "August" → ask which year if ambiguous (rare, but cheap to ask).
- Day-of-week labels are fine *alongside* the date for human readability: `Fri 2026-05-22`. The date must still be there.

## Examples

✓ `Day 3 — 2026-08-16 (Sat) — Kyoto`
✗ `Day 3 — Saturday — Kyoto`
✗ `Day 3 — next Sat — Kyoto`

## Related

- [filename-conventions.md](filename-conventions.md) — filenames also use absolute dates.
