# Differential Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `UpdateService` fetch only the files whose `sha256` changed (via HTTP range into the release zip) instead of the whole ~20 MB bundle, with a hard fall-back to today's full download.

**Architecture:** A new self-contained `RemoteZip` reads individual entries out of the release zip over HTTP range requests. `UpdateService.DownloadAsync` gains a delta path: download the small standalone `manifest.json`, diff vs the installed manifest, range-fetch only the changed entries, stage them + the new manifest, delta-verify, `ready.json`. The C++ launcher (unchanged) already overlays a partial `staged/` set and does manifest-diff removals.

**Tech Stack:** ASP.NET Core (net10) `Modules/Update`; `System.IO.Compression.DeflateStream` for inflate; zip format parsing (EOCD + central directory + local headers, no zip64); e2e via `devtools/scripts/e2e/pN.mjs` with a Node mock GitHub.

**Testing note:** this repo has no C# unit-test project — the test mechanism is the integration e2e suites. `RemoteZip` and the delta path are verified end-to-end by the new `p30` suite (real zip served over HTTP range). Each code task ends with a compile check; acceptance is `p30` + the full sweep. Do not add a unit-test framework.

---

## File structure

**New (server):**
- `src/server/Gatherlight.Server/Modules/Update/Services/RemoteZip.cs` — range-based single-entry zip reader (central directory + local header parse + inflate). No knowledge of updates.

**Modified (server):**
- `src/server/Gatherlight.Server/Modules/Update/Services/UpdateService.cs` — delta orchestration (`TryDeltaAsync`), range probe, delta-aware verify (`VerifyDeltaAsync`), and a `FullDownloadAsync` extracted from today's `DownloadAsync` body; `FindAssets`' manifest URL is now used, not discarded.

**New (devtools):**
- `devtools/scripts/e2e/p30.mjs` — delta + range-fallback acceptance suite (Node mock GitHub with Range support + request accounting).

No other files change (launcher, CI, `build-production.mjs`, `release.yml` untouched — verified against the design).

---

## Task 1: RemoteZip — range-based single-entry zip reader

**Files:**
- Create: `src/server/Gatherlight.Server/Modules/Update/Services/RemoteZip.cs`

- [ ] **Step 1: Write RemoteZip**

