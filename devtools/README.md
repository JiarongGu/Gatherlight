# devtools/ — dev dispatcher + local scratch

## Dispatcher

One entry point for every dev task (allow-list it once):

```bash
node devtools/dev.mjs server [port]    # headless server (dotnet run, data folder ./local)
node devtools/dev.mjs vite             # client dev server (HMR, proxies /api)
node devtools/dev.mjs build            # client build -> wwwroot + dotnet build
node devtools/dev.mjs e2e [pN|all]     # API end-to-end suites (isolated devtools/_e2e-* data folders)
node devtools/dev.mjs test-data        # synthetic fixture data folder
node devtools/dev.mjs install-hooks    # git core.hooksPath -> devtools/hooks (sensitive-info guard)
node devtools/dev.mjs check-sensitive [--tree]
```

Project-specific paths/ports live in `project.config.mjs` — the only file to edit when reusing
this toolkit on another project. Scripts live under `scripts/` (all generic).

## Scratch rules

- **All temporary / scratch files for dev + agent work go here — NOT the OS temp folder**
  (`%TEMP%`, `/tmp`, the Claude scratchpad). Prefix them with `_` (`_probe.mjs`, `_out.json`)
  so the `devtools/_*` gitignore entry catches them.
- It lives in the repo, so it's inspectable, survives across a task, and never leaks scratch
  into a user-account-local OS path.
- Screenshots → `devtools/screenshots/` (gitignored).
- Private/backup things (real family data, history archives) → `local/`, never here.
- Clean up throwaways when a task ends.

## Not for

- Standing tools (those go in `tools/<name>/` or C# server modules) or product code.
- Plans / household content (that's data — it lives in `local/`, tracked by its own private repo).
