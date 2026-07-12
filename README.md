# Gatherlight

A self-hosted, AI-first **family planner**: trips, daily/weekly plans, budgets, packing lists —
drafted and edited by an AI agent under human approval gates, browsable in a web UI.

## How it works

- **Server**: ASP.NET Core + SQLite (`src/server/`) — hosts the web client, the plan index/search,
  file operations, the tool registry, and the chat orchestration.
- **Client**: React + Vite (`src/client/`) — plan browser, maps, PDF export, and the chat drawer.
- **Data folder** (default `local/`, configurable via `GATHERLIGHT_DATA`): all user data lives
  here, never in this repo — markdown plans and household profiles under a **private git repo**
  (every AI edit is diff-reviewed and committed), the planner knowledge base the agent runs on,
  and app state (SQLite, uploads, caches).
- **AI core**: chat spawns the local authenticated `claude` CLI (your subscription — no API keys)
  in a **two-gate flow**: the agent proposes a plan → you approve → it edits files (scope-guarded)
  → you review the diff → commit. Deterministic work (browsing, search, scraping, budget math) is
  plain server code and registered tools, so tokens are spent only on actual planning.

## Status

Productization in progress — porting from the legacy Node prototype (`viewer/`, `tools/`) to the
.NET server. See `docs/ROADMAP.md`.

## Run

```bash
dotnet run --project src/server/Gatherlight.Server   # server on :5317, data in ./local
cd src/client && npm run dev                          # client HMR on :5173
```