```csharp
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Text;

namespace Gatherlight.Server.Modules.Update.Services;

/// <summary>
/// Reads individual entries out of a remote zip over HTTP range requests, so a differential update
/// fetches only the changed files' compressed bytes instead of the whole archive. No zip64 (bundles
/// are ~20 MB). Compress-Archive of a folder wraps every entry under a single top-level folder; that
/// root is stripped so entry keys are bundle-relative, matching the manifest paths (the same wrinkle
/// <c>FlattenSingleRoot</c> handles for full extracts). Range requests go to the ORIGINAL asset URL —
/// HttpClient follows GitHub's 302 to a fresh pre-signed CDN URL each time (which honors Range), so
/// there is no pre-signed-URL expiry to manage.
/// </summary>
public sealed class RemoteZip
{
    public sealed record Entry(string Path, long LocalHeaderOffset, long CompressedSize, ushort Method);

    private readonly HttpClient _http;
    private readonly string _url;
    private readonly long _length;
    private Dictionary<string, Entry> _entries = new(StringComparer.OrdinalIgnoreCase);

    public RemoteZip(HttpClient http, string url, long length)
    {
        _http = http;
        _url = url;
        _length = length;
    }

    // Range GET [from, from+count). Throws on non-206 or a short read.
    private async Task<byte[]> RangeAsync(long from, long count, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, _url);
        req.Headers.Range = new RangeHeaderValue(from, from + count - 1);
        using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseContentRead, ct);
        if (resp.StatusCode != HttpStatusCode.PartialContent)
            throw new InvalidOperationException($"range not honored (status {(int)resp.StatusCode})");
        var bytes = await resp.Content.ReadAsByteArrayAsync(ct);
        if (bytes.Length < count) throw new InvalidOperationException("short range read");
        return bytes;
    }

    /// <summary>Parse the End-Of-Central-Directory + central directory into the entry map (once).</summary>
    public async Task LoadAsync(CancellationToken ct = default)
    {
        var tailLen = (int)Math.Min(_length, 65_557); // max EOCD comment (65535) + EOCD record (22)
        var tail = await RangeAsync(_length - tailLen, tailLen, ct);

        int eocd = -1;
        for (int i = tail.Length - 22; i >= 0; i--)
            if (tail[i] == 0x50 && tail[i + 1] == 0x4b && tail[i + 2] == 0x05 && tail[i + 3] == 0x06) { eocd = i; break; }
        if (eocd < 0) throw new InvalidOperationException("EOCD not found");

        uint cdSize = BitConverter.ToUInt32(tail, eocd + 12);
        uint cdOffset = BitConverter.ToUInt32(tail, eocd + 16);

        byte[] cd;
        long tailStart = _length - tailLen;
        if (cdOffset >= tailStart)
        {
            int start = (int)(cdOffset - tailStart);
            cd = tail[start..(start + (int)cdSize)];
        }
        else cd = await RangeAsync(cdOffset, cdSize, ct);

        var entries = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
        int p = 0;
        while (p + 46 <= cd.Length && BitConverter.ToUInt32(cd, p) == 0x02014b50)
        {
            ushort method = BitConverter.ToUInt16(cd, p + 10);
            uint compSize = BitConverter.ToUInt32(cd, p + 20);
            ushort fnLen = BitConverter.ToUInt16(cd, p + 28);
            ushort exLen = BitConverter.ToUInt16(cd, p + 30);
            ushort cmLen = BitConverter.ToUInt16(cd, p + 32);
            uint lho = BitConverter.ToUInt32(cd, p + 42);
            string name = Encoding.UTF8.GetString(cd, p + 46, fnLen);
            if (!name.EndsWith('/')) entries[name] = new Entry(name, lho, compSize, method);
            p += 46 + fnLen + exLen + cmLen;
        }
        _entries = StripSingleRoot(entries);
    }

    // Drop a single shared top-level folder so keys are bundle-relative. No shared root → unchanged.
    private static Dictionary<string, Entry> StripSingleRoot(Dictionary<string, Entry> entries)
    {
        string? root = null;
        foreach (var k in entries.Keys)
        {
            var slash = k.IndexOf('/');
            if (slash <= 0) return entries; // a top-level file → no single wrapping root
            var top = k[..slash];
            if (root is null) root = top;
            else if (!root.Equals(top, StringComparison.OrdinalIgnoreCase)) return entries;
        }
        if (root is null) return entries;
        var prefix = root + "/";
        var remapped = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
        foreach (var (k, v) in entries)
        {
            var nk = k[prefix.Length..];
            remapped[nk] = v with { Path = nk };
        }
        return remapped;
    }

    public bool TryGet(string path, out Entry entry) => _entries.TryGetValue(path.Replace('\\', '/'), out entry!);

    /// <summary>Range-fetch one entry and inflate it (method 8 = raw deflate; 0 = stored).</summary>
    public async Task<byte[]> FetchAsync(Entry e, CancellationToken ct = default)
    {
        // Grab the local header (30 fixed + a generous 512 for name/extra) + the compressed data in one
        // request; re-fetch the data exactly if name+extra overflowed the slack (rare).
        long grab = Math.Min(30 + 512 + e.CompressedSize, _length - e.LocalHeaderOffset);
        var buf = await RangeAsync(e.LocalHeaderOffset, grab, ct);
        if (BitConverter.ToUInt32(buf, 0) != 0x04034b50) throw new InvalidOperationException("bad local header");
        ushort fnLen = BitConverter.ToUInt16(buf, 26);
        ushort exLen = BitConverter.ToUInt16(buf, 28);
        int dataStart = 30 + fnLen + exLen;

        byte[] comp;
        if (dataStart + e.CompressedSize <= buf.Length)
            comp = buf.AsSpan(dataStart, (int)e.CompressedSize).ToArray();
        else
            comp = await RangeAsync(e.LocalHeaderOffset + dataStart, e.CompressedSize, ct);

        if (e.Method == 0) return comp;                         // stored
        if (e.Method != 8) throw new InvalidOperationException($"unsupported zip method {e.Method}");
        using var msIn = new MemoryStream(comp);
        using var inflate = new DeflateStream(msIn, CompressionMode.Decompress);
        using var msOut = new MemoryStream();
        await inflate.CopyToAsync(msOut, ct);
        return msOut.ToArray();
    }
}
```

