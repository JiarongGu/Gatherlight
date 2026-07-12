# Dev conventions — server, data, tooling

The load-bearing patterns for working on Gatherlight's code. These mirror the sibling projects
(same family patterns); deviations need a reason.

## Backend (src/server/Gatherlight.Server)

- **Modules pattern**: `Modules/{Name}/` with `{Name}Controller.cs` (thin) → `Services/`
  (business logic + repository). Variation points are interfaces resolved via DI collections
  (e.g. `IGatherlightTool`), never if/else chains. Composition root: `GatherlightApp.Build()`.
- **SQLite via Dapper**: hand-written SQL, `snake_case` columns ↔ PascalCase properties
  (`MatchNamesWithUnderscores`). **Repository methods are async** (`QueryAsync`/`ExecuteAsync`).
  Trap: SQLite integer affinity — wrap double columns in `CAST(x AS REAL)` in SELECTs.
- **Migrations**: FluentMigrator in `Modules/Fluent/Migrations/`, numbered `YYYYMMDDNNNN` —
  never reuse a number (unapplied duplicates are skipped silently). Composite PKs must be
  inline at CreateTable (SQLite has no ALTER ADD CONSTRAINT).
- **Sources are BOM-less UTF-8 + `<CodePage>65001</CodePage>`** — without it, csc on a
  CJK-locale machine reads Chinese string literals as ANSI mojibake (bit us once).

## LLM / process spawning

- **claude CLI only, never API keys.** Resolve the executable via `where.exe` once, preferring
  `.cmd`/`.exe` (the first `where` hit can be an extensionless bash shim Windows can't run).
  `ArgumentList` only — never a shell (newlines + metacharacters in prompts). Prompts over
  stdin. BOM-less UTF-8 both directions. `Kill(entireProcessTree: true)` on abort.
- Cheap utility calls (extract, validation) run with a **neutral cwd** so the data folder's
  CLAUDE.md/knowledge base isn't loaded per call; the interactive chat runs cwd = data root
  **by design** (the planner gate is the product).
- Tests stub the CLI via `GATHERLIGHT_CLAUDE_CMD` (see devtools/scripts/claude-stub.mjs).

## Data folder discipline

- ALL user data in the untracked data folder (`local/` default, `GATHERLIGHT_DATA` override);
  it has its own private git repo. The server never edits `state/`-external data outside the
  reviewed flows (chat gates, fs ops, seeder) — and those all serialize on `DataWriteLock`
  (one writer, or git index.lock collisions + corrupted review diffs).
- The agent's write scope (`plans/ household/ .claude/`) is enforced by the PreToolUse
  scope-guard hook generated into the data folder — not by trust.
- The shipped knowledge base lives in `Assets/DataTemplate/` and is seeded/upgraded by
  `ZhikuSeeder` (hash-guarded: user-modified files are never overwritten).

## Dev loop

- `node devtools/dev.mjs <server|vite|build|e2e|test-data|check-sensitive|install-hooks>`.
- e2e suites self-host the server against isolated `devtools/_e2e-*` data folders with the
  claude stub; every phase of work lands with its suite green.
- Scratch files: `devtools/_*` (gitignored). Never OS temp.
