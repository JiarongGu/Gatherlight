# Keywords — Planning

Used by `/doc-loader` when the task is about any `plans/` file.

## Routing table

| Task | Read |
|---|---|
| Plan / edit a trip | [workflows/TRIP_PLANNING.md](../workflows/TRIP_PLANNING.md), [workflows/STORAGE.md](../workflows/STORAGE.md), [workflows/WEB_SEARCH.md](../workflows/WEB_SEARCH.md), [templates/trip.md](../templates/trip.md) |
| Plan / edit a day | [workflows/DAILY_PLANNING.md](../workflows/DAILY_PLANNING.md), [workflows/STORAGE.md](../workflows/STORAGE.md), [templates/daily.md](../templates/daily.md) |
| Plan / review a week | [workflows/WEEKLY_PLANNING.md](../workflows/WEEKLY_PLANNING.md), [workflows/STORAGE.md](../workflows/STORAGE.md), [templates/weekly.md](../templates/weekly.md) |
| Budget (plan or track) | [workflows/BUDGET_TRACKING.md](../workflows/BUDGET_TRACKING.md), [templates/budget.md](../templates/budget.md) |
| Packing list | [workflows/PACKING_LIST.md](../workflows/PACKING_LIST.md), [workflows/WEB_SEARCH.md](../workflows/WEB_SEARCH.md), [templates/packing.md](../templates/packing.md) |

## Household files to also read

Every planning task should pull from the household profile:

| Task | Household files |
|---|---|
| Trip | `people.md`, `preferences.md`, `constraints.md` |
| Daily | `constraints.md`, `recurring.md` |
| Weekly | `constraints.md`, `recurring.md`, `preferences.md` |
| Budget | `preferences.md` |
| Packing | `people.md`, `preferences.md` |

(Household files that don't exist yet are skipped silently — they're built up over time.)

## Rules to scan (every planning task)

| Rule | Why |
|---|---|
| [absolute-dates.md](../rules/absolute-dates.md) | No relative dates in files |
| [filename-conventions.md](../rules/filename-conventions.md) | Slug + pairing rules |
| [edit-in-place.md](../rules/edit-in-place.md) | Never `-v2` |
| [no-fabrication.md](../rules/no-fabrication.md) | Cite or TBD |
| [past-plans-first.md](../rules/past-plans-first.md) | Grep before drafting |
| [household-profile-first.md](../rules/household-profile-first.md) | Read household profile |
| [money-format.md](../rules/money-format.md) | If money is involved |
| [link-verification.md](../rules/link-verification.md) | URLs (restaurants / flights / hotels) must be scrape-verified |
| [verify-policy-info.md](../rules/verify-policy-info.md) | Visa / flight number / hours / prices: model recall stale → WebSearch + cite official |
| [tool-first.md](../rules/tool-first.md) | Reference libraries (≥ 5 fact claims) live-verified, not hand-curated |

## Past-plan search

Before drafting any new plan, grep the relevant `plans/` subdirectory for prior context. Concrete commands live in [`/pattern-finder`](../skills/pattern-finder/SKILL.md).

## Destination reference libraries

If the user builds a destination library over time (e.g. `.claude/workflows/<DESTINATION>_ATTRACTIONS.md`), read it FIRST when planning a trip there — and honour its verification status per [tool-first.md](../rules/tool-first.md) (hand-curated libraries carry a ⚠️ warning until verified).
