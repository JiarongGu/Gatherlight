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

```powershell
.\build-production.ps1                 # lean win-x64 bundle (root entry point)
.\build-production.ps1 -Zip            # also produce the release .zip
.\build-production.ps1 -Rid win-arm64  # another runtime
.\build-production.ps1 -SkipClient     # reuse an existing client build
```

`build-production.ps1` is a thin wrapper over `node devtools/scripts/build-production.mjs` (also reachable as
`node devtools/dev.mjs publish`). It builds the client, publishes the **Host** as a self-contained
single-file exe, compiles the **native C++ launcher** (`Gatherlight.exe`, if the MSVC toolchain is
present — otherwise it falls back to `Gatherlight.cmd`), and arranges a clean bundle in
`publish/Gatherlight/` (gitignored) + a matching `.zip`:

```
publish/Gatherlight/
  Gatherlight.exe    native launcher (carries the app icon) — double-click to run
  Gatherlight.cmd    fallback launcher (script)
  README.txt         run / transfer-memory / prerequisites
  manifest.json      sha256 of every shipped file
  libs/              the self-contained app (runtime + assemblies) + playwright.ps1
  res/               wwwroot (web planner) + template (knowledge-base seed)
  data/              the data folder — user data lands here (back this up)
```

The launcher points the app at `data/` and launches `libs/Gatherlight.Host.exe`; the server resolves
`wwwroot` + the knowledge template from `res/` and defaults its data folder to `data/` — so the
bundle is self-locating; move or rename the `Gatherlight/` folder freely.

**Release** (`.github/workflows/release.yml`): a **manual-trigger** (`workflow_dispatch`) workflow —
there is deliberately no auto CI on push/PR. Run it from the Actions tab: it bumps the version
(`patch`/`minor`/`major`, or an explicit value), runs the full e2e suite as a gate, builds the
bundle, optionally tags, and attaches the zip + `manifest.json` to a GitHub Release (draft by
default). GitHub Actions builds the launcher with the v143 toolset (v145 locally).

## Run it

Launch `publish/Gatherlight/Gatherlight.exe` (or `Gatherlight.cmd`; `node devtools/dev.mjs host` in
dev). A tray icon appears and the **management console** opens (a resizable, DPI-correct WebView2
window rendering the `/manage` dashboard):

- **Health monitor** — polls `/api/health` on a rolling strip (green/red), with latency + uptime,
  and (optionally) auto-restarts the server if it stops responding.
- **Live counts** — plans indexed, library entries, tools registered.
- **Controls** — open the planner in a browser, open the data folder, restart, or stop.
- Closing the window **minimizes to the tray**; the server keeps serving. "退出" stops everything.
- One instance per machine (a second launch just surfaces the console).

The planner itself is served on `http://127.0.0.1:5317` — **open it in a browser**.

