# Gatherlight productization roadmap

Porting the legacy markdown-notebook prototype into a .NET + SQLite self-hosted web product.
Each phase ends buildable/verifiable. Details live in the phase's PR/commit descriptions.

| Phase | Scope | Status |
|---|---|---|
| 0 | Privacy/repo reset: user data → untracked `local/` (own private git repo), pre-reset history archived to `local/archive/`, fresh main-repo history, sensitive-info pre-commit guard | ✅ 2026-07-13 |
| 1 | .NET skeleton: `Gatherlight.slnx`, `src/server/Gatherlight.Server` (ASP.NET Core net10.0), data-folder context, SQLite + Dapper + FluentMigrator initial schema, `/api/health`, devtools dispatcher | ✅ 2026-07-13 |
| 2 | Read side: data-repo git service, plan index (SQLite-backed browse/search, zero-LLM), plans/content/assets API, fs ops (delete/retitle/rename) with auto-commit | ✅ 2026-07-13 (e2e-p1) |
| 3 | LLM core: claude CLI runner (stream-json), two-gate chat state machine, SSE streaming, scope guard, uploads | ✅ 2026-07-13 (e2e-p2 + real-claude smoke) |
| 4 | Frontend port: `viewer/frontend` → `src/client` on the .NET API; delete legacy `viewer/` | ✅ 2026-07-13 |
| 5 | C# tool registry + HTTP MCP endpoint (hand-rolled JSON-RPC) for the spawned agent; Node tools wrapped as leaf subprocesses | ✅ 2026-07-13 (e2e-p3 + real-CLI MCP probe) |
| 6 | Knowledge-base split: scrubbed product template (`Assets/SiteTemplate/`) + seeder with hash-based upgrades; repo `.claude/` becomes dev rules | ✅ 2026-07-13 (e2e-p4) |
| 7 | C#-native tool ports — incremental, one tool per commit | ✅ 2026-07-13 (all 8 scrapers ported; `tools/puppeteer` deleted) |

### Phase 7 progress

| Tool | Status |
|---|---|
| `wiki_info` (Wikipedia REST + Wikidata official-site, pure HttpClient) | ✅ 2026-07-13, live-verified |
| `scrape` (Playwright .NET headless chromium via `PlaywrightHost`; replaces the Node puppeteer leaf; `dev.mjs fetch-tools` installs the browser) | ✅ 2026-07-13, live-verified on a JS-rendered Google Flights deeplink |
| `flight_schedule`, `policy_check` → **C#/Playwright native** | ✅ 2026-07-13. Shared `PlaywrightScraper` (navigate+extract on the one browser) + deterministic parse tested end-to-end against a local fixture server (e2e-p11: schedule extraction + fabricated-code detection; visa-required + max-stay + types). Node leaves deleted. |
| `flight_prices`, `hotel_prices`, `hotel_info`, `restaurant_info` → **C#/Playwright native** | ✅ 2026-07-13 (e2e-p12, 23 checks). On the shared `PlaywrightScraper` (now also `FetchLinksAsync` for DuckDuckGo result anchors + an `H1`). `flight_prices`/`hotel_prices` parse Kayak/Booking price text; `hotel_info`/`restaurant_info` DDG-search → classify trusted domains → verify (Tabelog table / generic name). Fixture seam: `GATHERLIGHT_FIXTURE_ORIGIN` rewrites any real-domain navigation to a local server while tools still classify the original URL. **All Node puppeteer leaves + `tools/puppeteer/` deleted.** |
| `fill_itinerary` (visa AcroForm) | ✅ registry tool; now one case of the general document subsystem |
| **General document/media subsystem** — `Platform/Capabilities/Documents`: `pdf_inspect` / `pdf_extract_text` / `pdf_fill` / `pdf_merge` + `image_info` / `image_resize` / `image_convert`. Library split: PdfPig (extract), pdf-lib leaves (form inspect/fill/merge — reliable on real + CJK PDFs), ImageSharp (images). PDFsharp evaluated + dropped (its AcroForm fill + page-import both threw on real PDFs). | ✅ 2026-07-13 (e2e-p10, 14 checks) |
| Zero-LLM ICS export — trip/daily plan → `.ics` (`GET /api/plans/ics`, one all-day event per dated Day heading; changelog dates excluded) + client download button | ✅ 2026-07-13, live-verified on the real 17-day trip (17 events) |
| Zero-LLM budget scan — `GET /api/plans/budget` + `budget_scan` tool: author-declared caps/totals, per-currency mention counts, excluded/rejected lines flagged. Honest by design (budgets are free-form: options, per-person vs total, "不计入预算" — so it never fabricates a net sum) | ✅ 2026-07-13, live-verified on the real budget (found cap AUD 12,000 + Path-A hit 12,200) |

