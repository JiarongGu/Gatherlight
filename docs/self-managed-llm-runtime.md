# The self-managed local LLM runtime — which one, and why

**Decision: `llama-server` (llama.cpp) in router mode, the `win-vulkan-x64` build.**
Researched, measured and **accepted** 2026-08-22.

We ship exactly ONE self-managed runtime. "Self-managed" means the app downloads it, starts it and owns
its lifecycle — as opposed to connecting to whatever the household happens to have installed. Both are
legitimate; this document picks the one we provision.

It replaces **provisioned Ollama**, which held the role from 2026-08-21. Ollama does not go away: it stays
as a *household* backend, detected and connected to but never managed, because plenty of households run
their own and removing that would be a regression. What changes is which runtime the app installs.

The decision rests on the measurements below, not on the documentation above them — llama-server matched
Ollama's retrieval (9/10) at 3× lower embedding latency and 1/42 the download, and a warm local judge came
in ~55× faster than the CLI judge this product ships today. The migration work it implies is tracked in
`TASKS.md`; the four things that measurement changed about the plan are in the costs section, because they
are what makes it more than a swap.

---

## Why this question needed asking

The app has provisioned Ollama since 2026-08-21 (sha256-pinned zip → `{data}/state/resources/ollama`,
started when the port is silent, models pulled through `/api/manage/models`). So a self-managed runtime
already existed — but the panel called it **本机 · Ollama**, which reads as *your* Ollama, and the
app-managed half surfaced only in a failure message. Two consequences worth recording:

* A household could reasonably conclude 语义 required them to go install a daemon.
* **So could we.** The justification originally written for the built-in ONNX arm claimed 语义 was "the
  only recall layer a household could not switch on without first installing a separate program". That
  was false when written. The app installs the program.

## Requirements, in the order that eliminated candidates

1. **Serves BOTH layers at once.** 判断 is a chat model, 语义 is an embedding model, and both are on the
   path of every fact written and every recall. A runtime that holds one model at a time means a model
   load per call — which is measured, in this product, at 8.9 s (see `memory-recall-resharpen.md` §3c).
2. **Redistributable** under a licence that lets us download and run it unattended.
3. **A plain archive**, sha256-pinnable, no installer, no admin, no package manager.
4. **Native Windows x64.** The product is a WinForms/WebView2 host behind a native C++ launcher. Docker
   or WSL is not a dependency a family planner may acquire.
5. **OpenAI-compatible HTTP.** `OpenAiCompatibleSource` already speaks `/v1/chat/completions` and
   `/v1/embeddings`, so a candidate that does too needs almost no new client code.
6. **Small.** Every megabyte is a household's first-run download.

## What was measured, 2026-08-22

Artifact names and sizes are from the GitHub releases API, not from documentation.

| candidate | both layers at once | Windows x64 archive | licence | size (Win x64) | verdict |
|---|---|---|---|---|---|
| **`llama-server` (llama.cpp)** | **yes — router mode** | **yes** | **MIT** | **34.9 MB** (vulkan) | **pick** |
| Ollama | yes | yes | MIT | **1460.3 MB** | incumbent, 42× larger |
| LocalAI | yes | **NO WINDOWS BUILD** | MIT | — | eliminated |
| Foundry Local (Microsoft) | ? | installer | **CLI: MS licence terms** | — | eliminated |
| llamafile | no — one model per file | yes | Apache-2.0 | per-model | eliminated |
| KoboldCpp | no — single model | yes | mixed | ~500 MB | eliminated |
| vLLM | yes | no — Linux/CUDA, Python | Apache-2.0 | — | eliminated |
| LM Studio / Jan | yes | desktop app | proprietary / not redistributable | — | eliminated |

**LocalAI was the closest miss and it is a hard fact, not a judgement:** v4.9.0 (2026-08-20) ships
`darwin-arm64`, `linux-amd64`, `linux-arm64`, a `.dmg` and a Linux launcher. There is no Windows asset.

**Foundry Local fails twice.** Its SDK is MIT but *the CLI is under Microsoft Software License Terms*, and
we would be silently downloading and running that CLI on a household's machine. Separately, its documented
endpoints are chat and audio — no embeddings, so 语义 has nothing to use.

## Why llama.cpp wins NOW and would not have six months ago

**Router mode is the whole reason.** `llama-server` is single-model by design, and `--embeddings`
*restricts* it to embedding-only — it disables chat. On that basis llama.cpp could not serve both layers,
and this document would have recommended keeping Ollama.

