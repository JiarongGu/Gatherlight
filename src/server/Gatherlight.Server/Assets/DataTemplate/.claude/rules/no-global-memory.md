# No Global Memory

**All planner memory — household facts, preferences, constraints, recurring obligations, planning conventions — lives in this workspace. Never write planner facts to any user-level / machine-local auto-memory directory.**

## Why

This planner is shared across devices and family members through the Gatherlight server. The whole point of keeping plans + household profile in the versioned workspace is that:

1. Switching machines doesn't lose context — the workspace is the single source of truth.
2. Family members read and update the same files.
3. Git history (managed by the server) is the audit trail — who changed what, when, why.

Writing to a machine-local auto-memory directory puts facts on **one machine, in one account, invisible to the workspace**. The next session on another device sees a fresh slate. Family members can't see anything. Two devices fork silently.

Auto-memory was designed for personal work-style preferences ("user prefers terse answers"), not for the load-bearing facts of a family planner.

## How to Apply

| Fact type | Where it goes |
|---|---|
| Who is in the household, ages, dietary, allergies | `household/people.md` |
| Travel style, accommodation prefs, food prefs | `household/preferences.md` |
| Hard no's, school terms, work schedule, anniversaries | `household/constraints.md` |
| Recurring bills, weekly classes, annual obligations | `household/recurring.md` |
| One-off plan content | the relevant `plans/**/*.md` file |
| Workflow / convention discoveries | `.claude/rules/<name>.md` + add to `RULES_INDEX.md` |
| Documentation of how to do a task | `.claude/workflows/<name>.md` |

What auto-memory IS still for:
- "User prefers short responses" — pure interaction style, not planner content.
- Nothing in this workspace's domain.

When in doubt: **if a future family member opening this workspace would benefit from knowing it, it goes in the workspace.**

## Examples

✗ User: "my daughter is vegetarian." → Assistant saves to a machine-local memory file.
✓ User: "my daughter is vegetarian." → Assistant proposes saving to `household/people.md`, edits in place after confirmation.

✗ Assistant discovers: "trip plans for hot destinations should default to lighter clothing quantities." → Saves to auto-memory.
✓ Same discovery → Edits `.claude/workflows/PACKING_LIST.md` to mention it, or creates a `.claude/rules/<name>.md` if it's a hard rule.

## Related

- [household-profile-first.md](household-profile-first.md) — counterpart: always read the in-workspace memory before planning.
- [household/README.md](../../household/README.md) — what each household file holds.
