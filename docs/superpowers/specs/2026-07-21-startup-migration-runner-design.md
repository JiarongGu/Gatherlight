# Startup Migration Runner + Progress UI — Design

- **Date:** 2026-07-21
- **Status:** Approved (design) → implementation plan next
- **Scope decision:** versioned upgrade runner **+ operational self-heal**
- **Surface decision:** server-run, progress rendered in `/manage` (which the `Gatherlight.Host` window displays), also visible in a browser — **Approach 1 (gated serving phase)**

## Problem

On every server boot, `GatherlightApp.Build()` runs the upgrade-ish work **synchronously before Kestrel starts listening**: DB migrations (`MigrationRunnerService`), data-repo init, KB seed/upgrade (`ZhikuSeeder` + `ZhikuMigrator`), guard re-issue (`ChatEnvironmentService.EnsureFiles`, keyed on `GUARD_VERSION`), plan-index rescan, interrupted-session/run reconcile.

Each piece is individually idempotent/version-guarded, but:
- There is **no unified notion of a version upgrade** (no record of the last-ran version, no orchestrated step set).
- There is **no progress/feedback** — during a long KB re-seed or index rescan the management app (`Gatherlight.Host`, a WebView2 shell over `/manage`) just appears to hang, because the server isn't listening yet so `/manage` can't render.
- A bad prior runtime state (a stale `.git/index.lock`, an interrupted job, an aborted commit's uncommitted leftovers) is invisible and can wedge the app after an update.

## Goals

1. A single **versioned, ordered, idempotent** startup-migration runner that replaces the scattered inline calls.
2. **Operational self-heal** of known-recoverable broken states on boot (non-destructive by default).
3. A **progress UI** rendered in `/manage` (Host window + browser) so a long upgrade is visible, with clear per-step status and a failure/retry path.
4. **Safe failure semantics**: never serve half-migrated state; surface errors instead of hanging or silently proceeding.

## Non-goals

- Replacing FluentMigrator or `ZhikuSeeder`/`ZhikuMigrator` internals — the runner *orchestrates* them.
- Auto-mutating user data during self-heal (no auto-commit / auto-discard of a dirty data-repo tree).
- SSE for the status feed (polling is sufficient; SSE is a possible later upgrade).
- Any change to the launcher / two-phase update apply.

## A. Startup restructure & readiness semantics

- `GatherlightApp.Build()` returns as soon as Kestrel binds. The heavy work moves into a **`StartupMigrationRunner`** started on `ApplicationStarted` (background task).
- `/api/health` stays **200 during migration** and gains a `migrating: bool` field, so the Host tray stays green and can load `/manage` to show the overlay.
- **`MigrationGateMiddleware`** (registered before auth/controllers) returns `503 {migrating:true}` for `/api/*` + `/mcp` while the phase runs, **excluding** `/api/health` and `/api/migration/*`; static `/manage` + assets always pass. Once the phase completes, it is a no-op bool check.
- **e2e compatibility:** the shared `waitHealthy` (in `devtools/scripts/e2e/_e2e-common.mjs`) is updated to wait for `migrating:false` (one place), so all existing suites keep working. This is mandatory: today `waitHealthy` implicitly waits for the whole pre-`Run` migration to finish because the port isn't open until then; with the refactor the port opens during migration, so `waitHealthy` must wait for readiness explicitly.

## B. Runner, steps, versioning, failure policy

- **Step contract:** `{ Id, Title (zh), Essential: bool, RunAsync(ctx) }` — idempotent, reports status `pending → running → ok | failed | skipped`, records elapsed ms + any error.
- **Ordered steps** (replacing the inline startup calls):
  1. DB schema migrate (`MigrationRunnerService.MigrateToLatest`) — essential
  2. Data-repo init + first-import baseline commit (`EnsureRepoAsync` / `CommitAllAsync`) — essential
  3. Self-heal (§E) — best-effort
  4. KB seed/upgrade + guard re-issue (+ commit) + KB-upgrade notify (`ZhikuSeeder`, `ChatEnvironmentService.EnsureFiles`, `ZhikuMigrator`) — guard/seed essential; notify best-effort
  5. Plan-index rescan (`IPlanIndexService.RescanAsync`) — best-effort
  6. Optional memory seed (`GATHERLIGHT_SEED_MEMORY`) — best-effort
- **Versioning:** compare `AppVersion.Semver` vs `app.lastRanVersion` (persisted in `app_config`). `isUpgrade = (lastRanVersion != current)` drives overlay wording ("升级到 vX…" vs "正在启动…"). `lastRanVersion` is written **only on successful completion**. Steps are idempotent, so a same-version boot no-ops fast and the gate window is brief.
- **Failure policy:**
  - An **essential** step failing keeps the gate **closed**, sets `phase = failed`, and the overlay shows the error + `重试` + `打开日志` — the app never serves half-migrated.
  - A **best-effort** step failing is logged + marked `failed` but the runner **continues** and lifts the gate (degraded-but-usable).
  - `POST /api/migration/retry` re-runs the runner from the first non-`ok` step.

## C. State + status feed

- **`MigrationState`** singleton (thread-safe): `phase` (`running | completed | failed`), `isUpgrade`, `fromVersion`, `toVersion`, `steps[]` (`{id, title, status, error, ms}`), `startedAt`, `finishedAt`.
- **`GET /api/migration/status`** → JSON snapshot. The overlay polls it every ~500 ms until `phase != running`.
- **`POST /api/migration/retry`** → re-run (valid only when `phase == failed`).

## D. `/manage` progress overlay

- New React `MigrationOverlay` mounted at the console root. On mount it fetches `/api/migration/status`; if `running`/`failed` it renders a **full-screen overlay** (title, step list with per-step icons, highlighted current step, and on failure the error + `重试` + `打开日志`), and defers the console's normal data loads (which would 503 anyway). On `completed` it fades out and reloads the console.
- Because the Host renders `/manage` in its WebView2, the overlay appears in the Host window and in a browser identically — no native Host code needed.

## E. Self-heal (non-destructive by default; all best-effort)

- **Stale `.git/index.lock`**: if present and stale (no active git; age over a small threshold), delete it + log (classic crashed-git recovery).
- **Interrupted chat sessions / job runs**: fold today's `FailInterruptedSessionsAsync` / `FailInterruptedRunsAsync` into a step (behavior unchanged — mark non-terminal → error/failed, inspectable).
- **Unexpected dirty data-repo working tree** (e.g. an aborted commit's leftovers): **detect** via `git status --porcelain` and **surface** a warning (count + paths) in the migration result + logs. **Never** auto-commit or auto-discard — that is user data. A `/manage` action to review/handle it may follow later.

## F. Testing

- New e2e suite `p29`:
  - Fresh boot reaches `migrating:false`; `/api/migration/status` shows all steps `ok`; `app.lastRanVersion` is written.
  - A seeded stale `.git/index.lock` in the fixture data repo is cleared + reported.
  - Test-only seams `GATHERLIGHT_MIGRATION_TEST_DELAY` (insert a delay step) and `GATHERLIGHT_MIGRATION_TEST_FAIL=<stepId>` let the suite observe the `503`-while-running window, the `status` progression, and the essential-failure-keeps-gate-closed → `retry` path.
- Full 28-suite sweep stays green via the `waitHealthy` change.

## Success criteria

- After an update, the Host window shows a live per-step upgrade overlay instead of appearing to hang; on completion the console loads normally.
- No request ever hits a half-migrated backend (essential-step failure blocks serving with a visible error + retry).
- A stale git lock / interrupted run no longer wedges startup; a dirty data-repo tree is surfaced, not hidden.
- All existing e2e suites pass; `p29` covers the new behavior.

## Risks / compatibility

- **Biggest compatibility risk:** the `waitHealthy` change — every suite relies on it. Land it with the refactor.
- Middleware ordering: the gate must run before `AccessGateMiddleware` and endpoint routing; `/api/health` + `/api/migration/*` must be excluded or the Host loses its heartbeat.
- Keep DB migrate first inside the runner so DB-touching steps (interrupted-run reconcile) run after the schema exists.
