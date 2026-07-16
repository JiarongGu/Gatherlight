# System-mode scope-guard write scope — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Broaden the 系统模式 (UI-update) scope guard from `src/client`-only to the whole code repo minus a protected set, consolidate the guard + version-update baseline into an app-managed `guard/` folder, and harden the planner guard with the same deny-list mechanism.

**Architecture:** Both PreToolUse guards get a two-part write policy — an allow-list (`WRITE_DIRS`) AND a deny-list (`PROTECTED`) that overrides it; write is permitted iff `underAny(rel, WRITE_DIRS) && !underAny(rel, PROTECTED)`. `WRITE_DIRS` + `PROTECTED` become the only two constants that differ between the guards, so they stay byte-identical everywhere else (the `e2e-p24` contract). The system guard moves to a new, write-denied-but-readable `guard/` folder.

**Tech Stack:** Node ESM (`.mjs` guards, run via `node`), C# (`ChatEnvironmentService` embeds the planner guard as a raw-string const), the `p24` pure-node e2e battery. No build framework, no DB migration.

**Spec:** `docs/superpowers/specs/2026-07-16-system-guard-write-scope-design.md`

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `guard/system-scope-guard.mjs` | **create (git mv from `devtools/scripts/`)** + rewrite write-policy | the 系统模式 boundary; now deny-list, app-managed |
| `guard/README.md` | create | human reference: the deny rules for both guards |
| `guard/default-site/README.md` | create | documents the version-update cherry-pick baseline slot |
| `src/server/Gatherlight.Server/Modules/Chat/Services/ChatEnvironmentService.cs` | modify | planner guard const (deny-list + v3) + system-guard spawn path |
| `devtools/scripts/e2e/p24.mjs` | modify | new path + allow/deny batteries for both guards |
| `.claude/rules/dev-conventions.md` | modify | doc: guard path + write-scope description |
| `CLAUDE.md` | verify (likely no change) | doc: only if it names the old path/scope |

**The two-part write check (used verbatim in both guards):**

```js
// rel is under any entry of `dirs`. A '' entry means the whole jail; other entries match the dir/
// file itself or anything beneath it. Shared by the WRITE_DIRS allow-list + PROTECTED deny-list.
const underAny = (rel, dirs) => dirs.some((d) => d === '' || rel === d || rel.startsWith(d + '/'));
```

```js
// write branch:
if (!underAny(rel, WRITE_DIRS))
  deny(`Blocked: ... may only edit ${WRITE_DIRS.join(', ') || 'the repo'} — not "${rel}".`);
if (underAny(rel, PROTECTED))
  deny(`Blocked: "${rel}" is a protected, app-managed path — not editable.`);
allow();
```

---

## Task 1: Broaden + move the system guard (with p24 coverage)

**Files:**
- Modify (then move): `devtools/scripts/system-scope-guard.mjs` → `guard/system-scope-guard.mjs`
- Test: `devtools/scripts/e2e/p24.mjs`

- [ ] **Step 1: Update p24 to the new system-guard contract (failing test first)**

In `devtools/scripts/e2e/p24.mjs`, change the guard path (line ~16):

```js
const systemGuard = path.join(repo, 'guard', 'system-scope-guard.mjs');
```

Replace the system-battery `// writes` block (the three `write …` rows) with:

```js
  // writes — broad allow (whole repo) minus the PROTECTED deny-list
  ['write src/client', 'Write', { file_path: 'src/client/src/x.tsx' }, false],
  ['write .claude rule', 'Write', { file_path: '.claude/rules/dev-conventions.md' }, false],
  ['write .claude skill', 'Write', { file_path: '.claude/skills/foo/foo.mjs' }, false],
  ['write devtools', 'Write', { file_path: 'devtools/dev.mjs' }, false],
  ['write docs', 'Write', { file_path: 'docs/x.md' }, false],
  ['write root file', 'Write', { file_path: 'README.md' }, false],
  ['write guard denied', 'Write', { file_path: 'guard/system-scope-guard.mjs' }, true],
  ['write guard default-site denied', 'Write', { file_path: 'guard/default-site/index.html' }, true],
  ['write src/server denied', 'Write', { file_path: 'src/server/x.cs' }, true],
  ['write .claude settings denied', 'Write', { file_path: '.claude/settings.json' }, true],
  ['write .claude settings.local denied', 'Write', { file_path: '.claude/settings.local.json' }, true],
  ['write .git denied', 'Write', { file_path: '.git/config' }, true],
  ['write outside repo', 'Write', { file_path: '../evil.txt' }, true],
```

- [ ] **Step 2: Run p24 to verify the new system cases fail**

