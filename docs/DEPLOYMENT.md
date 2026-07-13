# Deployment — running Gatherlight as an installed product

Gatherlight ships as a **desktop management console** — `Gatherlight.Host`, a self-contained
single-file executable that carries the .NET runtime, the built React client, the knowledge-base
template, and the native libraries (SQLite, Playwright). The target machine needs **no .NET
install**.

The Host is not the planner UI. It **hosts the Gatherlight server in-process** and **monitors its
health**; the family opens the actual planner in a **web browser** at the URL the console shows.
This is the proper way to run Gatherlight — the headless `dotnet run` / `dev.mjs server` path is
for development only.

## Build the artifact

```bash
node devtools/dev.mjs publish            # win-x64 by default
node devtools/dev.mjs publish linux-x64  # or another RID
```

This builds the client into `wwwroot`, then runs a self-contained single-file `dotnet publish` of
the **Host** into `dist/` (gitignored): `Gatherlight.Host.exe` + `wwwroot/` +
`Assets/DataTemplate/` + `playwright.ps1`.

## Run it

Launch `dist/Gatherlight.Host.exe` (or `node devtools/dev.mjs host` in dev). A tray icon appears and
a small **management console** opens:

- **Health monitor** — polls `/api/health` on a rolling strip (green/red), with latency + uptime,
  and (optionally) auto-restarts the server if it stops responding.
- **Live counts** — plans indexed, library entries, tools registered.
- **Controls** — open the planner in a browser, open the data folder, restart, or stop.
- Closing the window **minimizes to the tray**; the server keeps serving. "退出" stops everything.
- One instance per machine (a second launch just surfaces the console).

The planner itself is served on `http://127.0.0.1:5317` — **open it in a browser**.

- **Loopback only** — there is no auth story yet, and the data folder is a family's private life.
  Do not expose the port; run it on the machine that uses it (or behind your own tunnel/VPN).
- On first launch against an empty data folder it runs migrations, seeds the knowledge-base
  template, initializes the data git repo, and indexes plans.

### Configuration

| Setting | How | Default |
|---|---|---|
| Data folder | `GATHERLIGHT_DATA` env var, or `state/settings.json` | `./local` next to the exe |
| Port | `GATHERLIGHT_PORT` env var, or `state/settings.json` | `5317` |

The **data folder** holds all user data (plans, household, SQLite state, uploads, the live
knowledge base) in its **own private git repo** — back *that* up, not the exe. Point
`GATHERLIGHT_DATA` at a stable location outside the install dir.

### The database is untracked — back it up

The SQLite DB lives at `{data}/state/gatherlight.db` and is deliberately **outside every git repo**
(the code repo ignores `local/`; the data repo ignores `state/`; `.gitignore` also blocks `*.db*`
everywhere as defense-in-depth). It never goes to GitHub — it's app state and now also holds the
**knowledge library** (verified attractions/venues), so it is a *source of truth*, not a derived
index. That means the git audit trail does **not** cover it: include `{data}/state/` in your file
backups (or copy the DB while the server is stopped). Plans/household stay markdown in the data
repo (versioned); the library is the one knowledge surface whose durability rides on your backup.

## Host prerequisites (not bundled — by design)

1. **The authenticated `claude` CLI.** The chat/planning core spawns the local `claude` CLI
   (never an API key). Install Claude Code and sign in on the host once; the server resolves the
   executable via `where`/`which` at runtime. Without it, browsing/plans/documents still work but
   the AI chat gate errors.
2. **Playwright chromium** — only for the web-scraper tools (`scrape`, `flight_*`, `hotel_*`,
   `restaurant_*`, `policy_check`). Install once:
   ```bash
   pwsh dist/playwright.ps1 install chromium
   ```
   The rest of the product (plans, budget, ICS, documents, memory) needs no browser.

## Updating

Re-run `node devtools/dev.mjs publish` and replace the exe. Data folders are upgraded in place on
next boot: `ZhikuSeeder` re-seeds template files that the user hasn't modified (hash-guarded) and
migrations advance the SQLite schema — user edits and app state are preserved.

## Notes

- The composition root is `GatherlightApp.Build()`; `Program.cs` is the headless host. The same
  seam makes a desktop tray host (Kestrel in-process) a later drop-in without touching modules.
- Single-file extraction: native libs self-extract to a temp dir on first run
  (`IncludeNativeLibrariesForSelfExtract`); startup is a beat slower the first time.
