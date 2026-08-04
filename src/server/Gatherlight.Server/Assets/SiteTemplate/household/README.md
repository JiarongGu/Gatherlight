# Household Profile

Long-lived facts about the user, their family, and recurring constraints. **Always check this directory at the start of a planning task** — it's the difference between a plan that fits the household and a generic one.

This is *workspace memory*: versioned by the Gatherlight server, shared across sessions and devices. It is the load-bearing memory layer of the planner.

## What lives here

The profile files are **not pre-created** — build each one the first time the user reveals a relevant fact.

| File | Holds | Example content (fictional) |
|---|---|---|
| `people.md` | Family members: name/nickname, age band, dietary, mobility, allergies, interests | "Alex — vegetarian, loves museums"; "Grandpa — avoids stairs, prefers slow pace" |
| `preferences.md` | Travel style, pace, accommodation type, food likes/dislikes, defaults | "Prefer trains over short flights"; "Always book refundable" |
| `constraints.md` | Work schedule, school terms, anniversaries, religious dates, hard no's | "School term ends 2026-07-03"; "No travel mid-October (anniversary)" |
| `recurring.md` | Recurring obligations: bills, subscriptions, weekly classes, annual events | "Piano lesson every Tue 17:00"; "Internet bill on the 5th" |
| `income.md` | Income structure — type, cadence, rough bands. **NO sensitive numbers** | "Two salaries, monthly; occasional freelance" |
| `expenses.md` | Fixed costs, annual big-ticket items, financial dates. **NO account numbers** | "Rent monthly"; "Car insurance renews in March" |

Start with `people.md` and `preferences.md` — they change plans the most.

## When to read

- **Trip planning** → `people.md`, `preferences.md`, `constraints.md` (pace, allergies, mobility, term dates).
- **Daily / weekly planning** → `constraints.md`, `recurring.md`.
- **Packing list** → `people.md` (per-person items), `preferences.md`.
- **Budget** → `preferences.md` (spending tier).

If a file doesn't exist yet, skip silently — don't tell the user their profile is empty.

## When to update

When the user mentions a stable fact about a person / preference / constraint that will matter again, propose adding it. Don't auto-add private-feeling facts without confirming first.

Example: user says "my daughter is vegetarian." → Ask: "Want me to record that under household/people.md so future trip plans factor it in?"

## What this is NOT

- Not a place for one-off task notes — those live in the daily/weekly plan.
- Not a place for time-sensitive things ("we're booking flights this weekend") — those are plan state, not household profile.
- Not a place for secrets — passport numbers, card numbers, full addresses. Keep those out of the workspace entirely.
