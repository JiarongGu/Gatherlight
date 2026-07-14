# Gatherlight.Resources

Heavy **download-at-setup** resources for the self-hosted [Gatherlight](https://github.com/JiarongGu/Gatherlight)
family planner, published to nuget.org as **resource storage** — not a normal library.

Nothing `PackageReference`s this. It exists so the app can fetch large binaries at first-run setup
from nuget.org's public **flat-container CDN** instead of shipping them in the release bundle (keeping
the download lean) or being self-hosted as GitHub release assets (which need manual uploads).

## What's inside

The full win-x64 runtime, in one ~170 MB package:

| Path (in package) | Resource | Unpacks to |
|---|---|---|
| `content/playwright/` | Playwright **driver** (`node/win32_x64/node.exe` + `package/`) | `.playwright/` |
| `content/git/` | portable **git** (MinGit 64-bit) | `git/` |
| `content/browsers/` | **chromium headless-shell** (+ ffmpeg) | `browsers/` |

Only the chromium **headless-shell** ships (not the ~280 MB full browser): the scrapers run headless,
and Playwright's headless mode uses `chromium_headless_shell`. That keeps the package well under
nuget.org's 250 MB per-package cap. A small **ONNX embedding model** may follow (its own package if
it would push this over the cap).

## How the app consumes it

The server's `ResourceProvisioner` downloads the versioned `.nupkg` directly:

```
https://api.nuget.org/v3-flatcontainer/gatherlight.resources/<version>/gatherlight.resources.<version>.nupkg
```

then unpacks the three parts into `{data}/state/resources/{.playwright,git,browsers}` in one step
(survives app updates, fetched once). Override the source with `GATHERLIGHT_RESOURCES_URL` (a mirror,
or a local `.nupkg` during testing).

## Versioning

The driver is paired with the `Microsoft.Playwright` NuGet version the app builds against
(currently **1.49.0**). When that bumps, re-pack + republish this package and update
`ResourceProvisioner.ResourcesPackageVersion` to match.

## Build & publish

**Locally** — one PowerShell script packs (assembles driver + git + chromium headless-shell) and
pushes, for when a payload changes (Playwright bump, new resource):

```powershell
# reserve the id 'Gatherlight.Resources' on nuget.org once, then:
$env:NUGET_API_KEY = '<your-key>'            # or pass -ApiKey, or you'll be prompted (hidden)
./devtools/publish-resources.ps1             # pack + push at the provisioner's version
./devtools/publish-resources.ps1 -PackOnly   # build only; inspect dist/resources first
```

**Bumping a version:** update `ResourceProvisioner.ResourcesPackageVersion` (the app fetches that
version) and pass the same `-Version` — the script warns if they don't match.

**CI:** `.github/workflows/release-resources.yml` (manual `workflow_dispatch`, `NUGET_API_KEY` secret)
runs the same pack + push. Under the hood both call `node devtools/dev.mjs resources-pack`.

## Licensing

Redistributes third-party components under their own licenses, each shipping its license text in the
payload: **Microsoft Playwright** (Apache-2.0), **Node.js** (MIT), **Chromium** headless-shell
(BSD-3-Clause), and **git-for-windows / MinGit** (GPL-2.0). The package license expression is the
compound `Apache-2.0 AND MIT AND BSD-3-Clause AND GPL-2.0-only`.