- [ ] **Step 2: Build**

Run: `dotnet build src/server/Gatherlight.Server -v q -clp:ErrorsOnly`
Expected: `Build succeeded. 0 Error(s)`

- [ ] **Step 3: Commit**

```bash
git add src/server/Gatherlight.Server/Modules/Update/Services/RemoteZip.cs
git commit -m "feat(update): RemoteZip — range-based single-entry zip reader"
```

---

## Task 2: UpdateService delta path

**Files:**
- Modify: `src/server/Gatherlight.Server/Modules/Update/Services/UpdateService.cs`

- [ ] **Step 1: Add a threshold constant**

Add near the top of the class body (after `private readonly UpdateState _state = new();`):

```csharp
    // Above this fraction of total bytes changed, a whole-zip download is simpler than many ranges.
    private const double DeltaThreshold = 0.5;
```

- [ ] **Step 2: Refactor `DownloadAsync` to try delta first, else the existing full download**

Replace the body of `DownloadAsync` (from the `var api = ApiUrl()!;` line through `SetDone(pending: true, version: info.LatestVersion);`) with:

```csharp
            var api = ApiUrl()!;
            using var client = NewClient();
            var releaseJson = await client.GetStringAsync(api);
            using var doc = JsonDocument.Parse(releaseJson);
            var (zipUrl, manifestUrl) = FindAssets(doc.RootElement);
            if (zipUrl is null) throw new InvalidOperationException("release has no .zip asset");
            if (!IsSecureUpdateUrl(zipUrl)) throw new InvalidOperationException("release zip URL must be https (or http to loopback)");

            // Differential: fetch only changed files. Any problem returns false → full download below.
            var delta = manifestUrl is not null && IsSecureUpdateUrl(manifestUrl)
                && await TryDeltaAsync(client, zipUrl, manifestUrl, info.LatestVersion!);

            if (!delta)
                await FullDownloadAsync(client, zipUrl, info.LatestVersion!);

            _log.LogInformation("Update {V} staged ({Mode}); applies on next restart.", info.LatestVersion, delta ? "delta" : "full");
            SetDone(pending: true, version: info.LatestVersion);
```

(The `catch` block after it is unchanged — it already clears staging + records the error.)

- [ ] **Step 3: Extract the existing full-download logic into `FullDownloadAsync`**

Add this method to the class (it is the code that was inline in `DownloadAsync` before, minus the `ready.json`+`SetDone`, which move here for the full path):

```csharp
    // The original whole-zip path: download → extract → verify every manifest file → ready.json.
    private async Task FullDownloadAsync(HttpClient client, string zipUrl, string version)
    {
        if (Directory.Exists(StagingRoot)) Directory.Delete(StagingRoot, recursive: true);
        Directory.CreateDirectory(StagingRoot);
        var zipPath = Path.Combine(StagingRoot, "update.zip");

        await DownloadFileAsync(client, zipUrl, zipPath);

        Report(93);
        if (Directory.Exists(StagedDir)) Directory.Delete(StagedDir, recursive: true);
        ZipFile.ExtractToDirectory(zipPath, StagedDir, overwriteFiles: true);
        File.Delete(zipPath);
        FlattenSingleRoot(StagedDir);

        Report(97);
        var problems = await VerifyStagedAsync(StagedDir);
        if (problems.Count > 0)
            throw new InvalidOperationException($"verification failed ({problems.Count}): {string.Join(", ", problems.Take(3))}");

        await File.WriteAllTextAsync(ReadyMarker, JsonSerializer.Serialize(new { version }));
    }
```

- [ ] **Step 4: Add the delta orchestration + range probe + delta verify**

Add these three methods to the class:

