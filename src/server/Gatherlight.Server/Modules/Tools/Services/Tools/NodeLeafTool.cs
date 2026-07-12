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

    public abstract string Name { get; }
    public abstract string Description { get; }
    public abstract string InputSchema { get; }

    /// <summary>Working directory of the leaf (e.g. tools/puppeteer) — resolved by subclass.</summary>
    protected abstract string LeafDirectory { get; }

    /// <summary>Map validated JSON args to the leaf's argv (after "npx tsx src/<entry>.ts").</summary>
    protected abstract IEnumerable<string> BuildArgv(JsonElement args);

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        if (!Directory.Exists(LeafDirectory))
            throw new ToolException(500, $"工具目录不存在:{LeafDirectory}");

        var psi = new ProcessStartInfo
        {
            // npx resolves via the cmd shim on Windows; use cmd-safe direct start of npx.cmd.
            FileName = OperatingSystem.IsWindows() ? "npx.cmd" : "npx",
            WorkingDirectory = LeafDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Utf8NoBom,
            StandardErrorEncoding = Utf8NoBom,
        };
        foreach (var a in BuildArgv(args)) psi.ArgumentList.Add(a);

        using var proc = Process.Start(psi) ?? throw new ToolException(500, "无法启动工具进程");
        var stdoutTask = proc.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = proc.StandardError.ReadToEndAsync(ct);
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