Router mode (shipped 2025-12-11) changes it: a coordinator process plus one child per model, each child a
single-model `llama-server` on an ephemeral loopback port, `--models-max N` (default 4) resident at once
with LRU eviction, and **per-model presets** in an `.ini` so one child can carry `--embeddings` while
another serves chat. It was built, in the maintainers' own framing, to bring Ollama-style model management
to llama.cpp. That is exactly the shape this product needs.

**And Vulkan removes the artifact-selection problem.** Ollama is 1460 MB largely because one archive
carries every GPU runtime. llama.cpp publishes per-backend builds, which looks like it makes US responsible
for detecting the household's GPU — except `win-vulkan-x64` is **34.9 MB** and Vulkan is vendor-neutral
across NVIDIA, AMD and Intel. One artifact, no detection, 42× smaller than the incumbent. (CUDA would be
146.9 MB + a 391 MB cudart, i.e. still smaller than Ollama, and not worth the branching.)

**Models get stricter, not looser.** `ollama pull` fetches an unpinned tag from Ollama's registry. GGUF
files are ordinary downloads, so they become sha256-pinned `ResourceKind.Files` entries — the pattern the
built-in embedding model already uses. A pinned model is a better guarantee than a mutable tag.

## MEASURED 2026-08-22, before committing to any of it

Everything above was documentation. This section is a real `llama-server` b10549 `win-vulkan-x64`
(34.9 MB, sha256 `8e7b0e6382a5bcbf57c79cf54b61483e9f7b26561d4413f28095cdaee256207b`) on the development
machine, scored by `dev.mjs embed-bench` — the same 20-fact zh/en corpus, 10 paraphrase queries and
symmetric prompting that produced every number in `EmbeddingCatalog`. The instrument did not change, so
these rows compare directly with the ones already there.

### Retrieval and latency

| path | model | top-1 | top-3 | ms/query |
|---|---|---|---|---|
| **llama.cpp direct, Vulkan GPU** | embeddinggemma-300M-Q8_0 (334 MB) | **9/10** | 10/10 | **7** |
| **llama.cpp via router, Vulkan GPU** | same | **9/10** | 10/10 | **23** |
| Ollama (CUDA) | embeddinggemma:300m (622 MB) | 9/10 | 10/10 | 69 |
| 内置 ONNX (CPU, in-process) | embeddinggemma q4 (222 MB) | 8/10 | 10/10 | 28 |
| llama.cpp **without `-ngl`** (CPU) | embeddinggemma-300M-Q8_0 | 9/10 | 10/10 | 222 |

`llama-server` matches Ollama's retrieval on a smaller quant, and beats it on latency by 3× even with
the router's proxy hop in the path. It also beats the in-process ONNX arm on BOTH axes — 9/10 against
8/10, 23 ms against 28 ms — which is the first evidence that the built-in arm is dominated rather than
merely redundant.

### 判断, on a real chat model

`gemma-3-1b-it-Q4_K_M` (806 MB) through the router, judgement-shaped prompt, 8-token reply:

| call | ms |
|---|---|
| first (lazy load) | **17 306** |
| warm, 7 consecutive | 150 · 151 · 162 · 163 · 168 · 174 · 204 |

Against the CLI judge's measured **8 900 ms per recall**, a warm local judge is ~55× faster. That is the
argument for the local arm restated with a number, and it is larger than the token argument.

### Seven things the measurement decided that reading could not

1. **Ollama's GGUFs are NOT llama.cpp GGUFs.** Pointing `llama-server` at Ollama's own
   `embeddinggemma:300m` blob — a real file with a `GGUF` magic — fails with
   `done_getting_tensors: wrong number of tensors; expected 316, got 314`. So "we already have the
   models downloaded" is false, and a migration re-downloads every model from HuggingFace. This was the
   first thing tried and it is the single biggest hidden cost in the whole plan.
2. **Vulkan is genuinely vendor-neutral here.** `--list-devices` enumerates `Vulkan0: NVIDIA GeForce
   RTX 4080 Laptop GPU` and `Vulkan1: Intel(R) Arc(TM) Graphics` from the one 34.9 MB artifact. No
   per-vendor build, no detection logic.
3. **CPU fallback works, and now has a number** — the caveat this document raised as unverified.
   Without GPU offload it still scores 9/10 at 222 ms/query. A GPU-less household gets correct recall,
   slowly.
4. **`llama-server` does NOT offload to the GPU by default, and says nothing about it.** The first run
   here was 222 ms/query purely because `-ngl` was absent; adding `-ngl 99` made it 7 ms. A silent 30×
   penalty with no warning in the log is exactly the class of failure this product keeps finding, and it
   means `-ngl` is not optional configuration — it is part of the launch contract.
