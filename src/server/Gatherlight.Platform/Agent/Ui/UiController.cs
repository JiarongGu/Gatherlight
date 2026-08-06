using Gatherlight.Server.Platform.Agent.Ui.Models;
using Gatherlight.Server.Platform.Agent.Ui.Services;
using Gatherlight.Server.Platform.Capabilities.Models;
using Gatherlight.Server.Platform.Capabilities.Services;
using Gatherlight.Server.Platform.Kernel.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Platform.Agent.Ui;

/// <summary>Client-safe projection of one component's contract.</summary>
public sealed record UiComponentView(string Type, bool AcceptsChildren, Dictionary<string, string> Props);

/// <summary>The verdict on a tree the client asked about — same <c>ready</c>/<c>invalid</c> shape a
/// page and a ```ui block already report, so there is one thing for the client to render.</summary>
public sealed record UiCandidateView(string Status, UiNode? Root, string? Reason);

[ApiController]
[Route("api/ui")]
public sealed class UiController : ControllerBase
{
    private readonly IUiTreeValidator _validator;
    private readonly ISitePageStore _pages;
    private readonly ISiteContext _site;
    private readonly ICapabilityRegistry _capabilities;
    private readonly IUiBindingResolver _bindings;

    public UiController(
        IUiTreeValidator validator, ISitePageStore pages, ISiteContext site, ICapabilityRegistry capabilities,
        IUiBindingResolver bindings)
    {
        _validator = validator;
        _pages = pages;
        _site = site;
        _capabilities = capabilities;
        _bindings = bindings;
    }

    /// <summary>The component vocabulary. `dev.mjs check-ui-registry` compares this against the
    /// client's exported renderer keys — the two lists must agree and no compiler can see that.</summary>
    [HttpGet("registry")]
    public ActionResult<IEnumerable<UiComponentView>> Registry() =>
        Ok(_validator.Schemas.Select(s => new UiComponentView(
            s.Type,
            s.AcceptsChildren,
            s.Props.ToDictionary(p => p.Key, p => p.Value.Kind.ToString(), StringComparer.Ordinal))));

    [HttpGet("pages")]
    public ActionResult<IEnumerable<SitePageSummary>> Pages() => Ok(_pages.List());

    /// <summary>One page, with its bindings already resolved. The tree that goes over the wire has
    /// its rows filled and <c>bind</c> gone — the client is never handed a query, and a binding is
    /// never an endpoint the browser can call with parameters of its own choosing.</summary>
    [HttpGet("pages/{name}")]
    public async Task<ActionResult<SitePageView>> Page(string name, CancellationToken ct)
    {
        if (_pages.Get(name) is not { } page) return NotFound();
        return page.Root is null ? Ok(page) : Ok(page with { Root = await _bindings.ResolveAsync(page.Root, ct) });
    }

    /// <summary>Validates a candidate tree — the ONE way a tree that did not come from a page or a
    /// ```ui fence can reach the renderer. A capability's output is data, not a trusted view: the
    /// client renders it with <c>UiTree</c> only after this returns <c>ready</c>, so a `Link` href or
    /// an `Image` src invented downstream still has to survive the same validator every other tree
    /// does. Deliberately no persistence and no side effects — it only answers a question.</summary>
    [HttpPost("validate")]
    public async Task<ActionResult<UiCandidateView>> Validate(
        [FromBody] System.Text.Json.JsonElement root, CancellationToken ct)
    {
        var result = _validator.ValidateElement(root);
        return Ok(result.Ok
            ? new UiCandidateView("ready", await _bindings.ResolveAsync(result.Node!, ct), null)
            : new UiCandidateView("invalid", null, result.Reason));
    }

    /// <summary>What a runCapability button will actually do, for the confirmation the click shows.
    /// The clauses come from PermissionSentence over the ENFORCED grant — never from the page, whose
    /// label the agent chose. A Platform capability has no grant entry (it is compiled and shipped by
    /// us, not sandboxed against one), so both lists come back empty and the client says so rather
    /// than inventing a promise nothing enforces.</summary>
    [HttpGet("capability/{id}")]
    public IActionResult Capability(string id)
    {
        var info = _capabilities.All().FirstOrDefault(c => c.Id == id);
        if (info is null) return NotFound(new { error = "unknown capability" });
        var grant = _capabilities.GrantFor(id);
        return Ok(new
        {
            id,
            origin = info.Origin.ToString(),
            state = info.State.ToString(),
            description = info.Description,
            can = grant is null ? Array.Empty<string>() : PermissionSentence.Can(grant),
            cannot = grant is null ? Array.Empty<string>() : PermissionSentence.Cannot(grant),
        });
    }

    /// <summary>Images referenced by an Image node's record path. Deliberately narrow: image MIME
    /// types only, inside the site (ResolveSitePath already refuses state/), and no symlink anywhere
    /// in the chain — the jailed agent can write under the record dirs, and ResolveSitePath blocks
    /// `..` textually but a symlink whose target sits outside the data root would still resolve
    /// inside the prefix. Same guard PlansController.Asset applies to trip assets.</summary>
    [HttpGet("asset/{**path}")]
    public IActionResult Asset(string path)
    {
        var rel = path.Replace('\\', '/');
        var mime = Path.GetExtension(rel).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".svg" => "image/svg+xml",
            _ => (string?)null,
        };
        if (mime is null) return NotFound();
        var abs = _site.ResolveSitePath(rel);
        if (abs is null || !System.IO.File.Exists(abs)) return NotFound();
        if (!NoSymlinkEscape(abs)) return NotFound();
        return PhysicalFile(abs, mime, enableRangeProcessing: true);
    }

    private bool NoSymlinkEscape(string abs)
    {
        try
        {
            var root = Path.GetFullPath(_site.RootPath).TrimEnd(Path.DirectorySeparatorChar);
            var fi = new FileInfo(abs);
            if (fi.Attributes.HasFlag(FileAttributes.ReparsePoint)) return false;
            for (var dir = fi.Directory; dir is not null; dir = dir.Parent)
            {
                if (string.Equals(Path.GetFullPath(dir.FullName).TrimEnd(Path.DirectorySeparatorChar),
                        root, StringComparison.OrdinalIgnoreCase)) break;
                if (dir.Attributes.HasFlag(FileAttributes.ReparsePoint)) return false;
            }
            return true;
        }
        catch { return false; }
    }
}
