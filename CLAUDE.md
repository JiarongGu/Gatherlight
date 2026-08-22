# CLAUDE.md — Gatherlight

> Auto-loaded every session. Keep short — details live in `docs/` and `.claude/rules/`.

## What this is

**Gatherlight** — a self-hosted, AI-first family planner being productized from a markdown-notebook
prototype. Target architecture: **ASP.NET Core (net10.0) + SQLite** server (`src/server/`) hosting a
**React + Vite client** (`src/client/`), with all user data in a configurable untracked **data
folder** (default `local/`, env `GATHERLIGHT_DATA`). The data folder holds `site.json` (the site
manifest — record directories, capability grants, agent config; the scope guard's write-scope
renders from it), markdown plan/household artifacts under **its own private git repo** (audit
trail + diff-approval gate), the planner knowledge base (`local/.claude/` — CLAUDE.md, rules,
skills, templates the spawned agent runs on), and app state (`local/state/gatherlight.db`,
settings, uploads, caches).

The AI core: chat requests spawn the **local authenticated `claude` CLI** (never API keys) with
cwd = data folder, through a **two-gate flow** — agent drafts a plan (read-only) → user approves →
agent executes edits (scope-guarded to `plans/ household/ .claude/`) → user reviews the diff →
commit to the data repo. Deterministic work (browsing, search, file ops, budget math, scraping)
is server code / registered tools, never LLM calls — token spend is reserved for actual planning.

## Current state

All roadmap phases (0–7) plus the post-phase-7 production track of `docs/ROADMAP.md` are done: the
.NET server owns the product (plan index + fs ops, two-gate chat, SSE, uploads, tool registry over
HTTP + MCP at `/mcp`, knowledge-base seeder), the React client lives in `src/client/`, and the
legacy `viewer/` is deleted. On top of that: an **LLM-ops loop** (per-conversation ratings +
automated scorers + run traces + cortex prompt/model tuning + an eval playground), **FTS5 trigram
search**, portable **memory transfer**, **remote-access hardening** (access-token gate + TLS +
security headers + brute-force lockout), a **native C++ launcher** with two-phase **auto-update**,
and **CI/release** packaging. New server modules: `Platform/Ops/{Scoring,Trace,Cortex,Playground}`,
`Platform/Hosting/{Update,Security}`, `Platform/Storage/Memory`.

**Memory recall is a set-up surface, not a fixed behaviour** (校准 · Cortex → 记忆检索). Three
complementary layers: the always-on 公式 FORMULA floor (graph decay + rank fusion + FTS trigram), a
判断 JUDGE that annotates every write and reorders every recall, and 语义 SEMANTIC that changes what is
RETRIEVABLE. Each layer is a ROW with a backend and a model, and **a backend serves a layer by EXISTING** —
one interface per layer (`Agent/Llm/Sources`), a static catalog of implementations (`MemorySources`), and
nothing that filters.

**THREE answers to "where does this layer's model come from"** (`MemoryGroups`, keyed on what it costs the
household), which is what the picker shows — and the third one is *no model*:

| group | backends | what it costs |
|---|---|---|
| **Claude CLI** | `claude-cli` | an account, nothing local. 判断 annotates + verifies; 语义 REPHRASES — Claude has no embeddings endpoint, so it stores other wordings of each fact (`knowledge.aka`, in the trigram index) and a paraphrase matches one. Quota + a CLI spawn per call |
| **llama.cpp** | `llama-cpp` · `builtin` | disk, no quota, no address. `llama-cpp` is the runtime we download and start (both layers); `builtin` is EmbeddingGemma-300M as ONNX in our own process (语义 only, 222 MB, measured first — `docs/builtin-model-runner.md`). Models come from 资源, sha256-pinned and ranked |
| **内置** | *none* | nothing. Choosing it turns the layer off and leaves 公式 doing the work |

**内置 holds no backends, and that is its meaning.** "Off" used to be a separate 停用 button, which made
having a model look mandatory; it is a real answer to the question the row asks, so it sits in the row.
`BackendGroups` therefore keeps a group with zero sources *only* for this id — the filter that drops empty
headings would otherwise delete the option. And "off" means two different things per layer (判断 has a live
switch, 语义 unbinds), so the action is a PROP on `BackendPicker`, which knows nothing about layers.

