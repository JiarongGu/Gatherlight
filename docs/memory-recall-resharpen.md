# 记忆检索 · Memory recall — resharpening brief

Design notes for the next pass on the memory-recall surface. Written 2026-08-21, at the end of a session
that fixed the surface's UX defects and then found that the layer *model* underneath them needs work too.

---

## 1. The finding that reorders everything else

The sibling Lyntai repo's `docs/memory.md` carries a **measured** model-selection ranking for the judge
seam (`AddMemoryVerification`) — seven models on one machine, with a Claude-CLI arm:

| configuration | miss | pollution | what you pay |
|---|---|---|---|
| no judge (shipped default) | 0.5357 | 0.3331 | nothing |
| `gemma3:4b` local | 0.2571 | **0.0492** | ~1.5 s/recall, 3.3 GB VRAM, $0 |
| Claude Haiku via CLI | **0.1857** | 0.1271 | 3.0 s/recall, $66 / 1,000 recalls |

Two statements from the same document decide how the layers should be presented:

- **"0% of misses are retrieval failures."** The answers are already in the candidate set and merely
  ranked below the cut. Lyntai's own framing: *"this engine's ranking is its weakest part, and a judge is
  the only shipped mechanism that repairs it."*
- **An embedder with `SemanticSeedK = 0` recovers 0/3 paraphrases** — identical to no embedder at all
  (`tests/Lyntai.Tests/Memory/LlmSemanticRecallLiveTests.cs`; despite the name it runs on **Ollama**,
  gated by `LYNTAI_LIVE_OLLAMA`, default `nomic-embed-text`). Gatherlight sets `SemanticSeedK = 24`
  (`GatherlightApp.cs`), so our semantic path *is* reachable — but the gain still lands mostly in 判断.

**Implication for the panel.** The layers were presented as 判断 = reordering, 语义 = "changes what is
findable", which reads as though 语义 is the meaning layer. The measurement says the opposite ordering of
importance. The 语义 card now carries a sentence saying so; the deeper question below is whether the
layer's framing (and its position in the panel) should change too.

**Also on the record:** a Claude-CLI-backed *embedder* does not exist and cannot — Anthropic ships no
embeddings endpoint, `HttpEmbedder` is Lyntai's only production `IEmbedder`, and Ollama itself refuses
both cross-capability calls (verified 2026-08-21: `gemma3:4b` → `/v1/embeddings` = *"does not support
embeddings"*; `bge-m3:latest` → `/v1/chat/completions` = *"does not support chat"*). That is a narrow
technical fact and **not** a reason to describe Claude as unable to help meaning-based recall — via the
judge it is the strongest measured arm. Do not re-derive this from the type graph; read the measurement.

## 2. The restructure the household asked for

**Local models are provisioning artifacts, not memory-recall settings.** The capability split
(chat models judge, embedding models embed) is Ollama's, enforced upstream — not a product rule we chose
and could relax. So a local model carries no recall opinion: it is a file with a size, a capability and a
delete button, and it belongs in **资源 · Resources** beside chromium, git, node and the Ollama runtime
that hosts it (`ResourceProvisioner.Catalog`, `Id: "ollama"`, already a resource today).

Target shape:

| concern | today | after |
|---|---|---|
| list / pull / delete local models | `/api/manage/memory/local/{pull,remove}` | `/api/manage/models` — resource logic |
| which model each layer uses | `/api/manage/memory/{judge,local/enable}` | unchanged — recall logic |
| the measured embedding-model table | 记忆检索 | **open question** — see below |
| 判断 / 语义 pickers | 记忆检索 | unchanged, filtered by capability |

**Filter by capability, not by curated kind lists.** Each model reports what it can do; each layer offers
the models that can serve it. A model reporting *both* capabilities then serves both layers — which two
hard-coded kind sections cannot express. `OllamaModel.CanComplete` / `CanEmbed` already exist for this.

## 3. Open questions to settle before building

- **Where does the measured recall table go?** It is decision support for *which embedder to download*, so
  it argues for 资源. But `MemoryRecall.tsx` carries a standing warning against separating the comparison
  from the switch it satisfies ("turning the feature on would mean going somewhere else to finish").
  Possible answer: the table travels with the download (资源), the picker keeps a one-line recommendation.
- **Is 语义 worth its surface area at all?** Given §1, an honest panel might present 判断 as the primary
  recall control and 语义 as an advanced addition, rather than as co-equal thirds. Needs a measurement on
  *this* household's corpus before deciding — Lyntai's corpus is not ours.
- **Interaction with the existing backlog item "Phase B embeddings"** (ONNX embedder as a provisioned
  resource). That item already assumes embeddings-as-a-resource; if it lands, the 资源 move should host it
  the same way it hosts Ollama's models, and `IEmbedder` gains a second production implementation.
- **Does the judge's own model belong in the same picker vocabulary?** It is chosen in two places today —
  transport here, model in cortex's `llm.model.memory`.

## 4. What the 2026-08-21 session already did (do not redo)

All verified, `e2e-p51` green, **uncommitted at time of writing**:

- **Judge candidates are capability-driven** (Ollama's `capabilities`, catalog only as the fallback for an
  older daemon), a reason is shown when the switch is unavailable, and the `<select>` value is derived
  rather than seeded into state. The old catalog-only check was confirmed to answer **200** for an
  embedding-only judge — a fail-open policy that would have degraded recall silently.
- **Model downloads run detached** with a real progress bar aggregated across layers (`IModelPullStatus`),
  and a failed pull is recorded rather than vanishing.
- **`使用` reports what it is waiting on** and fast-fails a model Ollama says cannot embed.
- **The three layers are named by function** — 公式 / 判断 / 语义 — each carrying its *running* backend as
  a badge (`MemoryJudgeWiring` captures what was actually wired, so a saved-but-not-restarted change is
  not reported as live). Cortex's consumer label follows (`记忆判断 · Memory`).
- **The judge picker can pull a chat model** when the machine has only embedders, instead of printing an
  `ollama pull` command at a household sitting in front of a panel that downloads models.
