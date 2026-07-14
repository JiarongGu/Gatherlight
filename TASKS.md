# TASKS

> **How to use:** add a task anywhere in **Backlog** as a `- [ ]` line (one line, plain words —
> anyone can add, including the user). Agents work top-down unless told otherwise. When a task is
> finished, DELETE its line — the commit message is the record (no Done pile-up here). Detail/design
> lives in `docs/` and `.claude/rules/*.md`, NOT here. Keep this file a list.
>
> Scope: a self-hosted, AI-first family planner (ASP.NET Core + SQLite server hosting a React client,
> a WinForms/WebView2 desktop host, a native C++ launcher). Deterministic work is server code / tools;
> LLM tokens are reserved for the two-gate planning flow via the local `claude` CLI. All user data in
> the untracked data folder (`local/`). Architecture: `docs/` + `.claude/rules/`.

## In progress

(none)

## Backlog

### Verification (user-side — needs a real environment I can't reach)
- [ ] **Launcher long-path (#13):** on a >260-char install path, confirm (a) `Gatherlight.exe` still
  opens the host window (LauncherDir not truncated), and (b) with the host running, a staged update
  (`{install}/.update/`) applies on relaunch — the running host is killed and the overlay lands
  (CloseRunningHost). Enable Windows `LongPathsEnabled=1` for such installs. Compile-verified only.
- [ ] **Cut a release:** run `e2e all` as the final gate, then the manual `release.yml` (Actions →
  Run workflow). First real run also exercises the new bump-after-gate + version single-source flow.
- [ ] **Push:** the review-fix + data-foundation + packaging commits are on local `master`, unpushed.

### Product (deferred, not urgent)
- [ ] **Framework-dependent build + runtime bootstrapper:** app ~19 MB + ~19 MB updates instead of
  ~110 MB (the launcher provisions/installs the .NET Desktop + ASP.NET Core runtimes, d3dx-style).
  De-risked (official aka.ms installers); needs a clean-machine test. Parked per "no framework check
  for now" — pick up when bundle/update size matters.
- [ ] **Phase B embeddings:** ONNX embedding model as a provisioned resource (into Gatherlight.Resources
  or its own package) + EmbeddingService + vector tables + hybrid search over the FTS index.

## Parked (with reasons — don't pick up without a decision)
- Resource-bundle sha256 pin (review #15) — NOT added: nuget.org TLS + per-version immutability is the
  integrity guarantee; a pinned sha would reintroduce the per-release drift that #7 removed. An
  overridden `GATHERLIGHT_RESOURCES_URL` is a deliberate operator choice. Reasoning in
  `ResourceProvisioner.ProvisionBundleAsync`.
- Playwright shared-browser "fix" (review #11) — NOT a bug: `PlaywrightHost` already serializes launch
  + env-var setup behind `_gate`; concurrent `NewContextAsync` on a connected browser is Playwright-safe.
