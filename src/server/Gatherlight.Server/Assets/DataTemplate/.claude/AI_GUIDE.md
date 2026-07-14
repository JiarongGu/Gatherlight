# AI_GUIDE.md — AI Navigation Hub

> **AUDIENCE: AI assistants** (Claude). Auto-loaded for AI sessions. CLAUDE.md (always-loaded rules) points here.

This is the AI-side router. The detail lives in the docs and skills it links to.

---

## The per-task gate (BLOCKING)

Before any planning work, run **all 5 core discovery skills** in one parallel batch (atomic — all five or none):

| Skill | Args | What it does |
|---|---|---|
| `/doc-loader` | `"task description"` | Routes to relevant workflow doc + household files |
| `/skill-loader` | `"task description"` | Returns INVOKE/SKIP list of planning skills |
| `/tool-loader` | `"task description"` | Returns INVOKE/SKIP list of MCP tools (`scrape`, `extract`) |
| `/pattern-finder` | `<PatternType>` | Grep commands for past plans by pattern |
| `/caveman` | (no args) | Compressed communication if user asked for brevity |

**Then**: read every doc `/doc-loader` routes to, run every search `/pattern-finder` gives, invoke every planning skill in `/skill-loader`'s INVOKE list, and note `/tool-loader`'s tool matches before any tool call. Only then start writing.

Full protocol: [`rules/skills-workflow.md`](rules/skills-workflow.md).

---

## RAG router

The keyword→doc router lives in [`KEYWORDS_INDEX.md`](KEYWORDS_INDEX.md). It's a thin top-level file pointing to per-scope sub-indices under [`keywords/`](keywords/):

| Sub-index | Use when the task is about |
|---|---|
| [keywords/planning.md](keywords/planning.md) | Creating or editing any file in `plans/` (trip, daily, weekly, budget, packing) |
| [keywords/household.md](keywords/household.md) | Updating `household/*` — people, preferences, constraints, recurring |
| [keywords/conventions.md](keywords/conventions.md) | Filename, money format, dates, citations — the "how we write things" rules |
| [keywords/automation.md](keywords/automation.md) | Browser scraping, link verification, uploaded-file extraction |

`/doc-loader` reads `KEYWORDS_INDEX.md` first, picks ONE sub-index for the task, then reads what the sub-index lists.

---

## Skills (invocable workflows)

Available under `.claude/skills/`:

### 🔍 Discovery (core gate — invoke all five at task start)
- [`/doc-loader`](skills/doc-loader/SKILL.md) — RAG routing to docs + household files
- [`/skill-loader`](skills/skill-loader/SKILL.md) — planning-skill INVOKE/SKIP list
- [`/tool-loader`](skills/tool-loader/SKILL.md) — MCP-tool INVOKE/SKIP list
- [`/pattern-finder`](skills/pattern-finder/SKILL.md) — past-plan search commands
- [`/caveman`](skills/caveman/SKILL.md) — compressed communication mode

### 📋 Planning
- [`/plan-trip`](skills/plan-trip/SKILL.md) `<destination> <dates>` — multi-day trip
- [`/plan-day`](skills/plan-day/SKILL.md) `[YYYY-MM-DD]` — single day plan
- [`/plan-week`](skills/plan-week/SKILL.md) `[YYYY-Www]` — weekly review + plan
- [`/budget-track`](skills/budget-track/SKILL.md) `<scope>` — budget planning + tracking
- [`/packing-list`](skills/packing-list/SKILL.md) `<trip-slug>` — packing list

### 🔧 Verification
- [`/scrape`](skills/scrape/SKILL.md) — render a JS/SPA page via the `scrape` MCP tool; the mandatory deeplink verifier
- `extract` MCP tool (`mcp__planner-tools__extract`) — read user-uploaded PDFs/images (no wrapper skill; call directly)

### 🚀 Setup
- [`/onboard`](skills/onboard/SKILL.md) — first-run: fill the household profile + start the first plan (self-invoke on an empty `household/`)

### 💾 Memory + maintenance
- [`/household-update`](skills/household-update/SKILL.md) — add/edit household profile facts
- [`/remember`](skills/remember/SKILL.md) — capture session learnings + route to docs/rules/household
- [`/cleanup`](skills/cleanup/SKILL.md) — periodic prune of `cache/` scratch + RAG-index drift check

---

## Rules

The single source of rule metadata is [`rules/RULES_INDEX.md`](rules/RULES_INDEX.md). Don't grep the rules directory — the index is O(1).

Critical rules every session should be aware of:

| Rule | Why it matters |
|---|---|
| [skills-workflow.md](rules/skills-workflow.md) | The 5-core-skill gate protocol (mandatory, atomic) |
| [no-global-memory.md](rules/no-global-memory.md) | All memory stays in the workspace, never user-level auto-memory |
| [household-profile-first.md](rules/household-profile-first.md) | Always read the household profile before drafting |
| [absolute-dates.md](rules/absolute-dates.md) | No relative dates in files |
| [filename-conventions.md](rules/filename-conventions.md) | Slug + naming patterns enable cross-linking |
| [verify-policy-info.md](rules/verify-policy-info.md) | Visa/flight/hours/prices are time-sensitive — model recall is unreliable; WebSearch + cite official source |
| [link-verification.md](rules/link-verification.md) | URLs (esp. restaurant directory pages, search deeplinks) must be scrape-verified — WebFetch is insufficient |
| [tool-first.md](rules/tool-first.md) | Reference libraries (≥ 5 fact claims) must be live-verified, not hand-curated |
| [proactive-maintenance.md](rules/proactive-maintenance.md) | Self-invoke `/cleanup` `/remember` `/household-update` on trigger conditions |

---

## What this workspace is

The full layout contract is [`STRUCTURE.md`](STRUCTURE.md) — where every file lives and why (read it when unsure where something goes).

A markdown-first family planner, hosted by the Gatherlight server. Plans live as files in `plans/` (trips, daily, weekly, budgets, packing). The household profile (`household/*`) is the load-bearing memory layer. Claude is the planning agent; deterministic capability comes from the server's MCP tools (`scrape`, `extract`) — **there is no code here and nothing to build**.

The server also manages:
- **git** — every agent change is reviewed by the user in the Gatherlight UI and committed by the server. The agent never runs git.
- **`state/`** — app state; never read or edit.
- **`uploads/`** — user uploads; read only via the `extract` tool.
- **`cache/`** — the only sanctioned location for agent scratch files (git-ignored, pruned by `/cleanup`).

Don't treat this like a software project — the artefacts are markdown plans + verified data that survive across sessions and devices.
