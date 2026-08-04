---
name: remember
description: Capture a session-time learning / observation / convention and route it to the right durable storage. Use whenever the user gives feedback, makes a correction, or reveals something Claude should remember beyond the current task — broader than /household-update which only covers household facts.
---

# Remember

**Format**: `/remember <observation>` — or invoke whenever the user says something Claude should retain.

## Why this skill exists

The 5-skill gate captures docs / tools / skills / patterns at task **start**. But mid-conversation feedback often deserves to persist:
- "actually we both hate hiking" — preference drift
- "on every check-out day, forward the luggage to the next hotel" — workflow rule
- "always book the refundable fare" — preference
- "the senior discount worked at more venues than the guide said" — domain fact

If these aren't recorded, the next session re-learns them. `/remember` is the bridge.

## Trigger phrases

Invoke when the user says (or after they say) anything like:
- "actually we..." / "I should mention..."
- "next time remember..."
- "that should be a rule"
- "you didn't know this, but..."
- Any correction that contradicts what Claude just did or said
- Strong preference / aversion newly revealed

## Action — routing decision

1. **Classify the fact**:
   | Type | Examples | Destination |
   |---|---|---|
   | About a household member (preference / dietary / mobility / interest) | "partner dislikes split-group days" | `household/people.md` or `preferences.md` → **delegate to [/household-update](../household-update/SKILL.md)** |
   | Household-wide preference / default | "we always book refundable" | `household/preferences.md` → delegate to `/household-update` |
   | Hard rule that should override generic knowledge | "never quote a price without a date-stamp" | `.claude/rules/<name>.md` (new rule) + row in `RULES_INDEX.md` |
   | Convention for a planning workflow | "trip planning must treat overnight flights as zero destination nights" | `.claude/workflows/<DOC>.md` (existing) + mirror in the matching skill |
   | Tool / verification learning | "booking sites show the double-room price by default" | `.claude/workflows/BROWSER_AUTOMATION.md` or the matching workflow |
   | Destination knowledge worth keeping | "senior discounts often require local ID" | `.claude/workflows/TRIP_PLANNING.md` (regional notes) |
   | A tool gap in the Gatherlight registry | "we needed a batch hotel-price tool today" | note it in the relevant workflow's TBD section — future releases read these |
   | Session-local context only (not stable) | "today I'm tired" | **don't save** — it's transient |

2. **Confirm the destination** with the user before writing — show file + section + 1-line proposal.

3. **Write the addition**:
   - Append to the right section (don't restructure existing content)
   - Date-stamp the addition: `(2026-05 captured via /remember)` so future readers know when it was learned
   - Keep it short (1-2 sentences); the source of truth is the user's words paraphrased

4. **Cross-link** if relevant:
   - If a rule, add a row to [RULES_INDEX.md](../../rules/RULES_INDEX.md)
   - If a workflow update, also surface in the matching skill (plan-trip, budget-track, etc.)

5. **Output confirmation**:
   ```
   ✅ Recorded under household/preferences.md → "Avoid" section:
   > "No split-group days — the family prefers doing activities together."
   Future sessions will pick this up via /doc-loader + /household-update.
   ```

## When NOT to invoke

- One-off task input ("I want to go to Tokyo next month") — that's not durable, it's the task
- Secrets (passport / card numbers / addresses) — refuse politely
- Things that change frequently (mood / today's weather / current location) — transient

## Relationship to other skills

- [/household-update](../household-update/SKILL.md) — narrower scope (household/* files only). `/remember` delegates to it for household facts; `/remember` handles everything else.
- [/skill-loader](../skill-loader/SKILL.md) — `/remember` is a **discovery** skill (used reactively); not a planning skill.
- [Skill workflow rule](../../rules/skills-workflow.md) — `/remember` can be invoked OUTSIDE the 5-skill gate, mid-session, on feedback.

## Pattern: end-of-session sweep

Before ending the session (the user will review and approve the diff in the Gatherlight UI), run a mental check:
> "Anything the user told me this session that future sessions wouldn't know?"

If yes, /remember each item so it's part of the reviewed change. This is the discipline that keeps memory durable across sessions.

## Rules

- [edit-in-place.md](../../rules/edit-in-place.md) — append, don't fork files
- [no-global-memory.md](../../rules/no-global-memory.md) — write to the workspace, never to user-level auto-memory
