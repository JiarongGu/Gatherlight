# 记忆检索 · Memory recall — resharpening brief

Design notes for the next pass on the memory-recall surface. Written 2026-08-21, at the end of a session
that fixed the surface's UX defects and then found that the layer *model* underneath them needs work too.

> **BUILT 2026-08-22.** §2 shipped, and §3's questions are answered below in place. The design landed
> differently from what §2 proposed, on the household's correction: rather than one flat capability-filtered
> inventory, **each layer owns an interface and a backend serves a layer by implementing it**
> (`Agent/Llm/Sources`, catalog in `MemorySources`, shaped like `CortexConfigService.ModelCatalog`). Nothing
> filters — 语义 offers no Claude arm because no `ClaudeCliSemanticSource` exists. Proof in `e2e-p51`.
>
> Keep this document for §1, which is still the reasoning behind the weighting, and for the two open
> questions that survive at the bottom.

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

| concern | before | **shipped 2026-08-22** |
|---|---|---|
| list / pull / delete local models | `/api/manage/memory/local/{pull,remove}` | `/api/manage/models` — 资源 |
| start the local runtime | `/api/manage/memory/local/start` | `/api/manage/models/start` — 资源 |
| which model each layer uses | `/api/manage/memory/{judge,local/enable,local/disable}` | `POST /api/manage/memory/layer/{layer}` (+ `/off`) — one endpoint |
| the measured embedding-model table | 记忆检索 | 资源, with the download |
| 判断 / 语义 pickers | 记忆检索, two hand-built lists | 记忆检索, rendered from the layer's registered sources |
| the judge's model | cortex `llm.model.memory` (a SECOND writer, which won) | bound with its source; cortex row removed |

**Filter by capability, not by curated kind lists.** Each model reports what it can do; each layer offers
the models that can serve it. A model reporting *both* capabilities then serves both layers — which two
hard-coded kind sections cannot express. `OllamaModel.CanComplete` / `CanEmbed` already exist for this.

## 3. Open questions — ANSWERED 2026-08-22

- **Where does the measured recall table go?** → **资源**, with the download. The standing warning
  (don't separate a comparison from the switch it satisfies) is respected differently: the layer's picker
  offers only what is INSTALLED, and when there is nothing to offer it names the panel and the model to
  fetch. So the household is never mid-setup with no next step — but the comparison, which is decision
  support for *downloading*, sits where downloading happens.
- **Is 语义 worth its surface area?** → **Yes, but as the advanced one.** It is under a 高级 divider,
  one click, with its state still in the status pill row. The note carries Lyntai's numbers **attributed as
  Lyntai's, on Lyntai's corpus** — and that attribution stays until somebody measures this household's own,
  which is now its own backlog item. Being secondary is a reason to present a layer later, not a reason to
  drop it from "what is running right now".
- **Interaction with "Phase B embeddings"** → **its landing place is built.** An
  `EmbeddedSemanticSource : IMemorySemanticSource` plus one line in `MemorySources.Semantic` makes it a
  third arm in 语义's toggle, with no controller or client change. A judge counterpart is the same shape.
- **Does the judge's model belong in the same picker?** → **Yes, and it had to.** The two places were not
  merely inconvenient, they disagreed: cortex's `llm.model.memory` OVERRODE
  `DefaultModelByConsumer["memory"]`, so a household who set 记忆判断 to `haiku` and later moved the judge
  local had the router asking Ollama for `haiku` — fail-open on both policies, so zero calls and no error.
  The cortex row is gone; binding the layer writes source and model together.

## 3c. FIRST LOCAL MEASUREMENT (2026-08-22) — direction confirmed, magnitude not

`dev.mjs recall-bench` now asks §1's question of the corpus the advice is about. It samples the household's
own facts, has a model write one paraphrase question per fact (self-labelling: the fact's id is the answer),
and scores `recall_facts` with 判断 off and on. It prints numbers and ids only — never a fact, never a
question — and caches the generated set in the DATA folder, because that set is household content.

On this development machine — **16 facts, 12 probes, limit 3, 语义 off**:

| configuration | top-1 | miss rate | MRR | ms/query |
|---|---|---|---|---|
| 公式 only | 5/12 | 0.500 | 0.458 | **37** |
| 公式 + 判断 | 6/12 | 0.417 | 0.528 | **8 905** |

- **The direction holds:** 判断 improved every column. So the shape of Lyntai's claim survives contact with
  a different corpus.
- **The magnitude does not transfer:** −0.083 here against their −0.35. The panel's wording is therefore
  still correct to attribute the number rather than claim it.
- **A cost nobody had measured: 240× the latency.** 8.9 s per recall against 37 ms. Lyntai measured 3.0 s
  for a Haiku judge; the gap is a CLI process spawn per call. Every `recall_facts` the agent makes pays it.
  That is a real argument for the local-model arm that has nothing to do with tokens.
- **It is NOT a conclusion, and the tool says so itself.** 12 probes moves the rate by 0.08 per query. The
  first version of this bench nearly reported something worse than a borrowed number: at `limit 8` on a
  16-fact corpus, random ranking "finds" the answer 50% of the time, so 0.667 → 0.500 was measuring page
  size, not recall. It now prints the chance baseline above its own verdict.

Re-run it when the knowledge base reaches a few hundred facts; that is when the magnitude becomes worth
quoting, and when 语义 is worth A/B-ing across a restart.

## 3b. What is still open

- **A local measurement AT SCALE.** §3c has the direction on 16 facts. The magnitude needs a corpus big
  enough that a page is a small fraction of it — and 语义's own contribution needs two runs, since it is a
  startup registration.
- **The other cortex consumers.** `extract` and `scorer` are one-shot `ILlmClient` consumers, so they
  *could* take a local backend the way 判断 does — the mechanism is proven. `chat` cannot: it runs the agent
  path (`IAgentSession`) and never routes. Not attempted; recorded so the asymmetry is a known one.

## 4. What the 2026-08-21 session already did (do not redo)

All verified, `e2e-p51` green, shipped in `cadb913`:

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
