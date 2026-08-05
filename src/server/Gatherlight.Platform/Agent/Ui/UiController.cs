using Gatherlight.Server.Platform.Agent.Ui.Models;
using Gatherlight.Server.Platform.Agent.Ui.Services;
using Gatherlight.Server.Platform.Kernel.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Platform.Agent.Ui;

/// <summary>Client-safe projection of one component's contract.</summary>
public sealed record UiComponentView(string Type, bool AcceptsChildren, Dictionary<string, string> Props);

[ApiController]
[Route("api/ui")]
public sealed class UiController : ControllerBase
{
    private readonly IUiTreeValidator _validator;
    private readonly ISitePageStore _pages;
    private readonly ISiteContext _site;

    public UiController(IUiTreeValidator validator, ISitePageStore pages, ISiteContext site)
    {
        _validator = validator;
        _pages = pages;
        _site = site;
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

    [HttpGet("pages/{name}")]
    public ActionResult<SitePageView> Page(string name) =>
        _pages.Get(name) is { } page ? Ok(page) : NotFound();

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
