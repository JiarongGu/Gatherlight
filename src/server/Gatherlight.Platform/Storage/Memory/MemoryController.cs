using System.Text.Json;
using Gatherlight.Server.Platform.Storage.Knowledge.Services;
using Gatherlight.Server.Platform.Storage.Memory.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Platform.Storage.Memory;

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
    private readonly DetachedFactBackfill _backfill;

    public MemoryController(IMemoryService memory, DetachedFactBackfill backfill)
    {
        _memory = memory;
        _backfill = backfill;
    }

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
        // The import writes facts WITHOUT indexing them — new ones have no graph ref, and an edited one's was cleared —
        // so they would be found by keyword only until the next start. Back-fill them now, detached: the request does
        // not wait, and a browser that stops waiting does not cancel it. See DetachedFactBackfill. HERE and not in
        // ImportAsync, because of its other two callers: the backup import REBUILDS inline (which a concurrent back-fill
        // would race), and the startup seed step starts one of its own.
        if (r.Knowledge > 0) _backfill.Start("a memory import");
        return Ok(new { ok = true, imported = new { library = r.Library, knowledge = r.Knowledge, entities = r.Entities, cortex = r.Cortex } });
    }
}
