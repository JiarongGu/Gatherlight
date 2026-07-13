using System.IO.Compression;
using System.Reflection;
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
    private string? ApiUrl()
    {
        var u = _config.Current.SelfUpdate;
        var api = Environment.GetEnvironmentVariable("GATHERLIGHT_UPDATE_API");
        if (string.IsNullOrWhiteSpace(api)) api = u.ApiUrl;
        if (!string.IsNullOrWhiteSpace(api)) return api;

        var repo = Environment.GetEnvironmentVariable("GATHERLIGHT_UPDATE_REPO");
        if (string.IsNullOrWhiteSpace(repo)) repo = u.GithubRepo;
        if (!string.IsNullOrWhiteSpace(repo)) return $"https://api.github.com/repos/{repo.Trim()}/releases/latest";
        return null;
    }

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
            var (zipUrl, _) = FindAssets(doc.RootElement);
            if (zipUrl is null) throw new InvalidOperationException("release has no .zip asset");

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

            await File.WriteAllTextAsync(ReadyMarker, JsonSerializer.Serialize(new { version = info.LatestVersion }));
            _log.LogInformation("Update {V} staged; applies on next restart.", info.LatestVersion);
            SetDone(pending: true, version: info.LatestVersion);
        }
        catch (Exception ex)
        {
            _log.LogWarning("Update download failed: {Msg}", ex.Message);
            try { if (Directory.Exists(StagingRoot)) Directory.Delete(StagingRoot, recursive: true); } catch { }
            lock (_gate) { _state.Downloading = false; _state.Error = ex.Message; _state.Pending = false; }
        }
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
            if (string.IsNullOrEmpty(f.Sha256)) continue;
            if (!string.Equals(await Sha256Async(full), f.Sha256, StringComparison.OrdinalIgnoreCase))
                problems.Add($"{f.Path} (hash mismatch)");
        }
        return problems;
    }

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

    private static string CurrentVersion()
    {
        var v = (Assembly.GetEntryAssembly() ?? Assembly.GetExecutingAssembly()).GetName().Version;
        if (v is null) return "0.0.0";
        return $"{v.Major}.{v.Minor}.{v.Build}";
    }

    private static string NormalizeVersion(string tag)
    {
        tag = tag.Trim();
        return tag.StartsWith("v", StringComparison.OrdinalIgnoreCase) ? tag[1..] : tag;
    }

    private static bool IsNewer(string latest, string current)
    {
        if (string.IsNullOrWhiteSpace(latest)) return false;
        if (Version.TryParse(Pad(latest), out var l) && Version.TryParse(Pad(current), out var c)) return l > c;
        return !string.Equals(latest, current, StringComparison.OrdinalIgnoreCase);
    }

    private static string Pad(string v) => v.Count(ch => ch == '.') >= 1 ? v : v + ".0";

    private static string Str(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() ?? "" : "";
}
