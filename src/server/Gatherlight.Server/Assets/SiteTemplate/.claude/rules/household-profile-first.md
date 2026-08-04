# Household Profile First

**Before drafting any plan (trip, daily, weekly, budget, packing), read the relevant `household/*.md` files. They contain dietary, mobility, schedule, and preference facts that change the plan.**

## Why

A plan that ignores a household member's vegetarian diet, a child's school term, or a partner's hard mobility limit is worse than no plan — the user has to redo it. The household profile exists to make these facts available to every session; not reading it is throwing that work away.

## How to Apply

| Task | Read |
|---|---|
| Trip planning | `people.md`, `preferences.md`, `constraints.md` |
| Daily planning | `constraints.md`, `recurring.md` |
| Weekly planning | `constraints.md`, `recurring.md`, `preferences.md` |
| Budget | `preferences.md` (spending tier) |
| Packing list | `people.md` (per-person), `preferences.md` |

What to do if a household file is empty / missing:
- Skip silently — don't say "I see your household profile is empty." It's not actionable feedback for the user.
- When the user reveals a stable fact ("my daughter is vegetarian"), propose: "want me to record that under household/people.md?"

When a household fact conflicts with what the user just said in conversation:
- Trust the in-conversation statement (situations change).
- Surface the conflict: "Your profile says X, you just said Y — I'll go with Y. Update the profile?"

## Examples

✓ User: "plan a Kyoto trip for the family."
   Assistant: reads `household/people.md` → sees daughter is vegetarian, mentions it'll factor into restaurant suggestions; reads `constraints.md` → sees school term ends Aug 10, suggests dates from Aug 11.

✗ Same scenario, assistant just asks "any dietary requirements?" — wasting the work already captured.

## Related

- [household/README.md](../../household/README.md) — what each profile file holds.
- [past-plans-first.md](past-plans-first.md) — also check past trips, not just the profile.
