# The self-managed local LLM runtime — which one, and why

**Decision: `llama-server` (llama.cpp) in router mode, the `win-vulkan-x64` build.** Researched 2026-08-22.

We ship exactly ONE self-managed runtime. "Self-managed" means the app downloads it, starts it and owns
its lifecycle — as opposed to connecting to whatever the household happens to have installed. Both are
legitimate; this document picks the one we provision.

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

## What it costs — state these before starting

1. **Router mode is ~8 months old.** Issue #20137 ("`--models-max` not enforced under concurrent requests,
   TOCTOU race in `unload_lru`") was closed 2026-05-15 as **stale/unconfirmed**, i.e. not demonstrably
   fixed. The failure mode is over-shooting the resident-model cap under concurrency — a memory concern,
   not a correctness one, and this product issues one recall at a time. Low exposure, not zero.
2. **A process TREE, not a daemon.** We would own a coordinator and its children. Ollama is one process.
   `IOllamaRuntime`'s "start only when the port is silent" logic does not transfer unchanged.
3. **The model-management layer is Ollama-tag shaped.** `EmbeddingCatalog` ids (`embeddinggemma:300m`),
   `/api/manage/models` pull/remove, and `OllamaState` probing all assume Ollama. Migrating is real work,
   and the measured numbers in `EmbeddingCatalog` were taken through *Ollama's* quantisation — a GGUF of
   the same model is a different quantisation and must be re-measured (this is not hypothetical: the
   built-in ONNX arm of the same model scored 8/10 where Ollama's scored 9/10).
4. **Vulkan fallback is unverified.** llama.cpp builds include the CPU backend, so a machine with no
   Vulkan driver should fall back — but this product's rule is *probe, don't pattern-match*, and that has
   not been probed. It must be, before this ships.

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
