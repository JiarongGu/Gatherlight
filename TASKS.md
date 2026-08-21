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

- [ ] **Re-measure the embedding shortlist including 内置** — `dev.mjs embed-bench` scores embedders through
  an OpenAI-compatible endpoint, so it cannot yet score the in-process 内置 backend. Until it can,
  `EmbeddingCatalog`'s numbers describe the Ollama arm only, and 内置's "same score" rests on one 8-query
  fixture (`docs/builtin-model-runner.md`) — enough to separate working from broken, not enough to rank two
  working embedders. Teach embed-bench the built-in path and re-run.
- [ ] **内置 for 判断** — an in-process CHAT model, which is a much bigger thing than an embedder (GGUF via
  LLamaSharp; see `docs/builtin-model-runner.md` for why not ONNX Runtime GenAI). Deferred, not blocked:
  判断 already has two working backends, so this buys convenience rather than capability.

### Product (deferred, not urgent)
- [ ] **Measure the three layers on THIS household's corpus.** 语义 sits under 高级 on Lyntai's
  measurement (0% of misses are retrieval failures), which is someone else's corpus — the panel says so,
  and will keep saying so until there is a local number. Needs a recall bench over our own facts scoring
  公式 / +判断 / +语义 / all three; `dev.mjs embed-bench` measures embedders on a fictional corpus and is
  not that. Only then is the ordering ours rather than borrowed.
- [ ] **Measure the decay constants against real use.** The graph index now ranks `recall_facts`, but
  Lyntai ships several of its constants explicitly unmeasured (half-life, reinforce factor, and the
  three governing connectedness, which have to be measured *together* since edge decay erodes the
  strength that feeds the boost). Defaults are in use and settable in `GatherlightApp`'s
  `AddMemoryEngine("facts", …)`. Worth revisiting once the household has months of recall behind it —
  not before, since there is nothing to measure against yet.

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
