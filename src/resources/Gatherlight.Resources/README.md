# Gatherlight.Resources

Heavy **download-at-setup** resources for the self-hosted [Gatherlight](https://github.com/JiarongGu/Gatherlight)
family planner, published to nuget.org as **resource storage** — not a normal library.

Nothing `PackageReference`s this. It exists so the app can fetch large binaries at first-run setup
from nuget.org's public **flat-container CDN** instead of shipping them in the release bundle (keeping
the download lean) or being self-hosted as GitHub release assets (which need manual uploads).

## What's inside

| Path (in package) | Resource | Notes |
|---|---|---|
| `content/playwright/` | Playwright **win-x64 driver** slice (`node/win32_x64/node.exe` + `package/`) | ~88 MB unpacked; the bootstrap the app runs to install Chromium |

Planned additions: **MinGit** (portable git) and a small **ONNX embedding model** for local semantic
search — both comfortably under nuget.org's 250 MB per-package limit. Chromium itself is *not* here
(too large for a registry — the app installs it via the Playwright driver from Playwright's own CDN).

## How the app consumes it

The server's `ResourceProvisioner` downloads the versioned `.nupkg` directly:

```
https://api.nuget.org/v3-flatcontainer/gatherlight.resources/<version>/gatherlight.resources.<version>.nupkg
```

then extracts `content/playwright/` into `{data}/state/resources/.playwright` (survives app updates,
fetched once). Override the source with `GATHERLIGHT_PW_DRIVER_URL` (a mirror, or a local `.nupkg`
during testing).

## Versioning

The driver is paired with the `Microsoft.Playwright` NuGet version the app builds against
(currently **1.49.0**). When that bumps, re-pack + republish this package and update
`ResourceProvisioner.ResourcesPackageVersion` to match.

## Build & publish

```bash
# assemble payload/ from the built driver + pack -> dist/resources/*.nupkg
node devtools/dev.mjs resources-pack            # or: resources-pack 1.0.1

# publish (one-time: reserve the id on nuget.org, then push each version)
dotnet nuget push dist/resources/Gatherlight.Resources.1.0.0.nupkg \
  --api-key <NUGET_API_KEY> --source https://api.nuget.org/v3/index.json
```

CI: `.github/workflows/release-resources.yml` (manual `workflow_dispatch`) packs + pushes using the
`NUGET_API_KEY` repository secret.

## Licensing

Redistributes third-party components under their own licenses: **Microsoft Playwright** (Apache-2.0)
and **Node.js** (MIT). Their license texts ship inside the payload.
