using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Gatherlight.Server.Platform.Capabilities.Tools.Models;

namespace Gatherlight.Server.Platform.Capabilities.Tools.Services.Tools;

/// <summary>
/// Base for tools implemented as Node leaf subprocesses under <c>tools/</c> (transition state — they
/// port to C#/Playwright one at a time; the contract stays stdout = JSON result, stderr = logs).
/// Registry callers can't tell a leaf from a native tool.
/// <para>
/// Two run shapes, resolved per call from what the leaf directory actually contains:
/// a RELEASE ships <c>&lt;entry&gt;.cjs</c> — one esbuild-bundled file per entry — run as
/// <c>node &lt;entry&gt;.cjs</c> with no npm install, no npx and no node_modules on the target;
/// the SOURCE repo has <c>src/&lt;entry&gt;.ts</c>, run as <c>npx tsx src/&lt;entry&gt;.ts</c> so a dev
/// edit takes effect without rebuilding. The bundled form is what makes these tools work in an
/// installed copy at all.
/// </para>
/// </summary>
public abstract class NodeLeafTool : IGatherlightTool
{
    private static readonly UTF8Encoding Utf8NoBom = new(false);
    private const int MaxOutputChars = 2_000_000;   // ~2 MB cap on buffered child output (OOM guard)
    private static string? _nodeExe;                // resolved once (see ResolveNode)

    /// <summary>
    /// The <c>node</c> to run. PATH first; failing that, the <c>node.exe</c> inside the Playwright
    /// driver the 资源 · Resources panel provisions into the data folder — so a target that never
    /// installed Node still runs these tools. Same `where.exe`-once discipline as the claude CLI.
    /// </summary>
    private static string ResolveNode(string? resourcesPath)
    {
        if (_nodeExe is not null) return _nodeExe;
        if (OperatingSystem.IsWindows())
        {
            try
            {
                using var p = Process.Start(new ProcessStartInfo("where.exe", "node")
                { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true });
                var hits = (p?.StandardOutput.ReadToEnd() ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries)
                    .Select(s => s.Trim()).Where(s => s.Length > 0).ToArray();
                p?.WaitForExit(5000);
                // Prefer a real .exe: the first `where` hit can be an extensionless shim Windows can't run.
                var exe = hits.FirstOrDefault(h => h.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) ?? hits.FirstOrDefault();
                if (exe is not null && File.Exists(exe)) return _nodeExe = exe;
            }
            catch { /* fall through to the provisioned copy */ }
            var provisioned = string.IsNullOrEmpty(resourcesPath)
                ? null
                : Path.Combine(resourcesPath, ".playwright", "node", "win32_x64", "node.exe");
            if (provisioned is not null && File.Exists(provisioned)) return _nodeExe = provisioned;
        }
        return _nodeExe = "node";   // POSIX / last resort: let PATH resolution fail loudly at spawn
    }

    // Drain a child pipe to EOF (so the process never blocks on a full pipe) but stop ACCUMULATING past
    // the cap — a runaway/hostile leaf can't OOM the server by dumping unbounded stdout/stderr.
    private static async Task<string> ReadCappedAsync(StreamReader reader, int cap, CancellationToken ct)
    {
        var sb = new StringBuilder();
        var buf = new char[8192];
        int n;
        while ((n = await reader.ReadAsync(buf.AsMemory(), ct)) > 0)
            if (sb.Length < cap) sb.Append(buf, 0, Math.Min(n, cap - sb.Length));
        return sb.ToString();
    }

    /// <summary>
    /// Pick the run shape from what the leaf dir holds: the shipped bundle (<c>&lt;entry&gt;.cjs</c>,
    /// returned as the file for <c>node</c>) or the source (<c>src/&lt;entry&gt;.ts</c>, returned as
    /// argv for <c>npx tsx</c>). Neither — or no leaf dir at all — is a configuration error, and the
    /// message says which, since "工具目录不存在:" with a blank path told an operator nothing.
    /// </summary>
    private static (string? File, string[] Argv) ResolveEntry(string dir, string entry)
    {
        if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
            throw new ToolException(500,
                $"PDF 工具未随本次安装一起打包(缺少 res/tools/… 的 {entry} 脚本)。请更新到包含该工具的版本。");
        var bundled = Path.Combine(dir, entry + ".cjs");
        if (File.Exists(bundled)) return (bundled, []);
        if (File.Exists(Path.Combine(dir, "src", entry + ".ts"))) return (null, [$"src/{entry}.ts"]);
        throw new ToolException(500, $"工具入口不存在:{entry}(在 {dir} 下既无 {entry}.cjs 也无 src/{entry}.ts)");
    }

