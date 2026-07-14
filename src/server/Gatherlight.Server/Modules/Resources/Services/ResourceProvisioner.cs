using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.Resources.Services;

/// <summary>How a resource is fetched.</summary>
public enum ResourceKind
{
    /// <summary>A public .zip downloaded + sha256-verified + extracted into the install dir.</summary>
    Zip,
    /// <summary>Chromium, installed by the bundled Playwright driver (`playwright.ps1 install
    /// chromium`) into the install dir — not a single file, so it has its own readiness check.</summary>
    PlaywrightChromium,
}

/// <summary>
/// A large resource that ships download-at-setup instead of being bundled. Kept out of the
/// production zip to keep it small; the user provisions them once (desktop setup / the 资源 panel)
/// and they live under <c>{data}/state/resources/{InstallDir}</c> (in the data folder, so they
/// survive app updates and are fetched once).
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
    // The subpath inside the extracted archive that IS the payload root — used for a package archive
    // (our .nupkg is a zip that wraps the files under a content path). Null = the archive root itself,
    // with single-wrapper-folder flattening (a plain release .zip).
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
    // The catalog. Sha256 left null = best-effort (no integrity check) until a pinned hash is added.
    public static readonly IReadOnlyList<ResourceSpec> Catalog = new[]
    {
        new ResourceSpec(
            Id: "chromium", Name: "Chromium(无头浏览器)",
            NeededFor: "网页抓取工具 · scrape / flight / hotel / restaurant / policy(首次一并拉取 Playwright 驱动)",
            Kind: ResourceKind.PlaywrightChromium, InstallDir: "browsers", ReadyMarker: "",
            ApproxBytes: 164_000_000),
        new ResourceSpec(
            Id: "git", Name: "Git(便携版 · MinGit)",
            NeededFor: "数据文件夹版本管理 · 计划改动的提交/审阅",
            Kind: ResourceKind.Zip, InstallDir: "git", ReadyMarker: "cmd/git.exe",
            ApproxBytes: 46_000_000,
            Url: "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.2/MinGit-2.55.0.2-64-bit.zip"),
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
        var dir = InstallPath(s);
        if (s.Kind == ResourceKind.PlaywrightChromium)
            return Directory.Exists(dir) && Directory.EnumerateDirectories(dir, "chromium*").Any();
        return File.Exists(Path.Combine(dir, s.ReadyMarker.Replace('/', Path.DirectorySeparatorChar)));
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
            if (spec.Kind == ResourceKind.Zip) await ProvisionZipAsync(spec, p);
            else await ProvisionChromiumAsync(spec, p);
            Set(p, "ready", 100, "已就绪");
            _log.LogInformation("Resource provisioned: {Id} -> {Path}", spec.Id, InstallPath(spec));
        }
        catch (Exception ex)
        {
            Set(p, "error", p.Percent, ex.Message);
            _log.LogWarning("Resource provision failed: {Id}: {Msg}", spec.Id, ex.Message);
        }
        finally { lock (p) p.Running = false; }
    }

    // ---- Zip resources (git, and future model files) ----
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

            // The payload root: for a plain release .zip, the extract dir itself (hoisting a single
            // wrapper folder); for a package archive (our .nupkg — a zip with metadata around the
            // files), the ArchiveRoot subpath that holds the actual resource (e.g. content/playwright).
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

    // The Playwright .NET driver (win-x64 slice, ~34 MB zip -> ~88 MB): download-at-setup so it stays
    // out of the lean bundle. Playwright ships the .NET driver only inside the ~181 MB all-platform
    // Microsoft.Playwright NuGet, so we RE-PACK just the win-x64 slice into our own lean
    // `Gatherlight.Resources` package (devtools: `dev.mjs resources-pack`) and pull it from nuget.org's
    // public flat-container CDN — no self-hosted asset, versioned + immutable. The version MUST track
    // the Microsoft.Playwright package (1.49.0 — driver + DLL are paired). GATHERLIGHT_PW_DRIVER_URL
    // overrides the source (a mirror, or a local .nupkg during testing).
    public const string ResourcesPackageId = "gatherlight.resources";     // lower-case (flat-container)
    public const string ResourcesPackageVersion = "1.0.0";                // tracks the published package
    private static readonly ResourceSpec DriverSpec = new(
        "pw-driver", "Playwright 驱动", "", ResourceKind.Zip, ".playwright", "node/win32_x64/node.exe",
        34_000_000,
        Url: Environment.GetEnvironmentVariable("GATHERLIGHT_PW_DRIVER_URL")
             ?? $"https://api.nuget.org/v3-flatcontainer/{ResourcesPackageId}/{ResourcesPackageVersion}/{ResourcesPackageId}.{ResourcesPackageVersion}.nupkg",
        Sha256: null, // nuget.org is TLS + immutable-per-version; integrity is the registry's guarantee
        ArchiveRoot: "content/playwright");

    /// <summary>The Playwright driver dir (node/win32_x64/node.exe + package/cli.js): prefer the
    /// provisioned copy under the data folder, then one bundled next to the exe; null if neither.</summary>
    private string? ResolveDriverDir()
    {
        foreach (var dir in new[] { Path.Combine(_data.ResourcesPath, ".playwright"), Path.Combine(AppContext.BaseDirectory, ".playwright") })
            if (File.Exists(Path.Combine(dir, "node", "win32_x64", "node.exe"))) return dir;
        return null;
    }

    // ---- Chromium via the Playwright driver (provisioned or bundled) ----
    private async Task ProvisionChromiumAsync(ResourceSpec spec, Prog p)
    {
        // The driver is chromium's bootstrap. Prefer provisioned/bundled; else download it first.
        var driver = ResolveDriverDir();
        if (driver is null)
        {
            Set(p, "running", 2, "下载 Playwright 驱动…");
            await ProvisionZipAsync(DriverSpec, p);
            driver = Path.Combine(_data.ResourcesPath, ".playwright");
        }
        var node = Path.Combine(driver, "node", "win32_x64", "node.exe");
        var cli = Path.Combine(driver, "package", "cli.js");
        if (!File.Exists(node) || !File.Exists(cli)) throw new InvalidOperationException("Playwright 驱动缺失");

        var browsers = InstallPath(spec);
        Directory.CreateDirectory(browsers);
        Set(p, "running", 8, "下载 Chromium…(约 130MB,可能需要一两分钟)");

        // Direct node form — equivalent to `playwright.ps1 install chromium` (the ps1 isn't in the zip).
        var psi = new ProcessStartInfo(node)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in new[] { cli, "install", "chromium" }) psi.ArgumentList.Add(a);
        psi.Environment["PLAYWRIGHT_BROWSERS_PATH"] = browsers;

        using var proc = Process.Start(psi) ?? throw new InvalidOperationException("驱动启动失败");
        proc.OutputDataReceived += (_, e) => { if (e.Data is { } d && d.Contains('%')) Set(p, "running", ScrapePercent(d, p.Percent), "下载 Chromium…"); };
        proc.ErrorDataReceived += (_, _) => { };
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();
        await proc.WaitForExitAsync();
        if (proc.ExitCode != 0) throw new InvalidOperationException($"chromium 安装退出码 {proc.ExitCode}");
        if (!IsInstalled(spec)) throw new InvalidOperationException("安装后未找到 Chromium");
    }

    private static int ScrapePercent(string line, int fallback)
    {
        // Best-effort: pull the last "NN%" token from a playwright progress line.
        var i = line.IndexOf('%');
        if (i <= 0) return fallback;
        var start = i - 1;
        while (start >= 0 && (char.IsDigit(line[start]) || line[start] == '.')) start--;
        return int.TryParse(line.AsSpan(start + 1, i - start - 1), out var n) && n is >= 0 and <= 100 ? Math.Max(5, n) : fallback;
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
