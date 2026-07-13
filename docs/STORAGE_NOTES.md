# Memory / LLM storage — notes (Vidora review)

Where Gatherlight keeps durable "memory" today, and what's worth borrowing from the sibling
project **Vidora** (a video-tagging app that shares our storage tech) for the LLM-related storage
layer. Reviewed 2026-07-13.

## What Gatherlight stores now

| Data | Store | Notes |
|---|---|---|
| Verified reference entities (attractions/venues/…) | `library_item` table | first-class columns; browse gallery + `library_*` tools |
| Learned facts | `knowledge` table | **already** has `confidence` + `hits` + EMA reinforcement (`KnowledgeStore`) |
| Generic JSON docs | `entity` table | kind+key+json |
| Conversation | `chat_session` / `chat_event` | SSE replay; not summarized/compacted |
| Prompts | `PromptHarness` | **already** overridable via `app_config` `cortex.prompt.{name}` |
| Portable transfer | `/api/memory/export|import` + `GATHERLIGHT_SEED_MEMORY` | the DB half of memory |

Migrations: FluentMigrator; access: Dapper + hand-written SQL (same as Vidora). The two projects
already share the storage tech.

## Already present (Vidora has it, so do we — no action)

- **Confidence + hits + EMA on learned facts** — Vidora's `tag_knowledge`; Gatherlight's
  `KnowledgeStore` matches (EMA toward 1/0, hit counting on recall).
- **Prompt override via `app_config`** — Vidora seeds `cortex.prompt.*` but *never wires it*
  (dead override). Gatherlight's `PromptHarness` actually reads the override. We're ahead here.
- **Dapper + SQLite + FluentMigrator, per-workspace DB.**

## Worth adopting (future, prioritized)

1. **Semantic recall via embeddings** — the highest-value idea. Vidora stores vectors as a binary
   BLOB + explicit `dims` + `model_id`, loads the optional **`sqlite-vec`** native extension for ANN,
   and **falls back to brute-force C# cosine** when it's absent
   (`Modules/Embedding/Services/SqliteVecLoader.cs`). Gatherlight's `recall_facts` / `library_search`
   are now **FTS5 trigram** (BM25-ranked, CJK substring — migration `202607130006` + `FtsQuery`;
   LIKE only as the `<3`-char fallback), so the *lexical* gap is closed — but that's still keyword
   matching and misses paraphrases. Adding a small `*_embedding` table + the same
   optional-native (`sqlite-vec`)-with-cosine-fallback pattern would make recall *semantic*. Embeddings
   would come from a local ONNX model (offline, no API key) — see the "Optional / future" row in
   [ROADMAP.md](ROADMAP.md) for the bundle-size tradeoff.
2. **Bounded context injection** — Vidora caps injected memory at `MaxContextEntries = 40` +
   `MaxEntryLength = 400` (`AssistantMemoryService`). If chat threads ever inject learned facts /
   library entries into the prompt, cap them the same way so a small local model doesn't choke.
3. **Model-per-consumer routing** — Vidora's `LlmService.ConsumerKey()` resolves a per-task model
   from `app_config` (`model.{consumer}.llm`). Gatherlight already has the neutral-cwd cheap-call
   seam; formalizing `model.plan` (fast) vs `model.execute` (strong) via `app_config` is a clean
   token lever when multi-model routing is wanted.
4. **Conversation compaction** — neither project summarizes threads yet; if `chat_event` history
   grows, a periodic summary row (thread → durable summary) keeps replays + prompts bounded.

## Not applicable

Per-frame/image embeddings, the local ReAct tool loop, the tagging extractor — all specific to
Vidora's video domain. Gatherlight spawns the authenticated `claude` CLI, so no local harness.