**The name was a false claim until 2026-08-22.** 内置 labelled the llama.cpp group, whose own description
said the app DOWNLOADS the runtime and the models — 35 MB plus 222 MB–2.5 GB. The word moved to the option
that genuinely costs nothing; the group that downloads is named after what it downloads.

A fourth axis crosses these: a backend's **ORIGIN** — `bundled` · `app` · `household`, i.e. *whose* runtime
it is (`RuntimeOrigin`). `claude-cli` is the last backend where that question is live (we provision a copy
and a household may have their own, so only `Locate()` knows which won); the rest are constants. `p51` cannot
drive the `app` branch — every suite must point `GATHERLIGHT_CLAUDE_CMD` at the stub, which wins over a
planted file by design — so it is asserted in **`p50` case F**, which runs claudeless and downloads a real
file to the provisioned path. It checks the origin's TEXT as well as its kind: `Locate()` finding NOTHING
also answers `app`, phrased as an offer, so kind alone would pass for the wrong reason.

**TWO BACKENDS WERE RETIRED, for different reasons, and neither is silently redirected.** `ollama`
(2026-08-22): we half-managed it — detected, listed and depended on, but pulled and deleted from only some
screens — so 记忆检索 offered a daemon's models while nothing anywhere could add or remove one. Half-managing
someone else's runtime has no consistent version. `openai-compat` (same day): it was the one path never
tested end to end — every case in `p51` was a denial or an address round-trip against a port with nothing
listening, and the suite said so itself; nothing ever listed models from a live endpoint, embedded through
it, or answered a judgement through it. Shipping an option we cannot stand behind is worse than not offering
it. `MemoryBackends.IsRetired` covers both: binding one returns 400 and the layer carries a sentence naming
what it used to use and what to pick. A fallback would have moved 判断 to the CLI — spending quota nobody
chose — and switched 语义 off, both invisibly.

**"Worse" and "costlier" are reasons to DESCRIBE an option, not to remove it** — and *cannot* has to mean
cannot. Broken twice here (语义's missing Claude arm; Ollama's deleted pull/delete), both times by reasoning
that sounded like engineering judgement; `.claude/rules/dev-conventions.md` carries the rule and both
failures. A declined entry is only for a real impossibility — `builtin` on 判断 needs an in-process chat
model, which does not exist.

**The runtime the app provisions is llama.cpp's `llama-server`** (2026-08-22, measured: 35 MB against
Ollama's 1460, same 9/10 retrieval, 25 ms/query against 69 — `docs/self-managed-llm-runtime.md`).
`LlamaServerRuntime` runs it in router mode; `--n-gpu-layers` and warming are launch CONTRACT, not tuning,
because without either it is silently 30× slower or stalls 17 s on the first recall. Models are not portable
from Ollama — its GGUF blobs fail to load in llama.cpp — so each is a fresh pinned download.

**Models are provisioning artifacts, so 资源 owns them — the ones WE provision.** `/api/manage/models`
returns ONE list where `installed` is a field, not two arrays: the pinned GGUFs of `GgufCatalog` plus the
ONNX embedder, each with its measured ranking, all deletable, beside chromium, git and llama.cpp. It renders
as one table with one row shape, because "downloaded" is a state of a model rather than a different kind of
object — it was three components and three left edges before. 记忆检索 keeps only the recall decision: which
model each layer uses. Rebuilding the index runs detached with progress, and the panel reports index
COVERAGE rather than a history of runs. Lyntai's measurement that 0% of recall misses are retrieval failures
is **attributed as Lyntai's, on Lyntai's corpus** — it is a statement about a stack that HAS an embedder, so
it cannot also be the reason an install without one is offered nothing.

On top of THAT, the **platform/container track** (S1–S6, `docs/ROADMAP.md`) turned the app into a
host for one agent-driven site: `site.json` declares the site and drives the scope guard; capabilities
carry provenance and non-platform ones run sandboxed; drafts, escalations and approval cards are
platform chrome built from enforced grants; `Gatherlight.Platform` → `Gatherlight.Planner` is a
compiler-enforced boundary; chat history replays the stored event stream; and a gate parked on a human
decision survives a restart.

The agent's own UI is declarative: `Platform/Agent/Ui` validates a component tree that renders both
inline in chat and as site pages from `{data}/ui/` — no raw HTML anywhere in the agent's reach. A
`Table`/`Chart` can `bind` to a named server-side query, so a page reads live data instead of a copy.

