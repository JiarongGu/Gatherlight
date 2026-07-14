---
name: onboard
description: First-run setup for a new data folder — walks a new household through filling household/* (members, preferences, constraints) and starting their first plan. Invoke when the household profile is empty or the user asks to "get started" / "set up".
---

# Onboard

**Format**: `/onboard` — or self-invoke on a fresh data folder (empty `household/`) at the start of the first real planning ask.

## When to invoke

- The `household/*` files are empty/missing AND the user is starting to plan something.
- The user explicitly asks to "get started", "set up", "onboard", or "how does this work".
- **First-run only** — do NOT re-run once the household profile has real content (use `/household-update` for later additions).

## Goal

Turn a blank workspace into a usable one: a filled-*enough* household profile + the user's first plan started — captured **conversationally**, never as a wall of forms. Thin is fine; it fills in over time.

## The flow

Keep it light — 2–4 questions at a time, not an interrogation. Capture as you go via `/household-update`.

1. **Orient (1 line).** "I keep your family's plans + profile as files here — ask me to plan a trip, a day, a week, or a budget. First, a few basics so plans fit your family. Skip anything."

2. **People** → `household/people.md`. Who's in the household — ages/bands, dietary needs, mobility, interests. Enough to shape a plan, not a census.

3. **Preferences** → `household/preferences.md`. Pace (packed vs relaxed), lodging style, transport (trains vs flying vs driving), food adventurousness, budget tier.

4. **Constraints** → `household/constraints.md`. Hard limits: school terms, work blackouts, anniversaries, "never in October", accessibility must-haves.

5. **(Optional) Recurring** → `household/recurring.md`. Weekly classes / monthly bills / annual obligations — only if volunteered; don't dig.

6. **First plan.** "What's first — a trip, a day, a week, or a budget?" Hand off to the matching skill (`/plan-trip`, `/plan-day`, `/plan-week`, `/budget-track`), which runs the normal per-task gate.

## Rules of engagement

- **Confirm before writing** each household file (per `/household-update`) — show the line + section.
- **No secrets.** Never record passport/card/account numbers or full addresses — decline politely and keep them in conversation only.
- **Skippable.** Any question can be skipped; a thin profile is fine.
- **Absolute dates.** Convert anything relative before writing ([absolute-dates.md](../../rules/absolute-dates.md)).
- **One pass.** Don't loop back to re-onboard.

## Done when

- At least `people.md` + one of `preferences.md`/`constraints.md` have real content, AND
- The user's first plan is started (handed to the right planning skill).

Print a short recap: *"Recorded: 3 people, travel prefs, a school-term constraint. Starting your Kyoto trip now."*

## Related

- [/household-update](../household-update/SKILL.md) — the capture mechanism used throughout.
- [household-profile-first.md](../../rules/household-profile-first.md) — why the profile matters.
- [STRUCTURE.md](../../STRUCTURE.md) — the layout being set up.
