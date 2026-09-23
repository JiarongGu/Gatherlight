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
the router's proxy hop in the path. It also beats the in-process ONNX arm on both of the columns above —
9/10 against 8/10, 23 ms against 28 ms.

**That is NOT the same as dominating it, and this paragraph said so for a while.** The columns above are
retrieval and latency; the one that decides between these two is FOOTPRINT, and there the comparison runs
the other way: 内置 is 222 MB total with no process at all, against a 35 MB runtime **plus** a 334 MB model
**plus** a child process per model — 369 MB and a daemon. So the built-in arm is the smaller, quieter path
paying one top-1 hit in ten for it, which is a trade a low-spec household might well want. Comparing
runtime-to-runtime and calling it dominated was an error, and it had already reached `TASKS.md` as an
argument for deleting the arm before it was caught.

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

## A trap for anyone debugging this: Ollama's worker is ALSO called `llama-server.exe`

Ollama runs llama.cpp internally, so a machine with both has two unrelated processes of that name:

```
%LOCALAPPDATA%\Programs\Ollama\lib\ollama\llama-server.exe   <- Ollama's own worker
{data}\state\resources\llama-cpp\llama-server.exe            <- ours
```

**So never match this process by name.** Found the hard way during development: repeated
`Get-Process llama-server | Stop-Process -Force` cleanups were silently terminating Ollama's model
workers, forcing it to reload them — for a whole session, while looking like tidy-up. The product itself
does not have this bug and must not acquire it: `LlamaServerRuntime` keeps the `Process` handle it started
and kills THAT (`Dispose`), and nothing in the codebase calls `GetProcessesByName`. If a diagnostic ever
needs to find our router, match the executable PATH or the port — never the image name.

Telling them apart at a glance: ours listens on a port derived from the data folder (11435 + hash, 64
wide) and is launched with `--models-dir`; Ollama's is launched with `--model <blob>` on a port it chose.

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

## 2026-09-23 — a RERANKER in router mode (gate for 判断's reranker arm)

Build `llama-server --version` → `version: 0.1.2-dev (build 10549, commit b2e5e9b28)`. Preset section `reranking = true` + `ctx-size`/`batch-size`/
`ubatch-size = 4096` (a cross-encoder needs the whole pair in one physical batch). `/v1/models` listed the model;
`/v1/rerank` on 「市场周末几点开门?」 over [图书馆周一闭馆。, 东门市场周六周日早上七点开门。] ranked index 1 first
(4.9242 vs -6.4054); the English query over the same Chinese documents also ranked index 1 first (1.8458 vs -6.5160).
First call (model load) 10 850 ms, warm call 28 ms.
A warm call shaped like the app's current one for a judge (`POST /v1/chat/completions`, `max_tokens: 1`) gets
**500** `the current context does not logits computation. skipping` from the reranking child — sent to a COLD
model the router still loads it first (500 after 8.2 s, status `loaded` afterwards, the next rerank 121 ms), so a
chat warm call does warm a reranker but reports failure; a reranker's warm call has to be `/v1/rerank`.

**The bind-time screen pair** (`LlamaCppSource.ScreenQuery`/`ScreenDocuments`). Query 「游泳馆成人票多少钱?」 over a
distractor that repeats the question and never answers it (「游泳馆成人票到底多少钱,很多人在门口问价格,……」) and the
answer (「游泳馆成人票每张四十元,儿童半价。」, index 1). Both catalogued rerankers through the router, pinned GGUFs
sha-verified, three runs each with identical scores: LAMAR-600m.Q5_K_M ranks the answer ahead by **4.131**,
bge-reranker-v2-m3-Q5_K_M by **3.400**. The controls are the point: a lexical scorer ranks the DISTRACTOR first —
distinct query characters 1.000 against 0.667, character bigrams 7 of 8 against 5 — and so do both models' real
scores reversed (a backwards GGUF). The pair it replaced could not tell: overlap ranked its answer first (0.750
against 0.125), so a lexical model passed it. Cold ~4.8 s (the model load), warm 25–33 ms. The screen asserts
ORDERING only — the spreads are these two models' scales, and a household-dropped reranker may score on another.