**The agent works against three app-managed files in `{data}/.claude/`**, all version-gated and
re-issued by the app (never editable knowledge-base content): `hooks/scope-guard.mjs` (its jail),
`ui-spec.md` (the component vocabulary) and `tool-spec.md` (how to author its own capability —
including what the sandbox refuses, parsed from the shipped `cap-guard.mjs` so it cannot drift).
Anything that replaces a record subtree — notably backup import — must re-issue them.

- `tools/pdf-form/` — a Node utility (pdf-lib + fontkit) for PDF AcroForm inspect/fill/merge,
  invoked by the C# document tools via `NodeLeafTool` (reliable on real + CJK PDFs where PDFsharp
  threw). The former `tools/puppeteer/` scrapers are fully ported to C#/Playwright and removed —
  Phase 7 is done; the registry can't tell a Node leaf from a native tool.
- The shipped planner knowledge base lives in `src/server/Gatherlight.Server/Assets/SiteTemplate/`
  (scrubbed, generic; carries the `site.json` manifest) and is seeded/upgraded into data folders by
  `ZhikuSeeder` — the live family knowledge base in `local/.claude/` is user data and diverges freely.

## Rules

- **`.claude/rules/sensitive-info.md` — read it.** No family data, no absolute dev paths, no
  planner content in tracked files or commit messages. Pre-commit guard:
  `devtools/scripts/check-sensitive.mjs` (private tokens in gitignored
  `local/sensitive-patterns.txt`). History was reset on 2026-07-13 to remove exactly such leaks.
- **User data lives ONLY in `local/`** (own private git repo). Never move it back into this repo.
- **LLM via the authenticated `claude` CLI only — never an API key.** The CLI is a *provisioned resource*
  (资源 panel → `{data}/state/resources/claude`), not a machine dependency we assume; `ClaudeCliRuntime`
  resolves + probes it. **The app STARTS the browser login** (资源 → the CLI's row → 登录, spawning the
  RESOLVED binary — the old advice "run `claude auth login` in a terminal" was unactionable for a copy we
  installed, whose directory is never on PATH) but cannot COMPLETE it: that step needs a human in a browser
  and has no headless variant. **Whose login it uses is a choice** — the machine's (default) or the app's
  own in `{data}/state/resources/claude/home`, via `CLAUDE_CONFIG_DIR`, because one OS user otherwise means
  one shared session. Signing out is offered only for the app's own; the machine's is the household's.
- **Backend = three projects** (`Gatherlight.Platform` → `Gatherlight.Planner` → `Gatherlight.Server`
  → `Gatherlight.Host`; namespaces unchanged, `Platform/<Group>/<Name>` / `Product/Planner/<Name>`;
  controller → service → repository; Dapper + hand-written SQL, snake_case columns, FluentMigrator
  `YYYYMMDDNNNN` migrations; variation points are interfaces resolved via DI, never if/else chains).
  **Platform must never reference Planner** — the compiler enforces it; `dev.mjs check-layering`
  guards the reference graph; details in `.claude/rules/dev-conventions.md`.
- **Working files** (probes, drafts, captures) go under `devtools/` with a `_` prefix (gitignored),
  never OS temp.
- **Never commit without explicit user approval.**

## Dev loop

- `node devtools/dev.mjs server` — the .NET server (port 5317, data folder `./local`; serves the
  built client from wwwroot when present).
- `node devtools/dev.mjs vite` — client HMR on :5173 (proxies `/api` + `/mcp` → 5317).
- `node devtools/dev.mjs build` — client build → wwwroot + dotnet build.
- `node devtools/dev.mjs e2e [pN|all]` — API e2e suites with a stubbed claude CLI against
  isolated `devtools/_e2e-*` data folders. Keep them green; each phase of work lands with its suite.
- `node devtools/dev.mjs host` — the desktop management console (hosts the server in-process +
  monitors health); `publish` builds the shippable bundle (framework-dependent host — the launcher
  installs the .NET 10 runtime on first run — + native launcher).
- `node devtools/dev.mjs eval [scenarios.json]` — the prompt/agent playground (dry-plan + auto-score,
  a quality benchmark to run before/after tuning); `memory <export|import>` transfers DB memory;
  `embed-bench [models…]` re-measures the embedding shortlist that `EmbeddingCatalog` quotes.

Interactive family planning happens in the data folder, not here: run `claude` from `local/`
(its own CLAUDE.md + knowledge base apply there).
