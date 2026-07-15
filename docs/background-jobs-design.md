# Background Jobs — design

> Sub-project 1 of two. Sub-project 2 (version-triggered, LLM-assisted data migration on update)
> is deferred and will get its own spec; it reuses the **unattended agent-run** primitive built here.

## Goal

A generic background-job scheduler for the Gatherlight server: **one-off or recurring** jobs that run
unattended — repeat "analyze + generate report", browser/in-app notifications, deterministic tool
calls, or open-ended agent tasks. Full backend support + an AI skill so the planner agent can create
and manage jobs, + a management console panel.

Generic by construction: a **job kind is an `IJobHandler`** resolved from a DI collection (the same
pattern as `IGatherlightTool`). Adding a kind = implement + register, never an `if/else` chain.

## The one new primitive: unattended agent runs

Today every agent run has a human driving the two approval gates (`ChatSessionService`). A scheduled
3am job has nobody at the gate. `UnattendedRunService` drives the `claude` CLI headless and returns a
result (+ a captured diff for write jobs). To preserve the codebase's single-writer guarantee ("one
active agent task or the shared data tree corrupts"), an **`IAgentGate`** singleton (`SemaphoreSlim(1)`
+ `IsBusy`) is consulted by BOTH `ChatSessionService` and `UnattendedRunService`. Interactive chat
wins; an agent-kind job whose gate is taken defers to the next scheduler tick.

## Write policy (the safety gate)

The product's identity is the human diff-approval gate, so unattended writes never silently commit by
default:

- **`auto_commit = false` (default)** — the run's edits are captured as a **patch**, the working tree
  is restored clean (never left dirty across review latency, which would block interactive chat), and
  the run is stored as **staged** (`job_run.status = 'staged'`, `detail` = patch + rendered
  `DiffFile[]`). A notification links to it; the user approves in the SAME diff-review UI. Approve →
  `git apply` the patch + commit to the data repo (recorded in the data-commit audit index, source
  `job`). Apply conflict (data folder changed meanwhile) → surfaced as "re-run the job".
- **`auto_commit = true` (per-job opt-in)** — apply + commit immediately + notify.
- **`report` / `tool` / `notify`** kinds never write to the data tree, so they need no approval.

Patch-capture (vs. a `jobs/<runId>` git branch) chosen for v1: simpler, reuses the existing
`DiffFile` rendering and reject/restore flow, keeps the working tree clean immediately.

## Data model — migration `202607160001_Jobs.cs`

- **`job`** — `id` (`j{ticks:x}`), `name`, `kind` (`agent`/`tool`/`notify`/`report`), `config_json`
  (opaque per-handler payload), `schedule_kind` (`once`/`cron`), `cron`, `run_at`, `timezone` (IANA),
  `enabled`, `auto_commit`, `timeout_seconds`, `max_runs`, `run_count`, `consecutive_failures`,
  `next_run_at` (indexed — the scheduler polls this), `last_run_at`, `last_status`, `created_at`,
  `updated_at`.
- **`job_run`** — `id`, `job_id`, `started_at`, `finished_at`, `status`
  (`running`/`success`/`failed`/`timeout`/`staged`/`rejected`/`skipped`), `outcome` (short),
  `detail` (output / error / report path / staged patch+diff json), `tokens` (best-effort),
  `duration_ms`. Indexed by `job_id`.
- **`notification`** — `id`, `created_at`, `kind` (`info`/`job-result`/`reminder`/`error`),
  `title`, `body`, `link`, `read`, `source_job_id`. Indexed by `read`.

## Scheduler — `JobSchedulerService : BackgroundService`

Ticks every `jobs.pollSeconds` (default 30). Each tick: if the **global kill-switch**
(`jobs.enabled`, read in-memory from `ServerConfigService.Current`) is off, do nothing. Else select
`enabled=1 AND next_run_at <= now` ordered by `next_run_at`, dispatch **sequentially** through the
handler map. After a run, recompute `next_run_at` via **Cronos** (`GetNextOccurrence`, timezone/DST
aware) or disable the one-off.

