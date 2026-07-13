---
name: packing-list
description: Generate a packing list for a trip. Creates plans/packing/<slug>.md from the packing template, factoring in trip type, duration, weather, household members, and past-trip lessons.
---

# Packing List

**Format**: `/packing-list <trip-slug>` — slug should match an existing trip file. Falls back to asking for destination/dates if no trip file exists yet.

## Action

1. Run `/doc-loader packing` — loads [PACKING_LIST.md](../../workflows/PACKING_LIST.md), household `people.md` + `preferences.md`, rules.
2. **Resolve slug** to filename: `plans/packing/<slug>.md`.
3. **Read paired trip file** `plans/trips/<slug>.md` — pull dates, destination(s), trip type, daily activities.
4. **Grep `plans/packing/`** for past lists for similar trip types — surface "Lessons" notes (regrets, gaps).
5. **Web-search weather** for the destination & dates:
   - Within 7 days → forecast.
   - Further out → climate averages with caveat.
   - Cite source inline.
6. **Copy template** `.claude/templates/packing.md` → `plans/packing/<slug>.md`.
7. **Fill in per-person items** — for each household member from `people.md`, add prescription meds, allergy-relevant items, hobby gear.
8. **Quantify clothing** by trip duration and laundry access.
9. **Surface weather-driven items prominently** (rain shell, thermals, sun hat).
10. **Document checklist** — passport validity, visa, insurance, vaccination, driver's licence — verify against trip context.
11. **Add "Leaving home" section** if it's a longer trip — pet care, mail, plants.

## After the trip

Encourage the user to update the **Lessons** section at the bottom — what to bring next time, what to leave. This is what makes the *next* packing list good.

## Rules

- [past-plans-first.md](../../rules/past-plans-first.md)
- [household-profile-first.md](../../rules/household-profile-first.md)
- [filename-conventions.md](../../rules/filename-conventions.md)
