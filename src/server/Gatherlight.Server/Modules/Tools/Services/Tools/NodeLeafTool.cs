using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Tools.Services.Tools;

/// <summary>
/// Base for tools implemented as Node leaf subprocesses under the code repo's <c>tools/</c>
/// (transition state — they port to C#/Playwright one at a time; the contract stays
/// stdout = JSON result, stderr = logs). Registry callers can't tell a leaf from a native tool.
/// </summary>
public abstract class NodeLeafTool : IGatherlightTool
{
    private static readonly UTF8Encoding Utf8NoBom = new(false);
    private const int MaxOutputChars = 2_000_000;   // ~2 MB cap on buffered child output (OOM guard)

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

    public abstract string Name { get; }
    public abstract string Description { get; }
    public abstract string InputSchema { get; }

    /// <summary>Working directory of the leaf (e.g. tools/pdf-form) — resolved by subclass.</summary>
    protected abstract string LeafDirectory { get; }

    /// <summary>Map validated JSON args to the leaf's argv (after "npx tsx src/<entry>.ts").</summary>
    protected abstract IEnumerable<string> BuildArgv(JsonElement args);

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        if (!Directory.Exists(LeafDirectory))
            throw new ToolException(500, $"工具目录不存在:{LeafDirectory}");

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
        // Launch npx through cmd.exe on Windows: invoking npx.cmd directly via CreateProcess breaks
        // its %~dp0 self-location (it then can't find node/tsx and throws MODULE_NOT_FOUND) — same
        // class of bug as npm.cmd. (Data paths are space-free in normal setups.)
        if (OperatingSystem.IsWindows())
        {
            psi.FileName = "cmd.exe";
            psi.ArgumentList.Add("/c");
            psi.ArgumentList.Add("npx");
        }
        else
        {
            psi.FileName = "npx";
        }
        foreach (var a in BuildArgv(args)) psi.ArgumentList.Add(a);

        using var proc = Process.Start(psi) ?? throw new ToolException(500, "无法启动工具进程");
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

/// <summary>A NodeLeafTool with a caller-fixed directory + argv — for tools that resolve their own
/// paths and just need to run a specific leaf script (e.g. pdf_fill, fill_itinerary).</summary>
public sealed class FixedNodeLeaf : NodeLeafTool
{
    private readonly string _dir;
    private readonly string[] _argv;
    public FixedNodeLeaf(string dir, string[] argv) { _dir = dir; _argv = argv; }
    public override string Name => "_fixed";
    public override string Description => "";
    public override string InputSchema => "{}";
    protected override string LeafDirectory => _dir;
    protected override IEnumerable<string> BuildArgv(JsonElement args) => _argv;
}
