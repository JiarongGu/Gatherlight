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

### Release
- [ ] **Cut a release:** the manual `release.yml` (Actions → Run workflow). The `e2e all` gate is
  green at 47/47. Write `docs/release-notes/next.md` first — it becomes the release body, and without
  it the body is the raw commit log.

### Product (deferred, not urgent)
- [ ] **Phase B embeddings:** ONNX embedding model as a provisioned resource (into Gatherlight.Resources
  or its own package) + EmbeddingService + vector tables + hybrid search over the FTS index.
- [ ] **Decay for `recall_facts` (Lyntai 2.5.0 graph memory):** the fact store holds exactly what goes
  stale — a scraped price, a venue's status — and FTS ranks a six-month-old fact level with today's
  forever. Lyntai's graph engine decays by what has HAPPENED in the store (not wall-clock) and links
  whatever is recalled together, and the model-free half needs **no embedder**, so it does not drag in
  the declined Phase B above. Only worth it if recall quality becomes a felt problem: it is a new store
  + tables + migration, and `remember_fact` already handles staleness by same-kind+topic overwrite.
  Not a version bump: we are already ON 2.5.0 and it is inert, because none of it is reachable until
  something calls `AddMemory`/`AddMemoryEngine`.

## Parked (with reasons — don't pick up without a decision)
- OS-level sandbox for the spawned claude (AppContainer/restricted-token + FS ACL + network-egress
  filter) — the only layer that would contain code executed *inside* an agent-authored script or exfil
  via a crafted WebFetch URL. NOT done in this pass: it's a dedicated Windows security project that
  needs a real sandbox test rig to verify, and a half-built version gives a false sense of safety. The
  shipped mitigation is the PreToolUse scope-guard v2 jail (reads/writes/Bash confined; out-of-boundary
  → MCP), which closes the direct tool-based escapes; this is the defense-in-depth layer above it.
- Resource-bundle sha256 pin (review #15) — NOT added: nuget.org TLS + per-version immutability is the
  integrity guarantee; a pinned sha would reintroduce the per-release drift that #7 removed. An
  overridden `GATHERLIGHT_RESOURCES_URL` is a deliberate operator choice. Reasoning in
  `ResourceProvisioner.ProvisionBundleAsync`.
- Playwright shared-browser "fix" (review #11) — NOT a bug: `PlaywrightHost` already serializes launch
  + env-var setup behind `_gate`; concurrent `NewContextAsync` on a connected browser is Playwright-safe.
