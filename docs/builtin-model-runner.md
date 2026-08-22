# 内置 · Built-in model runner — which runtime, and why

The 记忆检索 panel lists **ONNX**, under the **内置** heading, as a backend on both recall layers and says it is not shipped
yet. This document picks what will implement it. Written 2026-08-22.

**Terms** (see `.claude/rules/dev-conventions.md`): a **backend** is *where a model comes from* —
`claude-cli`, `ollama`, `builtin`. `builtin` means a runtime inside the install (`res/`), with no daemon to
start and no separate install for the household. It is deliberately **not** called 嵌入式, because 嵌入
already means *embedding* in this panel and the collision cost a whole design conversation once already.

---

## The decision

**语义 first, on ONNX Runtime + `Microsoft.ML.Tokenizers`.** 判断 stays on its two existing backends.

| | 语义 (embeddings) | 判断 (chat) |
|---|---|---|
| pick | **ONNX Runtime** (`Microsoft.ML.OnnxRuntime`) | **not now** — and if ever, LLamaSharp, not ORT GenAI |
| why | one encoder forward pass is all this layer needs; first-party .NET; CPU-viable | a usable judge is a 3–4B model, which means GGUF quantisation and a large native payload |

### Why 语义 is the layer that gets it

语义 is the layer with **one** backend. 判断 already has two, so a third buys it far less. And the gap 语义
has is exactly the one 内置 closes: today it needs the household to install Ollama and pull a model before
the layer can be switched on at all — the only recall layer with a setup prerequisite outside the app.
**That last clause was wrong** and is corrected in `self-managed-llm-runtime.md`: 资源 had been
provisioning and starting Ollama since the day before this was written, so the prerequisite was a
PROCESS, not an install. The reasoning below still holds — 语义 was the layer with one backend, and
in-process is still the only option with no daemon — but it was argued from a premise that did not
survive checking.

### Why ONNX Runtime over the alternatives

- **In-process, so it is genuinely 内置.** No port, no daemon, nothing to start or keep running. LLamaSharp
  is also in-process, but for an *encoder* it buys nothing ORT does not already give.
- **First-party .NET.** `Microsoft.ML.OnnxRuntime` plus `Microsoft.ML.Tokenizers` — the .NET team's own
  tokenizer library — so there is no FFI layer of ours to maintain, on a stack that is already .NET 10.
- **CPU is enough.** An embedding is a single forward pass; this is the one model job in the app that does
  not want a GPU. That matters because `GpuLikely` is a *guess* everywhere else it appears.
- **It fits `ResourceProvisioner` unchanged.** The model is a sha256-pinned download into
  `{data}/state/resources/`, exactly like git and node; the ORT native libs ride in `res/` like the
  Playwright driver. No new provisioning concept.
- **Licence.** MIT, both packages.

### Why NOT ONNX Runtime GenAI for 判断

It is the faster runtime on paper (DirectML/CUDA kernels, and embeddings are reachable via
`--extra_options include_hidden_states=true`), but a judge model has to *fit a household machine*, and that
means 4-bit GGUF. Model availability in GGUF dwarfs ONNX, and the ONNX path would have us exporting and
pinning generative models ourselves for no gain the household can feel — 判断 on the CLI costs tokens but
is instant, and 判断 on Ollama already works. **Deferred, not rejected**: if it lands, LLamaSharp.

## MEASURED 2026-08-22, before writing any of it

A scratch probe (`devtools/_onnx-probe`, gitignored) against
[`onnx-community/embeddinggemma-300m-ONNX`](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX)
pinned at commit `5090578d9565bb06545b4552f76e6bc2c93e4a66`. Four things were unknown and every one of them
fails SILENTLY — a wrong tokenizer, variant, prompt or pooling gives worse recall, never an error — so they
were measured rather than assumed.

**The graph settles pooling for us.** Inputs are `input_ids` + `attention_mask` (int64); outputs are
`last_hidden_state [b,s,768]` **and `sentence_embedding [b,768]`**. The export carries the
sentence-transformers pooling head, so the single most likely way to produce a plausible-but-wrong vector
is not ours to get wrong. `hidden_size: 768` also matches `EmbeddingCatalog`'s recorded 768 for this model.

**Cosine against Ollama is the WRONG instrument, and finding that out mattered.** No prompt variant matched
(0.67–0.84) and *which* variant came closest flipped between texts — the signature of two different
quantisations of the same weights, not of a prompt mismatch. Vector compatibility is irrelevant anyway: a
backend change already forces a reindex, which the binding endpoint reports. What matters is retrieval, so
that is what was scored — both embedders, one fixture, same machine:

| embedder | top-1 | top-3 | 16 embeds |
|---|---|---|---|
| **内置 · ONNX q4, raw (symmetric)** | **8/8** | 8/8 | **512 ms** |
| 内置 · ONNX q4, document prompt | 7/8 | 8/8 | — |
| 本机 · Ollama `embeddinggemma:300m` | 8/8 | 8/8 | 10 677 ms |

**SUPERSEDED 2026-08-22 — and both of the headline numbers above were wrong.** Once the backend was wired,
`dev.mjs embed-bench` scored it on the same 10-query fixture `EmbeddingCatalog` uses, through the app's own
`OnnxEmbedder` (`POST /api/manage/models/embed`, which exists for exactly this):

