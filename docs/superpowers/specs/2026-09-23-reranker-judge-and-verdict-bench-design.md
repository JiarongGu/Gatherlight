# 判断 on a local reranker, a judge that sees the fact, and a bench for both — design

**Date:** 2026-09-23 · **Status:** approved in conversation, awaiting written review
**Branch:** `lyntai-3.2` (follows the Lyntai 3.2 upgrade, `be7233d`)

## What and why

Lyntai 3.2 can fill the memory **verification** seam with a cross-encoder (`AddMemoryScoringVerification`
over any backend producing `ProviderKinds.Score`). On Lyntai's own LoCoMo measurements a 468 MB multilingual
reranker captured **+9.0 of the 9.5** evidence-hit points a perfect judge offers, deterministically, locally
and free — where 判断 on the Claude CLI costs a model call and **9–17 s per recall**. Three things come out
of that:

1. **判断 gains a reranker option.** Verification runs locally on llama.cpp; the per-write subject tagging a
   reranker cannot do stays on the Claude CLI.
2. **The Claude judge is fixed to see the fact.** Found while verifying the 3.2 upgrade against the real CLI:
   `LlmMemoryVerificationPolicy` shows the judge only `"{n}. {Headline}"`, and `FactIndex` writes each fact's
   **topic** as its headline. So since 判断 was adopted the judge has decided "did this answer?" from topics
   alone ("weekend market" for a fact saying when the market opens) and correctly answered "no".
3. **A bench measures both, and `VerdictCombination.Fuse`.** Lyntai measured Fuse as insurance that never
   beats the base (judge and reranker alike); whether that holds on a Chinese-first household corpus, and
   what the two fixes above are worth, is measured here rather than assumed.

## Constraints that shaped it (measured, not preferred)