### Production readiness (post-phase-7)

| Item | Status |
|---|---|
| **Real-claude smoke** — `dev.mjs smoke` drives the full two-gate loop against the actual authenticated CLI (no stub) on an isolated data folder; the one path the deterministic e2e can't cover | ✅ 2026-07-13, verified (real plan + execute → scoped `plans/` commit; MCP reachable) |
| **Client bundle** — `manualChunks` (react/antd/markdown/vendor) + lazy-loaded leaflet map + dropped dead `html2pdf.js`. First-load gzip ~433kB → ~381kB, map deferred, >500kB warning gone | ✅ 2026-07-13 |
| **Packaging** — `dev.mjs publish` → self-contained single-file exe (runtime + client + template + native libs bundled). See [DEPLOYMENT.md](DEPLOYMENT.md) | ✅ 2026-07-13, published exe verified booting (health + client + 20 tools) |
| **Knowledge library** — DB-backed `library_item` + browse gallery (知识库) + agent tools (upsert/search/import); migrated the markdown attractions library (48 entries) into the DB, dropping trip/family lines. The SQLite DB stays outside git (source of truth → back up the data folder). | ✅ 2026-07-13 (e2e-p13, 34 checks) |
| **Desktop management host** — `Gatherlight.Host` (WinForms + WebView2, resizable/DPI-correct) renders the `/manage` "lantern control room" (health monitor + counts + controls) with a polished native tray + window-position persistence; hosts the server in-process. Users open the planner in a browser. `dev.mjs host`. | ✅ 2026-07-13, verified |
| **Memory transfer** — `/api/memory/export|import` (portable bundle: library + facts + entities + tuned cortex config) + `GATHERLIGHT_SEED_MEMORY` startup seeding; console + `dev.mjs memory`. | ✅ 2026-07-13 (e2e-p14) |
| **Eval / LLM-ops** — per-conversation 1–5 ranking (chat_feedback) + `/manage` observability tab (stats / transcripts / JSONL tuning-dataset export). | ✅ 2026-07-13 (e2e-p15) |
| **Cortex tuning** — `/manage` 校准 tab + `/api/manage/cortex`: edit the prompt templates (`cortex.prompt.{name}`, placeholder-contract validated) + model routing (`llm.model.{chat,extract}`) live from `app_config`, reset to shipped default. The write side of the LLM-ops loop (rank → inspect → tune). | ✅ 2026-07-13 (e2e-p16, 19 checks) |
| **Automated scorers** — Mastra-inspired (design taken from the Mastra source): each conversation auto-scored 0–1 on 智库-rule dimensions — scope-adherence / plan-structure / outcome / citations (deterministic) + answer-relevancy / faithfulness (cheap-LLM judge). Auto-runs on commit; `/manage` 自动评分 panel + `/api/manage/scores/*`; scores enrich the JSONL tuning dataset. | ✅ 2026-07-13 (e2e-p21) |
| **Run traces** — Mastra observability: `/api/manage/trace/{id}` structures the chat_event stream into a run timeline (phase durations + tool calls + LLM runs w/ tokens/cost + totals). `/manage` conversations expand to the trace + that conversation's scores. | ✅ 2026-07-13 (e2e-p21, 17 checks incl. traces) |
| **FTS5 recall** — library + fact search upgraded from LIKE to BM25-ranked FTS5 with the `trigram` tokenizer (CJK-capable substring matching), external-content tables kept in sync by triggers, `<3`-char LIKE fallback. Lexical (not embeddings — fastembed/ONNX is the follow-up); zero new deps, offline. | ✅ 2026-07-13 (e2e-p22, 11 checks) |
| **Prompt/agent playground** — Mastra `runEvals`, a CLI harness (`dev.mjs eval [scenarios.json]`, not a website surface): runs each scenario through a dry plan (read-only, no commit) + auto-scores the output (no-persist) → per-scenario + aggregate table. Run before/after tuning the cortex to measure the delta. `POST /api/manage/eval/run`. | ✅ 2026-07-14 (e2e-p23, 12 checks) |
| **Structured publish** — `dev.mjs publish` → `dist/Gatherlight/` (launcher · libs/ · res/ · data/) + zip + sha256 manifest; the server self-locates `res/` + `data/`. | ✅ 2026-07-13, verified |
| **Remote-access hardening** — loopback-trusted access-token gate on `/api` + `/mcp` (Bearer / header / httpOnly cookie), SPA login screen, per-IP login brute-force lockout, fail-closed binding (refuses non-loopback without a token), `trustLoopback:false` for same-host proxies. `security.*` in settings.json / `GATHERLIGHT_BIND`·`_ACCESS_TOKEN`·`_TRUST_LOOPBACK`. | ✅ 2026-07-13 (e2e-p17, 19 checks) |
| **TLS / HTTPS** — Kestrel-native HTTPS (`security.tls.enabled`): self-signed cert generated + reused from `state/gatherlight-tls.pfx`, or bring your own PFX (`certPath`/`certPassword`). Secure cookie flag flips under HTTPS; desktop host trusts its own loopback cert. | ✅ 2026-07-13 (e2e-p18, 11 checks) |
| **Security headers** — CSP (calibrated to the app + verified with a headless Edge render: 0 violations, full visual integrity) + `nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy` / `Permissions-Policy` on every response. | ✅ 2026-07-13 (e2e-p17 header asserts + headless render) |
| **App icon** — `src/assets/gatherlight.ico` (amber 拾 seal, 9 sizes, BMP frames) generated by `make-icon.ps1`; the exe/window/tray icon + web favicon. | ✅ 2026-07-13 |
| **Native launcher** — `src/launcher/` C++ `Gatherlight.exe` (carries the icon, resolves the install root, launches the self-contained host); built into the bundle by `build-production.mjs` (MSVC; falls back to `Gatherlight.cmd`). | ✅ 2026-07-13, launch→server verified |
| **Build + release** — root `build-production.ps1` / `build-resource.ps1` / `publish-resources.ps1`; single **manual-trigger** `.github/workflows/release.yml` (`workflow_dispatch`: version bump → e2e gate → bundle → optional tag → GitHub Release zip + manifest). No auto CI on push/PR (D3dx-style). | ✅ 2026-07-13 (release model revised 2026-07-14) |
| **Auto-update** — two-phase (D3dx-style): server checks the configured GitHub release + downloads/stages `{install}/.update/staged` (sha256-verified against the release manifest); the native launcher overlays it on the next restart. `/manage` 更新 card drives it; `selfUpdate.githubRepo` config. | ✅ 2026-07-13 (e2e-p19 apply + e2e-p20 check/stage) |

