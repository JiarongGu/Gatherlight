using System.Collections.Concurrent;
using System.IO.Compression;
using System.Security.Cryptography;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.Resources.Services;

/// <summary>How a resource is fetched.</summary>
public enum ResourceKind
{
    /// <summary>A public .zip downloaded + sha256-verified + extracted into the install dir.</summary>
    Zip,
    /// <summary>The Gatherlight.Resources NuGet package (itself a zip) holding the FULL win-x64 runtime
    /// — Playwright driver + git + chromium — downloaded once and unpacked into their install dirs.</summary>
    Bundle,
}

/// <summary>
/// A large resource (or a bundle of them) that ships download-at-setup instead of inside the app
/// bundle — kept out of the shipped zip so the app download stays lean; provisioned once (desktop
/// setup / the 资源 panel) under <c>{data}/state/resources/</c> (in the data folder, so it survives app
/// updates and is fetched once).
/// </summary>
public sealed record ResourceSpec(
    string Id,
    string Name,
    string NeededFor,
    ResourceKind Kind,
    string InstallDir,
    string ReadyMarker,
    long ApproxBytes,
    string? Url = null,
    string? Sha256 = null,
    // The subpath inside the extracted archive that IS the payload root — for a package archive whose
    // files sit under a content path. Null = the archive root itself (with single-wrapper flattening).
    string? ArchiveRoot = null);

/// <summary>Live provisioning state for one resource (for the setup UI to poll).</summary>
public sealed record ResourceStatus(
    string Id, string Name, string NeededFor, long ApproxBytes,
    bool Installed, string State, int Percent, string? Message);

public interface IResourceProvisioner
{
    IReadOnlyList<ResourceStatus> Status();
    /// <summary>Start provisioning in the background (no-op if already running or installed). Returns
    /// false if the id is unknown.</summary>
    bool Start(string id);
}

public sealed class ResourceProvisioner : IResourceProvisioner
{
    // The Gatherlight.Resources package: our own lean win-x64 runtime bundle (Playwright driver + git +
    // chromium), pulled from nuget.org's public flat-container CDN — no self-hosted assets, versioned +
    // immutable. GATHERLIGHT_RESOURCES_URL overrides the source (a mirror, or a local .nupkg to test).
    //
    // ResourcesPackageVersion is the SINGLE SOURCE OF TRUTH for the package version: `resources-pack`
    // reads it to stamp the .nupkg, and this URL asks nuget for exactly it — so they can't drift. The
    // package has its own semver, bumped whenever a payload changes (e.g. a Microsoft.Playwright
    // upgrade); it is NOT equal to the Playwright version. Bump this + re-publish the package together.
    public const string ResourcesPackageId = "gatherlight.resources";     // lower-case (flat-container)
    public const string ResourcesPackageVersion = "1.0.0";
    private static string ResourcesUrl =>
        Environment.GetEnvironmentVariable("GATHERLIGHT_RESOURCES_URL") is { Length: > 0 } u ? u
        : $"https://api.nuget.org/v3-flatcontainer/{ResourcesPackageId}/{ResourcesPackageVersion}/{ResourcesPackageId}.{ResourcesPackageVersion}.nupkg";

    // What the bundle contains (content/<Archive> inside the .nupkg) and where each part unpacks under
    // the resources root — the exact dirs the runtime resolvers look in (PlaywrightHost → .playwright +
    // browsers; GitCliService → git). "" marker = the browsers dir is ready when a chromium* dir exists.
    private static readonly (string Archive, string Install, string Marker)[] BundleParts =
    {
        ("content/playwright", ".playwright", "node/win32_x64/node.exe"),
        ("content/git", "git", "cmd/git.exe"),
        ("content/browsers", "browsers", ""),
    };

