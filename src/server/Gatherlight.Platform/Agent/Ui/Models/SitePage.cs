using System.Text.Json;

namespace Gatherlight.Server.Platform.Agent.Ui.Models;

/// <summary>A page file: <c>{data}/ui/&lt;name&gt;.json</c>.</summary>
public sealed record SitePageFile(string Title, JsonElement Root);

/// <summary>What the client receives. A page that fails validation is reported, never rendered.</summary>
public sealed record SitePageView(string Name, string Title, string Status, UiNode? Root, string? Reason);

public sealed record SitePageSummary(string Name, string Title);