- **Lyntai's in-process ONNX reranker reads WordPiece (`vocab.txt`) only.** The one model proven through it,
  `ms-marco-MiniLM-L6-v2` (23 MB int8), is **English-only** (+3.0 of 9.5 on LoCoMo, −5.4 on multi-hop). The
  strong multilingual rerankers (`LAMAR-600m`, `bge-reranker-v2-m3`) are XLM-R SentencePiece, which that path
  cannot read — but llama.cpp serves them, and llama.cpp is the runtime this app already provisions. Hence
  route (owner's choice): **llama.cpp**, not in-process ONNX.
- **A reranker scores pairs and never generates**, so it cannot write subject tags. Owner's choice: tagging
  **stays on the Claude CLI** (one call per written fact), verification moves local.
- **Bench corpus** (owner's choice): a **fictional, committed zh/en fixture** — no household data, reproducible.

## Design

### 1. A reranker is a MODEL of the llama.cpp backend, not a new backend

The vocabulary rule (`.claude/rules/dev-conventions.md` §VOCABULARY): a BACKEND is where a model comes from, a
MODEL is what it serves. A reranker is a model llama.cpp serves, so the 判断 row still reads
本机模型 → llama.cpp and the model list gains rerankers. A separate `llama-cpp-rerank` backend was rejected —
the picker would show one runtime twice, the naming class this area has already paid for twice. An add-on
"重排" switch over any judge was rejected — an unmeasured combination matrix on a row just simplified.

**Kinds.** `GgufCatalog` gains `GgufCapability.Reranking`. `ResourceProvisioner.IsEmbeddingGguf` becomes the
single-writer `GgufKind(modelId)` → `Chat | Embedding | Reranking` (catalogued: a fact; household-dropped:
a stated name heuristic, "rerank" → Reranking, "embed" → Embedding). Every existing caller moves to it.

**Catalogue.** Two candidates, ranked by the bench (§4), exactly as `EmbeddingCatalog` ranks embedders:
`LAMAR-600m` Q5_K_M (468,393,760 B, MIT, 51 languages — Lyntai's best measured arm) and `bge-reranker-v2-m3`
(Apache-2.0; ahead on MTEB-zh per Lyntai's desk survey, which matters for a Chinese-first household). Each is
sha256-pinned from its published GGUF at implementation; the byte size above doubles as the check that the
file is the one measured. Only the bench decides which is recommended.

**Runtime.** `LlamaServerRuntime.WritePresets` writes, for a reranker only, `reranking = true` plus
`ctx-size`, `batch-size` and `ubatch-size` = 4096 — a cross-encoder needs the whole (query, document) pair in
one physical batch, which is how Lyntai's own harness runs the same file. `reranking` and `embeddings` never
appear together. `WarmAsync` gains the third call shape: a reranker warms through `/v1/rerank`.
**Verified against the real llama-server before anything is built on it**: router mode honours the
per-model preset and serves `/v1/rerank` for the model; recorded in `docs/self-managed-llm-runtime.md`.

### 2. A judge source owns its whole wiring

Today `GatherlightApp` always builds LLM annotation + LLM verification on `judgeSource.ClientName`. A judge
source's `Register` instead returns a `JudgeWiring` record — the annotation client name, the annotation
model, and a factory for the verifier — and `GatherlightApp` wraps both in the live `Switchable*` policies
as now. No per-kind branch in the composition root.

| bound model | annotation | verification |
|---|---|---|
| Claude CLI (any) | default client, bound model | `LlmMemoryVerificationPolicy`, default client |
| llama.cpp chat model | `memory-llamacpp` client, bound model | `LlmMemoryVerificationPolicy`, that client |
| llama.cpp **reranker** | default client (Claude CLI), `haiku` | `ScoringVerificationPolicy` over `AddHttpProvider("llamacpp-rerank", Produces = Score)`, `ProviderId` named, `EndorseCount = 8` |

**`EndorseCount = 8`** is `recall_facts`' default page. Lyntai: endorsing more than a page *replaces* the
ranking instead of refining it; the verifier request does not carry the caller's limit, so it is a constant.

**One writer for the memory model, still.** `DefaultModelByConsumer["memory"]` and the `llm.model.memory` key
the binding endpoint writes become the **annotation** model. Writing the reranker's id there would ask the
Claude CLI for a model called `LAMAR-600m` — the two-writers trap one level over.

### 3. The Claude judge sees the fact

`SwitchableVerificationPolicy` (already in front of every verifier) hands the verifier each candidate as
`"{topic} — {content}"` when `Content` is present, instead of the topic headline. Topics stay the stored
headline, so `expand_fact`'s neighbour list is unchanged. Facts are short; the extra tokens are small and
paid only where a model judges. `ScoringVerificationPolicy` already reads `Content ?? Headline` and is
unaffected.

**Recorded on both sides** (the rule in dev-conventions): a comment at the mapping says it exists because
`LlmVerificationOptions` has no way to show content and what to delete when it does; a Lyntai `TASKS.md`
Part asks for that option and names this workaround.

### 4. The bench — `devtools/scripts/judge-bench.mjs` (`dev.mjs judge-bench`)

**Fixture** `devtools/fixtures/recall-bilingual.json`, committed: ~60 invented household-shaped facts
(venues, prices, policies, people, schedules; ~⅔ Chinese, the rest English with some Japanese), including
**deliberate near-duplicates** (two markets, two ticket prices, a superseded and a current policy) so ranking
has something to get wrong — an instrument must be able to express the effect (dev-conventions rule 1).
Each fact carries four questions — same language, other language, third language, code-switched — written
without reusing its wording. Generated once through the CLI by a devtools script, reviewed, and gated by
`check-sensitive`.

**Procedure.** Seed ONE data folder from the fixture (real CLI, so subject tags exist) → snapshot it once
per arm → one server per arm on its own port → the same questions in the same order, `limit 8` → per question
set × arm: top-1, found@8, MRR, mean latency, `answered` rate; reported as differences from the 公式-only
arm. Numbers and fact ids only. A recall reinforces what it returns, so each arm's graph drifts — that
drift is part of the arm's effect, and identical start + identical order is what makes arms comparable.
(Within-run pairing, dev-conventions rule 2, is impossible here: the combination is fixed at startup.)

**Arms.** 公式 only · Claude judge **topic-only** (today's behaviour) · Claude judge with content,
partition · Claude judge with content, **fuse** · reranker, partition · reranker, fuse — the last two once
§1–2 exist, run for each catalogued reranker.

**Knobs**, startup env vars documented as measurement-only: `GATHERLIGHT_VERDICT_COMBINATION=fuse` (→
`GraphMemoryOptions.VerdictCombination`) and `GATHERLIGHT_JUDGE_INPUT=headline` (restores topic-only input).
No product default moves without the numbers.

**Cost.** ~240 recalls per Claude-judge arm → ~720 haiku calls for the three CLI arms, plus ~60 generation
and ~60 tagging calls once; about an hour of wall time with arms in parallel. Reranker arms are free.
`--n` samples fewer facts.

## What the household sees

- **判断 → 本机模型 → llama.cpp**: rerankers listed beside chat models, badged 重排, noted
  「检索时的判断在本机完成;写入时的主题标注仍用 Claude CLI」.
- **Cost line** derived from the bound arm (p51 already pins this for every arm): verification local and
  free; tagging one Claude CLI call per written fact, **and the fact text is sent to Claude** — the sentence
  a household relies on, so it must be true.
- **Measurement**: 「未在本应用数据上实测」 until the bench runs, with Lyntai's figure attributed to Lyntai's
  English corpus; then our own numbers.
- **资源**: rerankers in the one model table, badged 重排, deletable.

## Failure behaviour

- Runtime down / model not loaded → `ScoringVerificationPolicy` fails open (`NoOpinion`): 公式 ordering,
  `answered` absent. `LlamaWarmStep` already warns when the runtime will not start.
- **Binding a reranker is PROVEN first**: a real `/v1/rerank` on a small bilingual pair must return finite
  scores **with the answering document first** — Lyntai found a converted model that ranked backwards
  while passing a looser screen.
- No signed-in CLI → tagging does nothing (as today) and the row says so; verification still works.
- Reranker file deleted while bound → the existing incomplete-backend rule (fall back to the CLI), visible as
  the panel's configured-vs-running mismatch. Not changed here.

## Tests (each confirmed to FAIL with its guarantee broken)

- **p48**: the stub judge's recorded notes contain the fact's **content**, not only its topic (fails today).
- **p51**: `reranking = true` + the three batch sizes only on reranker presets, never with `embeddings`;
  warming a reranker hits `/v1/rerank`; binding a reranker writes `llm.model.memory = haiku`, never the
  reranker id; the cost line names both halves.
- **p52**: 判断 bound to a reranker → a recall POSTs `/v1/rerank` carrying the query and the fact's CONTENT;
  a write's tagging reaches the CLI **stub**, and the fake llama-server receives no chat completion.
- **Manual, recorded**: the real llama-server serves `/v1/rerank` in router mode from our preset; a zh/en
  pair ranks correctly.

## Order of work

1. §3 — the judge sees the fact (+ p48, + Lyntai Part).
2. §4 — fixture, bench, knobs; run the Claude-judge arms (topic-only · content partition · content fuse).
3. §1–2 — the reranker (runtime verification first, then catalogue, wiring, panel, p51/p52).
4. §4 again — the reranker arms for both candidates; record the numbers (a docs note, the dev-conventions
   measured-layers table, the catalogue's measurement shown in the panel) and pick the recommended model.

## Explicitly not in scope

- An in-process ONNX reranker — WordPiece-only today; revisit if Lyntai's ONNX path gains SentencePiece.
- Moving `VerdictCombination`'s product default — only if the bench shows a win, as its own decision.
- A separate 标注 (tagging) row — declined in favour of keeping tagging on the CLI.
