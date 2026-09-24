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
recall that surfaced it unverified, silently — so `RerankInputCap` bounds every pair at 1 000 characters of document
(~830 tokens at the worst rate measured). llama-server does NOT truncate per pair. Since 2026-09-24 a longer candidate
is not cut to that bound but scored in several windows of it, in the same call (`ChunkedScoreProvider`;
`docs/judge-bench.md` Runs 6 and 6c measured the cut pushing a long note off the page). One call carrying 2 000 such
windows was served whole, and took 77–79 s on BGE and LAMAR — hence at most 480 windows per call. That count is only
right for this GPU, so it is a ceiling: below it, `RerankPace` times each rerank call the provider makes (ms per pair
character) and a chunked call carries only the windows it predicts will be scored within half the 60 s verification
deadline — fewer per long candidate on a slower machine, down to one, the cut. Not yet run on a CPU-only machine.

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

### 2026-09-24 — no restart while a CHAT judge tags through the router

Same build. A llama.cpp chat judge ANNOTATES every fact write through our router, and annotation is fail-open, so
a fact written while the router restarts is stored without subject tags, for good — the tag's version of the lost
vector above. `LlamaRestartPolicy` refused a restart only for 语义 and a reindex. The setup, on a scratch install
with the stub CLI: 判断 bound at startup to `gemma-3-1b-it-Q4_K_M` (the catalogue's pinned chat judge, downloaded
through 资源, sha256 verified), LAMAR also on disk, 语义 off. The router was ours and the judge warmed in 4.1–5.5 s.
Then bge-reranker-v2-m3 was hardlinked in and 判断 bound to it, while a fact was written every 250 ms.

- **Before the fix, three runs.** Two returned **200**, in 9.9 s and 9.6 s, after ONE router restart each (a new
  router PID). The port refused connections for 2.3 s (measured in one of the two). The new router spawned 1.4 s
  after the restart decision, and bge warmed in 5.6–5.9 s. The facts written in that window lost their tags: 2 of
  5 in one run and 1 of 5 in the other were stored with **no subjects** (`lyntai_memory_subject`), and their
  annotation calls logged `Failed — … actively refused` or `An error occurred while sending the request`. Every
  fact written before and after the bind was tagged. The remaining run (the first of the three) returned **500**
  after 9.6 s. The restart killed the router, then the re-probe's `GET /v1/models` hit its 4 s
  `HttpClient.Timeout`. `IsServingAsync` lets EVERY `OperationCanceledException` through, the timeout's included,
  so the exception escaped the bind and NO router was left running. The next fact's annotation was refused. The
  timing points at a cause, LIKELY rather than proven: 9.6 s is ~0.6 s of lead-in, plus `Kill`'s 5 s
  `WaitForExit` (whose result is ignored), plus the 4 s timeout — so the dying router most likely had not exited
  within 5 s, and its socket still accepted the re-probe's connection and never answered. That is a separate
  defect, fixed separately (the next sub-heading).
- **After the fix: 409 in 31 ms**, saying 「…「判断」正在用这个 llama.cpp 的对话模型给写入的事实做主题标注:重启它的那几秒里写入的事实会永久没有标注,所以应用不会自动重启它 —— 请重启服务,新模型会随 llama.cpp 一起载入。」
  There were **0** restarts and 0 spawns in `state/logs`, the router PID was the same before and after, and the
  port accepted connections throughout. The facts written during and after the bind were annotated through
  llama.cpp (subjects stored), so in the configuration tested — 判断 switched on, the chat judge RUNNING —
  「正在…做主题标注」 describes what was actually happening. `settings.json` was unchanged.
- **The two cases where that sentence would be false** now get a different answer (same build, same setup).
  **判断 switched OFF** (the live `memory.enrichment.enabled`) with the chat judge running: the `Switchable*`
  policies make no call, so a restart loses nothing and the bind is not refused — **200** in 9.6 s after one
  restart, the port refusing connections for 2.3 s. The 36 facts written meanwhile made no router call at all.
  **A chat judge SAVED but not running** (a reranker at startup, then 判断 bound to the chat model, which the router
  already listed — 200 in 4.1 s, no restart): the new-model bind is still refused, because a service restart is
  owed anyway, but in the right tense and with no loss clause — **409** in 18 ms, 「…「判断」已改用这个 llama.cpp
  的对话模型,要重启服务才会生效 —— 请现在重启服务,新模型会随 llama.cpp 一起载入。」, 0 restarts, the router PID
  unchanged. 语义 got the same split (「「语义」已改用这个 llama.cpp 做嵌入,要重启服务才会生效 —— …」 when saved
  but not running), verified by reading the code only.
