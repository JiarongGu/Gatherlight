namespace Gatherlight.Server.Platform.Site.Models;

/// <summary>
/// The site's declared shape — <c>{data}/site.json</c>. One reviewable file naming what the agent
/// may write, which non-platform capabilities are enabled, and how its agent is configured. It is
/// read by the platform and is NOT agent-writable: a jail whose occupant can edit its own walls is
/// not a jail. See docs/superpowers/specs/2026-08-04-site-model-container-design.md
/// </summary>
public sealed class SiteManifest
{
    public string Name { get; init; } = "Gatherlight";
    public SiteTemplateRef Template { get; init; } = new();
    public SiteAgentConfig Agent { get; init; } = new();

    /// <summary>Directories the agent may write, the git repo tracks and the index scans.
    /// The platform imposes no layout — this is the declaration the scope guard is built from.</summary>
    public IReadOnlyList<string> Records { get; init; } = ["plans", "household"];

    public SiteCapabilities Capabilities { get; init; } = new();
    public SiteUiRef Ui { get; init; } = new();
}

public sealed class SiteTemplateRef
{
    public string Id { get; init; } = "planner";
    public string Version { get; init; } = "0.0.0";
}

public sealed class SiteAgentConfig
{
    /// <summary>Null = inherit the platform default model.</summary>
    public string? Model { get; init; }
    public string PromptPack { get; init; } = "planner";
}

/// <summary>
/// NOT an enumeration of what the agent may use. Platform-shipped tools are available by default —
/// they are trusted by provenance, and an allow-list would tax every release with a manifest edit
/// while buying no safety, because the container is what bounds a mistake. S1 records these lists;
/// enforcing them is S2, where each entry grows from an id into a grant object.
/// </summary>
public sealed class SiteCapabilities
{
    /// <summary>Anything agent-callable deliberately withheld — a shipped MCP tool OR a CLI
    /// built-in such as <c>WebFetch</c>, which the scope guard's hook matcher does not intercept.</summary>
    public IReadOnlyList<string> Deny { get; init; } = [];

    /// <summary>Capabilities that did NOT come from the platform (an agent-drafted script tool, an
    /// external MCP server) and are therefore off until a human enables them.</summary>
    public IReadOnlyList<string> Enabled { get; init; } = [];
}

public sealed class SiteUiRef
{
    public string Spec { get; init; } = "ui/";
    public int SpecVersion { get; init; } = 1;
}
