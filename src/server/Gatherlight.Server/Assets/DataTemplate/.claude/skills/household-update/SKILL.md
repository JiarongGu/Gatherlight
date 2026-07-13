---
name: household-update
description: Add or update a stable fact in household/* — people, preferences, constraints, or recurring obligations. Use whenever the user reveals something durable that future planning sessions should know.
---

# Household Update

**Format**: `/household-update` — then describe the fact in natural language, or invoke whenever the user says something durable.

## When to invoke

The user reveals a fact that:
- **Is stable** (won't change in the next month or two).
- **Will matter again** for future planning.
- **Isn't already in the household profile.**

Examples:
- "My daughter is vegetarian." → `people.md`.
- "We prefer trains over flying within Europe." → `preferences.md`.
- "I don't travel mid-October — that's our anniversary." → `constraints.md`.
- "Internet bill is the 5th of every month." → `recurring.md`.

## When NOT to invoke

- One-off task notes ("I need to make a call today") — those go in the daily plan.
- Time-sensitive things ("we're flying out Friday") — those are trip state, not profile.
- Secrets — passport numbers, card numbers, addresses. Politely refuse: "I won't write that to the workspace; can keep it in conversation only."

## Action

1. **Confirm before writing**: "Want me to record under `household/people.md`?" Don't auto-save sensitive-feeling facts.
2. **Pick the right file**:
   | Fact type | File |
   |---|---|
   | About a person (member, age band, dietary, mobility, interests) | `people.md` |
   | Stable preference (style, defaults, what we like/dislike) | `preferences.md` |
   | Rules-out / hard limits / school terms / anniversaries | `constraints.md` |
   | Recurring schedule items / monthly fixed obligations | `recurring.md` |
   | Income structure (type / cadence / band, **no sensitive numbers**) | `income.md` |
   | Fixed expenses / annual big-ticket / financial dates (**no account numbers**) | `expenses.md` |
3. **Create the file if it doesn't exist yet** — household files are built up over time, not pre-created.
4. **Edit in place** — append to the right section, don't create a parallel file.
5. **Print a one-line confirmation** of what was added and where.

## Rules

- [edit-in-place.md](../../rules/edit-in-place.md)
- No secrets — passports, cards, full addresses.

## Related

- [household-profile-first.md](../../rules/household-profile-first.md) — counterpart: reading the profile.