- **Control, after the fix.** 判断 was bound to LAMAR (a reranker) at startup, then the same bind returned **200** in
  10.4 s after one restart. The port refused connections for 2.8 s, bge warmed in 5.7 s, and LAMAR re-warmed 5.3 s
  later. All 21 facts written meanwhile were annotated by the CLI, and none touched llama.cpp. A reranker judge's
  router carries only verification, which fails open for those seconds and writes nothing.

### 2026-09-24 — a port that accepts and never answers is HELD, and a restart waits for the old port

The 500 above had two halves. **The escaping timeout** is fixed in code: `IsServingAsync` and `RunAsync` now tell
the caller's cancellation apart by its TOKEN, as `WarmCoreAsync` and the reranker screen already did, and
`RunAsync` kills a child that outlives its 15 s. The start poll now runs to a 20 s deadline instead of forty polls,
so a slow probe no longer lands in its catch-all, which killed a router that was still starting.

The first version of that fix read the timeout as "not serving", which was wrong too. "Not serving" means "start
one", and a port that ACCEPTS a connection is held by something: a hung llama-server, another program, or our own
router too busy to reply. A router spawned beside it cannot bind. (Whether llama-server's HTTP library would share
the port on Windows is unmeasured, so nothing relies on it.) And every sentence named the wrong cause: 「没能启动」
at the bind, 「还没有下载」 at the start button. **The probe now has three answers.** REFUSED means nothing listens.
ANSWERING means a router replied with its models, a `data` array. HELD means the port accepted but gave no usable
answer: a timeout, a non-2xx reply, or a body that is not the model list (a JSON 200 without a `data` array
included). `EnsureServingCoreAsync` never spawns on a held port. Its
sentence takes precedence in `Problem`, over 「还没有下载」 too, and the bind and the start button pass it through.
The sentence names the port, says the process accepts connections but does not answer as llama.cpp does (a
non-2xx or an HTML page is an answer, just not a model list), and says to end it in 任务管理器 or restart the
machine. It is the adopted-router refusal's rule: not ours to end. For a router we started
and still hold, it says to try again or restart the service. During our own restart, it says the app is
restarting llama.cpp and to wait a few seconds: a panel probe that runs outside the restart's lock can otherwise see
our dying or starting router as HELD and blame another process for it. This half is drivable with a fake that accepts and
never answers `/v1/models`:
- `e2e-p51`: `GET /api/manage/models/llama?refresh=true` → 200 `serving:false` with the held sentence (not
  「还没有下载」, with no binary installed), and `POST …/llama/start` → 409 with the held sentence.
- `e2e-p52` case 8a: the judge bind → 409 with the held sentence.

Both suites also assert that NO spawn was attempted: no `llama-server starting` or `starting llama-server failed`
line in the fixture's log. With the old filter restored, all three calls returned **500**. With a held port let fall
through to the spawn, the no-spawn check failed in both suites, and p52's bind said 「没能启动」.

**The dying router** is not drivable by a fake. After `StopOursCore` a restart now polls the port until nothing
accepts, for at most 15 s, and only then probes. So a router we just killed is reported as not yet gone, never as a
stranger holding the port. When it never frees, the bind says so (the old process kept the port, llama.cpp is not
running, try again or end `llama-server.exe` and restart the service) instead of probing a router that is
dying. `Kill` now logs when its 5 s `WaitForExit` runs out. Ten restarts on the real binary, same build and harness:
five with a reranker judge at startup, and five with the chat judge running and 判断 switched off, so a chat
model was loaded as in the run that failed. **All ten returned 200**, in 9.1–15.8 s. The port was free on the first
check every time (0 polls waited), 0.8–2.7 s after the restart decision, and no kill ran out its 5 s. So the
wait is unexercised here: the 500 came in 1 of the 15 restarts driven on this machine for this work, and
not in these ten. The slower runs were slower loads (bge warm in 8.6–9.7 s) and a port that refused
connections for up to 5.0 s, not waits.