```csharp
    // Try a differential update: diff the installed manifest vs the release manifest, range-fetch only
    // the changed files out of the zip, stage them + the new manifest, and verify. Returns true when a
    // full delta was staged + ready.json written; false (or on any exception) means "fall back to full".
    private async Task<bool> TryDeltaAsync(HttpClient client, string zipUrl, string manifestUrl, string version)
    {
        try
        {
            var installedPath = Path.Combine(InstallDir, "manifest.json");
            if (!File.Exists(installedPath)) { _log.LogInformation("delta: no installed manifest → full"); return false; }
            var installed = JsonSerializer.Deserialize<UpdateManifest>(await File.ReadAllTextAsync(installedPath), Web);
            var newManifestJson = await client.GetStringAsync(manifestUrl);
            var newManifest = JsonSerializer.Deserialize<UpdateManifest>(newManifestJson, Web);
            if (installed is null || newManifest is null || newManifest.Files.Count == 0) return false;

            var old = installed.Files.ToDictionary(f => f.Path, f => f.Sha256, StringComparer.OrdinalIgnoreCase);
            var changed = newManifest.Files
                .Where(f => !(old.TryGetValue(f.Path, out var s) && string.Equals(s, f.Sha256, StringComparison.OrdinalIgnoreCase)))
                .ToList();
            if (changed.Count == 0) { _log.LogInformation("delta: nothing changed → full"); return false; }

            long changedBytes = changed.Sum(f => f.Size), totalBytes = newManifest.Files.Sum(f => f.Size);
            if (totalBytes > 0 && changedBytes > totalBytes * DeltaThreshold)
            {
                _log.LogInformation("delta: {P}% changed exceeds threshold → full", (int)(100 * changedBytes / totalBytes));
                return false;
            }

            var (length, rangeOk) = await ProbeRangeAsync(client, zipUrl);
            if (!rangeOk || length <= 0) { _log.LogInformation("delta: no range support → full"); return false; }

            var zip = new RemoteZip(client, zipUrl, length);
            await zip.LoadAsync();

            if (Directory.Exists(StagingRoot)) Directory.Delete(StagingRoot, recursive: true);
            Directory.CreateDirectory(StagedDir);
            Report(5);

            var n = 0;
            foreach (var f in changed)
            {
                if (!zip.TryGet(f.Path, out var entry)) { _log.LogWarning("delta: {P} not in zip → full", f.Path); return false; }
                var bytes = await zip.FetchAsync(entry);
                var dest = Path.Combine(StagedDir, f.Path.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                await File.WriteAllBytesAsync(dest, bytes);
                n++;
                Report(5 + (int)(85L * n / changed.Count));
            }

            await File.WriteAllTextAsync(Path.Combine(StagedDir, "manifest.json"), newManifestJson);
            Report(96);

            var problems = await VerifyDeltaAsync(StagedDir, changed);
            if (problems.Count > 0) { _log.LogWarning("delta: verify failed ({N}): {P} → full", problems.Count, string.Join(", ", problems.Take(3))); return false; }

            await File.WriteAllTextAsync(ReadyMarker, JsonSerializer.Serialize(new { version }));
            _log.LogInformation("delta: staged {N}/{M} files, {A}/{B} bytes ({P}% of full).",
                changed.Count, newManifest.Files.Count, changedBytes, totalBytes, totalBytes > 0 ? (int)(100 * changedBytes / totalBytes) : 0);
            return true;
        }
        catch (Exception ex)
        {
            _log.LogWarning("delta failed ({Msg}) → full", ex.Message);
            try { if (Directory.Exists(StagingRoot)) Directory.Delete(StagingRoot, recursive: true); } catch { }
            return false;
        }
    }

    // One-byte range probe: does the asset (following redirects) honor Range? Returns the total length.
    private async Task<(long length, bool rangeOk)> ProbeRangeAsync(HttpClient client, string url)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(0, 0);
            using var resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
            if (resp.StatusCode == System.Net.HttpStatusCode.PartialContent && resp.Content.Headers.ContentRange?.Length is long len && len > 0)
                return (len, true);
            return (-1, false);
        }
        catch { return (-1, false); }
    }

    // Delta verify: the fetched files exist + match the new manifest's sha256, and staged/ holds ONLY
    // those files + manifest.json (an intrusion check). Unlike VerifyStagedAsync it does NOT require
    // every manifest file to be present — a delta stages only what changed.
    public async Task<List<string>> VerifyDeltaAsync(string stagedDir, IReadOnlyList<ManifestFile> changed)
    {
        var problems = new List<string>();
        foreach (var f in changed)
        {
            var full = Path.Combine(stagedDir, f.Path.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(full)) { problems.Add($"{f.Path} (missing)"); continue; }
            if (string.IsNullOrEmpty(f.Sha256)) { problems.Add($"{f.Path} (no sha256)"); continue; }
            if (!string.Equals(await Sha256Async(full), f.Sha256, StringComparison.OrdinalIgnoreCase))
                problems.Add($"{f.Path} (hash mismatch)");
        }
        var changedSet = changed.Select(f => f.Path.Replace('\\', '/')).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var full in Directory.EnumerateFiles(stagedDir, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(stagedDir, full).Replace('\\', '/');
            if (rel == "manifest.json" || changedSet.Contains(rel)) continue;
            problems.Add($"{rel} (unexpected in delta staged)");
        }
        return problems;
    }
```

