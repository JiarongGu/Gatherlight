using System.Diagnostics;
using Gatherlight.Server.Platform.Capabilities.Models;

namespace Gatherlight.Server.Platform.Capabilities.Sandbox.Services;

public interface ICapabilityLauncher
{
    /// <summary>Build the process for a sandboxed capability entry. Throws when the sandbox cannot
    /// be enforced — never returns an unsandboxed process.</summary>
    ProcessStartInfo Build(CapabilityGrant grant, string workingDir, string entryFile);
}

/// <summary>
/// The Node implementation: filesystem scope from the grant, plus the platform preload that removes
/// the network unless the grant allows it. This is the seam a low-privilege-OS-account launcher can
/// replace later without touching capability code.
/// </summary>
public sealed class NodeCapabilityLauncher : ICapabilityLauncher
{
    private readonly ICapabilityRuntime _runtime;
    private readonly Kernel.Services.ISiteContext _site;

    public NodeCapabilityLauncher(ICapabilityRuntime runtime, Kernel.Services.ISiteContext site)
    {
        _runtime = runtime;
        _site = site;
    }

    public ProcessStartInfo Build(CapabilityGrant grant, string workingDir, string entryFile)
    {
        if (_runtime.NodePath is null)
            throw new Tools.Models.ToolException(503,
                $"能力沙箱不可用,拒绝以未受限方式运行:{_runtime.Unavailable}");

        var psi = new ProcessStartInfo(_runtime.NodePath)
        {
            WorkingDirectory = workingDir,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("--permission");

        // The capability must be able to read its own code.
        psi.ArgumentList.Add($"--allow-fs-read={workingDir}");
        foreach (var dir in Resolve(grant.Fs.Read)) psi.ArgumentList.Add($"--allow-fs-read={dir}");
        foreach (var dir in Resolve(grant.Fs.Write)) psi.ArgumentList.Add($"--allow-fs-write={dir}");

        if (!grant.Net)
        {
            var guard = Kernel.Services.ResourcePaths.CapGuard;
            // ResourcePaths.First falls back rather than failing, so it can name a file that does
            // not exist. A missing preload would mean spawning WITH network access while the grant
            // says otherwise — the exact failure this design exists to prevent, and one no test
            // notices unless it looks for it.
            if (!File.Exists(guard))
                throw new Tools.Models.ToolException(500,
                    "能力沙箱预载缺失(cap-guard.mjs),拒绝以可联网方式运行能力。");
            // Windows rejects a bare drive-letter path here with ERR_UNSUPPORTED_ESM_URL_SCHEME.
            psi.ArgumentList.Add($"--import={new Uri(guard).AbsoluteUri}");
        }

        psi.ArgumentList.Add(entryFile);
        return psi;
    }

    // Grant vocabulary is manifest-relative: a declared record directory, or the literal "cache".
    // Anything else — an absolute path, "state", a traversal — resolves to nothing and is dropped,
    // so a malformed grant fails CLOSED rather than widening reach.
    private IEnumerable<string> Resolve(IReadOnlyList<string> names)
    {
        foreach (var name in names)
        {
            if (string.IsNullOrWhiteSpace(name)) continue;
            var abs = _site.ResolveSitePath(name);
            if (abs is null) continue;
            Directory.CreateDirectory(abs);
            yield return abs;
        }
    }
}