### Platform maturity (2026-07-15 → 07-29)

| Item | Status |
|---|---|
| **Data foundation** — whole-install backup (git history + settings included), data-structure spec, onboarding, markdown index + MCP surface | ✅ 2026-07-15 |
| **Knowledge-base upgrade migration** — an LLM-assisted merge for `.claude/` files the household has customized, so a template upgrade never silently overwrites their edits | ✅ 2026-07-16 (e2e-p27) |
| **Error-continuity memory** — a chat run that FAILS still records its turn to the durable thread, so the next turn knows what was attempted | ✅ (e2e-p25) |
| **Background jobs** — generic scheduler backend (recurring + one-off) driving report/reminder/tool runs, with `notify_user` | ✅ (e2e-p26) |
| **Lyntai adoption** — scoring, the two-gate agent session, jobs, the conversation store and the cortex (prompt registry + model routing) all moved onto the shared `Lyntai` library; the native `ClaudeCliRunner` deleted, `chat_score`/`chat_session`/`chat_event` migrated to `lyntai_*`. The app keeps its business logic and reaches Lyntai only through its APIs. | ✅ 2026-07-19 → 07-21 |
| **Startup migration runner** — versioned ordered steps on `ApplicationStarted` behind a 503 gate, with a `/manage` progress overlay, essential/best-effort policy, retry and self-heal; replaced the inline pre-listen startup block | ✅ 2026-07-21 (e2e-p29) |
| **Differential auto-update** — `UpdateService` diffs installed vs release manifest and HTTP-Range-fetches only the changed files out of the release zip, with a hard fallback to the full download. No launcher, CI or build change. | ✅ 2026-07-22 (e2e-p30) |
| **Gatherlight as MCP client** — connect *out* to external MCP servers: client + proxy foundation, an in-chat confirmation gate for adding one, a generic QR/browser interactive-login component the agent can drive, and npx/`.cmd` launch on Windows | ✅ 2026-07-22 (e2e-p31…p35) |
| **Hosted judge tools** — the LLM-judge scorers can open the real artifact instead of grading a truncated excerpt, through Lyntai's `AddMcpToolHost` on the one-shot `ILlmClient` path only. Jailed read-only to `plans/ household/ .claude/` — never `state/` — so the judges gain no reach the scope guard doesn't already grant. | ✅ 2026-07-29 (e2e-p36) |

