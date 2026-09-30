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

- [ ] **Round 7** (`docs/superpowers/plans/2026-09-29-round-7.md`): Task F, the e2e flakes (branch
  `round-7-e2e`), then Task B, a higher-precision 内置 embedder (Run 16).

## Backlog

- [ ] **Research an OS sandbox for the planner agent — then an owner decision.** Round 7 Task S: confine only
  the escape routes (`state/` reads, writes to the guard and the generated `--settings`, writes outside the
  data folder's write set) and keep everything the agent uses. The jail's two best-effort legs are the gap
  (`.claude/rules/dev-conventions.md`, the three legs). A low-privilege service account stays declined.
- [ ] **Retire `EmbeddingCatalog`, the Ollama shelf.** Ollama stopped being a backend on 2026-08-22, and the
  class still describes it: `Recommend` has no caller; its ids are Ollama tags (`embeddinggemma:300m`), so the
  语义 bind response's `catalogued` is false for every embedder the app can bind today
  (`embeddinggemma-300M-Q8_0`, `embeddinggemma-300m-onnx`) and nothing reads it; and the models panel's
  footnote dates its rows from these Ollama-era measurements. `IsWellFormedId` is still the model-id check
  the bind endpoints and `LiveRoutes` use, so it moves rather than goes.
- [ ] **内置 for 判断's TAGGING half** — an in-process chat model (GGUF via LLamaSharp; see
  `docs/builtin-model-runner.md` for why not ONNX Runtime GenAI). 判断's checking half runs in process since
  round 6 (`BuiltInJudgeSource`, a reranker); tagging still needs the Claude CLI or a llama.cpp chat GGUF.
  Deferred, not blocked: this buys convenience rather than capability.

### Product (deferred, not urgent)
- [ ] **Re-run `dev.mjs recall-bench` once the knowledge base is a few hundred facts.** The first run is
  recorded in `docs/memory-recall-resharpen.md` §3c: 判断 improved every column on our own corpus (direction
  confirmed) but by −0.083 against Lyntai's −0.35, on 16 facts and 12 probes — which the tool itself refuses
  to call a conclusion. Every judge arm has since been measured on a fixture (`docs/judge-bench.md`, 240
  questions, quality and latency), but not on the household's own facts; at a few hundred the magnitude
  becomes quotable. 语义 needs two runs (it is a startup registration, so it cannot be A/B'd in one).
- [ ] **Measure the decay constants against real use.** The graph index now ranks `recall_facts`, but
  Lyntai ships several of its constants explicitly unmeasured (half-life, reinforce factor, and the
  three governing connectedness, which have to be measured *together* since edge decay erodes the
  strength that feeds the boost). Defaults are in use and settable in `GatherlightApp`'s
  `AddMemoryEngine("facts", …)`. Worth revisiting once the household has months of recall behind it —
  not before, since there is nothing to measure against yet.

## Parked (with reasons — don't pick up without a decision)
- Resource-bundle sha256 pin (review #15) — NOT added: nuget.org TLS + per-version immutability is the
  integrity guarantee; a pinned sha would reintroduce the per-release drift that #7 removed. An
  overridden `GATHERLIGHT_RESOURCES_URL` is a deliberate operator choice. Reasoning in
  `ResourceProvisioner.ProvisionBundleAsync`.
- Playwright shared-browser "fix" (review #11) — NOT a bug: `PlaywrightHost` already serializes launch
  + env-var setup behind `_gate`; concurrent `NewContextAsync` on a connected browser is Playwright-safe.
