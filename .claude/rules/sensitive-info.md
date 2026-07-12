# Sensitive info — keep family data + dev-machine specifics out of tracked files

This repo is the **code** of Gatherlight, a family planner product. All user/family data (plans,
household profiles, bookings, the planner knowledge base in active use) lives in the **untracked
data folder `local/`** — which has its own private git repo inside. The main repo's history was
**reset on 2026-07-13** precisely because family data had leaked into tracked files *and commit
messages*; the pre-reset history survives only in `local/archive/gatherlight-pre-reset.bundle`.
Keep it clean from here on.

## The rules (never in a tracked file or commit message)

- **No family/personal data.** Names, dates of birth, passports/visas, flight or booking numbers,
  hotel/restaurant names from real trips, income/expense figures, addresses. Product docs and the
  shipped knowledge-base template use neutral examples ("a family member", "CITY-2026 trip").
- **No absolute local paths.** No `C:\Users\<name>\…`, no dev-root paths. Use repo-relative paths
  or neutral placeholders.
- **No planner content.** `plans/**` and `household/**` style content belongs in `local/` only.
  If a doc needs an example plan, invent a clearly fictional one.
- **Commit messages are history too.** Describe changes structurally ("update trip plan dates"),
  never with the private specifics ("booked flight XY123 for Mom").

## How to apply

- **An automated pre-commit guard enforces this** — `devtools/scripts/check-sensitive.mjs` (run by
  `devtools/hooks/pre-commit`) scans staged changes and blocks the commit on any hit. Install once
  per clone: `git config core.hooksPath devtools/hooks`. The real private tokens live in the
  gitignored `local/sensitive-patterns.txt` (add new ones there — never in a tracked file). Scan
  the whole tree any time: `node devtools/scripts/check-sensitive.mjs --tree`.
- If the guard blocks you: move the value to `local/` and reference it generically.
- A leak already committed is a **history** problem, not a working-tree problem — it needs a
  history rewrite (bundle backup first), not just an edit.