- [ ] **Step 5: Build**

Run: `dotnet build src/server/Gatherlight.Server -v q -clp:ErrorsOnly`
Expected: `Build succeeded. 0 Error(s)`. If `Web`, `Sha256Async`, `FindAssets`, `DownloadFileAsync`, `VerifyStagedAsync`, `FlattenSingleRoot`, `IsSecureUpdateUrl`, `Report`, `SetDone`, `StagingRoot`, `StagedDir`, `ReadyMarker`, `InstallDir` don't resolve, confirm they're existing private members of this class (they are) — do not re-declare.

- [ ] **Step 6: Commit**

```bash
git add src/server/Gatherlight.Server/Modules/Update/Services/UpdateService.cs
git commit -m "feat(update): differential download — diff manifest, range-fetch changed files, full fallback"
```

---

## Task 3: e2e p30 — delta + range-fallback

**Files:**
- Create: `devtools/scripts/e2e/p30.mjs`

- [ ] **Step 1: Write the suite**

```js
#!/usr/bin/env node
// e2e P30 — differential auto-update. A mock "GitHub" serves a release zip WITH HTTP Range support and
// counts what it serves. Scenario 1 (delta): an installed manifest matching all-but-one file → only the
// changed file's ranges are fetched (never the whole zip), staged correctly, ready.json written.
// Scenario 2 (fallback): the mock refuses Range → the updater falls back to the full download.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { repo, dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, until } from './_e2e-common.mjs';

const dataDir = dataDirFor('p30');
const installDir = path.join(repo, 'devtools', '_e2e-p30-install');
// Name the src folder "Gatherlight" so Compress-Archive of the FOLDER wraps entries under Gatherlight/
// — exercising RemoteZip.StripSingleRoot exactly like the production bundle.
const src = path.join(repo, 'devtools', '_e2e-p30-src', 'Gatherlight');
const zipPath = path.join(repo, 'devtools', '_e2e-p30-update.zip');
const PORT = 5455, FAKE = 5456;
const { ok, fail, done } = makeReporter('p30');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// --- build a release bundle: app.txt (will change) + big.bin (unchanged, must NOT be refetched) + res/deep.txt (unchanged) ---
fs.rmSync(path.dirname(src), { recursive: true, force: true });
fs.mkdirSync(path.join(src, 'res'), { recursive: true });
const appNew = 'app v9.9.9 new';
const big = Buffer.alloc(20000, 7);       // 20 KB incompressible-ish filler that must not transfer
const deep = 'nested-unchanged';
fs.writeFileSync(path.join(src, 'app.txt'), appNew);
fs.writeFileSync(path.join(src, 'big.bin'), big);
fs.writeFileSync(path.join(src, 'res', 'deep.txt'), deep);
const newManifest = {
  product: 'Gatherlight', version: '9.9.9', rid: 'win-x64',
  files: [
    { path: 'app.txt', sha256: sha256(Buffer.from(appNew)), size: appNew.length },
    { path: 'big.bin', sha256: sha256(big), size: big.length },
    { path: 'res/deep.txt', sha256: sha256(Buffer.from(deep)), size: deep.length },
  ],
};
fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify(newManifest, null, 2));
fs.rmSync(zipPath, { force: true });
spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  `Compress-Archive -Path '${src}' -DestinationPath '${zipPath}' -Force`], { stdio: 'ignore' });
const zipBytes = fs.readFileSync(zipPath);
const manifestBytes = Buffer.from(JSON.stringify(newManifest));

// --- mock GitHub: release JSON + manifest + zip (Range-aware, counting) ---
let supportRange = true;
let fullZipServes = 0;      // count of whole-zip (non-range) responses
let rangeBytes = 0;         // total bytes served via range
const mock = http.createServer((req, res) => {
  if (req.url.startsWith('/releases/latest')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      tag_name: 'v9.9.9', name: 'Gatherlight 9.9.9', body: 'delta test',
      html_url: 'http://example/9.9.9', published_at: '2026-07-22T00:00:00Z',
      assets: [
        { name: 'Gatherlight-9.9.9-win-x64.zip', browser_download_url: `http://127.0.0.1:${FAKE}/update.zip` },
        { name: 'manifest.json', browser_download_url: `http://127.0.0.1:${FAKE}/manifest.json` },
      ],
    }));
  } else if (req.url === '/manifest.json') {
    res.setHeader('content-type', 'application/json'); res.end(manifestBytes);
  } else if (req.url === '/update.zip') {
    const range = supportRange ? req.headers.range : undefined;
    if (range && /^bytes=\d+-\d+$/.test(range)) {
      const [s, e] = range.slice(6).split('-').map(Number);
      const slice = zipBytes.subarray(s, e + 1);
      rangeBytes += slice.length;
      res.statusCode = 206;
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('content-range', `bytes ${s}-${e}/${zipBytes.length}`);
      res.setHeader('content-length', slice.length);
      res.end(slice);
    } else {
      fullZipServes++;
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-length', zipBytes.length);
      res.end(zipBytes);
    }
  } else { res.statusCode = 404; res.end(); }
});
await new Promise((r) => mock.listen(FAKE, r));

