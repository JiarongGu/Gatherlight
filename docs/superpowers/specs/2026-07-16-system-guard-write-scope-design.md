# System-mode scope-guard write scope — design

**Date:** 2026-07-16
**Status:** proposed (awaiting review)
**Area:** `guard/` (new), `devtools/scripts/system-scope-guard.mjs` → moved,
`src/server/.../Chat/Services/ChatEnvironmentService.cs`, `devtools/scripts/e2e/p24.mjs`, docs.

## Problem

The spawned planning agent runs behind one of two **PreToolUse scope guards** — a security jail
enforced at the tool layer. The docs keep the two guards byte-identical except for their
`WRITE_DIRS`; `e2e-p24` runs both against the shipped bytes.

- **Planner guard** (embedded in `ChatEnvironmentService.ScopeGuardMjs`, re-issued into the data
  folder at `{data}/.claude/hooks/scope-guard.mjs`): cwd = data folder, writes to
  `plans/ household/ .claude/`.
- **System guard** (`devtools/scripts/system-scope-guard.mjs`, 系统模式 / UI-update runs): cwd =
  **this code repo**, writes limited to `src/client` only.

The system guard is **too tight**: the UI-update agent can only touch `src/client`, so it cannot
improve its own skills, rules, or knowledge base under `.claude`, nor update tooling under
`devtools`. The user wants it broadly free across the repo, with only a handful of critical files
locked — "block a few, free the rest."

## Goals

- The system-mode agent can edit the repo broadly: `src/client`, all of `.claude` (skills / rules /
  KB), `devtools`, `docs`, root files.
- A small **protected set stays read-only** to the agent: the guard itself, the C# backend +
  migrations, the settings/hook files, git internals.
- Consolidate the protected, app-managed material into **one folder (`guard/`)** that doubles as the
  human reference for "what's off-limits" — never written by the agent, always readable, owned by
  the app's update/seed mechanism.
- Give the local AI an **upstream baseline to cherry-pick version updates from**: when a new release
  changes the default frontend, the pristine new default lands in `guard/default-site/`, and the
  local AI merges those upstream page changes into the user's (possibly customized) `src/client`
  instead of the update clobbering local customizations.
- Preserve the "two guards, identical code, different constants" discipline (and the p24 contract).
- Opportunistically close a latent hole: the planner guard currently lets the planner agent
  overwrite *its own* `.claude/hooks/scope-guard.mjs`.

## Non-goals

- No change to the planner guard's *allow-list* (`plans/ household/ .claude/`). The data folder must
  stay allow-list — a deny-list there would expose `state/` (the DB), `archive/`, etc. Only its
  new deny-list (hardening) is added.
- No OS-level sandbox. Residual gaps the hook can't see (code run inside an agent-authored script,
  exfil via a WebFetch URL) remain out of scope, as today.
- No production build/rebuild pipeline work for "self-updating the UI" — this spec is only the
  write-scope boundary.

## Design

### 1. Two-part write policy (shared by both guards)

Today the write check is a single allow-list:

```js
if (!WRITE_DIRS.some((d) => rel === d || rel.startsWith(d + '/'))) deny(...)
```

Replace it with **allow-list AND deny-list** — write permitted iff inside an allowed dir *and* not
inside a protected path. An allow entry of `''` means "the whole jail":

```js
const WRITE_DIRS = [...];   // allow-list (dirs, relative to the jail root; '' = whole jail)
const PROTECTED  = [...];   // deny-list (dirs/files; overrides WRITE_DIRS)

function underAny(rel, dirs) {
  return dirs.some((d) => d === '' || rel === d || rel.startsWith(d + '/'));
}
// ...in the Edit/Write/MultiEdit/NotebookEdit branch:
if (!underAny(rel, WRITE_DIRS)) deny(`Blocked: ... may only edit ${WRITE_DIRS.join(', ')} ...`);
if (underAny(rel, PROTECTED))   deny(`Blocked: "${rel}" is a protected path (app-managed / security boundary).`);
```

