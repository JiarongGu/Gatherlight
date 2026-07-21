# Differential Auto-Update — Design

- **Date:** 2026-07-22
- **Status:** Approved (design) → implementation plan next
- **Approach:** A — per-file delta via HTTP range into the existing release zip; hard full-download fallback
- **Predecessor:** builds on the shipped update machinery (`Modules/Update`, `src/launcher/updater.cpp`, `build-production.mjs`, `release.yml`)

## Problem

Every update downloads the **whole ~20 MB bundle** even when only a few files changed. `UpdateService.DownloadAsync` fetches the release `.zip`, extracts it to `{install}/.update/staged`, sha256-verifies against the staged manifest, and writes `ready.json`; the C++ launcher overlays it on the next restart. The bulk of the bundle is stable third-party/NuGet DLLs in `libs/` that rarely change between app versions — yet they re-transfer on every update. (This is the real target of the user's "only ship frameworks" idea; module federation was rejected as ill-fitting for a single self-hosted frontend.)

## Key enabling facts (already true today)

- The release publishes a standalone **`manifest.json`** asset — `{ product, version, rid, files: [{path, sha256, size}] }` (`release.yml:260`; `FindAssets` already locates it, then discards it).
- The launcher **already does delta-*apply***: it overlays whatever is in `staged/` (a partial set is fine) and **deletes files dropped from the new manifest** (removals), with backup + rollback (`updater.cpp` steps 3–4). So a partial `staged/` + the full new manifest applies correctly.
- `{install}/manifest.json` is the currently-installed version's full file list — the diff baseline.

Consequently the feature is **almost entirely a `UpdateService` change**: no launcher, CI, or build edits.

## Goals

1. Download **only the files whose `sha256` changed** (plus the small manifest), so stable framework/NuGet DLLs and unchanged wwwroot chunks stop transferring.
2. **Never regress**: any delta problem falls back to today's full download; the update is never worse, only cheaper.
3. Keep the change contained to the server (`Modules/Update`) with small, isolated, testable units.

## Non-goals

- No launcher / CI / `build-production.mjs` / `release.yml` changes.
- No new hosting or per-file release assets (we range into the existing zip).
- No cross-version precomputed deltas (the diff is always installed-manifest vs latest-manifest, so any version gap is handled uniformly).
- No zip64 handling (bundle ~20 MB).

## A. Download flow (delta path in front of the existing full path)

1. Check release → obtain the **zip** asset URL and the **manifest.json** asset URL (both from `FindAssets`).
2. Download the new `manifest.json`; read the installed `{install}/manifest.json`. **Missing/unreadable installed manifest → full download.**
3. Diff → `changed[]` (new path, or path whose `sha256` differs). Removals need no fetch (launcher handles them).
4. Choose the path. Full download when: nothing changed; `sum(changed.size) > threshold * sum(all.size)` (default `threshold = 0.5`); or ranges aren't supported (§C). Otherwise delta.
5. **Delta:** clear `.update`, create `staged/`; resolve the zip's final CDN URL once; for each `changed` file, range-fetch + inflate its entry and write to `staged/<path>`, sha256-verifying against the new manifest; copy the new `manifest.json` into `staged/`; write `ready.json`.
6. **Any delta failure → clear staging, run the full download.** `ready.json` is written only after a clean verify, so a partial delta can never be applied.

## B. Components

- **`RemoteZip`** (new) — constructed with an `HttpClient` + resolved zip URL + content length. `LoadCentralDirectoryAsync()` range-fetches the tail (~64 KB), finds the EOCD (`0x06054b50`), reads the central-directory offset/size (range-fetches it if outside the tail), and parses records into `path → ZipEntry {LocalHeaderOffset, CompressedSize, Method}`. `FetchAsync(entry) → byte[]` issues one range request over `[LocalHeaderOffset, dataStart + CompressedSize]`, parses the 30-byte local header for the exact data offset, and inflates (method 8 = raw `DeflateStream`; method 0 = store/copy). Strips the single top-level `Gatherlight/` root from entry names so lookups are bundle-relative (the wrinkle `FlattenSingleRoot` already handles for full extracts). Knows nothing about updates — unit-testable against any zip.
- **`ManifestDiff`** (new, pure) — `Diff(old, new) → { Changed: ManifestFile[], Removed: string[] }`. `Changed` = files in `new` with no `old` entry of the same `(path, sha256)`.
- **Delta-aware verify** — verify each **fetched** file exists in `staged/` and its sha256 matches the new manifest, plus the existing "no staged file is unlisted by the manifest" intrusion check. It does **not** require every manifest file to be present in `staged/` (today's `VerifyStagedAsync` does — correct for a full extract, wrong for a delta). Implemented as a parameter/overload so the full path keeps its stricter check.
- **`UpdateService`** — orchestrates diff → path choice → delta or full → verify → `ready.json` → fallback. The existing download/extract/verify/stage machinery is reused unchanged for the full path.

## C. Remote-zip mechanics

- **Redirect + range:** GitHub's `browser_download_url` 302-redirects to a time-limited, pre-signed CDN URL. Resolve the redirect **once** (no-follow GET → `Location`; a direct `200` — the e2e loopback mock — is used as-is), confirm `Accept-Ranges: bytes` + a `Content-Length`, then issue every range request against the resolved URL. Missing range support → full fallback.
- **Central directory:** parse EOCD from the tail; range-fetch the central directory if it lies outside the fetched tail; parse records (`0x02014b50`) for method, compressed size, filename, and local-header offset.
- **Per entry:** one range request; parse the local header (`0x04034b50`) for `dataStart = 30 + fileNameLen + extraLen`; inflate `[dataStart, dataStart + compressedSize]`.

## D. Robustness & observability

- Fallback triggers (all → full download): no installed manifest; ranges unsupported; central-dir/EOCD parse failure; entry not found for a changed path (manifest↔zip mismatch); inflate error; sha256 mismatch; over-threshold change set.
- Staging cleared before either path writes; `ready.json` only after a clean verify.
- Log the outcome: `delta: fetched N/M files, X MB of Y MB (saved Z%)`, or `delta unavailable (<reason>) → full download`.

## E. Testing

- Extend the p20 update-e2e mock server to serve **HTTP Range** on the zip asset (and keep serving the release JSON + standalone manifest). New delta scenario: seed an installed `{install}/manifest.json` matching most files of a freshly built (or synthetic) bundle where a couple of files differ → trigger download → assert (a) only the changed files were range-fetched (request/byte accounting exposed by the mock), (b) `staged/` contains exactly the changed files + the new `manifest.json`, (c) delta-verify passes and `ready.json` is written with the new version.
- Fallback scenario: mock advertises no range support (or the installed manifest is absent) → assert the full download path still stages + verifies correctly.
- Apply compatibility: confirm the existing launcher-apply e2e (p19) still overlays a **partial** `staged/` set + honors manifest-diff removals (it already does; add a partial-staged fixture case).

## Success criteria

- A code-only release (unchanged `libs/` framework DLLs) downloads only the changed files (Gatherlight.Server.dll + changed wwwroot chunks + manifest) instead of the whole ~20 MB — a multi-x reduction — visible in the logs.
- Every fallback path produces a byte-identical staged result to today's full download.
- No changes outside `Modules/Update` (+ the e2e mock/suite); launcher, CI, and build untouched.

## Risks

- **GitHub CDN range behavior across the asset redirect** — mitigated by resolving the redirect once and ranging the final URL; full fallback if `Accept-Ranges` isn't `bytes`.
- **Zip parsing correctness** (local-header/central-dir edge cases, stored vs deflated entries, the `Gatherlight/` root prefix) — contained in `RemoteZip` and covered by the e2e against a real bundle zip.
- **Pre-signed URL expiry mid-download** — a delta fetches few small ranges quickly; on any range failure, fall back to a fresh full download.
