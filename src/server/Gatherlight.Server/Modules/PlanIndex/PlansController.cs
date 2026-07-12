using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.PlanIndex.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.PlanIndex;

[ApiController]
public sealed class PlansController : ControllerBase
{
    private readonly IPlanIndexService _index;
    private readonly IDataContext _data;

    public PlansController(IPlanIndexService index, IDataContext data)
    {
        _index = index;
        _data = data;
    }

    /// <summary>Index tree (no content — content loads lazily per file).</summary>
    [HttpGet("api/plans")]
    public IActionResult List() => Ok(new
    {
        files = _index.List().Select(e => new
        {
            path = e.Path,
            category = e.Category,
            subgroup = e.Subgroup,
            name = e.Name,
            title = e.Title,
            planDate = e.PlanDate,
            sizeBytes = e.SizeBytes,
            updatedAt = e.UpdatedAt,
        }),
        assets = _index.ListAssets().Select(a => new
        {
            path = a.Path,
            slug = a.Slug,
            category = a.Category,
            kind = a.Kind,
            filename = a.Filename,
            sizeBytes = a.SizeBytes,
            url = $"/api/assets/{a.Path}",
        }),
    });

    /// <summary>Raw markdown of one indexed file.</summary>
    [HttpGet("api/plans/content")]
    public IActionResult GetContent([FromQuery] string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !path.EndsWith(".md"))
            return BadRequest(new { error = "path must be a .md file" });
        var abs = _data.ResolveDataPath(path);
        if (abs is null || !System.IO.File.Exists(abs)) return NotFound();
        return Ok(new { path, content = System.IO.File.ReadAllText(abs) });
    }

    [HttpGet("api/plans/search")]
    public IActionResult Search([FromQuery] string q)
    {
        if (string.IsNullOrWhiteSpace(q)) return Ok(new { results = Array.Empty<object>() });
        return Ok(new { results = _index.Search(q) });
    }

    /// <summary>Trip-paired binary assets (visa PDFs, data JSON) — download/preview.</summary>
    [HttpGet("api/assets/{**path}")]
    public IActionResult Asset(string path)
    {
        var rel = path.Replace('\\', '/');
        if (!rel.StartsWith("plans/")) return NotFound();
        var abs = _data.ResolveDataPath(rel);
        if (abs is null || !System.IO.File.Exists(abs)) return NotFound();
        var mime = Path.GetExtension(abs).ToLowerInvariant() switch
        {
            ".pdf" => "application/pdf",
            ".json" => "application/json",
            _ => "application/octet-stream",
        };
        return PhysicalFile(abs, mime, enableRangeProcessing: true);
    }
}
