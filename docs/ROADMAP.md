# Gatherlight productization roadmap

Porting the legacy markdown-notebook prototype into a .NET + SQLite self-hosted web product.
Each phase ends buildable/verifiable. Details live in the phase's PR/commit descriptions.

| Phase | Scope | Status |
|---|---|---|
| 0 | Privacy/repo reset: user data → untracked `local/` (own private git repo), pre-reset history archived to `local/archive/`, fresh main-repo history, sensitive-info pre-commit guard | ✅ 2026-07-13 |
| 1 | .NET skeleton: `Gatherlight.slnx`, `src/server/Gatherlight.Server` (ASP.NET Core net10.0), data-folder context, SQLite + Dapper + FluentMigrator initial schema, `/api/health`, devtools dispatcher | — |
| 2 | Read side: data-repo git service, plan index (SQLite-backed browse/search, zero-LLM), plans/content/assets API, fs ops (delete/retitle/rename) with auto-commit | — |
| 3 | LLM core: claude CLI runner (stream-json), two-gate chat state machine, SSE streaming, scope guard, uploads | — |
| 4 | Frontend port: `viewer/frontend` → `src/client` on the .NET API; delete legacy `viewer/` | — |
| 5 | C# tool registry (`IAssistantTool` + schema builder) + HTTP MCP endpoint for the spawned agent; legacy Node tools wrapped as leaf subprocesses | — |
| 6 | Knowledge-base split: scrubbed product template (`Assets/DataTemplate/`) + seeder with hash-based upgrades; repo `.claude/` becomes 2-tier dev rules | — |
| 7 | C#-native tool ports: wiki-info (HttpClient), web-fetch/scrape (Playwright .NET), scrapers one-by-one with golden-JSON verification, PDF AcroForm spike; zero-LLM endpoints (ICS export, budget rollups) | — |

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
