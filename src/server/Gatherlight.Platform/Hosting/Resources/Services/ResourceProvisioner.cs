using System.Collections.Concurrent;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Hosting.Resources.Services;

/// <summary>How a resource is fetched.</summary>
public enum ResourceKind
{
    /// <summary>A public .zip downloaded + sha256-verified + extracted into the install dir.</summary>
    Zip,
    /// <summary>The Gatherlight.Resources NuGet package (itself a zip) holding the FULL win-x64 runtime
    /// — Playwright driver + git + chromium — downloaded once and unpacked into their install dirs.</summary>
    Bundle,
    /// <summary>The claude CLI, from Anthropic's own release channel: a single self-contained binary, with
    /// the version and its sha256 read LIVE from the vendor's manifest rather than pinned in our source.
    /// That inversion is the point — see <see cref="ResourceProvisioner.ClaudeBaseUrl"/>.</summary>
    ClaudeCli,
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

/// <summary>Live provisioning state for one resource (for the setup UI to poll). <paramref name="Version"/>
/// / <paramref name="Available"/> are populated only for a resource whose version we actually track (the
/// claude CLI); when they differ, an update exists. <paramref name="Detail"/> is a resource-specific status
/// line — for the CLI it carries the login state, which is the difference between installed and usable.</summary>
public sealed record ResourceStatus(
    string Id, string Name, string NeededFor, long ApproxBytes,
    bool Installed, string State, int Percent, string? Message,
    string? Version = null, string? Available = null, string? Detail = null);

public interface IResourceProvisioner
{
    IReadOnlyList<ResourceStatus> Status();
    /// <summary>Start provisioning in the background (no-op if already running or installed). Returns
    /// false if the id is unknown.</summary>
    bool Start(string id);
    /// <summary>Provision a resource and WAIT for it — a no-op when it is already installed. For the
    /// resource the app cannot serve without (git): startup provisions it inline instead of failing and
    /// pointing at a panel, so a fresh install needs no click. Throws when it did not end up installed;
    /// <paramref name="onProgress"/> receives (percent, message) for the startup overlay.</summary>
    Task EnsureAsync(string id, Action<int, string?>? onProgress = null, CancellationToken ct = default);

    /// <summary>Ask the vendor what the newest claude CLI is (a few bytes) and remember it, so
    /// <see cref="Status"/> can say an update exists. Deliberately a CHECK, not a download: a household
    /// that boots should never be surprised by ~265 MB it did not ask for. Never throws — an install with
    /// no network simply keeps reporting the version it has.</summary>
    Task CheckUpdatesAsync(CancellationToken ct = default);
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
        Override("GATHERLIGHT_RESOURCES_URL")
        ?? $"https://api.nuget.org/v3-flatcontainer/{ResourcesPackageId}/{ResourcesPackageVersion}/{ResourcesPackageId}.{ResourcesPackageVersion}.nupkg";

    /// <summary>An operator's source override (a mirror, or a local server in a test), rejected when it
    /// would fetch over remote cleartext. Every resource is unpacked into executables the app then RUNS,
    /// so a MITM-able source is a code-execution channel; https, or http to loopback only.</summary>
    private static string? Override(string envVar)
    {
        var o = Environment.GetEnvironmentVariable(envVar);
        if (o is not { Length: > 0 }) return null;
        if (o.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            && !(Uri.TryCreate(o, UriKind.Absolute, out var u) && u.IsLoopback))
            throw new InvalidOperationException(
                $"{envVar} over http must target loopback — refusing a remote cleartext resource source.");
        return o;
    }

    // The portable git the data repo runs on (MinGit from git-for-windows). Git is the data repo's engine
    // — init, diff, commit, restore — so it is the ONE resource the app cannot serve without, which is why
    // startup provisions it inline (GitRuntimeStep) instead of failing with a pointer at the 资源 panel.
    //
    // sha256-pinned, like the node entry and unlike the nuget bundle: a GitHub release asset can be
    // replaced by its publisher, so the checksum — not the URL — is what guarantees the bytes of an
    // executable we are about to run. Bump version, tag and checksum together, never one.
    // build-production.mjs reads these constants for its --offline bundle, so the git it embeds and the
    // git a lean install downloads are the same build by construction rather than by remembering.
    public const string GitVersion = "2.55.0.2";
    public const string GitTag = "v2.55.0.windows.2";
    private const string GitSha256 = "e3ea2944cea4b3fabcd69c7c1669ef69b1b66c05ac7806d81224d0abad2dec31";
    private static string GitUrl =>
        Override("GATHERLIGHT_GIT_URL")   // the pin still applies: a mirror serves the same file
        ?? $"https://github.com/git-for-windows/git/releases/download/{GitTag}/MinGit-{GitVersion}-64-bit.zip";

