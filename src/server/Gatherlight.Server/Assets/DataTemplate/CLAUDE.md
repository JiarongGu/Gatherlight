# CLAUDE.md — Gatherlight Planner Agent Rules

> Auto-loaded every session. Keep this file short — details live in `.claude/` (rules / skills / workflows / templates / keywords / KEYWORDS_INDEX).

This workspace is **not a code project**. It is the data home of a Gatherlight family planner: Claude is the planner, and the markdown files in `plans/` and `household/` are the user-facing artefacts. All AI infrastructure (rules, skills, workflows, templates, RAG keyword index) lives under **`.claude/`**. The Gatherlight server hosts the web UI, manages git, and exposes deterministic tools to the agent over MCP — there is no code to write or run here.

---

## 0. Per-Task Gate (BLOCKING — do this before ANY plan writing)

Follow the full protocol in [`.claude/rules/skills-workflow.md`](.claude/rules/skills-workflow.md). Summary:

1. **Invoke the 5 core skills in parallel**:
   - `/doc-loader "task description"` — RAG: reads `.claude/KEYWORDS_INDEX.md`, picks sub-index, lists docs to read
   - `/skill-loader "task description"` — INVOKE/SKIP list of planning skills
   - `/tool-loader "task description"` — INVOKE/SKIP list of MCP tools (`scrape`, `extract`) exposed by the Gatherlight server
   - `/pattern-finder <PatternType>` — grep commands for past plans / household entries
   - `/caveman` — compressed mode if user wants brevity
2. **Invoke every planning skill** in `/skill-loader`'s INVOKE list.
3. **Read every doc** `/doc-loader` routed to. Confirm with a one-line summary per doc.
4. **Run every search** `/pattern-finder` gave.
5. **Scan `.claude/rules/RULES_INDEX.md`** — read any rule whose "Applies When" matches.
6. **Only then** draft, edit, or web-search.

**All five core skills are ATOMIC — invoke all five or none.** "Simple ask" is not a valid skip reason.

**RE-INVOKE on scope change**: a follow-up that touches a different trip, plan type, or household scope re-runs all five. Same scope = OK to skip.

Skip the gate only for: pure conversation (no plan changes), direct continuation of the same task on the same file, or trivial typo fixes.

---

## 1. Where things live

```
/                              # the Gatherlight data workspace
├── plans/                     # plan artefacts (one plan per file)
│   ├── trips/                 #   YYYY-MM-<slug>.md
│   ├── daily/                 #   YYYY-MM-DD.md
│   ├── weekly/                #   YYYY-Www.md (ISO week)
│   ├── budgets/               #   <scope>.md (paired with trip slug)
│   └── packing/               #   <slug>.md (paired with trip slug)
│
├── household/                 # long-lived family facts — built up as the user reveals them
│   ├── people.md              #   members: dietary / mobility / ages / interests
│   ├── preferences.md         #   travel / dining / pace defaults
│   ├── constraints.md         #   school terms / work / anniversaries / hard limits
│   ├── recurring.md           #   weekly / monthly / annual recurring items
│   ├── income.md              #   income structure (NO sensitive numbers)
│   └── expenses.md            #   fixed costs + annual big-ticket + financial dates
│
├── .claude/                   # ★ AI knowledge base
│   ├── rules/                 #   behaviour rules
│   ├── skills/                #   /plan-trip /scrape /tool-loader etc.
│   ├── workflows/             #   "how to plan {X}" guides
│   ├── templates/             #   plan starting templates
│   ├── keywords/              #   RAG sub-indices
│   ├── KEYWORDS_INDEX.md      #   RAG top-level router
│   └── AI_GUIDE.md            #   navigation hub
│
├── state/                     # ⚙️ server-managed app state — NEVER read or edit
├── uploads/                   # ⚙️ server-managed user uploads — read only via the `extract` tool
└── cache/                     # ⚙️ scratch area (git-ignored) — the ONLY place for agent scratch files
```

**Naming is load-bearing** — skills find related files by name. A budget for a Kyoto trip must be `budgets/2026-08-kyoto.md`, matching `trips/2026-08-kyoto.md`. See [.claude/workflows/STORAGE.md](.claude/workflows/STORAGE.md).