### 2026-09-24 — a restart that could not come back, and our own start

Two sentences were stale, found by review rather than on the binary. **(a)** After a restart stops our router and the
port is released, the re-probe can still find the port HELD: a stranger took the freed port, or our old router was
still dying and accepted too slowly for the release check's 120 ms connect to see it. That probe ran while
`_restarting` was set, so its sentence was 「应用正在重启 llama.cpp,稍等几秒」, and the bind passed it on as its FINAL
answer. By then the restart had given up with nothing of ours running, and the 20 s probe cache kept repeating it. It is
now `RestartBlocked`: 「应用为了载入 <model> 停下了 llama.cpp,但没能启动新的:端口 <port> 被另一个进程占着:它接受连接,
却没有像 llama.cpp 那样回答(可能是没有正常退出的 llama-server.exe,也可能是别的程序)。应用不会在它旁边再启动一个,所以
llama.cpp 现在没有在运行 —— 稍等片刻再试一次;仍然这样的话,在任务管理器里结束它后再试,或者重启电脑。这次的选择没有保存,
端口空出来后在「记忆检索」里再选一次这个模型。」 The first version ended 「…然后再试一次,或者重启服务」, and review caught
it: a service restart ends neither a stranger nor a router stuck in teardown, so waiting comes first and a reboot is the
remedy that always works. The description of the holder is shared with the stranger sentence (`HeldBy`). The not-ours
clause is not reused, because "not started by the app this time" is false when the holder is our own old router.
**(b)** A fresh start set no flag, and `_started` is set only once the new router answers. So a panel probe during
a start that found the port held by our own starting router blamed "another process". `SpawnAsync` now sets
`_starting` for every start, a fresh one included, and the sentence is 「应用正在启动 llama.cpp,稍等几秒」 (a restart
keeps its own). Each flag is cleared in a `finally`, under the same lock and together with the cached probe. A probe
that was already out when the cache was dropped does not write its result back (`_probeEpoch`).

Neither is driven by e2e: both need a router the app started, and a fake is always adopted. (a) is verified by
reading only, because a stranger grabbing the port inside the restart window cannot be staged on demand. Two
real-binary runs (same build, the round-1 harness, a reranker judge at startup, then bge dropped in and bound) show
no regression. Both started the router fresh at boot, with LAMAR warm in 6.0 s and 5.2 s. Both binds returned
**200** after ONE restart and one spawn, in 10.3 s and 8.7 s. The port was free 124 ms and 122 ms after the stop
(0 polls waited) and refused connections for 3.5 s and 2.7 s. bge warmed in 6.1 s and 5.2 s, and LAMAR re-warmed
about 5 s later. There were 19 fact writes during each bind, all 200 and all tagged by the CLI. The server log had
no warning, no `not started: port` line and no held sentence. In the second run a panel polled
`GET /api/manage/models/llama?refresh=true` through the bind. It saw the dying router as HELD for about 0.3 s and
said 「应用正在重启 llama.cpp,稍等几秒。」, which is the first time that sentence was seen outside the code. It then
reported not serving with no problem while the new router was not yet listening, then serving. Right after the bind
it read serving with no problem, so nothing stale was left. 「应用正在启动」 was not seen, because the new router went
from refused straight to answering.

### 2026-09-24 — mMiniLMv2's 512 window: the NFKC bound, a pair at the limit, and the launch

The figures behind the mMiniLMv2 row's declared window were first taken with scratch scripts when the window was
declared (commit bbc9b10) and quoted only in code comments (`RerankInputCap`, the row's comment in `GgufCatalog`,
`LlamaCppSource.Description`). They are reproducible now with `devtools/scripts/rerank-window-probe.mjs`, run as
`node devtools/dev.mjs rerank-window --resources=<dir>` where `<dir>` holds `llama-cpp/` and `gguf/`. It refuses a
GGUF whose sha256 is not the catalogue's pin, and re-ran them the same day with the same answers. Same build as above
(`version: 0.1.2-dev (build 10549, commit b2e5e9b28)`), the pinned `mmarco-mMiniLMv2-L12-H384-v1-Q8_0.gguf`, one
dedicated `llama-server --reranking --n-gpu-layers 99` per part, one laptop GPU.

