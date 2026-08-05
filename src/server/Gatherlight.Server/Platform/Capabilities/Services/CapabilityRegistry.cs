using Gatherlight.Server.Platform.Capabilities.McpClient.Services;
using Gatherlight.Server.Platform.Capabilities.Models;
using Gatherlight.Server.Platform.Capabilities.Tools.Models;
using Gatherlight.Server.Platform.Capabilities.Tools.Services;
using Gatherlight.Server.Platform.Site.Services;

namespace Gatherlight.Server.Platform.Capabilities.Services;

public interface ICapabilityRegistry
{
    /// <summary>Every known capability with its state — including ones that are not available,
    /// so the console can show why.</summary>
    IReadOnlyList<CapabilityInfo> All();
    /// <summary>Only what the agent may actually call.</summary>
    IReadOnlyList<CapabilityInfo> Available();
    CapabilityGrant? GrantFor(string id);
}

/// <summary>
/// One projection over every origin, applying the manifest — replaces the ad-hoc composition
/// (built-ins + script provider + MCP proxy) that used to live only inside <see cref="ToolRegistry"/>.
/// Platform capabilities are available unless denied; Script is available only when an
/// <c>enabled</c> entry names it AND it is not denied; Mcp tools reach this projection only once
/// already connected (a separate, access-gated flow — see <see cref="IExternalToolProvider"/>), so
/// they are available unless denied. Drafts are never available — nothing loads them yet (S2b);
/// this is not a policy choice to revisit here, it is that no source of drafts exists.
/// </summary>
public sealed class CapabilityRegistry : ICapabilityRegistry
{
    private readonly IEnumerable<IGatherlightTool> _platform;
    private readonly IScriptToolProvider _scripts;
    private readonly IExternalToolProvider _external;
    private readonly ISiteManifestStore _manifest;

    public CapabilityRegistry(IEnumerable<IGatherlightTool> platform, IScriptToolProvider scripts,
        IExternalToolProvider external, ISiteManifestStore manifest)
    {
        _platform = platform;
        _scripts = scripts;
        _external = external;
        _manifest = manifest;
    }

    public IReadOnlyList<CapabilityInfo> All()
    {
        var caps = _manifest.Current.Capabilities;
        var denied = caps.Deny.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var enabled = caps.Enabled
            .Where(g => g.Id.Length > 0)
            .ToDictionary(g => g.Id, StringComparer.OrdinalIgnoreCase);

        var list = new List<CapabilityInfo>();
        foreach (var t in _platform)
            list.Add(new CapabilityInfo(t.Name, CapabilityOrigin.Platform, t.Name, t.Description, t.InputSchema,
                denied.Contains(t.Name) ? CapabilityState.Denied : CapabilityState.Available));
        foreach (var t in _scripts.Current)
            list.Add(new CapabilityInfo(t.Name, CapabilityOrigin.Script, t.Name, t.Description, t.InputSchema,
                denied.Contains(t.Name) ? CapabilityState.Denied
                : enabled.ContainsKey(t.Name) ? CapabilityState.Available
                : CapabilityState.NotEnabled));
        foreach (var t in _external.Current)
            list.Add(new CapabilityInfo(t.Name, CapabilityOrigin.Mcp, t.Name, t.Description, t.InputSchema,
                denied.Contains(t.Name) ? CapabilityState.Denied : CapabilityState.Available));
        // Draft: nothing loads drafts yet (S2b) — deliberately no source contributes here.
        return list;
    }

    public IReadOnlyList<CapabilityInfo> Available() =>
        All().Where(c => c.State == CapabilityState.Available).ToList();

    public CapabilityGrant? GrantFor(string id) =>
        _manifest.Current.Capabilities.Enabled.FirstOrDefault(g =>
            string.Equals(g.Id, id, StringComparison.OrdinalIgnoreCase));
}