## Platform / container track (2026-08)

Gatherlight becomes a **host, container and harness for one agent-driven site**; the planner is that
site. Design of record: [`superpowers/specs/2026-08-04-site-model-container-design.md`](superpowers/specs/2026-08-04-site-model-container-design.md).

| Sub-project | Scope | Status |
|---|---|---|
| **S1** | **Site manifest + platform seam** — `site.json` declares records, capabilities, agent config and template version; `IDataContext` splits into `ISiteContext` / `IPlatformContext`; the scope guard's write scope is generated *from the manifest* instead of hardcoded; the manifest ships in the site template and is written on startup for data folders that predate it | ✅ 2026-08-05 (e2e-p37) |
| **S2a** | **Capability model + sandbox** — one registry carrying provenance across four origins (`Platform` available by default · `Script`/`Mcp` off until enabled · `Draft` never loaded); non-platform capabilities run under `node --permission` with a platform preload that removes the network; the launcher **fails closed** when the runtime can't sandbox; `deny` spans CLI built-ins as well as MCP tools | ✅ 2026-08-05 (e2e-p38) |
| **S2b** | **Drafts, approval cards + escalation** — a drafted tool is inert until a human promotes it; a refused capability becomes a **resumable decision** rather than a dead end; permission sentences render server-side from the enforced grant, never from agent text | ✅ 2026-08-05 (e2e-p39, p40) |
| **S3a** | **Declarative UI protocol** — the agent's UI is a validated node tree, never markup: a DI collection of `IUiNodeSchema` (fourteen components), one validator serving both mounts (a ```ui fence in a streamed turn + a page spec from `{data}/ui/`), `rehype-raw` and the sanitize allow-list deleted, and a drift check between the C# schema and the TS renderer | ✅ 2026-08-05 (e2e-p41) |
| **S3b** | **Site authoring loop** — the agent may write pages *and only pages* (`ui/` flat, `.json` only); a page change is reviewed by **rendering it** at the diff gate with a change summary computed from the two trees; an invalid page cannot be committed; a page button may call an already-approved capability | ✅ 2026-08-05 (e2e-p42) |
| **S4** | **Product extraction** — the split into `Gatherlight.Platform` / `Gatherlight.Planner` assemblies, making "Platform must never reference Planner" a compiler fact rather than a tested convention; `dev.mjs check-layering` asserts the reference graph | ✅ 2026-08-05 |
| **S5** | **Conversation history** — every agent event is persisted as its SSE payload verbatim and replayed through the **same reducer** the live stream feeds, so there is no history view to drift; a thread is one turn, a conversation is the run of turns sharing a `ConversationId`; a replayed gate renders **without** actions | ✅ 2026-08-05 (e2e-p43) |
| **S3c** | **Pages that stay true** — a `Table`/`Chart` can `bind` to a NAMED query (`IUiDataSource`, closed parameter set) instead of carrying a frozen copy of the data; resolution is server-side, so the client is never handed a query and the diff gate reviews live data. Plus `Chart` (inline SVG, no dependency) and composites — a named parameterized subtree, one level, whole-value substitution, expanded before the limits apply | ✅ 2026-08-06 (e2e-p45) |
| **S6** | **A parked decision survives a restart** — a session that was mid-run still fails (its child process is gone), but one PARKED ON A HUMAN DECISION comes back with working buttons, re-taking the app-wide agent lease. The diff gate is rebuilt from the working tree rather than remembered, so approval commits what the reviewer was shown. Matters because auto-update restarts the server | ✅ 2026-08-06 (e2e-p46) |
| — | **The agent's own MCP channel** — the agent's tools come from a loopback-only Kestrel endpoint (plain HTTP, ephemeral port, per-start bearer token, `/mcp` only), not the public listener. Turning on TLS or `trustLoopback:false` used to leave the agent with **zero tools, silently**. | ✅ 2026-08-06 (e2e-p44) |

