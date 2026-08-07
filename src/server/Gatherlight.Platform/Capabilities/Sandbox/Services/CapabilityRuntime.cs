using System.Diagnostics;

namespace Gatherlight.Server.Platform.Capabilities.Sandbox.Services;

public interface ICapabilityRuntime
{
    /// <summary>The node executable able to enforce the sandbox, or null when none is.</summary>
    string? NodePath { get; }
    /// <summary>Why the sandbox is unavailable, for the operator. Null when it is available.</summary>
    string? Unavailable { get; }
}

/// <summary>
/// Probes a node executable for the two features the sandbox needs: the permission model
/// (<c>--permission</c>) and synchronous module hooks (<c>module.registerHooks</c>, Node 22.15+).
/// If neither the PATH node nor the provisioned one qualifies, the sandbox is UNAVAILABLE and
/// every Script capability refuses to run.
///
/// Failing closed is the whole point: an unenforced capability whose card claims "cannot reach the
/// internet" is worse than one that does not run, because the claim is what the household trusts.
/// </summary>
public sealed class CapabilityRuntime : ICapabilityRuntime
{
    private const string Probe = "const m=require('node:module');process.exit(typeof m.registerHooks==='function'?0:9)";

    public CapabilityRuntime(Kernel.Services.IPlatformContext platform, ILogger<CapabilityRuntime> log)
    {
        foreach (var candidate in Candidates(platform))
        {
            if (!Supports(candidate)) continue;
            NodePath = candidate;
            log.LogInformation("Capability sandbox: using {Node}", candidate);
            return;
        }
        Unavailable = "no node runtime supporting --permission + module.registerHooks (Node 22.15+) was found — install the Node runtime from the 资源 · Resources panel";
        log.LogWarning("Capability sandbox UNAVAILABLE — {Reason}. Script capabilities will refuse to run.", Unavailable);
    }

    public string? NodePath { get; }
    public string? Unavailable { get; }

    private static IEnumerable<string> Candidates(Kernel.Services.IPlatformContext platform)
    {
        // The PINNED node first — provisioned through the 资源 panel specifically so this does not
        // depend on whatever the machine happens to have. Then the Playwright driver's own node (older,
        // usually fails the probe, but free to try), then PATH. Every one of them is probed, so order
        // is a preference and never an assumption.
        var pinned = Hosting.Resources.Services.ResourceProvisioner.ProvisionedNode(platform.ResourcesPath);
        if (File.Exists(pinned)) yield return pinned;
        var driver = Path.Combine(platform.ResourcesPath, ".playwright", "node", "win32_x64", "node.exe");
        if (File.Exists(driver)) yield return driver;
        yield return "node";
    }

    // Run the probe UNDER --permission, so a runtime that has registerHooks but rejects the
    // permission flag is also rejected. Exit code 0 means both features are present.
    private static bool Supports(string exe)
    {
        try
        {
            var psi = new ProcessStartInfo(exe)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add("--permission");
            psi.ArgumentList.Add("-e");
            psi.ArgumentList.Add(Probe);
            using var p = Process.Start(psi);
            if (p is null) return false;
            if (!p.WaitForExit(10_000)) { try { p.Kill(true); } catch { } return false; }
            return p.ExitCode == 0;
        }
        catch
        {
            return false;   // missing executable, or a node too old to accept --permission
        }
    }
}