makeTestData(dataDir);
fs.rmSync(installDir, { recursive: true, force: true });
fs.mkdirSync(installDir, { recursive: true });
// Installed manifest: big.bin + res/deep.txt already match the new release; app.txt has the OLD hash.
const installedManifest = {
  product: 'Gatherlight', version: '9.9.8', rid: 'win-x64',
  files: [
    { path: 'app.txt', sha256: sha256(Buffer.from('app v9.9.8 OLD')), size: 13 },
    { path: 'big.bin', sha256: sha256(big), size: big.length },
    { path: 'res/deep.txt', sha256: sha256(Buffer.from(deep)), size: deep.length },
  ],
};
fs.writeFileSync(path.join(installDir, 'manifest.json'), JSON.stringify(installedManifest));

const srv = startServer({
  dataDir, port: PORT,
  env: { GATHERLIGHT_INSTALL_DIR: installDir, GATHERLIGHT_UPDATE_API: `http://127.0.0.1:${FAKE}/releases/latest` },
});
const { j } = makeClient(srv.base);

const stagedDir = path.join(installDir, '.update', 'staged');
const triggerDownload = async () => {
  await j('/api/manage/update/download', { method: 'POST' });
  return until(async () => {
    const s = (await j('/api/manage/update/state')).body;
    if (s.error) throw new Error('stage errored: ' + s.error);
    return s.pending ? s : null;
  });
};

