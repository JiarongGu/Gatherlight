---
name: doc-loader
description: RAG router. Reads .claude/KEYWORDS_INDEX.md, picks the right sub-index for the task, and lists the exact docs + household files + rules to load. Core discovery skill — invoke as part of the 5-skill gate at every task start.
---

# Doc Loader

**Format**: `/doc-loader "task description"`

## Action

1. **Read [`.claude/KEYWORDS_INDEX.md`](../../KEYWORDS_INDEX.md)** — top-level router. Pick exactly **one** sub-index for the task (only load multiple if the task genuinely spans scopes).
2. **Read the chosen sub-index** under [`.claude/keywords/`](../../keywords/). It enumerates:
   - Workflow doc(s)
   - Template(s)
   - Household profile file(s) to read
   - Rules to scan
3. **Read every listed doc.** This is non-negotiable — the sub-index is small specifically so the actual reading is cheap.
4. **Scan [`.claude/rules/RULES_INDEX.md`](../../rules/RULES_INDEX.md)** for matching rule rows; read full text for any that apply.
5. **Print a one-line confirmation** so the gate is visible: *"Loaded {sub-index}: {N docs}, {M rules}. Ready to plan."*

## Sub-index map (mirror of KEYWORDS_INDEX.md)

| Task keyword | Sub-index |
|---|---|
| trip / daily / weekly / budget / packing | [`keywords/planning.md`](../../keywords/planning.md) |
| family / people / preference / constraint / recurring | [`keywords/household.md`](../../keywords/household.md) |
| filename / date format / money / citation / slug | [`keywords/conventions.md`](../../keywords/conventions.md) |
| scrape / link verify / uploaded file / browser automation | [`keywords/automation.md`](../../keywords/automation.md) |

If a task spans scopes (e.g. "plan a trip AND record that my daughter is vegetarian"), load both relevant sub-indices.

## What this skill does NOT do

- It does not invoke planning skills — that's [`/skill-loader`](../skill-loader/SKILL.md).
- It does not grep past plans — that's [`/pattern-finder`](../pattern-finder/SKILL.md).
- It does not write anything to plans — that's the planning skills.

## Why this design

Without the router, every task would load the whole knowledge base (~30+ KB of workflow + template + household text). With it, a typical task loads `KEYWORDS_INDEX.md` (~1 KB) + one sub-index (~2-3 KB) + the workflow it routes to (~3-5 KB) = ~7-10 KB total. The RAG layer's value is in routing, not in storing.