**Catch-up (once, within grace):** because a single `next_run_at` is stored (not a queue of slots), a
past-due job fires exactly once, never backfills. On the first tick after startup, if `next_run_at`
is older than `jobs.catchUpGraceHours` (default 24) the job does NOT fire — `next_run_at` rolls
forward, and `notify` jobs drop a "you were offline, this was missed" notification instead.

## Job handlers (`IJobHandler`, four built-ins)

| kind | writes? | LLM? | behaviour |
|---|---|---|---|
| `tool` | no | no | invoke a registered `IGatherlightTool` with fixed args via `IToolRegistry` |
| `notify` | no | no | create a `notification` row |
| `report` | no | yes | one read-only `UnattendedRunService` run; `FinalText` → `state/jobs/reports/<runId>.md` + notify |
| `agent` | yes | yes | one execute-mode run (scope-guarded); capture diff → auto-commit or stage per `auto_commit` |

`agent`/`report` jobs run a SINGLE headless `claude` invocation (no separate plan phase — there's no
human to approve a plan). `agent` uses the same execute-mode scope guard + `EditTracker` as chat.

## Guardrails (all four, per decision)

1. **Global kill-switch** — `jobs.enabled` toggle (console + settings); scheduler checks each tick.
2. **Per-job timeout + concurrency=1** — `timeout_seconds` kills the `claude` process tree on
   overrun; `IAgentGate` serializes agent-mutating runs with chat and each other.
3. **Run cap + cost log** — every run logged in `job_run` (duration always, tokens best-effort);
   `max_runs` reached → job auto-disables and asks for reconfirmation.
4. **Failure auto-disable** — `consecutive_failures >= jobs.maxConsecutiveFailures` (default 3) →
   `enabled=0` + notification. No mid-slot retry in v1 (a failed run waits for its next cron slot).

## AI surface

Tools (both surfaces, `Modules/Jobs/Tools/`): `job_schedule` (upsert), `job_list`, `job_cancel`,
`job_run_now`, `notify_user` (immediate ping mid-plan). Seeded skill
`Assets/DataTemplate/.claude/skills/schedule-job/SKILL.md` teaches when/how to schedule; wired into
`.claude/keywords/automation.md` + `KEYWORDS_INDEX` + `AI_GUIDE`. Ships via `ZhikuSeeder`
(hash-guarded).

## Notifications transport

`notification` table + `NotificationService` + `NotificationsController` (list, mark-read, `GET
/api/notifications/stream` SSE mirroring `ChatController.Stream`). React shell shows a bell/feed and
fires the browser `Notification` API when permission is granted; rows created while nothing is
connected show unread on next open. **Web Push** (fires when the app is fully closed) is out of scope
for v1 — documented as the future extension.

## Management UI

A "自动化 · Automation" panel in `Manage.tsx` (existing console-panel pattern): job list (name,
human-readable schedule, next run, enabled toggle, last status), create/edit form with preset picker
(daily/weekly/monthly/interval → cron, + raw-cron field), run-now, delete, run-history drawer, and the
global kill-switch. Notifications bell in the app shell. Client change ⇒ full `dev.mjs build`.

## Config (`jobs.*` in settings.json — new `JobsConfig`)

`enabled` (kill-switch, default true), `pollSeconds` (30), `catchUpGraceHours` (24),
`defaultTimeoutSeconds` (600), `maxConsecutiveFailures` (3).

## Testing — e2e suite `p26`

claude-stub-driven: create/list via API, cron next-run math, startup catch-up-within-grace,
`tool` job runs deterministically, `notify` job emits a notification, `agent` job both
stages-a-review and (auto_commit) commits, kill-switch pauses dispatch, auto-disable after N
failures, per-job timeout kills the run.

## New module surface

`Modules/Jobs/{JobsController, NotificationsController}` · `Services/{JobService, JobRepository,
JobSchedulerService, UnattendedRunService, NotificationService, IJobHandler + 4 handlers, AgentGate}`
· `Models/*` · `Tools/*`. Plus: `202607160001_Jobs.cs`, `JobsConfig` in `ServerConfig`,
`CapturePatchAsync`/`ApplyPatchAsync` on `IGitCliService`, `IAgentGate` consulted by
`ChatSessionService`, Cronos NuGet, the seeded skill, the client panel.