| embedder | runs | top-1 | top-3 | ms/query |
|---|---|---|---|---|
| 本机 · Ollama `embeddinggemma:300m` | ollama | **9/10** | 10/10 | 69 |
| **内置 · ONNX q4** | in-process | **8/10** | 10/10 | **28** |

Two corrections, both in the direction of the thing we had already chosen — which is the direction to be
most suspicious of:

* **The tie was an artifact of the fixture.** 8/8 against 8/8 says only that neither embedder failed. Ten
  queries separate them: 内置 places the right fact first once less often. Same weights, different
  quantisation, so a small difference is the expected shape of this trade — but "实测同分" shipped in the
  panel, the resource row and the release notes as a measured fact, and it was not one.
* **"~21× faster" compared a warm ONNX session against a COLD Ollama.** The 10 677 ms above is dominated by
  Ollama loading the model. Warm against warm it is 28 ms vs 69 ms — 内置 is still faster, because it skips
  an HTTP hop, but the honest figure is **2.5×**, not 21×.

Latency across these two rows is not like-for-like in any case (an ORT **CPU** session in-process against a
**GPU** server one hop away); it is what the household experiences from each, which is the comparison that
matters, but it is not a comparison of the two models.

Three decisions fall out, none of them guesses any more:

1. **q4, not fp32 or int8.** It ties Ollama on this fixture at **197 MB** against fp32's 1.23 GB. Total
   payload with the SentencePiece tokenizer (4.7 MB — not the 20 MB `tokenizer.json`, which
   `Microsoft.ML.Tokenizers` cannot load anyway) is **~222 MB**, versus 622 MB for the Ollama model *plus*
   the Ollama runtime download. 内置 is the SMALLER path, which is the opposite of what "bundle a runtime"
   sounds like.
2. **Raw/symmetric prompting.** embeddinggemma is asymmetric by design (`task: search result | query: ` for
   queries, `title: none | text: ` for documents), so the obvious move is to apply them — and it measured
   WORSE (7/8). Symmetric is also what this app already does, so the built-in path matches the product
   rather than diverging from it. Do not "fix" this without re-running the fixture.
3. **The recorded 9/10 does NOT transfer verbatim — confirmed, and it is 8/10.** `EmbeddingCatalog`'s
   numbers were measured through Ollama's quantisation; this is a different one, and the caveat about an
   8-query fixture applied to this page's own table. Re-measured on the catalog's 10-query fixture once the
   backend was wired (see the superseded block above), 内置 scores 8/10 top-1 / 10/10 top-3 where the Ollama
   arm scores 9/10 / 10/10. That number now lives on the `ModelOption` the 内置 picker returns, so the panel
   states it instead of implying a tie.

**Cheap and repeatable:** the probe is ~150 lines and the oracle (an Ollama holding the same model) is
already on the development machine. Re-run it before changing the variant, the tokenizer or the prompting.

## What it costs us

Three things, all of which the panel must state rather than discover at runtime:

1. **A curated model set, not "any model".** ORT needs a per-model ONNX export plus its tokenizer config, so
   内置 offers the one or two embedders we export and pin — not the free-form field 本机 · Ollama has. That
   is the correct trade for a no-setup option, and the picker must say so instead of looking broken.
2. **Native payload in `res/`.** ORT CPU is the only EP worth shipping; DirectML would double the bundle for
   a forward pass that does not need it.
3. **Vector width is a commitment.** Switching between 本机 and 内置 changes the embedder, so it invalidates
   every stored vector exactly as a model change does — `reindexRequired` already covers this, and the
   binding endpoint's existing `modelChanged` check must extend to a **source** change too.

## How it lands

`Agent/Llm/Sources` is already shaped for it — this is the seam the per-layer source design exists to have:

1. `BuiltInSemanticSource : IMemorySemanticSource` — `StatusAsync` reports whether the model is provisioned,
   `ModelsAsync` returns the curated set, `ProveAsync` runs one real embed (the same "installed is not
   usable" rule the Ollama arm follows), `Register` adds the `IEmbedder` + vector store.
2. One line in `MemorySources.Semantic`, and **remove** the `builtin` entry from
   `MemorySources.SemanticDeclined` — the same commit, or the panel lists it twice.
3. A `ResourceSpec` for the model, sha256-pinned.
4. `p51`'s `bindable(semantic, 'builtin') === false` assertion **flips to true** — deliberately, so nobody
   can land the source without noticing the suite's claim about it changed.

No controller change, no client change, no capability table to update.

## Sources

- [Run Phi models locally in C#: Ollama vs ONNX vs Foundry Local](https://medium.com/@bhargavkoya56/run-phi-models-locally-in-c-ollama-vs-onnx-vs-foundry-local-e05f30f5f6d3)
- [ONNX Runtime GenAI — generating embeddings (hidden states)](https://github.com/microsoft/onnxruntime-genai/discussions/474)
- [ONNX Runtime C# getting started](https://onnxruntime.ai/docs/get-started/with-csharp.html)
- [Hugging Face tokenizer → ONNX, for cross-language embedding generation](https://github.com/yuniko-software/tokenizer-to-onnx-model)
- [Top .NET AI/LLM open-source projects](https://amarozka.dev/top-dotnet-ai-llm-open-source-projects/)
