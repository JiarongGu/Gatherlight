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
