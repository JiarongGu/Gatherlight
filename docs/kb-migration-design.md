# Knowledge-base upgrade migration — design

> Sub-project 2. Reconciles a user's **customized** `.claude/` files with shipped template
> improvements on an app update — the case `ZhikuSeeder` otherwise skips forever. Reuses the
> background-jobs primitives (git patch-capture, one-shot `claude`, notifications, stage-for-review).

## Problem

`ZhikuSeeder` upgrades a template file only if the user hasn't touched it (current hash == last
shipped hash). A **user-modified** file whose **template also changed** is skipped — so the user
never gets rule/skill/workflow improvements we ship. A naive overwrite would clobber their edits.

## Solution — LLM reconciliation, staged for review

1. **Detect** (server-side, zero LLM). A file is an *upgrade candidate* when, per the `zhiku_state`
   `shipped:{rel}` hash: it exists, `current != shipped` (user modified) AND `template != shipped`
   (we shipped a new version) AND `current != template`. (Absent file / no shipped record / template
   unchanged / already-current → not a candidate.)
2. **Notify, opt-in** (per the trigger decision). On startup, after `ZhikuSeeder`, if candidates
   exist, post ONE notification ("N 个知识库文件有可用升级 — 待审阅"). No tokens spent until the user
   opts in. The console 校准 · Cortex tab surfaces the same.
3. **Merge on request.** `POST /api/manage/kb-upgrades/run`: for each candidate, a **one-shot
   `claude`** call (neutral cwd, read-only, no MCP) with a MERGE prompt — user's version (A) + new
   template (B) → a merged file that keeps the user's intentional customizations while adopting B's
   improvements. (2-way reconciliation: the previous shipped version isn't retained on existing
   installs, so no true 3-way base — the model infers customization vs. improvement from A vs. B.)
4. **Stage for review** — reuse the jobs pattern: write the merged files, capture the combined
   **patch**, restore the tree clean, persist the staged review to `state/kb-migration-staged.json`
   (patch + rendered `DiffFile[]` + the new template hashes). Notify "升级已就绪,待审阅".
5. **Approve / reject.** Approve → `git apply` the patch + commit `zhiku: migrate knowledge base` +
   record in the data-commit index + set `shipped:{rel}` to the new template hash. Reject → discard;
   also set `shipped:{rel}` to the new template hash so the same upgrade isn't re-offered every boot
   ("I'll keep my version for this template version"). Either way the working tree is never left dirty.

## Surface

- `Modules/Seed/Services/ZhikuMigrator.cs` (`IZhikuMigrator`: Detect / Run / GetStaged / Approve /
  Reject) + `Modules/Seed/ZhikuMigrationController.cs` (`/api/manage/kb-upgrades*`).
- Merge prompt in `PromptHarness` (tunable, group `system`/`migration`).
- Startup hook in `GatherlightApp` (detect → notification).
- Console: a card in the 校准 · Cortex tab (available upgrades → run → review → approve/reject),
  reusing the diff renderer.
- e2e `p27` with the claude stub: seed → user-edit a file → bump the template → detect → run (stub
  merge) → stage → approve → committed; reject path.

## Not in scope (v1)

- Plan/household content-format migrations (the second scope option — deferred).
- True 3-way merge (would need retaining the previously-shipped content, or reconstructing it from
  the last `zhiku: seed` commit in the data repo's git history — a future enhancement).
