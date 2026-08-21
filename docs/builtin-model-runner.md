# 内置 · Built-in model runner — which runtime, and why

The 记忆检索 panel lists **内置(随应用附带)** as a backend on both recall layers and says it is not shipped
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
