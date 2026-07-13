---
name: cleanup
description: Audit and prune accumulated scratch / superseded files in the knowledge base. Categorizes cache/ files as KEEP (referenced) / SUPERSEDED (older version) / ORPHAN (unreferenced), proposes deletions, and respects user confirmation. Also checks completed-trip lessons and RAG keyword-index drift.
---

# Cleanup

**Format**: `/cleanup [scope]` — `scope` ∈ `cache` (default — `cache/` scratch audit) | `plans` (completed-trips review) | `keywords` (RAG index drift check) | `all`.

## Why this skill exists

The workspace accumulates ephemeral artifacts over time:

| Source | Pattern | Lifecycle |
|---|---|---|
| `cache/*.json` / `cache/*.txt` | Persisted scrape outputs and investigation notes | Useful for hours-days, then often stale. Some referenced in plan files for citation traceability. |
| Old plan variant files | n/a — repo discipline (rule [edit-in-place.md](../../rules/edit-in-place.md)) keeps a single canonical file per slug. | Git (server-managed) is the archive. |
| `.claude/keywords/*.md` | RAG sub-indices | Drift if new workflows are added without an index update. |
| Completed `plans/trips/*.md` | Post-trip Lessons sections embedded in trip files | Can be abstracted into workflows/rules over time. |

Without cleanup, `cache/` grows unbounded and stale files masquerade as fresh data. Without index review, RAG routing stays accurate only by luck.

**`/cleanup` is a periodic audit + proposal step. It never mass-deletes blind — the user confirms anything uncertain.**

## Trigger conditions — self-invoke per [proactive-maintenance.md](../../rules/proactive-maintenance.md)

**Auto-invoke when** (don't wait for the user to type `/cleanup`):
- Task-end / session-end if **≥ 10 new `cache/` files** were created this session
- After a versioned cache file is superseded by a newer version
- Beginning of a new planning task — quick audit if a previous session left ≥ 15 cache files
- User explicitly asks ("clean up the scratch files", "prune the cache")

**Auto-execute without confirmation** (per [proactive-maintenance.md Confirmation thresholds](../../rules/proactive-maintenance.md)):
- Clearly SUPERSEDED versioned files (e.g. `stays-v4` when `stays-v7` exists + v4 has zero references)
- ORPHAN cache files where the user explicitly rejected the option they belong to

**ASK before deleting**:
- Investigation files for backup options the user wanted retained
- Files < 2 days old without a superseding version (might still be in active use)

## Action — Scope: `cache` (default)

### Step 1 — Inventory

Glob `cache/*` and record per file: name, size, modification time.

### Step 2 — Reference check

For each cache file, Grep for the filename across:
- `plans/**/*.md`
- `.claude/**/*.md`
- `household/*.md`

Categorize each file:

| Category | Definition | Recommended action |
|---|---|---|
| **KEEP** | Referenced in ≥ 1 plan/budget/packing/rule file (filename appears in source) | Don't delete; this is "live" verification data |
| **SUPERSEDED** | A newer version of the same prefix exists (e.g. `hotels-v2.json` when `hotels-v3.json` exists) | Propose delete; show what supersedes it |
| **ORPHAN** | No references found, no newer-version twin, > 7 days old | Propose delete |
| **RECENT** | No references but < 7 days old | Keep for now (may still be in active use) |

### Step 3 — Propose

Output a single report (fictional example):

```
### 📊 Audit: cache/ (2026-05-20)

KEEP (referenced in plans):
- flights-aaa-bbb-aug.json — referenced in plans/trips/2026-08-kyoto.md

SUPERSEDED (newer version exists):
- hotels-v2.json → superseded by hotels-v3.json (no longer referenced)

ORPHAN (no references, > 7 days):
- old-transit-notes.txt

RECENT (no references, < 7 days — keep for now):
- daytrip-options.json — investigated alternative, not yet decided

Proposed deletions: 1 SUPERSEDED + 1 ORPHAN.
Run cleanup? [yes / no / specific files only]
```

### Step 4 — Confirm + Execute

Wait for confirmation where the thresholds require it, then delete the agreed files (deletions appear in the Gatherlight review diff like any other change to tracked paths; `cache/` itself is git-ignored so its deletions are immediate).

### Step 5 — Report

```
✅ Deleted 2 files (~16 KB freed). Remaining: 4 (3 KEEP + 1 RECENT).
```

## Action — Scope: `plans` (lighter audit)

Check `plans/trips/` for completed trips (departure date < today). For each, check for a `## Lessons (after the trip)` section with non-placeholder content. If the user has written lessons that are still trip-specific (not yet abstracted into a workflow/rule), propose:

> "Trip `2024-04-kyoto.md` has 3 lessons. Want to abstract any into `.claude/workflows/TRIP_PLANNING.md` or a new rule? (yes / no / show me)"

Don't auto-modify. Plan files stay put (rule [edit-in-place.md](../../rules/edit-in-place.md) — git is the archive).

## Action — Scope: `keywords` (RAG drift check)

Sanity-check the keyword index:

1. Read [`.claude/KEYWORDS_INDEX.md`](../../KEYWORDS_INDEX.md)
2. For each sub-index referenced (`keywords/planning.md`, `keywords/household.md`, etc.), check the file exists.
3. Read each sub-index, check every file it routes to (workflow / template / household / rule) exists.
4. Find `.claude/workflows/*.md` or `.claude/rules/*.md` files **not** referenced by any keyword sub-index — they're discoverable only via direct grep, not RAG.

Report:

```
### KEYWORDS_INDEX audit:
✅ All 4 sub-indices exist
✅ All routed workflow + template files exist
⚠️  Orphan rule (not in any keyword sub-index): .claude/rules/<name>.md
    → suggest adding to the relevant keywords/<scope>.md

✅ All rules in RULES_INDEX.md are file-backed.
```

Propose adding the orphan to the relevant sub-index. User confirms.

## Action — Scope: `all`

Run `cache` + `plans` + `keywords` sequentially. One report at the end.

## Heuristics + Edge cases

- **Version pattern**: same filename prefix, `vN` suffix — treat higher N (or newer mtime) as the survivor.
- **Investigation files**: created during decision-making. Once the decision is committed to a plan file, the alternatives become orphans — **but** worth keeping 1-2 weeks in case the user reconsiders.
- **When unsure whether a file is needed** — default to KEEP; never auto-delete unreviewed.

## Rules

- [edit-in-place.md](../../rules/edit-in-place.md) — never auto-fork or rename plan files during cleanup. Plans are append-or-edit, never archived as siblings.
- [no-global-memory.md](../../rules/no-global-memory.md) — cleanup is workspace-scoped only.

## Relationship to other skills

- [/remember](../remember/SKILL.md) — captures new facts (additive). `/cleanup` is subtractive (prune obsolete).
- [/doc-loader](../doc-loader/SKILL.md) — uses KEYWORDS_INDEX which `/cleanup keywords` validates.
- [/scrape](../scrape/SKILL.md) — the main creator of persisted `cache/` files that `/cleanup cache` prunes.

## When NOT to invoke

- Mid-task (during active planning — would disrupt cache files being used)
- Right after a fresh scrape (give files time to be referenced)
- If unsure whether a file is needed — default to KEEP
