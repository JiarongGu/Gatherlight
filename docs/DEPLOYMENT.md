# Deployment — running Gatherlight as an installed product

Gatherlight ships as a **self-contained single-file executable**: the .NET runtime, the built
React client, the knowledge-base template, and the native libraries (SQLite, Playwright) are all
carried inside one `Gatherlight.Server.exe`. The target machine needs **no .NET install**.

## Build the artifact

```bash
node devtools/dev.mjs publish            # win-x64 by default
node devtools/dev.mjs publish linux-x64  # or another RID
```

This builds the client into `wwwroot`, then runs a self-contained single-file `dotnet publish`
into `dist/` (gitignored). Output (~190 MB): `Gatherlight.Server.exe` + `wwwroot/` +
`Assets/DataTemplate/` + `playwright.ps1`.

## Run it

```bash
dist/Gatherlight.Server.exe
```

- Serves the API **and** the client on `http://127.0.0.1:5317` (open it in a browser).
- **Loopback only** — there is no auth story yet, and the data folder is a family's private life.
  Do not expose the port; run it on the machine that uses it (or behind your own tunnel/VPN).
- On first boot against an empty data folder it runs migrations, seeds the knowledge-base
  template, initializes the data git repo, and indexes plans.

### Configuration

| Setting | How | Default |
|---|---|---|
| Data folder | `GATHERLIGHT_DATA` env var, or `state/settings.json` | `./local` next to the exe |
| Port | `GATHERLIGHT_PORT` env var, or `state/settings.json` | `5317` |

The **data folder** holds all user data (plans, household, SQLite state, uploads, the live
knowledge base) in its **own private git repo** — back *that* up, not the exe. Point
`GATHERLIGHT_DATA` at a stable location outside the install dir.

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
