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

- [ ] **Move the self-managed runtime from Ollama to `llama-server`.** Decided and measured 2026-08-22 —
  `docs/self-managed-llm-runtime.md` has the numbers, the eliminated alternatives and the four things that
  only running it revealed. Ollama stays as a *household* backend (detected, never managed); what changes is
  what the app installs. Not a swap, in this order: ~~(1) a `llama-cpp` resource~~ **DONE** — 34.9 MB
  `win-vulkan-x64`, sha256-pinned (arm64 falls back to the 12 MB CPU build; there is no vulkan-arm64
  asset), listed above Ollama, provisioned + probed end to end, asserted in `p49`; ~~(2) a runtime service~~ **DONE** —
  `LlamaServerRuntime` locates/probes/starts the router and WARMS its models, with `--n-gpu-layers` written
  into a generated per-model preset (contract, not tuning) and `embeddings = true` only on embedders;
  `GET/POST /api/manage/models/llama[/start]`; measured end to end through the app at 9/10 top-1 and
  25 ms/query; `p51` asserts the absent path (a suite has no business downloading 370 MB);
  ~~(3) models as pinned GGUF downloads~~ **PARTLY DONE** — `embed-gguf` (the Q8 embedder, pinned by HF
  commit + sha256) is in; the judge's chat GGUF is not, and neither is a way to choose among several.
  Ollama's own blobs do NOT load in llama.cpp (`expected 316 tensors, got 314`), so nothing already
  downloaded can be reused; ~~(4) a backend a layer can BIND to~~ **DONE** — `LlamaCppSource` on both
  layers (models filtered by kind, `origin=app`, no address), `LlamaWarmStep` starting + warming only when
  bound, verified by binding 语义 to it and restarting (saved AND running, warm step green); what remains of
  ~~(4) the shelf~~ **DONE** — `GgufCatalog` (3 pinned models: the Q8 embedder plus gemma-3 1B and 4B for
  判断) generates one resource spec per entry, each in its own install dir; 判断 now suggests a chat model
  that exists. What remains here is smaller and worth naming: `/api/manage/models` still reports only
  Ollama's inventory, so a GGUF's download progress and its delete button live in the generic 资源 list
  rather than beside the models they belong to; and `EmbeddingCatalog.Recommend` still advises as though
  Ollama were the only local option.
  (5) re-measure the shortlist through it — the Q8 embedder scored the same 9/10 as Ollama's f16 and the
  1B judge was timed at 150–204 ms, but 判断's QUALITY has never been measured per model on this corpus at
  all, and the catalogue says so rather than implying otherwise.
- [ ] **Give 内置 a stated ROLE, or drop it — but the "dominated" case for dropping it was wrong.**
  I wrote that `llama-server` beats it on both axes. On retrieval and per-query latency it does (9/10 vs
  8/10, 25 ms vs 28 ms), but I compared runtime-to-runtime and got the footprint backwards: 内置 is
  **222 MB total with no process at all**, against llama.cpp's 35 MB runtime **plus** a 334 MB model **plus**
  a child process per model — 369 MB and a daemon. So it is the smaller and quieter path, paying one top-1
  hit in ten for it. That is a real trade a real household might want, which makes this a ROLE question
  rather than a ranking one: keep it as the minimum-footprint, zero-process option (the descriptions now
  say exactly that), or drop it to carry one backend fewer. Not a decision to take on the size column
  alone, which is how the wrong answer got written down the first time.
- [ ] **内置 for 判断** — an in-process CHAT model, which is a much bigger thing than an embedder (GGUF via
  LLamaSharp; see `docs/builtin-model-runner.md` for why not ONNX Runtime GenAI). Deferred, not blocked:
  判断 already has two working backends, so this buys convenience rather than capability.

### Product (deferred, not urgent)
- [ ] **Re-run `dev.mjs recall-bench` once the knowledge base is a few hundred facts.** The bench exists and
  the first run is recorded in `docs/memory-recall-resharpen.md` §3c: 判断 improved every column on our own
  corpus (direction confirmed) but by −0.083 against Lyntai's −0.35, on 16 facts and 12 probes — which the
  tool itself refuses to call a conclusion. At a few hundred facts the magnitude becomes quotable, and the
  panel's attributed wording can finally be replaced with our own number. 语义 needs two runs (it is a
  startup registration, so it cannot be A/B'd in one).
  The 8.9 s / 37 ms latency found there is now STATED in 判断's cost line (with the 公式 floor beside it, and
  asserted by `p51`), so a household sees it before recall starts feeling slow. What is still unmeasured is
  the LOCAL arm's own latency — the panel says only that it avoids the CLI's process spawn, because quoting
  a figure nobody took here is the thing that panel refuses to do. Measuring it needs a second run: the
  backend is a `settings.json` binding consumed at DI registration, so it is bind → restart → `recall-bench`,
  which `recall-bench` already tells you at the end of its own output.
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
