using Gatherlight.Server.Modules.Library.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Library;

/// <summary>
/// Read side of the knowledge library — the browse gallery. Zero-LLM: everything is served
/// straight from the <c>library_item</c> table. Writes go through the agent's library_* MCP tools,
/// not this controller (the library is curated knowledge, not user-entered form data).
/// </summary>
[ApiController]
public sealed class LibraryController : ControllerBase
{
    private readonly ILibraryRepository _repo;
    public LibraryController(ILibraryRepository repo) => _repo = repo;

    /// <summary>Filtered list + facet counts (kinds / regions) for the gallery filters.</summary>
    [HttpGet("api/library")]
    public async Task<IActionResult> List(
        [FromQuery] string? kind, [FromQuery] string? region, [FromQuery] string? q, [FromQuery] int? limit)
    {
        var items = await _repo.QueryAsync(Norm(kind), Norm(region), Norm(q), limit ?? 200);
        var facets = await _repo.FacetsAsync();
        return Ok(new { items, facets });
    }

    /// <summary>A single library entity by (kind, key).</summary>
    [HttpGet("api/library/item")]
    public async Task<IActionResult> Item([FromQuery] string kind, [FromQuery] string key)
    {
        if (string.IsNullOrWhiteSpace(kind) || string.IsNullOrWhiteSpace(key))
            return BadRequest(new { error = "kind and key are required" });
        var item = await _repo.GetAsync(kind.Trim(), key.Trim());
        return item is null ? NotFound(new { error = "not found" }) : Ok(item);
    }

    private static string? Norm(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}
