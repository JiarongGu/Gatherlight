using System.Diagnostics;
using System.Text;
using Gatherlight.Server.Modules.DataRepo.Services;

namespace Gatherlight.Server.Modules.Chat.Services;

/// <summary>Git operations on the CODE repo — 系统模式 (UI-update chat) commits here after the
/// human diff gate; the sensitive-info pre-commit hook still applies.</summary>
public sealed class CodeRepoGit : GitCliService
{
    public CodeRepoGit(GatherlightServerOptions options, ILogger<CodeRepoGit> log)
        : base(options.CodeRootPath, log) { }
}

public sealed record BuildResult(bool Ok, string Output);

/// <summary>
/// 系统模式 build gate: the client must compile (`npm run build` in {codeRoot}/src/client =
/// tsc -b && vite build) before its diff can be committed. Output tail feeds the auto-repair
/// prompt on failure. Because the built bundle lands in the server project's wwwroot and the
/// server serves it per request, an approved UI change is live on the next browser refresh.
/// </summary>
public sealed class BuildVerifyService
{
    private static readonly UTF8Encoding Utf8NoBom = new(false);
    private readonly GatherlightServerOptions _options;

    public BuildVerifyService(GatherlightServerOptions options) => _options = options;

    public async Task<BuildResult> BuildClientAsync(CancellationToken ct = default)
    {
        var clientDir = Path.Combine(_options.CodeRootPath, "src", "client");
        if (!Directory.Exists(clientDir)) return new BuildResult(false, $"client dir missing: {clientDir}");
        var psi = new ProcessStartInfo
        {
            WorkingDirectory = clientDir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Utf8NoBom,
            StandardErrorEncoding = Utf8NoBom,
        };
        // Launch npm through cmd.exe on Windows: invoking npm.cmd directly via CreateProcess
        // breaks its %~dp0 self-location (npm then hunts for npm-cli.js under the cwd and fails).
        // Args are static, so cmd quoting is not a concern.
        if (OperatingSystem.IsWindows())
        {
            psi.FileName = "cmd.exe";
            psi.ArgumentList.Add("/c");
            psi.ArgumentList.Add("npm");
        }
        else
        {
            psi.FileName = "npm";
        }
        psi.ArgumentList.Add("run");
        psi.ArgumentList.Add("build");

        using var proc = Process.Start(psi)!;
        var stdoutTask = proc.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = proc.StandardError.ReadToEndAsync(ct);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMinutes(5));
        try
        {
            await proc.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            try { proc.Kill(entireProcessTree: true); } catch { }
            if (ct.IsCancellationRequested) throw;
            return new BuildResult(false, "build timed out (5min)");
        }
        var output = await stdoutTask + "\n" + await stderrTask;
        var tail = output.Length > 4000 ? output[^4000..] : output;
        return new BuildResult(proc.ExitCode == 0, tail.Trim());
    }
}