## Optional / future

Reviewed 2026-08-06/07 and **all declined** — recorded here with the reasoning so they are not
re-proposed as oversights. Each was a real deferral, and each is still the right call. A pattern
worth noticing across three of them: the benefit a deferral was written to buy had *already been
obtained by other means* by the time it came up (S3a dropped `rehype-raw` without migrating the map
divs; S2a proved the capability model without moving `fill_itinerary`; p28 gave `NEEDS_INPUT` its
buttons without a `choice` block). A deferral is worth re-reading against what shipped since, not
just executing.

| Idea | What it's for | Why declined |
|---|---|---|
| **OS-level sandbox** — ❌ declined | A low-privilege OS account + firewall rules: the containment ceiling above the `node --permission` sandbox, closing the residuals the PreToolUse hook structurally cannot (code run *inside* an agent-authored script, exfil through a `WebFetch` URL). | **Wrong shape for this product.** The `claude` CLI's authentication is per-user, so a low-privilege service account breaks the one mechanism the whole architecture rests on — and the agent already runs with the household's own credentials by design. The honest containment ceiling for a self-hosted personal app is the machine itself; pretending otherwise would buy a security *story* rather than a boundary. |
| **Sandboxing external MCP servers** — ❌ declined | Contain `Mcp`-origin capabilities the way `Script` ones are contained. | Meaningfully containing an arbitrary `npx` stdio server needs exactly the OS-level work above, and `node --permission` cannot wrap one without breaking most real servers. They are third-party processes a human explicitly added through a gate. **The cheap half was taken instead**: the add-gate now *says* the server runs unsandboxed with the user's privileges, because a card that stays silent about the grant it is asking for is the defect the card model exists to prevent. |
| **Non-claude agent backend** — ❌ declined | Run `codex` or another CLI behind `IAgentSession`; plus stdio transport for the app's own tools. | Optionality, not capability. The MCP-channel work already removed the claude-only coupling, so this stays cheap to pick up the day a second authenticated CLI is actually available. Building it now would mean maintaining an untested second path. |
| **`fill_itinerary` as a script tool** — ❌ declined, ✅ **its goal met another way** | S1 named it (a visa-shaped wrapper over the generic `pdf_fill`) as a candidate to stop being compiled C# and become "the first real proof of the capability model rather than an exception to it". | **The stated motivation was satisfied by S2a** — `e2e-p38` runs a genuine hot-loaded Script capability with a real grant and a sandbox-escape battery — so converting would buy a second demonstration at a real cost: a `Script` capability is off until a human enables it, so a working tool would go dark on every existing install while the shipped knowledge base still lists it, and because a grant's filesystem vocabulary is site-relative while the `pdf-form` leaf lives in the install's `res/`, the script would have to vendor pdf-lib + fontkit into every household's data folder and stop being updated with the app. **The real benefit underneath it — revising a form without shipping a release — was taken instead** (2026-08-07, e2e-p10): the form's *shape* moved to a **form map** in `.claude/forms/`, so field names, row limits, font sizes and flattening are an editable, diff-reviewed file, while the PDF machinery stays compiled and shipped. Data where it churns; code where it doesn't. |
| **Semantic recall (embeddings)** — ❌ declined | Library + fact search is FTS5 **trigram** today — *lexical*: it matches shared characters/keywords. Embeddings would make recall *semantic* (retrieve by MEANING): a query like "peaceful garden" would surface a "Zen temple" entry with no shared words, and a paraphrased fact would still match. Approach: a **local ONNX embedding model** (e.g. Mastra's `fastembed` / a bge-small model) — no API key, fully offline — writing a vector per `library_item`/fact into a `*_embedding` table, ranked by cosine similarity (optionally `sqlite-vec` for speed, with a managed cosine fallback). | Adds `Microsoft.ML.OnnxRuntime` + a ~130 MB model file, ~**doubling the bundle size** — the main tension with Gatherlight's offline/lightweight ethos. FTS5 trigram already gives CJK substring recall at a household's library scale, so this would double the bundle to fix a retrieval problem nobody has hit. Revisit if recall actually fails in use ("I know it's in there and can't find it"), not before. |

## Architecture decisions of record

- **Hybrid data model**: markdown artifacts + private git repo in the data folder (the AI edits
  files; diffs gate commits); SQLite for app state and derived indexes.
- **Web-only headless server** for now; composition-root seam (`GatherlightApp.Build()`) keeps a
  desktop tray host possible later.
- **Git via CLI** (not LibGit2Sharp) — behavior parity with the prototype, zero native friction.
- **SSE** (not WebSocket) for agent event streaming — one-directional, replayable from DB.
- **claude CLI only, never API keys**; cheap utility calls use a neutral cwd + small model,
  chat runs cwd = data folder so the planner knowledge base loads.
- **One site, no registry — because the knowledge is shared.** Multi-site hosting was considered and
  dropped: the product's value is one accumulated pool (knowledge base + library + memory + entities
  and the cross-references between them), so isolating sites would wall off the shared brain that
  makes a plan worth more than the sum of its parts.
- **Trust follows provenance, and the walls bound a mistake.** Platform-shipped tools are available
  by default because we wrote and shipped them; only capabilities that did not come from the platform
  need human enablement. Behaviour is controlled by a boundary that is few, hard and well understood
  — not by tightening the toolset or scripting the agent's steps.
- **Cards are platform chrome.** Every permission clause a human approves is rendered server-side
  from the *enforced* grant, never from agent text, because an injected agent writes a reassuring
  explanation exactly when it matters most.
- **Ports**: server 5317, client dev 5173.
