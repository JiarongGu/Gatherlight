# devtools/ — local dev scratch

**All temporary / scratch files for dev + agent work go here — NOT the OS global
temp folder** (`%TEMP%`, `/tmp`, the Claude scratchpad).

Use this for:
- throwaway test fixtures (sample PDFs/images, probe files)
- commit-message drafts, one-off scripts, captured command output
- anything you'd otherwise dump in a system temp dir during a task

## Rules

- Everything in here is **git-ignored except this README** (see root `.gitignore`:
  `devtools/*` + `!devtools/README.md`). Nothing here is committed.
- It lives in the repo, so it's inspectable, survives across a task, and never
  leaks scratch into a user-account-local OS path. Same principle as
  [`.claude/rules/no-temp-files.md`](../.claude/rules/no-temp-files.md).
- Puppeteer scrape output keeps its own convention (`tools/puppeteer/.tmp-*.json`)
  — that's tool-local; `devtools/` is for general dev/agent scratch.
- A dev/test script that imports `viewer/` workspace deps (e.g. the MCP SDK) must
  resolve them — run it from `viewer/` or keep it under `viewer/`, since bare
  imports resolve from the file's own directory up the tree.

## Not for

- Standing tools (those go in `tools/<name>/`) or reusable viewer code (`viewer/`).
- Plans / household content (those are the repo's real, committed value).