- **Loopback by default** — the server binds `127.0.0.1` only, so nothing is reachable off the
  machine until you deliberately change the bind address (see [Remote access](#remote-access)).
- On first launch against an empty data folder it runs migrations, seeds the knowledge-base
  template, initializes the data git repo, and indexes plans.

### Remote access

Gatherlight can spawn the authenticated `claude` CLI and holds a family's private life, so exposing
it to the network without auth is unauthenticated control of both. The access model is
**loopback is trusted, remote needs a token**:

- The local machine (desktop host, `localhost` browser) is always trusted — no prompt.
- To reach it from another device, set an **access token** and change the **bind address**. Bound
  beyond loopback *without* a token, the server **refuses to start** (fail closed).
- A remote browser is shown a token prompt; a correct token drops an httpOnly cookie. The token can
  also be sent as `Authorization: Bearer <token>` or an `X-Gatherlight-Token` header (for scripts).
- **Brute-force lockout** — after 5 failed logins from an IP within 10 min that IP is locked out for
  5 min (the only barrier is the token, so guessing is throttled); already-authenticated sessions
  are unaffected.
- Behind a **same-host reverse proxy** (e.g. nginx → `127.0.0.1`), every request looks like
  loopback — set `trustLoopback: false` so the token is enforced anyway.

**Encryption (HTTPS).** Plain HTTP carries the token in the clear. Turn on `security.tls.enabled`
(or `GATHERLIGHT_TLS=1`) and Kestrel terminates TLS itself:

- **Self-signed by default** — a certificate is generated once and reused from
  `{data}/state/gatherlight-tls.pfx`. The connection is encrypted, but browsers show an "untrusted
  certificate" warning (the desktop host accepts its own loopback cert automatically).
- **Bring your own cert** — point `security.tls.certPath` at a PFX/PKCS#12 bundle (e.g. from
  Let's Encrypt), plus `security.tls.certPassword` if it has one, to remove the warning.
- Or terminate TLS at a reverse proxy / tunnel in front and leave Kestrel on HTTP loopback with
  `trustLoopback: false`.

```jsonc
// {data}/state/settings.json
{
  "security": {
    "accessToken": "a-long-random-string",
    "bindAddress": "0.0.0.0",
    "trustLoopback": true,
    "tls": { "enabled": true, "certPath": "C:/certs/gatherlight.pfx", "certPassword": "…" }
  }
}
```

### Configuration

| Setting | How | Default |
|---|---|---|
| Data folder | `GATHERLIGHT_DATA` env var, or `state/settings.json` | `./local` next to the exe |
| Port | `GATHERLIGHT_PORT` env var, or `state/settings.json` | `5317` |
| Bind address | `GATHERLIGHT_BIND` env var, or `security.bindAddress` | `127.0.0.1` (loopback) |
| Access token | `GATHERLIGHT_ACCESS_TOKEN` env var, or `security.accessToken` | *(none — loopback only)* |
| Trust loopback | `GATHERLIGHT_TRUST_LOOPBACK=0` env var, or `security.trustLoopback` | `true` |
| TLS / HTTPS | `GATHERLIGHT_TLS=1` env var, or `security.tls.enabled` | `false` (HTTP) |
| TLS certificate | `GATHERLIGHT_TLS_CERT`(+`_PASSWORD`) env var, or `security.tls.certPath` | *(self-signed, generated)* |
| Update source | `GATHERLIGHT_UPDATE_REPO` env var, or `selfUpdate.githubRepo` (`owner/name`) | *(none — updates off)* |

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

## Host prerequisites

**Large resources download at setup, not bundled** — the shipped zip is lean (~200 MB vs ~350 MB;
chromium ~120 MB + git ~37 MB are omitted). First run, open the console's **资源 · Resources** panel
and click download; each lands in the data folder (`{data}/state/resources/…`, downloaded once,
preserved across app updates). `--offline` bundles them for an air-gapped install.

**git** is the data repo's engine (init / diff / commit / restore — the two-gate audit trail). The
server resolves it automatically (`GitCliService`: `GATHERLIGHT_GIT` override → provisioned
`{data}/state/resources/git/cmd/git.exe` → bundled `libs/git` if `--offline` → `git` on PATH), so
provision it from the 资源 panel (or have git on PATH). The items below each gate one optional
feature, and none blocks the app from starting:

1. **The authenticated `claude` CLI** — only for the AI chat/planning gate. The core spawns the local
   `claude` CLI (never an API key). Install Claude Code and sign in on the host once; the server
   resolves the executable via `where`/`which` at runtime. Without it, browsing / plans / documents /
   library import all still work — only the AI chat gate errors. It's the one per-user step (an
   authenticated login can't be shipped in a bundle).
2. **Web-scraper tools** (`scrape`, `flight_*`, `hotel_*`, `restaurant_*`, `policy_check`) — **fully
   provisioned at setup.** Neither the Playwright **driver** nor **chromium** is bundled; click download
   in the 资源 · Resources panel and both land in `{data}/state/resources/` (`.playwright` + `browsers`),
   resolved at runtime via `PLAYWRIGHT_DRIVER_SEARCH_PATH` + `PLAYWRIGHT_BROWSERS_PATH`. Playwright ships
   the .NET driver only via NuGet (no public CDN), so we host it as a fixed GitHub **release asset**
   (`pw-driver-v<ver>/pw-driver-win-x64.zip`, sha256-pinned; `GATHERLIGHT_PW_DRIVER_URL` overrides for a
   mirror); chromium installs via the downloaded driver (`node cli.js install chromium`). `--offline`
   bundles both at `libs/.playwright` + `libs/browsers` for air-gapped installs. (WebView2 was rejected —
   it needs a UI thread/window in a headless server and lacks Playwright's automation API.)
3. **Node.js on PATH** — only for the PDF *form* tools (`pdf_fill` / `pdf_merge` / `fill_itinerary`),
   which shell out to the `tools/pdf-form` pdf-lib leaf via `npx`. (`pdf_extract_text` / `pdf_inspect`
   and the image tools are native — no Node needed.) Nothing else requires Node at runtime.

## Updating

**Auto-update** (recommended). Set `selfUpdate.githubRepo` to `owner/name` in `settings.json` (or
`GATHERLIGHT_UPDATE_REPO`). The `/manage` console then shows an **更新 · Updates** card that checks
the repo's latest GitHub release; **下载更新** downloads the release zip, extracts it to
`{install}/.update/staged`, and verifies every file against the release `manifest.json` (sha256)
before marking it ready. **重启并安装** restarts through the native launcher, which overlays the
staged files onto the install (a running exe can't replace itself), deletes files the new manifest
drops, and relaunches. The two-phase split — app stages, launcher applies — is why the C++ launcher
exists. The launcher never self-updates (it's excluded from the overlay); a launcher change is a
manual re-download.

> The host is framework-dependent (~20 MB app; the .NET 10 runtime is installed once by the launcher
> on first run and survives updates), so each update re-downloads only ~20 MB — not the ~110 MB a
> bundled-runtime build would. `release.yml` publishes the zip + `manifest.json` as release assets on
> a `v*` tag.

**Manual.** Re-run `.\build-production.ps1` (or `node devtools/dev.mjs publish`) and replace the folder. Data
folders are upgraded in place on next boot regardless of update path: `ZhikuSeeder` re-seeds template
files the user hasn't modified (hash-guarded) and migrations advance the SQLite schema — user edits
and app state are preserved.

## Notes

- The composition root is `GatherlightApp.Build()`; `Program.cs` is the headless host. The same
  seam makes a desktop tray host (Kestrel in-process) a later drop-in without touching modules.
- Single-file extraction: native libs self-extract to a temp dir on first run
  (`IncludeNativeLibrariesForSelfExtract`); startup is a beat slower the first time.