**A model downloaded while the router runs is UNKNOWN to it until a restart** (same build, measured 2026-09-23).
Router started with only LAMAR-600m in `--models-dir` and its preset section, then bge-reranker-v2-m3 hardlinked
in: `/v1/models` still listed only LAMAR; `/v1/rerank` naming bge answered **400** `model
'bge-reranker-v2-m3-Q5_K_M' not found` in 3 ms; after rewriting the preset file with a bge section, still **400**,
still unlisted. The router reads its models directory and preset file once, at start. After a restart (router
answering in 2.1 s) both were listed and bge reranked (index 1 first, 5.163 vs 1.759). So
`LlamaServerRuntime.EnsureServesAsync` restarts OUR router when a bind or warm names a model it does not list —
never for one it lists, since a restart drops every warm model — and re-warms what was loaded, in the background.
Verified through the app on the real binary: 判断 booted on LAMAR (router ours, warmed 6.7 s), bge dropped in,
binding bge restarted the router (1.3 s from the decision to "starting … with 2 model(s)"), the screen passed and
the bind returned 200 in 9.2 s, and LAMAR was warm again 5.9 s later. A router we ADOPTED (an orphan of an earlier
run, or the household's own) is not ours to kill and an app restart would only adopt it again, so there the bind is
refused with a sentence saying the llama-server process must be ended for the model to load.

**One long document fails the WHOLE rerank call** (same build and presets, measured 2026-09-23, both
rerankers). A batch of one long document plus one short one: English of 6 263 characters (Lyntai's `longProbe`
shape) is ~1 600 tokens and scores; 12 503 is ~3 160 and scores; 20 823 is 5 218 tokens and the call answers
**500** `input (5218 tokens) is too large to process. increase the physical batch size (current batch size:
4096)` — the short document unscored too. Chinese costs about three times as much per character: 4 089
characters is ~3 400 tokens and scores, 6 010 is ~4 960 and fails the same way. The limit is per PAIR, not per
call: 96 documents of 2 000 Chinese characters (~1 660 tokens each, ~160 000 in all) scored in one call, in
~9.7 s. The worst rate measured was 0.83 tokens per UTF-16 unit (common CJK; emoji ~0.48; rare CJK, Extension
A or B, collapses to a handful of tokens). Since the scoring verifier is fail-open, a single long fact made every
recall that surfaced it unverified, silently — so `RerankInputCap` sends at most 1 000 characters per candidate
(~830 tokens at the worst rate measured). llama-server does NOT truncate per pair.

**An upgrade stripped every vector from an install on 语义 · llama.cpp — reproduced, then fixed** (same build,
2026-09-24). Lyntai's graph engine does not fail a write whose embed fails: `GraphMemoryEngine.SearchAsync` logs
"similarity search failed … storing without signals or links" and the node is stored without its vector, and the
fact still gets its graph reference, so no back-fill ever returns to it. The 3.2 layout rebuild (2 → 3) runs in
`FactIndexStep`, which was registered BEFORE `LlamaWarmStep` — the first thing that starts llama-server — and a
graceful shutdown kills the router. Reproduced on a scratch install with the real embedder
(`embeddinggemma-300M-Q8_0`): boot 1 wrote 6 facts, 6 indexed and 6 vectors; the layout marker was set back to 2
and the app stopped; boot 2 logged six "storing without signals or links" warnings and came up with 6 of 6 facts
indexed, **0 vectors**, and the marker at 3 — coverage 100%, semantic recall empty, and nothing would ever repair
it. Fixed twice over: `LlamaWarmStep` now runs before `FactIndexStep` (the same repro: 6 of 6 facts, **6
vectors**, the rebuild logged "6/6 facts indexed"), and `FactIndexStep` probes one embed first and, when an embedder
is wired but does not answer, indexes nothing, leaves the marker, and says so in a startup warning. Driven on the
real binary by holding the router's port with a listener that answers 503: boot 2 left the marker at 2 and the 6
vectors untouched, with the warning; boot 3, port freed, rebuilt to 6 vectors and marker 3.