try {
  await waitHealthy(srv.base);

  // --- Scenario 1: DELTA — only app.txt should transfer ------------------------------------
  const st1 = await triggerDownload();
  ok('delta: pending 9.9.9', st1.pending === true && st1.pendingVersion === '9.9.9', JSON.stringify(st1));
  ok('delta: whole zip never served', fullZipServes === 0, `fullZipServes=${fullZipServes}`);
  ok('delta: bytes served << full zip', rangeBytes < zipBytes.length && rangeBytes < 8000, `rangeBytes=${rangeBytes} zip=${zipBytes.length}`);
  ok('delta: app.txt staged with new content', fs.existsSync(path.join(stagedDir, 'app.txt')) && fs.readFileSync(path.join(stagedDir, 'app.txt'), 'utf8') === appNew);
  ok('delta: big.bin NOT staged (unchanged)', !fs.existsSync(path.join(stagedDir, 'big.bin')));
  ok('delta: res/deep.txt NOT staged (unchanged)', !fs.existsSync(path.join(stagedDir, 'res', 'deep.txt')));
  ok('delta: new manifest staged', fs.existsSync(path.join(stagedDir, 'manifest.json')));
  ok('delta: ready.json written', fs.existsSync(path.join(installDir, '.update', 'ready.json')));

  // --- Scenario 2: FALLBACK — mock refuses Range → full download stages everything -----------
  fs.rmSync(path.join(installDir, '.update'), { recursive: true, force: true });
  supportRange = false; fullZipServes = 0; rangeBytes = 0;
  const st2 = await triggerDownload();
  ok('fallback: pending 9.9.9', st2.pending === true && st2.pendingVersion === '9.9.9');
  ok('fallback: whole zip served once', fullZipServes >= 1, `fullZipServes=${fullZipServes}`);
  ok('fallback: all files staged', ['app.txt', 'big.bin', 'res/deep.txt'].every((p) => fs.existsSync(path.join(stagedDir, p.replace('/', path.sep)))));
  ok('fallback: manifest staged + ready.json', fs.existsSync(path.join(stagedDir, 'manifest.json')) && fs.existsSync(path.join(installDir, '.update', 'ready.json')));
} catch (err) {
  fail('e2e-p30 fatal: ' + err.message);
  console.error(srv.log().slice(-2500));
} finally {
  srv.stop();
  mock.close();
  fs.rmSync(path.dirname(src), { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.rmSync(installDir, { recursive: true, force: true });
}
done();
```

- [ ] **Step 2: Run p30**

Run: `node devtools/dev.mjs e2e p30`
Expected: `e2e-p30 PASS`. If the delta scenario reports `whole zip served` > 0, the delta path bailed — check the server log (printed on failure) for the `delta: … → full` reason and fix the cause (do NOT weaken the assertion). Likely causes: `ProbeRangeAsync` not seeing 206 (mock range header parse), or `RemoteZip` not finding `app.txt` (StripSingleRoot / path mapping).

- [ ] **Step 3: Commit**

```bash
git add devtools/scripts/e2e/p30.mjs
git commit -m "test(e2e): p30 — differential update (delta fetch + range fallback)"
```

---

## Task 4: Full sweep

- [ ] **Step 1: Full build**

Run: `node devtools/dev.mjs build`
Expected: client `✓ built`, server `Build succeeded`.

- [ ] **Step 2: Full e2e sweep**

Run: `node devtools/dev.mjs e2e all`
Expected: `e2e: 30/30 suites passed`. In particular p20 (full update download) must still pass unchanged — it has no installed manifest, so the delta path bails to full immediately.

- [ ] **Step 3: Commit any final fixups**

```bash
git add -A
git commit -m "chore(update): finalize differential update"
```

---

## Self-review notes (author)

- **Spec coverage:** A (flow + fallback) → Task 2 `DownloadAsync`/`TryDeltaAsync`. B (RemoteZip / ManifestDiff / delta-verify / orchestration) → Task 1 + Task 2. C (range + redirect + central-dir + per-entry) → Task 1 `RemoteZip` + Task 2 `ProbeRangeAsync`. D (fallback triggers, staging discipline, logging) → Task 2 `TryDeltaAsync`. E (range mock + delta + fallback + partial-apply) → Task 3 (p30); the partial-staged launcher-apply is already covered by the launcher's existing manifest-diff overlay (p19) and by p30 asserting a partial `staged/`.
- **Type consistency:** `RemoteZip.Entry` fields, `TryGet`/`FetchAsync`/`LoadAsync` names match between Task 1 and Task 2; `UpdateManifest`/`ManifestFile` are the existing model types; `VerifyDeltaAsync(stagedDir, changed)` signature matches its call.
- **Fallback safety:** every early `return false` in `TryDeltaAsync` (and the `catch`) leaves the download to `FullDownloadAsync`; `ready.json` is written only on a clean verify in either path.
- **Known follow-up (out of scope):** none required; `build-production.mjs`/CI/launcher unchanged by design.
```