- **The NFKC bound** that `RerankInputCap` counts by. .NET 10.0.11's `FormKC` over every assigned BMP scalar and
  every astral scalar it changes: 64,012 scalars, 4,928 of them changed. Each was tokenized by the model's own
  `/tokenize`, without special tokens. Scalars over `tokens(NFKC) ≤ UTF-16 length(NFKC) + 1`: **0**. Raw and
  normalised token ids differ for 95 of the 4,928: characters newer than the model's normalisation table (㋿ U+32FF)
  plus fullwidth ～ U+FF5E. The worst RAW cost is 6 tokens for one UTF-16 unit (㌚ U+331A). Node's NFKC and .NET's
  `FormKC` differ on 0.
- **A pair at the limit**, fitted to 512 the way `RerankInputCap.Fit` does it (window − 6, the query at most half).
  A ℃-dense fact cut on its RAW length is 506 characters and 1,006 tokens, and `/v1/rerank` answers **500** `input
  (1006 tokens) is too large to process … (current batch size: 512)`. Cut on its NFKC text it is 506 characters and
  510 tokens, and is served (**200**). ℃㎡㎏㍿ mixed into Chinese fits either way (416 tokens raw, 349 NFKC).
- **The launch.** judge-bench Run 4 measured the row's whole recall under a 4096 launch, and the product launches it
  at the declared 512, so the rerank CALL was timed under both: one fixture question against all 60 fixture facts,
  12 questions × 3 rounds after a warm-up, serial. First run: median 75.1 ms at 4096, 76.3 ms at 512, 79.3 ms at
  4096 again. The script's run: 75.2, 71.7 and 71.8 ms. There is no difference beyond the 4096 launch's own
  run-to-run spread, so the row's 0.31 s per recall and +0.08 s over no judge stand, said as measured at 4096.

### 2026-09-24 — a CHAT child's context: capped at 16,384, and what the cap costs

`WritePresets` wrote no `ctx-size` on a chat section, so a chat child took its model's TRAINING context and llama.cpp
reserved the KV cache for all of it when the child loaded. For Qwen3-0.6B that is 40,960 tokens with full attention on
all 28 layers. A chat section now carries `ctx-size = 16384` (`LlamaServerRuntime.ChatContextTokens`); rerankers keep
their whole-pair window and embedders their own. Same build as above (b10549, Vulkan), one RTX 4080 Laptop GPU (12,282
MiB) shared with other resident processes, the pinned GGUFs. Scratch scripts, not committed; the method is here.

**How big the prompts get.** Built exactly as Lyntai 3.2.0's verifier and annotator build them: its system prompts
verbatim, candidates as the app's content-only judge input renders them (one line, at most
`JudgeSeesContentPolicy.MaxChars` = 400 characters plus "…"), numbered. Counted by the server as `usage.prompt_tokens`
(template included) with `max_tokens: 1`, or read from its refusal past the window. "Fixture facts" are the bench's 60
invented household facts (median 29 characters, at most 101), cycled; the question is the bench's longest (164
characters).

