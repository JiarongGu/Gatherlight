using System.Text.Json;
using Gatherlight.Server.Modules.Memory.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Memory;

/// <summary>
/// Transfer the durable DB memory (knowledge library + learned facts + entity store) between
/// installs. `GET /api/memory/export` downloads a portable bundle; `POST /api/memory/import` merges
/// one in (idempotent upsert). The same bundle can pre-seed a fresh install at startup via
/// <c>GATHERLIGHT_SEED_MEMORY</c>.
/// </summary>
[ApiController]
public sealed class MemoryController : ControllerBase
{
    private static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly IMemoryService _memory;
    public MemoryController(IMemoryService memory) => _memory = memory;

    [HttpGet("api/memory/export")]
    public async Task<IActionResult> Export()
    {
        var bundle = await _memory.ExportAsync();
        var bytes = JsonSerializer.SerializeToUtf8Bytes(bundle, Wire);
        var name = $"gatherlight-memory-{DateTime.UtcNow:yyyyMMdd-HHmmss}.json";
        return File(bytes, "application/json", name);
    }

    [HttpPost("api/memory/import")]
    public async Task<IActionResult> Import([FromBody] MemoryBundle? bundle)
    {
        if (bundle is null || bundle.GatherlightMemory < 1)
            return BadRequest(new { error = "not a Gatherlight memory bundle" });
        var r = await _memory.ImportAsync(bundle);
        return Ok(new { ok = true, imported = new { library = r.Library, knowledge = r.Knowledge, entities = r.Entities, cortex = r.Cortex } });
    }
}