`WRITE_DIRS` + `PROTECTED` are now **the only two per-guard constants** — everything else
(`norm`/`relTo`/`inside`/`bashEscapes`, the HISTORY/NETWORK/EVALS/CRAWL/HOME batteries, read jail)
stays identical across both guards. The comment banner in both files updates from "identical except
`WRITE_DIRS`" to "identical except `WRITE_DIRS` + `PROTECTED`".

Reads are unchanged: the agent may **read** anything inside the jail (so `guard/` is readable as
reference); only **writes** are gated by the two lists.

### 2. The `guard/` folder (new, at repo root)

App-managed, read-only to the agent, the single protected/reference area:

```
guard/
  system-scope-guard.mjs     # the system guard, MOVED here from devtools/scripts/
  README.md                  # documents the deny model + the protected-path list for BOTH guards
  default-site/              # pristine default config/landing — protected reference (see §5)
    README.md
```

- Moving the guard *out of* `devtools/` is what makes "allow `devtools`" safe: once `devtools` is
  broadly writable, the guard must not live there.
- `guard/` is tracked source in the code repo, shipped in the bundle, and overlaid by the two-phase
  auto-update — i.e. "managed by our updates." The agent never writes it (it's in `PROTECTED`), and
  always can read it as the reference.

### 3. System guard config

```js
const WRITE_DIRS = [''];  // whole repo
const PROTECTED  = ['guard', 'src/server', '.claude/settings.json', '.claude/settings.local.json', '.git'];
```

Net effect for the system-mode agent:

| Path | Before | After |
|---|---|---|
| `src/client/**` | write | write |
| `.claude/rules/**`, `.claude/skills/**`, KB | ❌ | ✅ write |
| `devtools/**` (except the guard) | ❌ | ✅ write |
| `docs/**`, root files | ❌ | ✅ write |
| `guard/**` | n/a | ❌ (read-only reference) |
| `src/server/**` (backend + migrations) | ❌ | ❌ |
| `.claude/settings.json` / `settings.local.json` | ❌ | ❌ |
| `.git/**` | ❌ | ❌ |

**Why settings files are protected (even though not explicitly requested):** `.claude/settings*.json`
configure **hooks**, and a hook `command` runs arbitrary shell *outside* the guard. An agent that
could edit them could inject a hook and escape the jail entirely. Locking them is required for the
boundary to hold.

### 4. Planner guard config (hardening, keep allow-list)

```js
const WRITE_DIRS = ['plans', 'household', '.claude'];              // unchanged allow-list
const PROTECTED  = ['.claude/hooks', '.claude/settings.json', '.claude/settings.local.json'];
```

This stops the planner agent from neutering its own guard (`.claude/hooks/scope-guard.mjs`) or
injecting hooks via data-folder settings — the same class of protection as the system side, and it
closes the latent hole where a tampered same-`GUARD_VERSION` guard would survive until the next boot.

Bump `GUARD_VERSION` **2 → 3** in the embedded planner guard so the server re-issues the hardened
logic into existing data folders (`ChatEnvironmentService.ShouldReissueGuard`). The system guard
carries the matching `// GUARD_VERSION: 3` for parity (its version isn't used for re-issue — it's a
tracked file — but the two stay in lockstep for the p24 "identical" contract).

### 5. `guard/default-site/` — the upstream default frontend, for update cherry-picking

**Purpose:** this is the pristine **default frontend as shipped by the current version** — the
"theirs" side of an AI-assisted merge. The install starts with `src/client` == the default; the
local AI may then customize `src/client` for the family. When a new app version changes the default
page, the auto-update overlays the *new* default into `guard/default-site/` (it's under the
app-managed `guard/` folder). The local AI then **reads `guard/default-site/`, diffs it against the
customized `src/client`, and cherry-picks the upstream changes in** — reconciling version updates
with local customizations semantically, rather than the update clobbering the user's page.

**Why it must be under `guard/`:** it is app/version-managed (write-denied to the agent, so the
agent can't corrupt its own merge base) yet freely **readable** (the agent merges *from* it). Reads
are unrestricted inside the jail, so no guard change is needed for the read side.

**Content:** the default frontend *source* the AI can meaningfully merge — the default `src/client`
UI (pages / screens / config), **excluding** build artifacts (`dist/`) and dependencies
(`node_modules/`). Kept to what defines "the site." Exact include set finalized at implementation
time; initial commit also carries a `guard/default-site/README.md` explaining the cherry-pick role.

**Out of scope here:** the cherry-pick *itself* is a runtime chat interaction (a future skill /
flow the local AI runs), not part of this guard change. This spec only guarantees the boundary:
`guard/default-site/` is readable-but-write-denied and app-managed. The merge UX is a separate
feature.

### 6. Wire-up changes

- **`ChatEnvironmentService.cs`** (`EnsureFiles`): the system-guard path changes from
  `devtools/scripts/system-scope-guard.mjs` to `guard/system-scope-guard.mjs`. Update the embedded
  planner guard body (`ScopeGuardMjs`): add `PROTECTED`, the two-part write check, bump
  `GUARD_VERSION` to 3, update the banner comment.
- **Move** `devtools/scripts/system-scope-guard.mjs` → `guard/system-scope-guard.mjs` (git mv);
  apply the same `PROTECTED` + two-part write check + `GUARD_VERSION: 3` + banner update; set its
  `WRITE_DIRS`/`PROTECTED` per §3.
- **Docs:** `CLAUDE.md` and `.claude/rules/dev-conventions.md` reference
  `devtools/scripts/system-scope-guard.mjs` and "系统模式: `src/client`" — update the path and the
  write-scope description (broad repo minus the protected set; `guard/` folder).

### 7. Testing (`devtools/scripts/e2e/p24.mjs`)

- Update `systemGuard` path to `guard/system-scope-guard.mjs`.
- **System battery** — add cases: allow `.claude/rules/x.md`, `.claude/skills/foo/foo.mjs`,
  `devtools/dev.mjs`, `docs/x.md`; deny `guard/system-scope-guard.mjs`, `guard/default-site/x`,
  `src/server/x.cs`, `.claude/settings.json`, `.claude/settings.local.json`, `.git/config`. Keep the
  existing read/bash cases (unchanged behavior).
- **Planner battery** — add cases: still allow `.claude/skills/...`; now **deny**
  `.claude/hooks/scope-guard.mjs`, `.claude/settings.json`.
- The extractor regex for the C# const stays valid (body shape unchanged apart from constants).

Run `node devtools/dev.mjs e2e p24` (and the full `e2e all`) — keep green.

## Security analysis

- **Boundary integrity preserved:** the guard file moves out of the now-writable `devtools` into the
  denied `guard/`; settings/hook files denied → no hook injection; backend/migrations denied → the
  UI/KB agent can't alter server logic; `.git` denied → no direct history tampering (Bash git-history
  already denied).
- **Both gates still apply:** the human plan-gate and diff-gate are unchanged; the guard is the
  first of the defense-in-depth layers, not the only one.
- **Residual (unchanged):** code executed *inside* an agent-authored script and exfil via a
  WebFetch URL remain outside any hook's view — an OS sandbox is the belt-and-suspenders upgrade,
  same as today.

## Rollout / compatibility

- System guard is a tracked file; the move + logic ship with the code and are overlaid by
  auto-update. No migration needed.
- Planner guard reaches existing data folders via the `GUARD_VERSION` 2→3 re-issue at server boot;
  the re-issued file shows up in the data repo as a normal reviewed change.
- No DB migration, no config schema change.

## Open questions

- Exact `src/client` include set to vendor into `guard/default-site/` (default UI source, excluding
  `dist/` + `node_modules/`) — finalize during implementation.
- How auto-update populates `guard/default-site/` with each version's default (out of scope for the
  guard change, but the boundary here assumes the update mechanism owns that folder).
