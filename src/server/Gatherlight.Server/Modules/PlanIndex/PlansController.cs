using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.PlanIndex.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.PlanIndex;

[ApiController]
public sealed class PlansController : ControllerBase
{
    private readonly IPlanIndexService _index;
    private readonly IDataContext _data;
    private readonly IIcsExportService _ics;

    public PlansController(IPlanIndexService index, IDataContext data, IIcsExportService ics)
    {
        _index = index;
        _data = data;
        _ics = ics;
    }

    /// <summary>Index tree. <c>content=1</c> inlines each file's markdown — the client's
    /// startup load (family-scale data, one request beats 80 round-trips).</summary>
    [HttpGet("api/plans")]
    public IActionResult List([FromQuery] int content = 0) => Ok(new
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
            content = content == 1 ? ReadContent(e.Path) : null,
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

    private string? ReadContent(string rel)
    {
        var abs = _data.ResolveDataPath(rel);
        if (abs is null || !System.IO.File.Exists(abs)) return null;
        try { return System.IO.File.ReadAllText(abs); }
        catch (IOException) { return null; } // mid-write; watcher rescan follows
    }

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

    /// <summary>Deterministic (zero-LLM) iCalendar export of a plan's dated entries.</summary>
    [HttpGet("api/plans/ics")]
    public IActionResult Ics([FromQuery] string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !path.EndsWith(".md"))
            return BadRequest(new { error = "path must be a .md plan" });
        var ics = _ics.BuildIcs(path);
        if (ics is null) return NotFound(new { error = "no dated entries to export" });
        var name = Path.GetFileNameWithoutExtension(path);
        return File(System.Text.Encoding.UTF8.GetBytes(ics), "text/calendar; charset=utf-8", $"{name}.ics");
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