    // What the bundle contains (content/<Archive> inside the .nupkg) and where each part unpacks under
    // the resources root — the exact dirs the runtime resolvers look in (PlaywrightHost → .playwright +
    // browsers; GitCliService → git). "" marker = the browsers dir is ready when a chromium* dir exists.
    private static readonly (string Archive, string Install, string Marker)[] BundleParts =
    {
        ("content/playwright", ".playwright", "node/win32_x64/node.exe"),
        ("content/git", "git", "cmd/git.exe"),
        ("content/browsers", "browsers", ""),
    };

    // The pinned Node the capability sandbox needs. Node 24 LTS ("Krypton"): the sandbox requires BOTH
    // --permission and module.registerHooks (22.15+), and the node.exe inside the Playwright driver is
    // older than that — so without this the sandbox depended on whatever node the machine happened to
    // have, and a clean install had Script capabilities refusing to run with nothing offering a fix.
    // CapabilityRuntime still PROBES whatever it picks, so a wrong pin fails closed rather than
    // pretending; this entry just makes the right answer available and one click away.
    //
    // sha256-pinned, unlike the nuget bundle: nodejs.org serves a mutable path, so the checksum from
    // that release's SHASUMS256.txt is the integrity guarantee. Bump the two together, never one.
    public const string NodeVersion = "v24.19.0";
    private const string NodeSha256 = "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73";

    // The claude CLI — the engine the whole product runs on, and until now the one runtime dependency we
    // merely ASSUMED. A fresh install spawned the PATH `claude` that was not there and died at spawn in
    // 17ms with a raw Win32 error; the household saw "计划阶段未能完成(CLI 报告错误)".
    //
    // Integrity model, and why there is NO sha256 constant here: Anthropic publishes a version pointer and
    // a per-version manifest carrying each platform's checksum, both over TLS from the same origin as the
    // binary. So the checksum is still what guarantees the bytes of an executable we are about to run — it
    // is just READ rather than restated. Pinning a constant would buy nothing (the same origin serves all
    // three) and would cost the thing the household actually needs: a CLI that can be updated without a
    // release of ours. A stale CLI eventually stops working against the API, so "never update" is not a
    // safe default the way it is for git.
    //
    // This mirrors the shipped bootstrap (`claude.ai/install.ps1`) exactly: /latest → /<v>/manifest.json →
    // /<v>/<platform>/claude.exe. Verified live against 2.1.237.
    public const string ClaudeBaseUrl = "https://downloads.claude.ai/claude-code-releases";
    private static string ClaudeSource => Override("GATHERLIGHT_CLAUDE_URL") ?? ClaudeBaseUrl;

    /// <summary>The vendor's platform key for this machine. Windows-only, like the portable git: the
    /// bundle ships win-x64 and the launcher is MSVC. An unsupported OS fails closed with a sentence that
    /// says to install the CLI by hand, rather than downloading a binary that cannot run.</summary>
    private static string? ClaudePlatform =>
        !OperatingSystem.IsWindows() ? null
        : System.Runtime.InteropServices.RuntimeInformation.OSArchitecture
            == System.Runtime.InteropServices.Architecture.Arm64 ? "win32-arm64" : "win32-x64";