    // One catalog entry: the whole runtime in a single download (the user's "bundle everything").
    public static readonly IReadOnlyList<ResourceSpec> Catalog = new[]
    {
        new ResourceSpec(
            Id: "runtime", Name: "运行环境(浏览器 · Git · 驱动)",
            NeededFor: "网页抓取工具 + 数据仓库版本管理 —— 首次一次性下载全部运行组件",
            Kind: ResourceKind.Bundle, InstallDir: "", ReadyMarker: "",
            ApproxBytes: 235_000_000,
            Url: ResourcesUrl),
    };

    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };

    private readonly IDataContext _data;
    private readonly ILogger<ResourceProvisioner> _log;
    private readonly ConcurrentDictionary<string, Prog> _prog = new();

    public ResourceProvisioner(IDataContext data, ILogger<ResourceProvisioner> log)
    {
        _data = data;
        _log = log;
    }

    private sealed class Prog { public string State = "idle"; public int Percent; public string? Message; public bool Running; }

    /// <summary>Absolute install dir for a resource under the data folder's resources root.</summary>
    public string InstallPath(ResourceSpec s) => Path.Combine(_data.ResourcesPath, s.InstallDir);

    public bool IsInstalled(ResourceSpec s)
    {
        if (s.Kind == ResourceKind.Bundle)
            return BundleParts.All(part =>
            {
                var dir = Path.Combine(_data.ResourcesPath, part.Install);
                if (part.Marker.Length == 0) // browsers → a chromium* dir present
                    return Directory.Exists(dir) && Directory.EnumerateDirectories(dir, "chromium*").Any();
                return File.Exists(Path.Combine(dir, part.Marker.Replace('/', Path.DirectorySeparatorChar)));
            });
        return File.Exists(Path.Combine(InstallPath(s), s.ReadyMarker.Replace('/', Path.DirectorySeparatorChar)));
    }

    public IReadOnlyList<ResourceStatus> Status() => Catalog.Select(s =>
    {
        var p = _prog.GetValueOrDefault(s.Id);
        var installed = IsInstalled(s);
        var state = p?.State ?? (installed ? "ready" : "idle");
        return new ResourceStatus(s.Id, s.Name, s.NeededFor, s.ApproxBytes, installed, state, p?.Percent ?? 0, p?.Message);
    }).ToList();

    public bool Start(string id)
    {
        var spec = Catalog.FirstOrDefault(s => s.Id == id);
        if (spec is null) return false;
        var p = _prog.GetOrAdd(id, _ => new Prog());
        lock (p)
        {
            if (p.Running) return true;                 // already provisioning
            p.Running = true; p.State = "running"; p.Percent = 0; p.Message = "准备中…";
        }
        _ = Task.Run(() => ProvisionAsync(spec, p));
        return true;
    }

    private async Task ProvisionAsync(ResourceSpec spec, Prog p)
    {
        try
        {
            Directory.CreateDirectory(_data.ResourcesPath);
            if (spec.Kind == ResourceKind.Bundle) await ProvisionBundleAsync(spec, p);
            else await ProvisionZipAsync(spec, p);
            Set(p, "ready", 100, "已就绪");
            _log.LogInformation("Resource provisioned: {Id}", spec.Id);
        }
        catch (Exception ex)
        {
            Set(p, "error", p.Percent, ex.Message);
            _log.LogWarning("Resource provision failed: {Id}: {Msg}", spec.Id, ex.Message);
        }
        finally { lock (p) p.Running = false; }
    }

    // ---- The runtime bundle: one .nupkg → driver + git + chromium into their install dirs ----
    // Integrity model (why there's no sha256 pin here, unlike ProvisionZipAsync): the default source is
    // nuget.org over TLS, where a published (id, version) is IMMUTABLE — that's the integrity guarantee,
    // and pinning a sha would just add a value to bump on every package release (the drift class #7
    // removed). GATHERLIGHT_RESOURCES_URL can point elsewhere, but that's a deliberate operator choice
    // (mirror / local test), trusted like any other configured source. Extract only pulls the known
    // content/{playwright,git,browsers} subpaths (below), and ZipFile.ExtractToDirectory guards against
    // path-traversal entries on current .NET.
    private async Task ProvisionBundleAsync(ResourceSpec spec, Prog p)
    {
        if (string.IsNullOrEmpty(spec.Url)) throw new InvalidOperationException("no download url");
        var staging = Path.Combine(_data.ResourcesPath, ".staging");
        Directory.CreateDirectory(staging);
        var pkg = Path.Combine(staging, "runtime.nupkg");
        var extract = Path.Combine(staging, "runtime");
        try
        {
            Set(p, "running", 0, "下载运行环境…(约 220MB,首次可能需要几分钟)");
            await DownloadAsync(spec.Url, pkg, pct => Set(p, "running", (int)(pct * 0.80), "下载运行环境…"));

            Set(p, "running", 82, "解压中…");
            if (Directory.Exists(extract)) Directory.Delete(extract, true);
            ZipFile.ExtractToDirectory(pkg, extract);

            // Move each part (content/playwright, content/git, content/browsers) into its install dir.
            var step = 0;
            foreach (var (archive, install, _) in BundleParts)
            {
                var src = Path.Combine(extract, archive.Replace('/', Path.DirectorySeparatorChar));
                if (!Directory.Exists(src)) throw new InvalidOperationException($"包内未找到 {archive}");
                var dest = Path.Combine(_data.ResourcesPath, install);
                if (Directory.Exists(dest)) Directory.Delete(dest, true);
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                Directory.Move(src, dest);
                Set(p, "running", 84 + (++step * 5), "安装中…");
            }
        }
        finally
        {
            try { if (File.Exists(pkg)) File.Delete(pkg); } catch { /* best-effort */ }
            try { if (Directory.Exists(extract)) Directory.Delete(extract, true); } catch { /* best-effort */ }
        }
    }

    // ---- A single public .zip (retained for future standalone resources; not in the catalog today) ----
    private async Task ProvisionZipAsync(ResourceSpec spec, Prog p)
    {
        if (string.IsNullOrEmpty(spec.Url)) throw new InvalidOperationException("no download url");
        var staging = Path.Combine(_data.ResourcesPath, ".staging");
        Directory.CreateDirectory(staging);
        var zip = Path.Combine(staging, spec.Id + ".zip");
        var extract = Path.Combine(staging, spec.Id);
        try
        {
            Set(p, "running", 0, "下载中…");
            await DownloadAsync(spec.Url, zip, pct => Set(p, "running", (int)(pct * 0.85), "下载中…"));

            if (!string.IsNullOrEmpty(spec.Sha256))
            {
                Set(p, "running", 88, "校验中…");
                var actual = await Sha256Async(zip);
                if (!string.Equals(actual, spec.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException($"sha256 不匹配(期望 {spec.Sha256[..8]}…)");
            }

            Set(p, "running", 92, "解压中…");
            if (Directory.Exists(extract)) Directory.Delete(extract, true);
            ZipFile.ExtractToDirectory(zip, extract);

            string payload;
            if (!string.IsNullOrEmpty(spec.ArchiveRoot))
            {
                payload = Path.Combine(extract, spec.ArchiveRoot.Replace('/', Path.DirectorySeparatorChar));
                if (!Directory.Exists(payload)) throw new InvalidOperationException($"包内未找到 {spec.ArchiveRoot}");
            }
            else
            {
                FlattenSingleRoot(extract, spec.ReadyMarker);
                payload = extract;
            }

            Set(p, "running", 97, "安装中…");
            var dest = InstallPath(spec);
            if (Directory.Exists(dest)) Directory.Delete(dest, true);
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            Directory.Move(payload, dest);
        }
        finally
        {
            try { if (File.Exists(zip)) File.Delete(zip); } catch { /* best-effort */ }
            try { if (Directory.Exists(extract)) Directory.Delete(extract, true); } catch { /* best-effort */ }
        }
    }

    private static void Set(Prog p, string state, int pct, string? msg)
    {
        lock (p) { p.State = state; p.Percent = Math.Clamp(pct, 0, 100); p.Message = msg; }
    }

    private static async Task DownloadAsync(string url, string dest, Action<int> onPct)
    {
        using var resp = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        resp.EnsureSuccessStatusCode();
        var total = resp.Content.Headers.ContentLength ?? -1;
        await using var src = await resp.Content.ReadAsStreamAsync();
        await using var dst = File.Create(dest);
        var buf = new byte[81920];
        long read = 0; int n; var lastPct = -1;
        while ((n = await src.ReadAsync(buf)) > 0)
        {
            await dst.WriteAsync(buf.AsMemory(0, n));
            read += n;
            if (total > 0) { var pct = (int)(read * 100 / total); if (pct != lastPct) { lastPct = pct; onPct(pct); } }
        }
    }

    private static async Task<string> Sha256Async(string path)
    {
        await using var s = File.OpenRead(path);
        return Convert.ToHexString(await SHA256.HashDataAsync(s)).ToLowerInvariant();
    }

    /// <summary>If a zip extracted into a single wrapper dir that doesn't itself hold the ready
    /// marker, hoist its contents up one level (some archives wrap everything in a top folder).</summary>
    private static void FlattenSingleRoot(string dir, string readyMarker)
    {
        var marker = readyMarker.Replace('/', Path.DirectorySeparatorChar);
        if (marker.Length > 0 && File.Exists(Path.Combine(dir, marker))) return;
        var entries = Directory.GetFileSystemEntries(dir);
        if (entries.Length != 1 || !Directory.Exists(entries[0])) return;
        var inner = entries[0];
        foreach (var e in Directory.GetFileSystemEntries(inner))
        {
            var target = Path.Combine(dir, Path.GetFileName(e));
            if (Directory.Exists(e)) Directory.Move(e, target); else File.Move(e, target);
        }
        Directory.Delete(inner, true);
    }
}