Run: `node devtools/dev.mjs e2e p24`
Expected: FAIL — the guard is not yet at `guard/…`, so the new `…false` (allow) rows and the `…true` (deny) rows misbehave (node can't find the file / old v2 logic denies `.claude`). The `p24` summary shows failed assertions in the `system:` group.

- [ ] **Step 3: Move the guard file (preserve history)**

Run:
```bash
mkdir -p guard
git mv devtools/scripts/system-scope-guard.mjs guard/system-scope-guard.mjs
```

- [ ] **Step 4: Rewrite the write policy + banner + version in `guard/system-scope-guard.mjs`**

Replace the banner comment + version line (top of file, the `/** … */` block and `// GUARD_VERSION: 2`) with:

```js
/**
 * PreToolUse scope guard (v3) for 系统模式 (UI-update) headless claude runs — cwd = the CODE repo.
 * Registered via {data}/state/settings.system.json (generated by the server).
 *
 * The spawned agent is JAILED to the code repo. Enforced boundaries:
 *   WRITE (Edit/Write/MultiEdit/NotebookEdit)  → anywhere in the repo EXCEPT the PROTECTED set
 *                                                (guard/, src/server/, .claude/settings*.json, .git/)
 *   READ  (Read/Grep/Glob)                     → only inside the code repo
 *   BASH                                       → not: git-history / delete, network egress,
 *                                                inline code-eval, filesystem crawl, or any path
 *                                                outside the repo (args or redirects)
 *
 * The guard itself lives under guard/ (app-managed, re-issued by updates), so it stays read-only to
 * the agent even though devtools/ is now writable. Anything genuinely out-of-boundary (fetch a URL,
 * run a scraper, read a shared resource) MUST go through a server MCP tool — mediated + auditable —
 * never raw Bash. Everything else: silent exit 0.
 *
 * This body is kept identical to the planner guard (ChatEnvironmentService.ScopeGuardMjs) except for
 * WRITE_DIRS + PROTECTED; the e2e suite (p24) runs both. GUARD_VERSION lets the server re-issue newer logic.
 */
// GUARD_VERSION: 3
```

Replace the `const WRITE_DIRS = ['src/client'];` line with:

```js
const WRITE_DIRS = [''];  // '' = the whole jail (repo); writes are gated by PROTECTED below
const PROTECTED = ['guard', 'src/server', '.claude/settings.json', '.claude/settings.local.json', '.git'];
```

Immediately after the `const inside = (p, root) => relTo(p, root) !== null;` line, add:

```js
// rel is under any entry of `dirs`. A '' entry means the whole jail; other entries match the dir/
// file itself or anything beneath it. Shared by the WRITE_DIRS allow-list + PROTECTED deny-list.
const underAny = (rel, dirs) => dirs.some((d) => d === '' || rel === d || rel.startsWith(d + '/'));
```

Replace the whole `Edit/Write/MultiEdit/NotebookEdit` branch with:

```js
if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
  const filePath = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path ?? '';
  if (!filePath) allow();
  const rel = relTo(filePath, projectDir);
  if (rel === null) deny(`Blocked: ${filePath} is outside the repo.`);
  if (!underAny(rel, WRITE_DIRS))
    deny(`Blocked: 系统模式 may only edit ${WRITE_DIRS.join(', ') || 'the repo'} — not "${rel}".`);
  if (underAny(rel, PROTECTED))
    deny(`Blocked: "${rel}" is a protected, app-managed path (guard / backend / settings / .git) — not editable in 系统模式.`);
  allow();
}
```

Leave the `HISTORY/NETWORK/EVALS/CRAWL/HOME`, `norm`, `relTo`, `bashEscapes`, stdin read, and the `Bash` / `Read|Grep|Glob` branches unchanged.

- [ ] **Step 5: Run p24 to verify the system section passes**

Run: `node devtools/dev.mjs e2e p24`
Expected: the `system:` assertions all PASS. (The `planner:` section is still the untouched v2 and also passes.) If the runner prints `p24 … PASS`, green.

- [ ] **Step 6: Confirm the moved guard is tracked (not gitignored)**

Run: `git check-ignore guard/system-scope-guard.mjs; echo "exit=$?"`
Expected: no path printed, `exit=1` (not ignored).

- [ ] **Step 7: Commit**

```bash
git add guard/system-scope-guard.mjs devtools/scripts/e2e/p24.mjs
git commit -m "feat(scope-guard): move system guard to guard/ + deny-list write scope

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Harden the planner guard + repoint the system-guard spawn path

**Files:**
- Modify: `src/server/Gatherlight.Server/Modules/Chat/Services/ChatEnvironmentService.cs`
- Test: `devtools/scripts/e2e/p24.mjs`

- [ ] **Step 1: Add failing planner deny-cases to p24**

In `devtools/scripts/e2e/p24.mjs`, inside the `battery('planner', …)` array, immediately after the `['write .claude skill', …, false]` row, add:

```js
    ['write .claude hooks guard denied', 'Write', { file_path: '.claude/hooks/scope-guard.mjs' }, true],
    ['write .claude settings denied', 'Write', { file_path: '.claude/settings.json' }, true],
```

- [ ] **Step 2: Run p24 to verify the planner cases fail**

Run: `node devtools/dev.mjs e2e p24`
Expected: FAIL — the v2 planner guard allows any write under `.claude`, so both new `…true` (deny) rows report `expected DENY` in the `planner:` group.

- [ ] **Step 3: Update the embedded planner guard (const `ScopeGuardMjs`) in `ChatEnvironmentService.cs`**

All lines below are inside the 8-space-indented raw-string const. Change the banner's WRITE line and the "kept identical" line, and bump the version:

Change `-> only under plans/ household/ .claude/` (the WRITE bullet) to:

```
         *   WRITE (Edit/Write/MultiEdit/NotebookEdit)  -> under plans/ household/ .claude/ EXCEPT
         *                                                the PROTECTED set (.claude/hooks/, .claude/settings*.json)
```

Change the line `* Kept identical to devtools/scripts/system-scope-guard.mjs except WRITE_DIRS; e2e suite p24` to:

```
         * Kept identical to guard/system-scope-guard.mjs except WRITE_DIRS + PROTECTED; e2e suite p24
```

Change `// GUARD_VERSION: 2` to `// GUARD_VERSION: 3`.

Replace the `const WRITE_DIRS = ['plans', 'household', '.claude'];` line with:

```
        const WRITE_DIRS = ['plans', 'household', '.claude'];
        const PROTECTED = ['.claude/hooks', '.claude/settings.json', '.claude/settings.local.json'];
```

After the `const inside = (p, root) => relTo(p, root) !== null;` line, add (8-space indent):

```
        // rel is under any entry of `dirs`. A '' entry means the whole jail; other entries match the
        // dir/file itself or anything beneath it. Shared by the WRITE_DIRS allow-list + PROTECTED deny-list.
        const underAny = (rel, dirs) => dirs.some((d) => d === '' || rel === d || rel.startsWith(d + '/'));
```

Replace the const's `Edit/Write/MultiEdit/NotebookEdit` branch with (8-space indent):

```
        if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
          const filePath = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path ?? '';
          if (!filePath) allow();
          const rel = relTo(filePath, projectDir);
          if (rel === null) deny(`Blocked: ${filePath} is outside the data folder.`);
          if (!underAny(rel, WRITE_DIRS))
            deny(`Blocked: the agent may only edit ${WRITE_DIRS.join(', ')} — not "${rel}".`);
          if (underAny(rel, PROTECTED))
            deny(`Blocked: "${rel}" is a protected, app-managed path (the guard / settings) — not editable.`);
          allow();
        }
```

> Note: keep the raw-string delimiters (`"""`) and the 8-space indentation exactly — the p24 extractor regex `private const string ScopeGuardMjs = """…""";` and its `^ {8}` strip depend on them.

- [ ] **Step 4: Repoint the system-guard spawn path in `EnsureFiles`**

Change (around line 39):

```csharp
        var systemGuard = Path.Combine(_options.CodeRootPath, "devtools", "scripts", "system-scope-guard.mjs")
            .Replace('\\', '/');
```

to:

```csharp
        var systemGuard = Path.Combine(_options.CodeRootPath, "guard", "system-scope-guard.mjs")
            .Replace('\\', '/');
```

- [ ] **Step 5: Run p24 to verify both guards pass**

Run: `node devtools/dev.mjs e2e p24`
Expected: `system:` and `planner:` groups all PASS; runner prints `p24 … PASS`.

- [ ] **Step 6: Build the server to verify the C# still compiles**

Run: `node devtools/dev.mjs build`
Expected: client build + `dotnet build` succeed with no errors (the const is a string literal, so this mainly catches a broken edit around it).

- [ ] **Step 7: Commit**

```bash
git add src/server/Gatherlight.Server/Modules/Chat/Services/ChatEnvironmentService.cs devtools/scripts/e2e/p24.mjs
git commit -m "feat(scope-guard): harden planner guard (deny-list) + repoint system-guard path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Create the `guard/` reference docs

**Files:**
- Create: `guard/README.md`
- Create: `guard/default-site/README.md`

- [ ] **Step 1: Write `guard/README.md`**

```markdown
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
```

- [ ] **Step 2: Write `guard/default-site/README.md`**

```markdown
# `default-site/` — pristine default frontend (update cherry-pick baseline)

This holds the **default frontend as shipped by the current app version** — the "theirs" side of an
AI-assisted merge. It is app/version-managed: auto-update overlays the new default here on each
release. The planning agent **never writes** here (it is under the protected `guard/` folder), but
**freely reads** it.

## How it's used

1. On install, `src/client` starts equal to this default.
2. The local AI (系统模式) may customize `src/client` for the family.
3. A new version changes the default page → the new default lands here.
4. The local AI diffs this baseline against the customized `src/client` and **cherry-picks the
   upstream changes in**, reconciling version updates with local customizations instead of the
   update clobbering the user's page.

## Content

The default UI *source* the AI can meaningfully merge (pages / screens / config), **excluding**
build artifacts (`dist/`) and dependencies (`node_modules/`). Population of this folder with the
per-version default is handled by the update mechanism (out of scope for the scope-guard change that
introduced this folder — see `docs/superpowers/specs/2026-07-16-system-guard-write-scope-design.md`).
```

- [ ] **Step 3: Commit**

```bash
git add guard/README.md guard/default-site/README.md
git commit -m "docs(guard): reference for the app-managed guard/ folder + default-site baseline

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Update the dev-facing docs

**Files:**
- Modify: `.claude/rules/dev-conventions.md`
- Verify: `CLAUDE.md`

- [ ] **Step 1: Update the scope-guard bullet in `dev-conventions.md`**

In the "Data folder discipline" section, the bullet begins "The spawned agent is **jailed to the
data folder** by the PreToolUse scope-guard hook". Replace that whole bullet with:

```markdown
- The spawned agent is **jailed** by the PreToolUse scope-guard hook
  (`ChatEnvironmentService.ScopeGuardMjs` planner / `guard/system-scope-guard.mjs`
  系统模式 — identical logic, different write-scope; `e2e-p24` runs both): **reads**
  (Read/Grep/Glob) confined to the jail, **writes** (Edit/Write/…) to `plans/ household/ .claude/`
  (planner) or the **whole code repo except the PROTECTED set** — `guard/`, `src/server`,
  `.claude/settings*.json`, `.git` — (系统模式); each guard also deny-lists a `PROTECTED` set that
  overrides its allow-list (the planner protects `.claude/hooks` + settings so the agent can't
  neuter its own guard). **Bash** denied git-history / network-egress / inline-eval (`node -e`,
  `python -c`) / fs-crawl / path-escape. Anything genuinely **out-of-boundary must route through a
  server MCP tool** — mediated + auditable — never raw Bash. Enforcement, not trust. The guard
  carries a `GUARD_VERSION`; the server re-issues it into existing data folders when it bumps (it's
  a security boundary, not editable KB content). The `guard/` folder is app-managed (shipped +
  overlaid by updates), read-only to the agent. Residuals the hook can't close (code run *inside*
  an agent-authored script; exfil via a WebFetch URL) need an OS sandbox.
```

- [ ] **Step 2: Verify `CLAUDE.md` doesn't name the old path/scope**

Run: `grep -nE "system-scope-guard|src/client|系统模式" CLAUDE.md`
Expected: no line describing the old `src/client`-only scope or the `devtools/scripts/system-scope-guard.mjs` path. If a match describes the old boundary, update it to match the new scope; otherwise no change.

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/dev-conventions.md
# add CLAUDE.md too only if Step 2 required a change
git commit -m "docs: update scope-guard write-scope + guard/ path in dev conventions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full e2e battery**

Run: `node devtools/dev.mjs e2e all`
Expected: every suite green, ending with `e2e: N/N passed`. The planner-guard `GUARD_VERSION` 2→3 bump means any suite reusing a data folder will re-issue the guard on boot — that's the designed path and should stay green. (Tolerate the known Windows libuv teardown abort per the suite's own PASS markers.)

- [ ] **Step 2: Confirm no stale references remain**

Run: `grep -rnE "devtools/scripts/system-scope-guard|only under src/client|系统模式.*src/client" --include=*.mjs --include=*.cs --include=*.md .`
Expected: no hits outside `docs/superpowers/` (the spec/plan legitimately describe the move).

- [ ] **Step 3: Report**

Summarize: suites passing, the new boundary in effect (system guard = repo minus PROTECTED; planner guard hardened), and the one deferred item — populating `guard/default-site/` with the per-version default frontend is owned by the update mechanism, not this change.

---

## Notes / assumptions

- **Production packaging:** the system guard resolves at `{CodeRootPath}/guard/system-scope-guard.mjs`
  — the same `CodeRootPath` anchor the old `devtools/scripts/` path used, so the published source
  tree must include `guard/` (it did include the guard before, just under a different dir). No
  `build-production.mjs` change is expected since it doesn't enumerate the guard by name; confirm the
  publish step ships the repo source tree that contains `guard/`.
- **`guard/default-site/` population** (copying each version's default UI source in) is deliberately
  out of scope here; this plan only establishes the folder + its read-only-but-readable boundary.
