---
name: schedule-job
description: Schedule background work — recurring or one-off — via the Gatherlight job MCP tools. Use when the user wants something to happen later or on a repeat (a periodic report/analysis, a reminder/notification, or a recurring planning task), rather than done right now in this chat.
---

# Schedule a background job

Wraps the Gatherlight server's **job MCP tools** (`mcp__planner-tools__job_schedule` / `job_list` /
`job_run_now` / `job_cancel`, plus `notify_user`). A background job runs **unattended** on a schedule —
there is no human in the chat when it fires — so the server handles it safely (see auto-commit below).

## When to use

Trigger phrases: "每月/每周/每天…", "定期", "以后每次…", "提醒我…", "到时候…", "生成一份…报告",
"repeat", "recurring", "remind me", "every month/week", "schedule".

- **Recurring analysis / report** — "每月分析一次预算并告诉我" → a `report` (read-only) or `agent` job on a cron.
- **Reminder / notification** — "每周日提醒我做计划", "签证到期前提醒我" → a `notify` job (browser/in-app notification is enough).
- **Recurring maintenance task** — "每月底把过期的计划归档" → an `agent` job.
- **Deterministic periodic tool run** — "每天重建一次索引" → a `tool` job (no tokens).

If the user wants the thing done **now**, just do it in this chat — don't schedule it. For an immediate
one-off ping (not scheduled), use `notify_user`.

## Job kinds

| kind | writes files? | uses tokens? | use for |
|---|---|---|---|
| `notify` | no | no | reminders / notifications at a time |
| `tool` | no | no | run one MCP tool on a schedule (e.g. `index_reindex`) |
| `report` | no | yes | read-only analysis whose output is saved as a report + notified |
| `agent` | **yes** | yes | a task that edits `plans/`/`household/`/`.claude/` (analyze → update files) |

## How to call `job_schedule`

```
mcp__planner-tools__job_schedule {
  "name": "月度预算复盘",          // required — short human name
  "kind": "report",              // required — agent | tool | notify | report
  "schedule": "cron",            // required — "cron" | "once"
  "cron": "0 9 1 * *",           // cron (schedule=cron): here = 每月 1 号 09:00
  "runAt": "2026-09-01T09:00:00Z", // ISO time (schedule=once)
  "timezone": "Asia/Shanghai",   // IANA tz for cron (default UTC) — set it so 09:00 means local 09:00
  "instructions": "汇总本月各计划的预算与实际支出,给出结余与超支提醒。", // agent/report
  // tool jobs:  "tool": "index_reindex", "toolArgs": { ... }
  // notify jobs: "notifyTitle": "做本周计划", "notifyBody": "……"
  // agent jobs:  "autoCommit": false   // ← see safety note
}
```

Returns `{ ok, id, nextRunAt }`. Confirm the next run time back to the user in their timezone.

### cron quick reference (5 fields: `min hour day month weekday`)

| schedule | cron |
|---|---|
| 每天 09:00 | `0 9 * * *` |
| 每周一 09:00 | `0 9 * * 1` |
| 每月 1 号 09:00 | `0 9 1 * *` |
| 每周日 20:00 | `0 20 * * 0` |

Always set `timezone` for cron jobs, or the time is interpreted as UTC. Convert the user's "9点" to the
right field + tz; don't guess.

## Safety — `agent` jobs and `autoCommit`

An `agent` job edits real files with **no human watching**. Default to **`autoCommit: false`**: the run
captures its changes and **stages them for you to review** (a notification links to the diff, approved in
the same review UI as chat). Only set `autoCommit: true` when the user explicitly wants a trusted job to
commit on its own (e.g. "自动归档,不用问我"). When unsure, keep it false and say so.

## Managing jobs

- `job_list {}` — show defined jobs (kind, schedule, next run, last result). Use before creating a
  duplicate.
- `job_run_now { "id": "…" }` — run once immediately to test a freshly-created job.
- `job_cancel { "id": "…", "delete": false }` — disable (default) or delete (`delete: true`).

## Rules

- Convert relative times to absolute per [absolute-dates.md](../../rules/absolute-dates.md) (runAt/cron).
- `report`/`agent` instructions still obey the knowledge base (no-fabrication, verify-policy-info, etc.) —
  the job runs the full planner, so write the instructions as you'd brief yourself.
- Don't schedule token-spending `agent`/`report` jobs the user didn't ask to recur — confirm cadence first.

## Related

- [keywords/automation.md](../../keywords/automation.md) — routing for automation tasks.
- [remember skill](../remember/SKILL.md) — capture a wished-for job kind the tools don't cover yet.
