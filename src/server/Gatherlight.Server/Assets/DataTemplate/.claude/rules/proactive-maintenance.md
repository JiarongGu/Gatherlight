# Proactive Maintenance (Self-Invoke Maintenance Skills)

**Maintenance skills (`/cleanup`, `/remember`, `/household-update`) should be self-invoked by the agent when their trigger conditions are met — not wait for the user to type the slash command. The user shouldn't have to remember to clean up after Claude.**

## Why

Maintenance skills exist to keep the knowledge base healthy. If Claude only runs them when explicitly asked:
- Stale scratch files pile up under `cache/`
- Hand-curated libraries stay un-verified (see [tool-first.md](tool-first.md))
- Mid-session feedback drifts away because `/remember` wasn't invoked
- Household facts go uncaptured because `/household-update` wasn't invoked

These are all costs the user shouldn't pay. The agent has full visibility into when triggers fire — it should act.

This rule generalizes the [skills-workflow.md](skills-workflow.md) gate (which is *task-start* discovery) to *task-end* and *event-driven* maintenance.

## How to Apply

### Trigger table — when to self-invoke

| Skill | Trigger condition | Action |
|---|---|---|
| [/cleanup](../skills/cleanup/SKILL.md) `cache` | End of session OR ≥ 10 new `cache/` scratch files were created this session | Run audit, propose deletions, execute on safest categories (clearly SUPERSEDED versions) without confirmation; ASK before deleting investigation files (user may want to reconsider rejected options) |
| [/cleanup](../skills/cleanup/SKILL.md) `keywords` | After adding ≥ 2 new files to `.claude/rules/` or `.claude/skills/` or `.claude/workflows/` | Validate sub-indices route to the new files; propose adding orphan rules/skills to the relevant `keywords/<scope>.md` |
| [/remember](../skills/remember/SKILL.md) | User gives feedback that contradicts a default, reveals a stable preference, or surfaces a recurring pattern (≥ 1 such moment per session) | Self-classify the fact and route it to the right destination (household / rules / workflows); **do not wait** for the user to say "remember this" |
| [/household-update](../skills/household-update/SKILL.md) | User reveals a stable fact about a household member (dietary / mobility / preference / constraint) | Propose the update; edit `household/*.md` on confirmation |
| [/pattern-finder](../skills/pattern-finder/SKILL.md) | Already gated at task start — but **also re-run mid-session** if scope changes to a new destination / trip / household member | Run the relevant Glob/Grep commands |
| Library verification (per [tool-first.md](tool-first.md)) | After creating or significantly editing a hand-curated reference library (≥ 5 fact claims about external entities) | Propose a verification pass (scrape + web search per entry); keep the ⚠️ warning until verified |

### Self-invocation protocol

When a trigger fires:

1. **Detect**: notice the condition is met.
2. **Announce**: one short line stating what's about to happen.
   - `🧹 /cleanup cache: 14 new scratch files this session — auditing`
   - `📝 /remember: user preference revealed — proposing capture`
3. **Execute**: run the skill's safe portion (KEEP/DELETE categorization, fact classification).
4. **Confirm only for destructive or uncertain**: clearly superseded scratch files can go without asking; deletes that lose investigation data should be confirmed; edits to `household/*.md` should be confirmed.
5. **Report**: short result line ("deleted 12 superseded files, 6 remain — 4 KEEP + 2 recent").

### When NOT to self-invoke

- User explicitly turned off proactive maintenance for the session.
- Mid-task in a flow where the maintenance would disrupt focus — defer to end-of-task.
- Less than 5 minutes since the previous self-invoke of the same skill (avoid loops).

### Confirmation thresholds

| Action | Threshold |
|---|---|
| Delete clearly SUPERSEDED cache files (a newer version exists + zero references from plans) | No confirmation needed |
| Delete cache files for options the user explicitly rejected | No confirmation needed |
| Delete cache files for backup options the user wanted retained | ASK |
| Edit `household/*.md` to record a new fact | ASK (show proposed line + section) |
| Run a verification pass over a hand-curated library | ASK (costs scrape/search time) |
| Create a new rule / skill / workflow file | ASK (these are durable additions) |

## Examples

✗ Session creates 14 scratch files under `cache/` exploring options. Session ends. Files accumulate.
✓ At session end, agent says "🧹 14 cache files created — running cleanup" → categorizes → removes the unambiguously stale ones → reports.

✗ User says "actually we don't like split-group days" — agent acknowledges but doesn't record. Next trip session re-asks the question.
✓ Agent says "📝 Recording 'no split-group days' → `household/preferences.md`?" → user confirms → fact captured.

## Related

- [skills-workflow.md](skills-workflow.md) — task-start 5-skill gate (this rule is the task-end/event-driven counterpart)
- [tool-first.md](tool-first.md) — the library-verification trigger
- [no-fabrication.md](no-fabrication.md) — why library verification exists
- Each maintenance skill's SKILL.md — has its own "Trigger conditions" section that should mirror the table above

## Maintenance skill checklist

Every maintenance skill should:
- [ ] List explicit trigger conditions in `SKILL.md` (not just "use when asked")
- [ ] Categorize actions into safe-auto vs confirm-first
- [ ] Be discoverable via [`/skill-loader`](../skills/skill-loader/SKILL.md) AND via this rule's trigger table
- [ ] Output a short report (1-2 lines) after running so the user sees what changed without scrolling