    private static Process StartOrExplain(ProcessStartInfo psi, bool fromSource)
    {
        try
        {
            return Process.Start(psi) ?? throw new ToolException(500, "无法启动工具进程");
        }
        catch (System.ComponentModel.Win32Exception)
        {
            throw new ToolException(500, fromSource
                ? "找不到 npx —— 源码模式下的 PDF 工具需要 Node.js。"
                : "找不到 Node.js —— PDF 工具需要 node 运行时。请安装 Node.js,或在「资源 · Resources」面板下载运行资源(其中的 Playwright 驱动自带 node)。");
        }
    }

    public abstract string Name { get; }
    public abstract string Description { get; }
    public abstract string InputSchema { get; }

    /// <summary>Working directory of the leaf (e.g. tools/pdf-form) — resolved by subclass.</summary>
    protected abstract string LeafDirectory { get; }

    /// <summary>Entry name inside the leaf (e.g. <c>fill-itinerary</c>) — extension-free; the run
    /// shape (bundled .cjs vs source .ts) is resolved from the directory.</summary>
    protected abstract string Entry { get; }

    /// <summary>Provisioned-resources dir, for the fallback <c>node</c>. Null = PATH only.</summary>
    protected virtual string? ResourcesPath => null;

    /// <summary>Map validated JSON args to the leaf's argv (after the entry script).</summary>
    protected abstract IEnumerable<string> BuildArgv(JsonElement args);

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var (file, argv) = ResolveEntry(LeafDirectory, Entry);

        var psi = new ProcessStartInfo
        {
            WorkingDirectory = LeafDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Utf8NoBom,
            StandardErrorEncoding = Utf8NoBom,
        };
        if (file is null)
        {
            // Source-repo shape: npx tsx. On Windows launch npx through cmd.exe — invoking npx.cmd
            // directly via CreateProcess breaks its %~dp0 self-location (it then can't find node/tsx
            // and throws MODULE_NOT_FOUND), same class of bug as npm.cmd.
            if (OperatingSystem.IsWindows()) { psi.FileName = "cmd.exe"; psi.ArgumentList.Add("/c"); psi.ArgumentList.Add("npx"); }
            else psi.FileName = "npx";
            psi.ArgumentList.Add("tsx");
        }
        else
        {
            psi.FileName = ResolveNode(ResourcesPath);
            psi.ArgumentList.Add(file);
        }
        foreach (var a in argv) psi.ArgumentList.Add(a);
        foreach (var a in BuildArgv(args)) psi.ArgumentList.Add(a);

        // A missing runtime surfaces as a Win32Exception from CreateProcess — an opaque "系统找不到指定的
        // 文件" that reads like a bug in the tool. Name the actual prerequisite instead: this is the only
        // thing on the host these tools need, and the message is what an operator acts on.
        using var proc = StartOrExplain(psi, file is null);
        var stdoutTask = ReadCappedAsync(proc.StandardOutput, MaxOutputChars, ct);
        var stderrTask = ReadCappedAsync(proc.StandardError, MaxOutputChars, ct);
        try
        {
            await proc.WaitForExitAsync(ct);
        }
        catch (OperationCanceledException)
        {
            try { proc.Kill(entireProcessTree: true); } catch { /* already gone */ }
            throw;
        }
        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        if (proc.ExitCode != 0)
        {
            var tail = stderr.Length > 400 ? stderr[^400..] : stderr;
            throw new ToolException(500, $"工具退出码 {proc.ExitCode}:{tail.Trim()}");
        }
        return stdout.Trim();
    }
}

/// <summary>A NodeLeafTool with a caller-fixed directory, entry + argv — for tools that resolve their
/// own paths and just need to run a specific leaf entry (e.g. pdf_fill, fill_itinerary).</summary>
public sealed class FixedNodeLeaf : NodeLeafTool
{
    private readonly string _dir;
    private readonly string _entry;
    private readonly string[] _argv;
    private readonly string? _resources;
    public FixedNodeLeaf(string dir, string entry, string[] argv, string? resourcesPath = null)
    { _dir = dir; _entry = entry; _argv = argv; _resources = resourcesPath; }
    public override string Name => "_fixed";
    public override string Description => "";
    public override string InputSchema => "{}";
    protected override string LeafDirectory => _dir;
    protected override string Entry => _entry;
    protected override string? ResourcesPath => _resources;
    protected override IEnumerable<string> BuildArgv(JsonElement args) => _argv;
}