    public static readonly IReadOnlyList<ResourceSpec> Catalog = new[]
    {
        new ResourceSpec(
            Id: "runtime", Name: "运行环境(浏览器 · Git · 驱动)",
            NeededFor: "网页抓取工具 + 数据仓库版本管理 —— 首次一次性下载全部运行组件",
            Kind: ResourceKind.Bundle, InstallDir: "", ReadyMarker: "",
            ApproxBytes: 235_000_000,
            Url: ResourcesUrl),
        new ResourceSpec(
            Id: "git", Name: $"Git 版本管理({GitVersion})",
            NeededFor: "数据仓库的引擎(改动审阅 + 历史记录)—— 系统未装 git 时,启动时自动下载",
            Kind: ResourceKind.Zip, InstallDir: "git", ReadyMarker: "cmd/git.exe",
            ApproxBytes: 38_839_825,
            Url: GitUrl,
            Sha256: GitSha256),
        new ResourceSpec(
            Id: "node", Name: $"Node 运行时({NodeVersion})",
            NeededFor: "自定义能力的沙箱 —— 没有它,脚本能力会拒绝运行",
            Kind: ResourceKind.Zip, InstallDir: "node", ReadyMarker: "node.exe",
            ApproxBytes: 32_000_000,
            Url: $"https://nodejs.org/dist/{NodeVersion}/node-{NodeVersion}-win-x64.zip",
            Sha256: NodeSha256),
        new ResourceSpec(
            Id: "claude", Name: "Claude CLI(智能体引擎)",
            NeededFor: "计划与执行对话的引擎 —— 没有它,聊天无法进行;下载后还需登录一次",
            Kind: ResourceKind.ClaudeCli, InstallDir: "claude", ReadyMarker: "claude.exe",
            ApproxBytes: 266_000_000,
            Url: ClaudeBaseUrl),
    };

    /// <summary>Where a provisioned node lands. Read by the sandbox probe and the Node leaf tools, so
    /// the path exists in exactly one place.</summary>
    public static string ProvisionedNode(string resourcesPath) =>
        Path.Combine(resourcesPath, "node", "node.exe");

    /// <summary>Where a provisioned claude CLI lands. Read by <c>ClaudeCliRuntime</c> (the resolver + probe)
    /// and written here, so the path exists in exactly one place — same contract as
    /// <see cref="ProvisionedNode"/>.</summary>
    public static string ProvisionedClaude(string resourcesPath) =>
        Path.Combine(resourcesPath, "claude", "claude.exe");

    /// <summary>The version we installed, recorded beside the binary. A file read beats spawning a 265 MB
    /// process every time the panel polls, and it states what we actually put there rather than what the
    /// binary claims.</summary>
    public static string ClaudeVersionMarker(string resourcesPath) =>
        Path.Combine(resourcesPath, "claude", "version.txt");

    /// <summary>The installed claude version, or null when it was never provisioned here (a machine-wide
    /// install has no marker of ours — and that is a legitimate, fully working configuration).</summary>
    public static string? InstalledClaudeVersion(string resourcesPath)
    {
        try
        {
            var marker = ClaudeVersionMarker(resourcesPath);
            if (!File.Exists(marker)) return null;
            var v = File.ReadAllText(marker).Trim();
            return v.Length is > 0 and < 40 ? v : null;
        }
        catch (IOException) { return null; }
    }

    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };

    private readonly IPlatformContext _data;
    private readonly ILogger<ResourceProvisioner> _log;
    private readonly ConcurrentDictionary<string, Prog> _prog = new();

