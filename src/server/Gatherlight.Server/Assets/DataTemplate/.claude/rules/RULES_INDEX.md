# Rules Index

One-line-per-rule registry. **Read this first** during the per-task gate — scan the "Applies When" column and read any matching rule.

| Rule | Applies When | Enforces |
|---|---|---|
| [skills-workflow.md](skills-workflow.md) | EVERY non-trivial planning task | 5-core-skill atomic gate (`/doc-loader` + `/skill-loader` + `/tool-loader` + `/pattern-finder` + `/caveman`) before drafting. Mid-session feedback → use [/remember](../skills/remember/SKILL.md) to persist learnings to docs/skills/rules. |
| [absolute-dates.md](absolute-dates.md) | Anytime a date appears in user input or in a plan file | Convert all relative dates to `YYYY-MM-DD` before writing |
| [filename-conventions.md](filename-conventions.md) | Creating any file under `plans/` | Slug format; pairing (budget/packing) with trip slug; no `-v2`/`-final` suffixes |
| [money-format.md](money-format.md) | Writing any monetary amount | Currency code + amount; conversion in parens with `@ rate`; source currency preserved |
| [edit-in-place.md](edit-in-place.md) | User asks to update / revise / change an existing plan | Edit the existing file; never create a parallel "v2" |
| [no-fabrication.md](no-fabrication.md) | Any fact that drives a decision (hours, prices, requirements) | Cite source or mark TBD; don't guess to fill the page |
| [past-plans-first.md](past-plans-first.md) | Planning a trip, packing list, or budget for a destination/scope the user has visited before | Grep `plans/` for prior context BEFORE drafting fresh |
| [household-profile-first.md](household-profile-first.md) | Drafting any plan (trip, daily, weekly, budget, packing) | Read the relevant `household/*.md` files first |
| [no-global-memory.md](no-global-memory.md) | Recording a household fact, preference, constraint, or workflow discovery | Write to `household/*.md` / `.claude/rules/*.md` / `.claude/workflows/*.md` in this workspace — never to user-level auto-memory |
| [link-verification.md](link-verification.md) | Writing ANY URL (esp. flight/hotel search deeplinks, Kayak/Booking/Google Flights, **restaurant directory pages**) into a plan file | Verify the URL actually serves content. For JS-rendered/SPA/deeplinks → MUST use the `scrape` MCP tool; WebFetch is insufficient. Restaurant directory IDs are systematically fabricated by model recall — scrape-verify each one. Prefer verified deeplinks + scrape-timestamped prices. |
| [tool-first.md](tool-first.md) | Building reference libraries / fact lists / comparison tables (≥ 5 fact claims about external entities) | Verify entries against live sources via MCP tools + web search. Hand-curation needs a prominent ⚠️ warning + verify TODO. |
| [proactive-maintenance.md](proactive-maintenance.md) | EVERY session (task-end + event-driven) | Self-invoke `/cleanup` `/remember` `/household-update` when trigger conditions fire. Don't wait for the user to type the slash command. Safe deletes auto-execute; ASK for destructive/uncertain. |
| [verify-policy-info.md](verify-policy-info.md) | Writing visa rules, flight numbers, opening hours, prices, event dates, customs / quarantine info (time-sensitive policy facts) | Model recall fabricates / stales these silently. WebSearch + cite the official source. Categories list inside the rule. |

## How to Use

1. During the per-task gate, scan the **Applies When** column.
2. If a rule matches → read its full file. Rules override generic knowledge.
3. New rule discovered (recurring correction, multi-step pattern that bit you twice) → copy [TEMPLATE.md](TEMPLATE.md), write it, **add a row here**.

## Invariants

- One rule = one concern. No god-files.
- Every row points to a file that exists.
- Rule names describe **what is enforced**, not the incident that caused them (`absolute-dates.md`, not `fix-2026-05-relative-date-bug.md`).
