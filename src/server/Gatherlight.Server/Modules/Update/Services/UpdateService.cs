using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Update.Models;

namespace Gatherlight.Server.Modules.Update.Services;

/// <summary>
/// App self-update (the C# half of the two-phase flow; the C++ launcher applies it — see updater.cpp).
/// Checks the configured GitHub release, and on request downloads the release zip, extracts it to
/// <c>{install}/.update/staged</c>, verifies every staged file against the staged manifest's sha256,
/// and writes <c>{install}/.update/ready.json</c>. The launcher overlays that on the next startup (a
/// running exe can't replace itself). The desktop console drives it and then restarts via the launcher.
/// </summary>
public interface IUpdateService
{
    Task<UpdateInfo> CheckAsync();
    void StartDownload();
    UpdateState GetState();
}

public sealed class UpdateService : IUpdateService
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    private readonly IHttpClientFactory _http;
    private readonly ServerConfigService _config;
    private readonly ILogger<UpdateService> _log;

    private readonly object _gate = new();
    private readonly UpdateState _state = new();

    // Above this fraction of total bytes changed, a whole-zip download is simpler than many ranges.
    private const double DeltaThreshold = 0.5;

    public UpdateService(IHttpClientFactory http, ServerConfigService config, ILogger<UpdateService> log)
    {
        _http = http;
        _config = config;
        _log = log;
    }

    // Install root = the dir holding manifest.json + the launcher (the host runs from libs/, so it's
    // the parent). GATHERLIGHT_INSTALL_DIR overrides (tests / unusual layouts).
    private string InstallDir
    {
        get
        {
            var env = Environment.GetEnvironmentVariable("GATHERLIGHT_INSTALL_DIR");
            if (!string.IsNullOrWhiteSpace(env)) return env;
            var b = AppContext.BaseDirectory;
            if (File.Exists(Path.Combine(b, "manifest.json"))) return b;
            var parent = Path.GetFullPath(Path.Combine(b, ".."));
            if (File.Exists(Path.Combine(parent, "manifest.json"))) return parent;
            return b;
        }
    }

    private string StagingRoot => Path.Combine(InstallDir, ".update");
    private string StagedDir => Path.Combine(StagingRoot, "staged");
    private string ReadyMarker => Path.Combine(StagingRoot, "ready.json");

    // Effective release-API URL: env > explicit setting > derived from the repo slug; null = disabled.
    // The update payload is applied to the install, so the fetch MUST be https — a http/other-scheme URL
    // disables updates (fail safe) rather than fetching the trust anchor in cleartext.
    private string? ApiUrl()
    {
        var u = _config.Current.SelfUpdate;
        var api = Environment.GetEnvironmentVariable("GATHERLIGHT_UPDATE_API");
        if (string.IsNullOrWhiteSpace(api)) api = u.ApiUrl;
        if (!string.IsNullOrWhiteSpace(api))
        {
            if (IsSecureUpdateUrl(api)) return api;
            _log.LogWarning("Update API URL must be https (or http to loopback) — updates disabled: {Api}", api);
            return null;
        }

        var repo = Environment.GetEnvironmentVariable("GATHERLIGHT_UPDATE_REPO");
        if (string.IsNullOrWhiteSpace(repo)) repo = u.GithubRepo;
        if (!string.IsNullOrWhiteSpace(repo)) return $"https://api.github.com/repos/{repo.Trim()}/releases/latest";
        return null;
    }

    // https, or http only to loopback (a local mirror / the update e2e's mock server). A REMOTE http
    // source is MITM-able and the payload is applied to the install.
    private static bool IsSecureUpdateUrl(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u)
        && (u.Scheme == Uri.UriSchemeHttps || (u.Scheme == Uri.UriSchemeHttp && u.IsLoopback));

    private HttpClient NewClient()
    {
        var c = _http.CreateClient();
        c.Timeout = TimeSpan.FromMinutes(10);
        c.DefaultRequestHeaders.Add("User-Agent", "Gatherlight-Updater");
        c.DefaultRequestHeaders.Add("Accept", "application/vnd.github+json");
        return c;
    }

    public async Task<UpdateInfo> CheckAsync()
    {
        var current = CurrentVersion();
        var api = ApiUrl();
        if (api is null) return new UpdateInfo { Configured = false, CurrentVersion = current };

        try
        {
            using var client = NewClient();
            var json = await client.GetStringAsync(api);
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var latest = NormalizeVersion(Str(root, "tag_name"));
            return new UpdateInfo
            {
                Configured = true,
                CurrentVersion = current,
                LatestVersion = latest,
                ReleaseName = Str(root, "name"),
                ReleaseNotes = Str(root, "body"),
                ReleaseUrl = Str(root, "html_url"),
                PublishedAt = Str(root, "published_at"),
                UpdateAvailable = IsNewer(latest, current),
            };
        }
        catch (Exception ex)
        {
            _log.LogWarning("Update check failed: {Msg}", ex.Message);
            return new UpdateInfo { Configured = true, CurrentVersion = current, Error = ex.Message };
        }
    }

    public UpdateState GetState()
    {
        lock (_gate)
        {
            _state.Configured = ApiUrl() is not null;
            if (!_state.Downloading)
            {
                _state.Pending = File.Exists(ReadyMarker);
                _state.PendingVersion = _state.Pending ? TryReadPendingVersion() : null;
            }
            return Clone(_state);
        }
    }

    public void StartDownload()
    {
        lock (_gate)
        {
            if (_state.Downloading) return;
            _state.Downloading = true;
            _state.Progress = 0;
            _state.Error = null;
        }
        _ = Task.Run(DownloadAsync);
    }

    private async Task DownloadAsync()
    {
        try
        {
            var info = await CheckAsync();
            if (!info.Configured) throw new InvalidOperationException("updates are not configured");
            if (info.Error is not null) throw new InvalidOperationException(info.Error);
            if (!info.UpdateAvailable || string.IsNullOrWhiteSpace(info.LatestVersion))
            {
                SetDone(pending: false);
                return;
            }

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
        }
        catch (Exception ex)
        {
            _log.LogWarning("Update download failed: {Msg}", ex.Message);
            try { if (Directory.Exists(StagingRoot)) Directory.Delete(StagingRoot, recursive: true); } catch { }
            lock (_gate) { _state.Downloading = false; _state.Error = ex.Message; _state.Pending = false; }
        }
    }

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
                // Zip-slip guard: a hostile manifest path (../, absolute) must not write outside staged/.
                // The full-download fallback (ZipFile.ExtractToDirectory) rejects the same, so bail to it.
                if (!Path.GetFullPath(dest).StartsWith(Path.GetFullPath(StagedDir) + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                { _log.LogWarning("delta: entry path escapes staged/ ({P}) → full", f.Path); return false; }
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

    private async Task DownloadFileAsync(HttpClient client, string url, string dest)
    {
        using var resp = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        resp.EnsureSuccessStatusCode();
        var total = resp.Content.Headers.ContentLength ?? -1;
        await using var src = await resp.Content.ReadAsStreamAsync();
        await using var dst = File.Create(dest);
        var buf = new byte[81920];
        long read = 0;
        int n;
        while ((n = await src.ReadAsync(buf)) > 0)
        {
            await dst.WriteAsync(buf.AsMemory(0, n));
            read += n;
            if (total > 0) Report((int)(read * 90 / total));   // download = 0–90%
        }
    }

    // Verify every file the staged manifest lists against its sha256. A missing/unreadable manifest is
    // itself a failure (never apply an unverifiable update). Returns the problems (empty = all good).
    public async Task<List<string>> VerifyStagedAsync(string stagedDir)
    {
        var problems = new List<string>();
        var manifestPath = Path.Combine(stagedDir, "manifest.json");
        if (!File.Exists(manifestPath)) { problems.Add("manifest.json (missing)"); return problems; }

        UpdateManifest? manifest;
        try { manifest = JsonSerializer.Deserialize<UpdateManifest>(await File.ReadAllTextAsync(manifestPath), Web); }
        catch (Exception ex) { problems.Add($"manifest.json (unreadable: {ex.Message})"); return problems; }
        if (manifest is null) { problems.Add("manifest.json (empty)"); return problems; }

        foreach (var f in manifest.Files)
        {
            var full = Path.Combine(stagedDir, f.Path.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(full)) { problems.Add($"{f.Path} (missing)"); continue; }
            // A blank hash is a tampered/incomplete manifest — never skip verification for a listed file.
            if (string.IsNullOrEmpty(f.Sha256)) { problems.Add($"{f.Path} (no sha256 in manifest)"); continue; }
            if (!string.Equals(await Sha256Async(full), f.Sha256, StringComparison.OrdinalIgnoreCase))
                problems.Add($"{f.Path} (hash mismatch)");
        }

        // Reject any staged file NOT covered by the manifest — the launcher overlays everything in
        // staged/, so an unlisted (unverified) file would otherwise be applied (e.g. a side-loaded DLL).
        // Mirror the builder's manifest exclusions (build-production.mjs): user data + the version-locked
        // Playwright runtime are intentionally unhashed, so they're expected-but-unlisted, not intrusions.
        var listed = manifest.Files.Select(f => f.Path.Replace('\\', '/')).ToHashSet(StringComparer.OrdinalIgnoreCase);
        listed.Add("manifest.json");
        foreach (var full in Directory.EnumerateFiles(stagedDir, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(stagedDir, full).Replace('\\', '/');
            if (IsUnhashedByDesign(rel) || listed.Contains(rel)) continue;
            problems.Add($"{rel} (not in manifest)");
        }
        return problems;
    }

    // Paths the build deliberately omits from the manifest (build-production.mjs §5) — user data + the
    // huge version-locked Playwright runtime. Not intrusions; skip them in the unlisted-file check.
    private static bool IsUnhashedByDesign(string rel) =>
        rel is "data" or ".update"
        || rel.StartsWith("data/", StringComparison.OrdinalIgnoreCase)
        || rel.StartsWith(".update/", StringComparison.OrdinalIgnoreCase)
        || rel.StartsWith("libs/browsers/", StringComparison.OrdinalIgnoreCase)
        || rel.StartsWith("libs/.playwright/", StringComparison.OrdinalIgnoreCase);

    // Compress-Archive wraps the bundle in a top-level "Gatherlight/" folder; unwrap it so staged/ has
    // manifest.json + libs/ + res/ directly (ExtractToDirectory keeps the archive's own root).
    private static void FlattenSingleRoot(string dir)
    {
        if (File.Exists(Path.Combine(dir, "manifest.json"))) return;
        var entries = Directory.GetFileSystemEntries(dir);
        if (entries.Length == 1 && Directory.Exists(entries[0]) && File.Exists(Path.Combine(entries[0], "manifest.json")))
        {
            foreach (var e in Directory.GetFileSystemEntries(entries[0]))
                Directory.Move(e, Path.Combine(dir, Path.GetFileName(e)));
            Directory.Delete(entries[0], recursive: true);
        }
    }

    private static (string? Zip, string? Manifest) FindAssets(JsonElement root)
    {
        string? zip = null, manifest = null;
        if (root.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array)
        {
            foreach (var a in assets.EnumerateArray())
            {
                var name = Str(a, "name");
                var url = Str(a, "browser_download_url");
                if (string.IsNullOrEmpty(url)) continue;
                if (name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)) zip = url;
                else if (name.Equals("manifest.json", StringComparison.OrdinalIgnoreCase)) manifest = url;
            }
        }
        return (zip, manifest);
    }

    private void Report(int pct) { lock (_gate) { _state.Progress = Math.Clamp(pct, 0, 100); } }
    private void SetDone(bool pending, string? version = null)
    {
        lock (_gate)
        {
            _state.Downloading = false;
            _state.Progress = pending ? 100 : 0;
            _state.Pending = pending;
            _state.PendingVersion = version;
        }
    }

    private string? TryReadPendingVersion()
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(ReadyMarker));
            return Str(doc.RootElement, "version");
        }
        catch { return null; }
    }

    private static UpdateState Clone(UpdateState s) => new()
    {
        Configured = s.Configured, Downloading = s.Downloading, Progress = s.Progress,
        Pending = s.Pending, PendingVersion = s.PendingVersion, Error = s.Error,
    };

    private static async Task<string> Sha256Async(string path)
    {
        await using var stream = File.OpenRead(path);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream)).ToLowerInvariant();
    }

    private static string CurrentVersion() => Core.Services.AppVersion.Semver;

    private static string NormalizeVersion(string tag)
    {
        tag = tag.Trim();
        if (tag.StartsWith("v", StringComparison.OrdinalIgnoreCase)) tag = tag[1..];
        // Canonicalize the numeric core to 3-part semver so a `v1.0` release renders + compares as
        // `1.0.0` (matching the app's own AppVersion.Semver), preserving any -pre/+build suffix.
        var core = NumericCore(tag);
        var suffix = tag.Length > core.Length ? tag[core.Length..] : "";
        var parts = core.Split('.', StringSplitOptions.RemoveEmptyEntries).ToList();
        while (parts.Count < 3) parts.Add("0");
        return string.Join('.', parts.Take(3)) + suffix;
    }

    private static bool IsNewer(string latest, string current)
    {
        if (string.IsNullOrWhiteSpace(latest)) return false;
        // Compare the numeric core, stripping any prerelease/build suffix (1.2.0-rc1 → 1.2.0). If either
        // side still isn't a plain version, treat it as NOT newer — an unparseable tag must never flip
        // UpdateAvailable=true on every check (which would loop re-download / downgrade-to-equal).
        return Version.TryParse(Pad(NumericCore(latest)), out var l) && Version.TryParse(Pad(NumericCore(current)), out var c)
            && l > c;
    }

    private static string NumericCore(string v)
    {
        var i = v.IndexOfAny(new[] { '-', '+' });
        return i >= 0 ? v[..i] : v;
    }

    private static string Pad(string v) => v.Count(ch => ch == '.') >= 1 ? v : v + ".0";

    private static string Str(JsonElement el, string prop) => JsonEl.Str(el, prop);
}