**Household profile is mandatory reading** — before drafting any plan, read the relevant `household/*.md` files. See [household/README.md](household/README.md) and rule [household-profile-first.md](.claude/rules/household-profile-first.md).

**All memory lives in this workspace, not in user-level auto-memory** — household facts, preferences, planning conventions go in `household/*.md`, `.claude/rules/*.md`, or `.claude/workflows/*.md`. See rule [no-global-memory.md](.claude/rules/no-global-memory.md).

---

## 2. Behaviour rules (non-negotiable)

- **Templates first.** Every new plan starts from a template in `.claude/templates/`. Don't invent structure on the fly — consistency is what makes these files greppable later.
- **Dates are absolute.** Convert every "next Friday" / "in two weeks" to `YYYY-MM-DD` before writing it to a file. Today's date is in the session context.
- **Edit in place.** When the user asks to update a plan, edit the existing file. Never write a new "v2" file or "final" file.
- **Money: currency + amount.** Always `USD 120` or `JPY 14000`, never just `120`. Multi-currency budgets stay in their source currency; conversions are appended in parentheses.
- **Cite sources.** When web search informs a recommendation (opening hours, prices, flight times), include the URL inline so it can be re-checked.
- **Confidence over completeness.** If you don't know something, write `TBD` with a one-line note on what would resolve it. Don't fabricate.

---

## 3. Tools (deterministic work goes through MCP)

The agent does **not** write or run code in this workspace. Deterministic work — rendering JS pages, verifying links, reading uploaded documents — goes through the MCP tools the Gatherlight server exposes (server name `planner-tools`):

| Tool | Call as | Use for |
|---|---|---|
| `scrape` | `mcp__planner-tools__scrape` with `{url, selector?, waitFor?, timeout?}` | Render a JS/SPA page in a real headless browser and return its text. **Mandatory** for verifying search deeplinks — `WebFetch` cannot execute JS. |
| `extract` | `mcp__planner-tools__extract` with `{relPath, instruction?}` | Read an uploaded file (PDF / image) under `uploads/` and return extracted or summarised text. Read-only. |
| `library_*` | `mcp__planner-tools__library_upsert` / `library_search` / `library_import` | The DB **knowledge library** (景点/餐厅/酒店/体验). `search` before researching (skip re-verified work); `upsert` verified entities instead of hand-writing an ATTRACTIONS.md; `import` migrates a legacy markdown library once. See [tool-first.md](.claude/rules/tool-first.md). |

Ground rules:

- **Never crawl the filesystem with Bash** (`find`, `ls -R`, `dir /s`…). Use Glob / Grep / Read, and only within `plans/`, `household/`, `.claude/`.
- **Avoid creating scratch files.** Most tool output can be used inline and discarded. If a result genuinely must persist (e.g. a large scrape you'll reference from a plan), write it under `cache/` (git-ignored) with a descriptive name — never to OS temp paths. `/cleanup` prunes `cache/` later.
- **Tool gaps**: there is no dedicated flight-price / hotel-price tool yet. Verify those facts with `WebSearch` + per-URL `scrape` calls, cite with a date-stamp, and capture the gap via `/remember` so it can inform a future release.

---

## 4. Git & the review flow

- **The agent NEVER runs git.** No `git add` / `commit` / `push` — a scope-guard hook blocks it.
- Every change you make is shown to the user as a diff in the Gatherlight UI; **the server commits only after the user approves**.
- History still lives in git — that's why "edit in place" is safe: approved checkpoints preserve every old version. Plans are the value of this workspace.

---

## 5. Evolving the system

When you notice a recurring pattern across two or more sessions (e.g. "every trip plan needs a transport sub-section the template doesn't have"), update the template, the workflow doc, or add a rule. The next session shouldn't have to rediscover it.

- New rule → copy `.claude/rules/TEMPLATE.md`, add a row to `RULES_INDEX.md`.
- New template field → edit the template in `.claude/templates/` and mention the change in the matching workflow doc.
- New skill → add `.claude/skills/<name>/SKILL.md` and route it from `/doc-loader`.
- New MCP tools arrive with Gatherlight releases — they are not written here. Record wished-for tools via `/remember`.
