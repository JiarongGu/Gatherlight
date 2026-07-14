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

## Current state

All roadmap phases (0–7) plus the post-phase-7 production track of `docs/ROADMAP.md` are done: the
.NET server owns the product (plan index + fs ops, two-gate chat, SSE, uploads, tool registry over
HTTP + MCP at `/mcp`, knowledge-base seeder), the React client lives in `src/client/`, and the
legacy `viewer/` is deleted. On top of that: an **LLM-ops loop** (per-conversation ratings +
automated scorers + run traces + cortex prompt/model tuning + an eval playground), **FTS5 trigram
search**, portable **memory transfer**, **remote-access hardening** (access-token gate + TLS +
security headers + brute-force lockout), a **native C++ launcher** with two-phase **auto-update**,
and **CI/release** packaging. New server modules: `Modules/{Scoring,Trace,Cortex,Update,Security,
Playground,Memory}`.

- `tools/pdf-form/` — a Node utility (pdf-lib + fontkit) for PDF AcroForm inspect/fill/merge,
  invoked by the C# document tools via `NodeLeafTool` (reliable on real + CJK PDFs where PDFsharp
  threw). The former `tools/puppeteer/` scrapers are fully ported to C#/Playwright and removed —
  Phase 7 is done; the registry can't tell a Node leaf from a native tool.
- The shipped planner knowledge base lives in `src/server/Gatherlight.Server/Assets/DataTemplate/`
  (scrubbed, generic) and is seeded/upgraded into data folders by `ZhikuSeeder` — the live family
  knowledge base in `local/.claude/` is user data and diverges freely.

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

- `node devtools/dev.mjs server` — the .NET server (port 5317, data folder `./local`; serves the
  built client from wwwroot when present).
- `node devtools/dev.mjs vite` — client HMR on :5173 (proxies `/api` + `/mcp` → 5317).
- `node devtools/dev.mjs build` — client build → wwwroot + dotnet build.
- `node devtools/dev.mjs e2e [pN|all]` — API e2e suites with a stubbed claude CLI against
  isolated `devtools/_e2e-*` data folders. Keep them green; each phase of work lands with its suite.
- `node devtools/dev.mjs host` — the desktop management console (hosts the server in-process +
  monitors health); `publish` builds the shippable bundle (framework-dependent host — the launcher
  installs the .NET 10 runtime on first run — + native launcher).
- `node devtools/dev.mjs eval [scenarios.json]` — the prompt/agent playground (dry-plan + auto-score,
  a quality benchmark to run before/after tuning); `memory <export|import>` transfers DB memory.

Interactive family planning happens in the data folder, not here: run `claude` from `local/`
(its own CLAUDE.md + knowledge base apply there).
