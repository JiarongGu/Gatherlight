# Gatherlight · 拾光

> **拾光** (shí guāng) — 拾 "to gather / pick up" + 光 "light", a homophone of 时光 "time".
> To gather light is to gather the moments worth planning for. Gatherlight is a self-hosted,
> AI-first **family planner** — trips, daily / weekly plans, budgets, packing lists — drafted and
> edited by an AI agent under human approval gates, browsable in a web UI.

## How it works

- **Server** (`src/server/`) — ASP.NET Core + SQLite: hosts the web client, the plan index/search,
  file operations, the tool registry (HTTP + MCP), and the chat orchestration.
- **Client** (`src/client/`) — React + Vite, atomic design (`ui/atoms|molecules|organisms` +
  `screens`): plan browser, maps, PDF / calendar export, and the chat drawer.
- **Data folder** (default `local/`, configurable via `GATHERLIGHT_DATA`) — **all** user data lives
  here, never in this repo: markdown plans + household profiles under a **private git repo** (every
  AI edit is diff-reviewed and committed), the planner knowledge base (智库) the agent runs on, and
  app state (SQLite, uploads, caches).
- **AI core** — chat spawns your local authenticated `claude` CLI (your subscription, **no API
  keys**) in a **two-gate flow**: the agent proposes a plan → you approve → it edits files
  (scope-guarded) → you review the diff → commit. A server-side RAG router pre-loads the right
  knowledge deterministically, so recognized tasks skip the discovery round-trips.

## Token economy — do it in code, not in the model

Deterministic work never touches the LLM: browsing, search, file ops, budget math, calendar (ICS)
export, and the scrapers/verifiers all run as plain server code or registered tools. The model is
spent only on genuine planning and reasoning — and the chat panel shows live token + cost usage so
you can see it.

## Extending it

- **Tools** — 11 built in (`extract`, `scrape`, `wiki_info`, `policy_check`, `hotel_info`,
  `restaurant_info`, `flight_schedule`, `flight_prices`, `hotel_prices`, `fill_itinerary`,
  `remember_fact` / `recall_facts` cross-session memory). Add your own with **zero rebuild** by
  dropping a `tool.json` into `{data}/tools/<name>/` — see `docs/TOOLS.md`.
- **系统模式 (system mode)** — the chat can edit Gatherlight's **own UI**: toggle it on, and the
  agent edits `src/client`, runs the build, and ships the change on your next refresh (build must
  pass; you approve the diff).

## Run

```bash
node devtools/dev.mjs server    # server on :5317, data folder ./local (serves the built UI too)
node devtools/dev.mjs vite      # client HMR on :5173 (proxies /api → 5317) for UI work
node devtools/dev.mjs build     # client build → wwwroot + dotnet build
node devtools/dev.mjs e2e       # API end-to-end suites (stubbed claude, isolated data folders)
```

Interactive family planning happens in the data folder itself: run `claude` from `local/` (its own
`CLAUDE.md` + 智库 apply there). See `docs/ROADMAP.md` for architecture decisions and status.