| prompt | Qwen3-0.6B | Gemma 3 1B |
|---|---|---|
| verification, 96 fixture facts (the default page's depth) | 2,523 | 2,634 |
| verification, 400 fixture facts (the deepest: a kind, or a limit ≥ 34) | 9,993 | 10,395 |
| verification, 400 × 100 English characters | 12,565 | 12,830 |
| verification, 100 × 400 Chinese characters (at the cap) | 28,698 | 31,134 |
| verification, 400 × 100 Chinese characters | 30,819 | 32,941 (refused at its own 32,768) |
| verification, 400 × 400 Chinese characters | 114,476 (refused) | 124,166 (refused) |
| annotation: 24 known subjects, 8 earlier fixture facts, the write | 604 | 606 |
| annotation: the same with every fact at 400 Chinese characters | 2,909 | 3,132 |
| annotation: the same at 1,000 Chinese characters | 6,676 | 7,242 |

The worst fixture-shaped request, 10,395 tokens plus the 512-token reply cap, is 10,907: 16,384 leaves a third to
spare. Past the window llama-server refuses the prompt whole, before generating anything: HTTP 400
`exceed_context_size_error`, in 0.15–0.5 s. Both memory seams fail open on that, verification to NoOpinion and
annotation to no subjects. At 16,384, a verification overflows when 400 candidates average more than ~45–50 Chinese
characters (~130 English). An annotation overflows when the 8 earlier facts and the write total ~20,000 Chinese
characters. 400 candidates at the 400-character cap exceed both models' own training windows, so no cap would hold
them.

**Memory, with the app writing the preset.** Two data folders, each with the real binary and GGUFs hard-linked and 判断
bound to Qwen3-0.6B. The app was started, its warm step loaded Qwen3, and GPU memory was read by nvidia-smi (median of
five) before the app started and after. Then Gemma 3 1B was loaded as the router's second resident. Buffer sizes come
from a router started on the SAME app-written preset with `verbosity = 4` added to the two chat sections, the only
change.

| | before (uncapped) | after (16,384) |
|---|---|---|
| Qwen3 child argv | `--n-predict 512 --n-gpu-layers 99 --reasoning off` | `--ctx-size 16384 --n-predict 512 --n-gpu-layers 99 --reasoning off` |
| Qwen3 KV cache | 4,480 MiB (40,960 cells, K 2,240 + V 2,240) | **1,792 MiB** (16,384 cells) |
| Qwen3 model / compute buffers | 604 / 66 MiB | 604 / 42 MiB |
| Qwen3 projected by `--fit` | 5,150 MiB | 2,438 MiB |
| router + Qwen3 child, nvidia-smi | **+5,175 MiB** | **+2,472 MiB** |
| Gemma 3 1B KV cache (global + sliding window) | 128 + 55 MiB | 64 + 55 MiB |
| Gemma 3 1B child, nvidia-smi | +1,108 MiB | +1,026 MiB |

**Function, at the cap, against the router the app started.** A verification of 400 fixture facts was answered on
Qwen3 (9,979 / 9,993 prompt tokens, HTTP 200, 5.1–6.1 s). Its replies ran into the 512-token cap, as they did uncapped
(finish `length` on all six app-driven calls, three before and three after). A small judge shown 400 candidates
endorses most of them. The 96-candidate page was answered too. Gemma 3 1B answered 96 and 400 candidates capped, as it
did uncapped (HTTP 200 on every call, 0.2–4.5 s, the first call including the load). 400 × 100 Chinese characters was
refused by both (HTTP 400). Uncapped, Qwen3 had answered that one in 16.5 s, into the reply cap.

**Two things the cap changes besides memory**, both measured:

- **llama.cpp's `--fit` no longer shrinks the window.** Its default `--fit on` adjusts only what a launch left UNSET.
  With less free memory, simulated with a `fit-target` margin, an uncapped Qwen3 child logged `context size reduced
  from 40960 to 12032` to leave 1 GiB free. That line appears only at verbosity 4, so the window a household got
  depended on what else held the GPU at load time. With the cap and the same margin, the child logged `context size
  set by user to 16384 -> no change`. It then logged `failed to fit params ... n_gpu_layers already set by user to 99,
  abort` and loaded as asked. The footprint is now the same on every machine. A GPU without room for it is not
  measured. Every model here was already in that position, since `n-gpu-layers` has always been set.
- **The window is shared by the child's 4 slots** (`n_slots = 4`, `kv_unified = true`). At the cap, a deep verification
  (400 fixture facts) was answered with any of these in flight beside it: a fixture-sized annotation, an annotation at
  400 Chinese characters a fact, or a 96-candidate verification. So were two 96-candidate verifications at once. TWO
  deep verifications at once (~10.5k tokens each) do not fit together. llama.cpp shrank its batch down to 1, logged
  `Context size has been exceeded`, and failed BOTH with HTTP 500 in ~1.6 s. The same happened for three at once, on
  both models. The child served the next request normally. Uncapped, by the same arithmetic, it would take four at
  once (not measured).
