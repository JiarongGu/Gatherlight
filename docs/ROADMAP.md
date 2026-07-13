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
| 7 | C#-native tool ports — incremental, one tool per commit | 🔶 in progress |

### Phase 7 progress

| Tool | Status |
|---|---|
| `wiki_info` (Wikipedia REST + Wikidata official-site, pure HttpClient) | ✅ 2026-07-13, live-verified |
| `scrape` (Playwright .NET headless chromium via `PlaywrightHost`; replaces the Node puppeteer leaf; `dev.mjs fetch-tools` installs the browser) | ✅ 2026-07-13, live-verified on a JS-rendered Google Flights deeplink |
| `policy_check`, `hotel_info`, `restaurant_info`, `flight_schedule`, `flight_prices`, `hotel_prices` | ✅ exposed as registry tools (HTTP + MCP) via `NodeLeafTool` wrappers over the working Node code. Full C#/Playwright ports (golden-JSON vs the leaf) remain the eventual goal; leaves are fine meanwhile. |
| `fill_itinerary` (visa AcroForm) | ✅ exposed as a registry tool (Node pdf-form leaf; data-relative paths). PDFsharp CJK/flatten port is a later spike — if it fails, the leaf stays permanently (rare-use, honors the JSON contract). |
| Zero-LLM ICS export — trip/daily plan → `.ics` (`GET /api/plans/ics`, one all-day event per dated Day heading; changelog dates excluded) + client download button | ✅ 2026-07-13, live-verified on the real 17-day trip (17 events) |
| Zero-LLM budget rollups in the index | ⏳ |

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
