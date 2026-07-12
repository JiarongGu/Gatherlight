# CLAUDE.md — Gatherlight

> Auto-loaded every session. Keep short — details live in `docs/` and `.claude/rules/`.

## What this is

**Gatherlight** — a self-hosted, AI-first family planner being productized from a markdown-notebook
prototype. Target architecture: **ASP.NET Core (net10.0) + SQLite** server (`src/server/`) hosting a
**React + Vite client** (`src/client/`), with all user data in a configurable untracked **data
folder** (default `local/`, env `GATHERLIGHT_DATA`). The data folder holds markdown plan/household
artifacts under **its own private git repo** (audit trail + diff-approval gate), the planner
knowledge base (`local/.claude/` — CLAUDE.md, rules, skills, templates the spawned agent runs on),
and app state (`local/state/gatherlight.db`, settings, uploads, caches).

The AI core: chat requests spawn the **local authenticated `claude` CLI** (never API keys) with
cwd = data folder, through a **two-gate flow** — agent drafts a plan (read-only) → user approves →
agent executes edits (scope-guarded to `plans/ household/ .claude/`) → user reviews the diff →
commit to the data repo. Deterministic work (browsing, search, file ops, budget math, scraping)
is server code / registered tools, never LLM calls — token spend is reserved for actual planning.

## Current state (productization in progress)

Porting from the legacy prototype per `docs/ROADMAP.md`:

- `viewer/` — **legacy** Node prototype (React frontend + Express backend + processors that spawn
  claude CLI). Being replaced by `src/server/` + `src/client/`; delete after Phase 4 parity.
- `tools/puppeteer/`, `tools/pdf-form/` — **legacy** Node tool leaves (scrapers, PDF form filler).
  Wrapped by the C# tool registry, then ported to C#/Playwright one at a time (Phase 7).
- `src/server/Gatherlight.Server/` — the .NET product server (Phases 1+).

## Rules

- **`.claude/rules/sensitive-info.md` — read it.** No family data, no absolute dev paths, no
  planner content in tracked files or commit messages. Pre-commit guard:
  `devtools/scripts/check-sensitive.mjs` (private tokens in gitignored
  `local/sensitive-patterns.txt`). History was reset on 2026-07-13 to remove exactly such leaks.
- **User data lives ONLY in `local/`** (own private git repo). Never move it back into this repo.
- **LLM via the authenticated `claude` CLI only — never an API key.**
- **Backend = modules** (`Modules/{Name}` controller → service → repository; Dapper + hand-written
  SQL, snake_case columns, FluentMigrator `YYYYMMDDNNNN` migrations; variation points are
  interfaces resolved via DI, never if/else chains).
- **Working files** (probes, drafts, captures) go under `devtools/` with a `_` prefix (gitignored),
  never OS temp.
- **Never commit without explicit user approval.**

## Dev loop

- Server: `dotnet run --project src/server/Gatherlight.Server` (port 5317, data folder `./local`).
- Client dev: `npm run dev` in `src/client` (port 5173, proxies `/api` → 5317).
- Legacy viewer (until Phase 4): `cd viewer && npm run dev`.
- Devtools dispatcher (`node devtools/dev.mjs <cmd>`) arrives with Phase 1; e2e suites run with a
  stubbed claude CLI against isolated `devtools/_e2e-*` data folders.

Interactive family planning happens in the data folder, not here: run `claude` from `local/`
(its own CLAUDE.md + knowledge base apply there).
