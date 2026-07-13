# Gatherlight · 拾光

> **拾光** (shí guāng) — 拾 "to gather / pick up" + 光 "light", a homophone of 时光 "time".
> To gather light is to gather the moments worth planning for. Gatherlight is a self-hosted,
> AI-first **family planner** — trips, daily / weekly plans, budgets, packing lists — drafted and
> edited by an AI agent under human approval gates, browsable in a web UI and supervised from a
> desktop console.

Self-hosted · loopback-only · **your own `claude` subscription, no API keys** · your data stays on
your machine.

## How it works

- **Server** (`src/server/Gatherlight.Server`) — ASP.NET Core (net10) + SQLite: hosts the web
  client, the plan index/search, file operations, the tool registry (HTTP + MCP), chat
  orchestration, the knowledge library, memory transfer, and the eval surface.
- **Client** (`src/client`) — React + Vite, atomic design: plan browser, maps, PDF/calendar export,
  the chat drawer, the 知识库 library gallery, and the `/manage` console — all in one **lantern-paper**
  design system (warm ivory/ink, amber accent, editorial serif; self-hosted fonts, works offline).
- **Desktop host** (`src/server/Gatherlight.Host`) — a WinForms + WebView2 tray app that hosts the
  server **in-process** and monitors its health. This is the proper way to run it; the family opens
  the planner in a browser.
- **Data folder** (default `local/`, `GATHERLIGHT_DATA`) — **all** user data lives here, never in
  this repo: markdown plans + household profiles in a **private git repo** (every AI edit is
  diff-reviewed and committed), the planner knowledge base (智库), and app state (SQLite, uploads,
  caches). The SQLite DB is deliberately outside git — back up the data folder.
- **AI core** — chat spawns your local authenticated `claude` CLI in a **two-gate flow**: the agent
  proposes a plan → you approve → it edits files (scope-guarded to `plans/ household/ .claude/`) →
  you review the diff → commit. A server-side RAG router pre-loads the right knowledge
  deterministically, so recognized tasks skip discovery round-trips.

## Token economy — do it in code, not in the model

Deterministic work never touches the LLM: browsing, search, file ops, budget math, calendar (ICS)
export, the knowledge library, and the scrapers/verifiers all run as server code or registered
tools. The model is spent only on genuine planning — and the chat panel shows live token + cost.

## Highlights

- **Knowledge library (知识库)** — verified reference entities (attractions/venues/hotels) live in a
  DB table, browsable as a card gallery, curated by the agent (`library_*` tools) instead of a
  markdown blob. Import a legacy `ATTRACTIONS.md` with `library_import`.
- **Memory transfer** — export the DB knowledge and the tuned cortex config
  (`/api/memory/export`) and move it to another install, or seed a fresh one at startup with
  `GATHERLIGHT_SEED_MEMORY`.
- **Eval / LLM-ops** — users rank each conversation (1–5 + note); the `/manage` console shows
  aggregate stats, transcripts, and a JSONL tuning-dataset export. Its **校准 (Cortex)** tab closes
  the loop: edit the agent's prompt templates and per-consumer model routing live (stored in
  `app_config`, effective next call, one click to reset to the shipped default).
- **Extensible tools** — 24 built in (`extract`, `scrape`, `wiki_info`, `policy_check`,
  `hotel_info`, `restaurant_info`, `flight_schedule`, `flight_prices`, `hotel_prices`,
  `fill_itinerary`, `pdf_*`/`image_*`, `budget_scan`, `remember_fact`/`recall_facts`, `library_*`).
  Add your own with **zero rebuild** — drop a `tool.json` into `{data}/tools/<name>/` (see
  `docs/TOOLS.md`).
- **Remote-access hardening** — loopback by default; to reach it from another device set an access
  token (`security.accessToken`) and bind address — remote clients get a login gate, the local
  machine stays frictionless, and exposing the port without a token fails closed. See
  `docs/DEPLOYMENT.md`.

## Run (development)

```bash
node devtools/dev.mjs server    # headless server on :5317, data folder ./local
node devtools/dev.mjs host      # desktop management console (hosts + monitors)
node devtools/dev.mjs vite      # client HMR on :5173 (proxies /api → 5317) for UI work
node devtools/dev.mjs build     # client build → wwwroot + dotnet build
node devtools/dev.mjs e2e       # API end-to-end suites (stubbed claude, isolated data folders)
node devtools/dev.mjs smoke     # real-claude two-gate smoke (opt-in; needs an authenticated CLI)
```

## Publish (a shippable bundle)

```bash
node devtools/dev.mjs publish   # → dist/Gatherlight/ (Gatherlight.cmd · libs/ · res/ · data/) + .zip
```

A self-contained bundle (no .NET install needed) — double-click `Gatherlight.cmd`. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Prerequisites kept external by design: an authenticated
`claude` CLI, and (for the scraper tools) a Playwright chromium.

## Docs

[ROADMAP](docs/ROADMAP.md) · [DEPLOYMENT](docs/DEPLOYMENT.md) · [TOOLS](docs/TOOLS.md) ·
[UI_ARCHITECTURE](docs/UI_ARCHITECTURE.md) · [STORAGE_NOTES](docs/STORAGE_NOTES.md)

## License

[MIT](LICENSE) © Jiarong Gu
