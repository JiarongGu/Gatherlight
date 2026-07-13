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
- **Full-text search = FTS5 `trigram`**: search indexes are external-content FTS5 virtual tables
  with the **`trigram`** tokenizer (indexed CJK *substring* recall — `unicode61` treats a whole
  Chinese phrase as one token), kept in sync by AFTER INSERT/DELETE/UPDATE triggers and backfilled
  in the same migration. Build the MATCH string via `Core/Services/FtsQuery` (drops `<3`-char tokens,
  quotes the rest), fall back to LIKE when it returns null, rank with `bm25()`. Reference: migration
  `202607130006` + `LibraryStore`/`Knowledge/Stores`.
- **Sources are BOM-less UTF-8 + `<CodePage>65001</CodePage>`** — without it, csc on a
  CJK-locale machine reads Chinese string literals as ANSI mojibake (bit us once).
- **Scorers / evals** are the DI-collection pattern in practice: each eval dimension is an `IScorer`
  registered `AddSingleton<IScorer, …>` (`Modules/Scoring`) — deterministic ones compute in code,
  LLM-judge ones extend `LlmScorerBase` (one-shot claude from a neutral cwd, `{score,reason}`
  verdict). Add a dimension = add a class + one registration, never a switch. The eval playground
  (`Modules/Playground`, `dev.mjs eval`) reuses them against dry plans (no persistence).

## LLM / process spawning

- **claude CLI only, never API keys.** Resolve the executable via `where.exe` once, preferring
  `.cmd`/`.exe` (the first `where` hit can be an extensionless bash shim Windows can't run).
  `ArgumentList` only — never a shell (newlines + metacharacters in prompts). Prompts over
  stdin. BOM-less UTF-8 both directions. `Kill(entireProcessTree: true)` on abort.
- Cheap utility calls (extract, validation) run with a **neutral cwd** so the data folder's
  CLAUDE.md/knowledge base isn't loaded per call; the interactive chat runs cwd = data root
  **by design** (the planner gate is the product).
- Tests stub the CLI via `GATHERLIGHT_CLAUDE_CMD` (see devtools/scripts/claude-stub.mjs).

## Security / remote access (`Modules/Security`)

- **Loopback is trusted; remote needs a token.** `AccessGateMiddleware` gates `/api` + `/mcp` (token
  via `Authorization: Bearer` / `X-Gatherlight-Token` / httpOnly `gl_auth` cookie; loopback bypasses
  it unless `security.trustLoopback:false`, e.g. behind a same-host proxy). `SecurityHeadersMiddleware`
  puts CSP + nosniff/frame/referrer/permissions on every response — the CSP is calibrated to the
  built client, verify with a real render before tightening. `ILoginThrottle` = per-IP brute-force
  lockout. Binding beyond loopback **without** a token **fails closed** (refuses to start).
- **TLS is Kestrel-native** (`TlsCertificate.Resolve`): a self-signed cert generated + reused from
  `state/gatherlight-tls.pfx`, or a configured PFX. Config lives in `security.*` (settings.json) +
  `GATHERLIGHT_BIND`·`_ACCESS_TOKEN`·`_TRUST_LOOPBACK`·`_TLS[_CERT]` env overrides.

## Packaging & auto-update

- `dev.mjs publish` (→ `devtools/scripts/build-production.mjs`) builds the self-contained host **plus
  the native C++ launcher** (`src/launcher/`, MSVC — CI selects the v143 toolset via `CI=true`; falls
  back to `Gatherlight.cmd` where MSVC is absent) into `dist/Gatherlight/` (`libs/`·`res/`·`data/` +
  sha256 `manifest.json` + zip). The launcher carries the app icon (`src/assets/gatherlight.ico`,
  regen via `make-icon.ps1`).
- **Auto-update is two-phase**: the server (`Modules/Update`) checks the configured GitHub release +
  downloads/sha256-verifies into `{install}/.update/staged`; the C++ launcher overlays it on the next
  restart (a running exe can't replace itself) and is itself excluded from the overlay. That split is
  the whole reason the launcher exists. Release: a single **manual-trigger**
  `.github/workflows/release.yml` (`workflow_dispatch`; version bump → e2e gate → bundle → optional
  tag → GitHub Release) — no auto CI on push/PR (D3dx-style).

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

- `node devtools/dev.mjs <server|host|vite|build|publish|e2e|smoke|memory|eval|test-data|check-sensitive|install-hooks>`.
- e2e suites self-host the server against isolated `devtools/_e2e-*` data folders with the
  claude stub; every phase of work lands with its suite green. Shared harness in
  `devtools/scripts/_e2e-common.mjs` (leading `_` → not discovered as a suite).
- `dev.mjs eval [scenarios.json]` = the prompt/agent playground (dry-plan + auto-score, a quality
  benchmark); `dev.mjs memory <export|import>` transfers DB memory; `host`/`publish` run/build the
  desktop bundle.
- Scratch files: `devtools/_*` (gitignored). Never OS temp.
