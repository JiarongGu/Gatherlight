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
| 6 | Knowledge-base split: scrubbed product template (`Assets/DataTemplate/`) + seeder with hash-based upgrades; repo `.claude/` becomes dev rules | ✅ 2026-07-13 (e2e-p4) |
| 7 | C#-native tool ports — incremental, one tool per commit | ✅ 2026-07-13 (all 8 scrapers ported; `tools/puppeteer` deleted) |

### Phase 7 progress

| Tool | Status |
|---|---|
| `wiki_info` (Wikipedia REST + Wikidata official-site, pure HttpClient) | ✅ 2026-07-13, live-verified |
| `scrape` (Playwright .NET headless chromium via `PlaywrightHost`; replaces the Node puppeteer leaf; `dev.mjs fetch-tools` installs the browser) | ✅ 2026-07-13, live-verified on a JS-rendered Google Flights deeplink |
| `flight_schedule`, `policy_check` → **C#/Playwright native** | ✅ 2026-07-13. Shared `PlaywrightScraper` (navigate+extract on the one browser) + deterministic parse tested end-to-end against a local fixture server (e2e-p11: schedule extraction + fabricated-code detection; visa-required + max-stay + types). Node leaves deleted. |
| `flight_prices`, `hotel_prices`, `hotel_info`, `restaurant_info` → **C#/Playwright native** | ✅ 2026-07-13 (e2e-p12, 23 checks). On the shared `PlaywrightScraper` (now also `FetchLinksAsync` for DuckDuckGo result anchors + an `H1`). `flight_prices`/`hotel_prices` parse Kayak/Booking price text; `hotel_info`/`restaurant_info` DDG-search → classify trusted domains → verify (Tabelog table / generic name). Fixture seam: `GATHERLIGHT_FIXTURE_ORIGIN` rewrites any real-domain navigation to a local server while tools still classify the original URL. **All Node puppeteer leaves + `tools/puppeteer/` deleted.** |
| `fill_itinerary` (visa AcroForm) | ✅ registry tool; now one case of the general document subsystem |
| **General document/media subsystem** — `Modules/Documents`: `pdf_inspect` / `pdf_extract_text` / `pdf_fill` / `pdf_merge` + `image_info` / `image_resize` / `image_convert`. Library split: PdfPig (extract), pdf-lib leaves (form inspect/fill/merge — reliable on real + CJK PDFs), ImageSharp (images). PDFsharp evaluated + dropped (its AcroForm fill + page-import both threw on real PDFs). | ✅ 2026-07-13 (e2e-p10, 14 checks) |
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
| **Structured publish** — `dev.mjs publish` → `dist/Gatherlight/` (launcher · libs/ · res/ · data/) + zip + sha256 manifest; the server self-locates `res/` + `data/`. | ✅ 2026-07-13, verified |
| **Remote-access hardening** — loopback-trusted access-token gate on `/api` + `/mcp` (Bearer / header / httpOnly cookie), SPA login screen, per-IP login brute-force lockout, fail-closed binding (refuses non-loopback without a token), `trustLoopback:false` for same-host proxies. `security.*` in settings.json / `GATHERLIGHT_BIND`·`_ACCESS_TOKEN`·`_TRUST_LOOPBACK`. | ✅ 2026-07-13 (e2e-p17, 19 checks) |
| **TLS / HTTPS** — Kestrel-native HTTPS (`security.tls.enabled`): self-signed cert generated + reused from `state/gatherlight-tls.pfx`, or bring your own PFX (`certPath`/`certPassword`). Secure cookie flag flips under HTTPS; desktop host trusts its own loopback cert. | ✅ 2026-07-13 (e2e-p18, 11 checks) |
| **Security headers** — CSP (calibrated to the app + verified with a headless Edge render: 0 violations, full visual integrity) + `nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy` / `Permissions-Policy` on every response. | ✅ 2026-07-13 (e2e-p17 header asserts + headless render) |

## Architecture decisions of record

- **Hybrid data model**: markdown artifacts + private git repo in the data folder (the AI edits
  files; diffs gate commits); SQLite for app state and derived indexes.
- **Web-only headless server** for now; composition-root seam (`GatherlightApp.Build()`) keeps a
  desktop tray host possible later.
- **Git via CLI** (not LibGit2Sharp) — behavior parity with the prototype, zero native friction.
- **SSE** (not WebSocket) for agent event streaming — one-directional, replayable from DB.
- **claude CLI only, never API keys**; cheap utility calls use a neutral cwd + small model,
  chat runs cwd = data folder so the planner knowledge base loads.
- **Ports**: server 5317, client dev 5173.
