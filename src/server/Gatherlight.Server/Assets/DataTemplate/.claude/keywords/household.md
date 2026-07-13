# Keywords — Household

Used by `/doc-loader` when the task is updating or reading the household profile.

## Routing table

| Task | Read |
|---|---|
| Add / update a person | `household/people.md` (create if missing) |
| Add / update a preference (style, food, accommodation) | `household/preferences.md` (create if missing) |
| Add / update a constraint (school, work, hard no's, anniversaries) | `household/constraints.md` (create if missing) |
| Add / update a recurring obligation (bills, weekly classes) | `household/recurring.md` (create if missing) |
| Anything household — full context | [household/README.md](../../household/README.md) (index) |

## When household is read (not updated)

The household profile is read at the start of every planning task. See [keywords/planning.md](planning.md) for the per-task subset.

## Rules to scan

| Rule | Why |
|---|---|
| [no-global-memory.md](../rules/no-global-memory.md) | Household facts live in the workspace, not auto-memory |
| [edit-in-place.md](../rules/edit-in-place.md) | Update existing entries; don't create parallel files |
| [verify-policy-info.md](../rules/verify-policy-info.md) | When recording traveler passport/visa info: passport validity rules + visa requirements go stale yearly → verify via the destination's official source before writing |

## What does NOT go here

- One-off task notes — daily/weekly plan files instead.
- Time-sensitive things ("flight is Friday") — trip/daily file instead.
- Secrets — passports, card numbers, full addresses. Politely refuse.
