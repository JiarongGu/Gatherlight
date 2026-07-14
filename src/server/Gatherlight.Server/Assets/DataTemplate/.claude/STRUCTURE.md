# STRUCTURE.md — Data Folder Contract

> The canonical layout of a Gatherlight data folder. This is the **contract**: every file has a home,
> every home has a purpose. `CLAUDE.md §1` is the short version; this is the full spec. When in doubt
> about where something goes, this file decides.

## The tree

```
/                              # the data workspace (its own private git repo)
├── CLAUDE.md                  # always-loaded agent rules (short; points into .claude/)
│
├── plans/                     # ★ the artefacts — one plan per file, markdown
│   ├── trips/                 #   trips/YYYY-MM-<slug>.md
│   ├── daily/                 #   daily/YYYY-MM-DD.md
│   ├── weekly/                #   weekly/YYYY-Www.md   (ISO week)
│   ├── budgets/               #   budgets/<slug>.md    (trip-paired or <scope>)
│   ├── packing/               #   packing/<slug>.md    (trip-paired)
│   ├── visa/                  #   visa/<country>.md
│   └── INDEX.md               #   ⇢ generated index of plans/ (see "Indexing")
│
├── household/                 # ★ long-lived family facts — the load-bearing memory
│   ├── README.md              #   what each file holds
│   ├── people.md              #   members: dietary / mobility / ages / interests
│   ├── preferences.md         #   travel / dining / pace defaults
│   ├── constraints.md         #   school terms / work / anniversaries / hard limits
│   ├── recurring.md           #   weekly / monthly / annual recurring items
│   ├── income.md              #   income structure (NO sensitive numbers)
│   └── expenses.md            #   fixed costs + big-ticket + financial dates
│
├── .claude/                   # ★ the AI knowledge base (how the agent works)
│   ├── CLAUDE.md              #   (root CLAUDE.md is the loaded one; this dir holds the detail)
│   ├── AI_GUIDE.md            #   navigation hub
│   ├── STRUCTURE.md           #   this file — the layout contract
│   ├── routing.json           #   deterministic keyword → docs/skills routing (server pre-routing)
│   ├── KEYWORDS_INDEX.md      #   RAG top-level router → keywords/*
│   ├── keywords/              #   RAG sub-indices (planning / household / conventions / automation)
│   ├── rules/                 #   behaviour rules + RULES_INDEX.md (the O(1) registry)
│   ├── skills/                #   invocable workflows (/plan-trip, /onboard, /scrape, loaders, …)
│   ├── workflows/             #   "how to plan {X}" long-form guides
│   └── templates/             #   plan starting templates (every new plan starts from one)
│
├── state/                     # ⚙️ server-managed app state — NEVER read or edit
│   ├── gatherlight.db         #   SQLite: memory (library/facts/cortex), plan_index, chat, settings
│   ├── settings.json          #   server config
│   ├── resources/             #   provisioned runtime (git/chromium/driver) — from nuget, regenerable
│   └── logs/                  #   daily log files
├── uploads/                   # ⚙️ user uploads — read ONLY via the `extract` tool
└── cache/                     # ⚙️ scratch (git-ignored) — the ONLY place for agent scratch files
```

## Invariants (the contract)

1. **One plan = one file.** Never `-v2` / `-final` / `-new` siblings — history is git's job (`edit-in-place.md`,
   `filename-conventions.md`).
2. **Naming is load-bearing.** A budget/packing file shares its trip's slug so skills pair them by name
   alone (`budgets/2026-08-kyoto.md` ↔ `trips/2026-08-kyoto.md`). Slugs are kebab-case, no diacritics.
3. **Dates are absolute** (`YYYY-MM-DD`) everywhere — filenames and file contents (`absolute-dates.md`).
4. **Memory lives here, never in user-level auto-memory** (`no-global-memory.md`). Facts → `household/*`,
   conventions → `.claude/rules/*`, how-to → `.claude/workflows/*`.
5. **`state/` `uploads/` `cache/` are the server's**, not the agent's. The agent reads/writes only
   `plans/`, `household/`, `.claude/` (a PreToolUse scope-guard hook enforces this).
6. **Every index/registry row points to a file that exists.** `RULES_INDEX.md`, `KEYWORDS_INDEX.md`,
   `routing.json`, and the generated `INDEX.md` files must not reference missing files.

## The two halves of "memory"

| Half | Lives in | Portable via |
|---|---|---|
| **Records** (plans, household, knowledge base) | markdown files in `plans/ household/ .claude/` (+ git history) | the data-folder git repo — and the full-backup `.zip` |
| **DB memory** (verified library, learned facts, tuned cortex) | `state/gatherlight.db` | `/api/memory` JSON — and the full-backup `.zip` |

A **full backup** (`/api/backup`, or the 管理台 「完整备份」) bundles *both* into one `.zip`; import restores
everything. This is why markdown-as-source-of-truth is future-proof *and* fully restorable.

## Indexing

`plans/INDEX.md` (and per-category index files) are the **markdown-native, human-readable index** of the
records — a table of contents kept in sync with the DB's `plan_index` (the fast query cache + FTS). The
agent navigates + maintains them through the **`index_*` MCP tools** (`index_list`, `index_search`,
`index_get`, `index_reindex`) instead of crawling the folder. Markdown is the source of truth; the DB is
the synced cache. See `keywords/` for the RAG routing layer that sits on top.

## First run

A brand-new data folder is seeded from this template (empty `plans/`, stub `household/`). The
[`/onboard`](skills/onboard/SKILL.md) skill walks a new household through filling `household/*` and laying
down the first plans — so an install is guided, not blank.