5. **Router presets reach the children, verified from the child's own argv:**
   `--embeddings --host 127.0.0.1 --port 12013 --alias embeddinggemma-300M-Q8_0 --model … --n-gpu-layers 99`.
   Both models stay resident (3 processes: router + 2 children), and alternating chat → embed → chat
   costs nothing after the first call of each.
6. **The router's proxy hop costs ~16 ms/query.** Isolated by hitting the child's own ephemeral port
   (7 ms) and the router (23 ms) with the same instrument against the same loaded child. Worth knowing,
   not worth avoiding.
7. **Models load LAZILY, on first request.** `--models-max` is a cap, not a preload: the router logs
   `ensure_model: model … is not loaded, loading...` and the first judge call paid **17.3 s**. So the app
   must warm both models at startup, or the first recall after every restart pays a multi-second stall —
   the same shape as the CLI-spawn cost we are trying to escape, once per restart instead of per call.

**A methodological note, because I nearly published a wrong number again.** The first router
measurements were 188 and 145 ms/query, which I began to attribute to proxy overhead. They were cold —
the child was still loading during the run, visible as a 12 s corpus embed. Warm and isolated the answer
is 23 ms. That is the third time in two days that a cold-versus-warm confusion produced a
plausible-and-wrong figure in this area (the others: the `/embed` endpoint's per-call model load, and
"21× faster" comparing warm ONNX against cold Ollama). When a latency surprises you here, check what was
loaded before believing it.

## What it costs — state these before starting

1. **Router mode is ~8 months old.** Issue #20137 ("`--models-max` not enforced under concurrent requests,
   TOCTOU race in `unload_lru`") was closed 2026-05-15 as **stale/unconfirmed**, i.e. not demonstrably
   fixed. The failure mode is over-shooting the resident-model cap under concurrency — a memory concern,
   not a correctness one, and this product issues one recall at a time. Low exposure, not zero.
2. **A process TREE, not a daemon.** We would own a coordinator and its children. Ollama is one process.
   `IOllamaRuntime`'s "start only when the port is silent" logic does not transfer unchanged.
3. **The model-management layer is Ollama-tag shaped.** `EmbeddingCatalog` ids (`embeddinggemma:300m`),
   `/api/manage/models` pull/remove, and `OllamaState` probing all assume Ollama. Migrating is real work
   — and it is made worse by finding #1: Ollama's downloaded blobs cannot be reused, so every model is a
   fresh download. The re-measurement worry turned out fine (Q8_0 scored 9/10, same as Ollama's f16), but
   it had to be checked rather than assumed.
4. **~~Vulkan fallback is unverified~~ — MEASURED, see above.** The CPU backend ships alongside Vulkan
   (16 `ggml-cpu-*.dll` micro-arch variants in the archive) and scores 9/10 at 222 ms/query. What replaced
   this concern is a worse one: `-ngl` is absent by default, so the CPU path is what you get unless the
   launch line says otherwise.

## What happens to the two runtimes we already have

Not decided here — it is a product call, and both readings are defensible:

* **Ollama** should almost certainly stay as a **household** backend: detected, connected to, never
  managed. Plenty of households run it, and dropping the ability to use theirs would be a regression.
  What changes is that it stops being the thing we *provision*.
* **The built-in ONNX embedder** is the awkward one. If `llama-server` serves 语义, the ONNX arm is
  redundant on capability — but it remains the only option with **no separate process at all**, and at
  222 MB total it is the smallest path to a working 语义. Its measured 8/10 vs Ollama's 9/10 argues it is
  not free either way.

## Reproducing this

Sizes and licences move. The instrument was the GitHub releases API, e.g.

```
curl -s https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b10549 \
  | python -c "import json,sys; [print(a['name'], a['size']) for a in json.load(sys.stdin)['assets']]"
```

Re-run it before acting on any number above.

## Sources

- [llama-server README (endpoints, `--embeddings`, router flags)](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [New in llama.cpp: Model Management](https://huggingface.co/blog/ggml-org/model-management-in-llamacpp) — router mode, 2025-12-11
- [Router Mode and Model Management (DeepWiki)](https://deepwiki.com/ggml-org/llama.cpp/6.3-router-mode-and-model-management)
- [llama.cpp issue #20137 — `--models-max` TOCTOU](https://github.com/ggml-org/llama.cpp/issues/20137)
- [LocalAI](https://github.com/mudler/LocalAI) · [releases](https://github.com/mudler/LocalAI/releases/latest)
- [Foundry Local](https://github.com/microsoft/foundry-local) · [What is Foundry Local?](https://learn.microsoft.com/en-us/azure/foundry-local/what-is-foundry-local)
- [Ollama releases](https://github.com/ollama/ollama/releases)
