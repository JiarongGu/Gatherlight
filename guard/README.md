# `guard/` — app-managed security boundary + update baseline

Everything in this folder is **owned by the app / its updates** and is **read-only to the spawned
planning agent**. The agent may *read* it (as reference) but the PreToolUse scope guards deny
*writes* to it. Do not put agent-editable content here.

## Contents

- **`system-scope-guard.mjs`** — the PreToolUse scope guard for 系统模式 (UI-update) runs. The server
  registers it (absolute path) into `{data}/state/settings.system.json` at boot. It jails the agent
  to the code repo: writes anywhere in the repo **except** the PROTECTED set, reads inside the repo,
  Bash denied for git-history / network / inline-eval / crawl / path-escape. Carries a
  `GUARD_VERSION`. Kept byte-identical to the planner guard (`ChatEnvironmentService.ScopeGuardMjs`)
  except for `WRITE_DIRS` + `PROTECTED`; `e2e-p24` runs both.

- **`default-site/`** — the pristine default frontend shipped by the current version, used as the
  merge base for AI-assisted update cherry-picking (see its README).

## The PROTECTED (never-editable) set

| Guard | Jail (cwd) | `WRITE_DIRS` (allow) | `PROTECTED` (deny, overrides) |
|---|---|---|---|
| 系统模式 (`system-scope-guard.mjs`) | code repo | whole repo (`''`) | `guard/`, `src/server`, `.claude/settings.json`, `.claude/settings.local.json`, `.git` |
| planner (`ChatEnvironmentService.ScopeGuardMjs`) | data folder | `plans/ household/ .claude/` | `.claude/hooks`, `.claude/settings.json`, `.claude/settings.local.json` |

Why the settings files are protected: `.claude/settings*.json` configure **hooks**, and a hook
`command` runs arbitrary shell *outside* the guard — an agent that could edit them could inject a
hook and escape the jail. Why `guard/` is protected: it holds the guard itself; a self-editable
boundary is no boundary.
