using System.Text.Json;

namespace Gatherlight.Server.Platform.Agent.Ui.Models;

/// <summary>Optional navigation hints a page carries about itself. Writing the file publishes it —
/// there is no separate list to keep in sync, so a page cannot exist and be invisible.</summary>
public sealed record SitePageNav(string? Label = null, int? Order = null, bool Hidden = false);

/// <summary>A page file: <c>{data}/ui/&lt;name&gt;.json</c>.</summary>
public sealed record SitePageFile(string Title, JsonElement Root, SitePageNav? Nav = null);

/// <summary>What the client receives. A page that fails validation is reported, never rendered.</summary>
public sealed record SitePageView(string Name, string Title, string Status, UiNode? Root, string? Reason);

/// <summary>One row of the site's menu. <c>Label</c>/<c>Order</c>/<c>Hidden</c> come from the page's
/// own <c>nav</c> block, resolved here so no caller has to know the fallbacks.</summary>
public sealed record SitePageSummary(string Name, string Title, string Label, int Order, bool Hidden);

/// <summary>What the diff gate shows for one changed page. <c>Summary</c> is computed from the two
/// trees in code — a summary the AGENT wrote would be the agent describing its own change at an
/// approval surface, which is exactly what S2 established must not be trusted.</summary>
public sealed record PageDiffView(
    string Path, string Name, string Title, string Status, UiNode? Root, string? Reason, string Summary);
