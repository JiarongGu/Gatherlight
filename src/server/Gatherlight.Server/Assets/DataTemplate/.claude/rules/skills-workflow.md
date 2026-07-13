# Skills + RAG Workflow — The Per-Task Gate

**Every non-trivial planning task starts with the 5-core-skill gate. All five are atomic — invoke all five or none. "Simple ask" is not a valid skip reason.**

## Why

Without the gate, sessions:
- Skip the household profile and ask the user questions already answered (`household/people.md` knows).
- Re-discover past trip context that's already in `plans/trips/`.
- Violate filename / money / date conventions because the rules weren't read.
- Write a generic plan instead of one shaped by the household.

The gate costs ~5-15 KB of routing + reading per task. The cost of a non-conforming plan (the user re-doing it, or worse, acting on a wrong fact) is 10x larger.

## The Gate

Invoke these **5 core skills via `Skill()` in one parallel batch** — before any Read/Grep/Glob/Agent calls:

| Core Skill | Args | Purpose |
|---|---|---|
| `/doc-loader` | `"task description"` | RAG: reads `KEYWORDS_INDEX.md`, picks sub-index, lists docs to read |
| `/skill-loader` | `"task description"` | Returns INVOKE/SKIP list of planning skills |
| `/tool-loader` | `"task description"` | Returns INVOKE/SKIP list of MCP tools (`scrape`, `extract`) |
| `/pattern-finder` | `<PatternType>` | Grep commands for past plans / household entries |
| `/caveman` | (no args) | Compressed mode if user requested brevity |

### Step 1b — Invoke matched planning skills

After `/skill-loader` returns its INVOKE list, call each listed skill via `Skill()` before drafting.

### Step 2 — Read every doc `/doc-loader` routed to

This is **blocking**. After reading, write one summary line per doc so it's visible the reading happened:
> Read `workflows/TRIP_PLANNING.md` (inputs, day-by-day, TBDs), `workflows/STORAGE.md` (slug rules), `household/people.md` (daughter is vegetarian).

If you didn't read every routed doc, STOP and read them now.

### Step 3 — Run every command `/pattern-finder` gave

These surface prior plans and household entries. Loop in any relevant nuggets *before* drafting fresh content.

### Step 4 — NOW draft, edit, or web-search

Only after steps 1-3 are complete may you write the plan, run a web search for time-sensitive facts, or invoke `Write`/`Edit`.

## When to SKIP the gate

- Pure conversation (questions, explanations, no plan changes).
- **Direct continuation** of the SAME task on the SAME file (e.g. "add day 4 to the trip I just planned"). Same scope = skip OK.
- Trivial fix to a typo or formatting nit.

**"Simple ask" and "I just ran the gate two messages ago" are NOT valid skip reasons when the scope changes.**

## When to RE-INVOKE mid-session

If the user's follow-up changes scope, **re-run all 5 core skills** — not a subset:

- "now plan the Iceland trip too" → different destination, re-invoke.
- "let's start a budget for it" → different artefact type, re-invoke.
- "actually record that my partner has a nut allergy" → different scope (household), re-invoke.

## Common failure modes

1. **Calls `/doc-loader` but doesn't read the docs it routed to** — Step 2 is the whole point.
2. **Reads workflow doc, skips household file** — household profile is part of every planning sub-index for a reason.
3. **Mentions a skill in text without `Skill()`-calling it** — invocation means the tool call.
4. **Skips `/pattern-finder` because "it's a fresh trip"** — past-plan precedent applies to "fresh" trips too.
5. **Invokes 1-4 of the 5 core skills** — atomic. All five or none.
6. **Ignores `RULES_INDEX.md`** — rules override generic knowledge.

## Related

- [.claude/AI_GUIDE.md](../AI_GUIDE.md) — navigation hub that points back to this rule.
- [.claude/KEYWORDS_INDEX.md](../KEYWORDS_INDEX.md) — the RAG top-level router.
- [no-global-memory.md](no-global-memory.md) — memory lives in the workspace, which is why the RAG layer matters.