    public ResourceProvisioner(IPlatformContext data, ILogger<ResourceProvisioner> log)
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
        // Version tracking is claude-only on purpose: git and node are sha256-pinned to a version WE chose,
        // so "an update exists" is a fact about our source, not about the household's install. The CLI is
        // the opposite — the vendor moves it, and an install that never follows eventually stops working.
        string? version = null, available = null;
        if (s.Kind == ResourceKind.ClaudeCli)
        {
            version = InstalledClaudeVersion(_data.ResourcesPath);
            available = _latestClaude;
        }
        return new ResourceStatus(s.Id, s.Name, s.NeededFor, s.ApproxBytes, installed, state,
            p?.Percent ?? 0, p?.Message, version, available);
    }).ToList();

    // The newest CLI the vendor is serving, as of the last check. Null until something checks — a field,
    // not a fetch inside Status(), because the panel polls Status() every 1.2s while a download runs and
    // that must not become 1.2s of outbound requests.
    private volatile string? _latestClaude;

    public async Task CheckUpdatesAsync(CancellationToken ct = default)
    {
        try
        {
            var latest = await FetchLatestClaudeAsync(ct);
            if (latest is null) return;
            _latestClaude = latest;
            var installed = InstalledClaudeVersion(_data.ResourcesPath);
            if (installed is not null && installed != latest)
                _log.LogInformation("A newer claude CLI is available: {Installed} → {Latest}", installed, latest);
        }
        catch (Exception ex)
        {
            // No network, a proxy, an offline household: none of that is a failure of the app. Keep the
            // version we have and say nothing on screen.
            _log.LogDebug("claude update check skipped: {Msg}", ex.Message);
        }
    }

    /// <summary>The vendor's current version pointer. Validated against a strict version shape BEFORE it is
    /// ever concatenated into the manifest or binary URL — the shipped bootstrap does the same, because an
    /// HTML error page served from that path would otherwise become part of a download URL.</summary>
    private static async Task<string?> FetchLatestClaudeAsync(CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(20));
        var text = (await Http.GetStringAsync($"{ClaudeSource}/latest", cts.Token)).Trim();
        return System.Text.RegularExpressions.Regex.IsMatch(text, @"^\d+\.\d+\.\d+[\w.\-+]*$") ? text : null;
    }

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

    public async Task EnsureAsync(string id, Action<int, string?>? onProgress = null, CancellationToken ct = default)
    {
        var spec = Catalog.FirstOrDefault(s => s.Id == id)
            ?? throw new InvalidOperationException($"unknown resource '{id}'");
        if (IsInstalled(spec)) return;

        var p = _prog.GetOrAdd(id, _ => new Prog());
        bool mine;
        lock (p)
        {
            mine = !p.Running;
            if (mine) { p.Running = true; p.State = "running"; p.Percent = 0; p.Message = "准备中…"; }
        }
        // Not ours = the 资源 panel already kicked this off; ride along rather than downloading twice
        // into the same directory (ProvisionZipAsync deletes the destination before moving into it).
        var work = mine ? ProvisionAsync(spec, p) : null;
        while (true)
        {
            var (pct, msg) = Read(p);
            onProgress?.Invoke(pct, msg);        // outside the lock — the observer takes its own
            if (work is not null ? work.IsCompleted : !Running(p)) break;
            if (work is not null) await Task.WhenAny(work, Task.Delay(400, ct));
            else await Task.Delay(400, ct);
            ct.ThrowIfCancellationRequested();
        }
        if (work is not null) await work;        // surface a cancellation/fault, never swallow it here

        // ProvisionAsync records failures on the progress record instead of throwing (the panel polls
        // it). A CALLER that is waiting needs the failure itself, with the reason it recorded.
        if (!IsInstalled(spec))
            throw new InvalidOperationException($"{spec.Name} 安装失败:{Message(p) ?? "未知错误"}");
    }

    private static bool Running(Prog p) { lock (p) return p.Running; }
    private static string? Message(Prog p) { lock (p) return p.Message; }
    private static (int Pct, string? Msg) Read(Prog p) { lock (p) return (p.Percent, p.Message); }

    private async Task ProvisionAsync(ResourceSpec spec, Prog p)
    {
        try
        {
            Directory.CreateDirectory(_data.ResourcesPath);
            switch (spec.Kind)
            {
                case ResourceKind.Bundle: await ProvisionBundleAsync(spec, p); break;
                case ResourceKind.ClaudeCli: await ProvisionClaudeAsync(spec, p); break;
                default: await ProvisionZipAsync(spec, p); break;
            }
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

    // ---- The claude CLI: /latest → /<version>/manifest.json → /<version>/<platform>/claude.exe ----
    // A single self-contained binary, so there is nothing to extract — but there IS something to verify,
    // and the checksum comes from the vendor's manifest for the exact version we are about to fetch.
    private async Task ProvisionClaudeAsync(ResourceSpec spec, Prog p)
    {
        var platform = ClaudePlatform
            ?? throw new InvalidOperationException(
                "自动下载的 Claude CLI 仅支持 Windows —— 请自行安装 Claude CLI 后重启应用。");

        Set(p, "running", 0, "查询最新版本…");
        var version = await FetchLatestClaudeAsync(default)
            ?? throw new InvalidOperationException("无法确定 Claude CLI 的最新版本(返回内容不是版本号)。");

        Set(p, "running", 2, $"读取校验信息({version})…");
        var checksum = await FetchClaudeChecksumAsync(version, platform)
            ?? throw new InvalidOperationException($"发布清单中没有 {platform} 平台的校验和。");

        var staging = Path.Combine(_data.ResourcesPath, ".staging");
        Directory.CreateDirectory(staging);
        var staged = Path.Combine(staging, $"claude-{version}-{platform}.exe");
        try
        {
            Set(p, "running", 3, "下载 Claude CLI…(约 265MB,首次可能需要几分钟)");
            await DownloadAsync($"{ClaudeSource}/{version}/{platform}/claude.exe", staged,
                pct => Set(p, "running", 3 + (int)(pct * 0.90), "下载 Claude CLI…"));

            Set(p, "running", 94, "校验中…");
            var actual = await Sha256Async(staged);
            if (!string.Equals(actual, checksum, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"sha256 不匹配(期望 {checksum[..8]}…)");

            Set(p, "running", 97, "安装中…");
            var dest = ProvisionedClaude(_data.ResourcesPath);
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            ReplaceBinary(staged, dest);
            // The marker is written LAST, and only after the binary is in place: a marker naming a version
            // that is not on disk would make the panel report an install that cannot run.
            await File.WriteAllTextAsync(ClaudeVersionMarker(_data.ResourcesPath), version);
            _latestClaude = version;
            _log.LogInformation("Provisioned claude CLI {Version} ({Platform}) → {Path}", version, platform, dest);
        }
        finally
        {
            try { if (File.Exists(staged)) File.Delete(staged); } catch { /* best-effort */ }
        }
    }

    private static async Task<string?> FetchClaudeChecksumAsync(string version, string platform)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        await using var s = await Http.GetStreamAsync($"{ClaudeSource}/{version}/manifest.json", cts.Token);
        using var doc = await JsonDocument.ParseAsync(s, cancellationToken: cts.Token);
        return doc.RootElement.TryGetProperty("platforms", out var plats)
               && plats.TryGetProperty(platform, out var entry)
               && entry.TryGetProperty("checksum", out var sum)
            ? sum.GetString()
            : null;
    }

    /// <summary>Move the verified binary into place, tolerating a copy that is CURRENTLY RUNNING. Windows
    /// refuses to overwrite a loaded image, and an update is exactly when one may be mid-chat — so fall
    /// back to renaming the old file aside (which Windows does allow) and let the next sweep delete it.
    /// Failing the whole install because a turn was in flight would make updates unreliable by design.</summary>
    private static void ReplaceBinary(string staged, string dest)
    {
        // Sweep any earlier displaced copy first — this is the only thing that ever deletes them.
        foreach (var stale in Directory.EnumerateFiles(Path.GetDirectoryName(dest)!, "claude.exe.old-*"))
            try { File.Delete(stale); } catch { /* still running or locked; next time */ }

        try
        {
            File.Move(staged, dest, overwrite: true);
        }
        catch (IOException)
        {
            var aside = $"{dest}.old-{Guid.NewGuid():N}";
            File.Move(dest, aside);                  // permitted even while the image is loaded
            File.Move(staged, dest);
        }
    }

    private static void Set(Prog p, string state, int pct, string? msg)
    {
        lock (p) { p.State = state; p.Percent = Math.Clamp(pct, 0, 100); p.Message = msg; }
    }

    private const long MaxDownloadBytes = 600L * 1024 * 1024;   // hard ceiling — a wrong/hostile URL can't fill the disk

    private static async Task DownloadAsync(string url, string dest, Action<int> onPct)
    {
        // Per-download deadline (the shared HttpClient timeout is infinite for large provisioning fetches).
        using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(30));
        using var resp = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.EnsureSuccessStatusCode();
        var total = resp.Content.Headers.ContentLength ?? -1;
        if (total > MaxDownloadBytes) throw new InvalidOperationException($"download too large ({total} bytes)");
        await using var src = await resp.Content.ReadAsStreamAsync(cts.Token);
        await using var dst = File.Create(dest);
        var buf = new byte[81920];
        long read = 0; int n; var lastPct = -1;
        while ((n = await src.ReadAsync(buf, cts.Token)) > 0)
        {
            read += n;
            if (read > MaxDownloadBytes) throw new InvalidOperationException("download exceeded size cap");
            await dst.WriteAsync(buf.AsMemory(0, n), cts.Token);
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
