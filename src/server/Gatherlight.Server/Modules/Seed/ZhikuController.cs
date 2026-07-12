using Gatherlight.Server.Modules.Seed.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Seed;

[ApiController]
public sealed class ZhikuController : ControllerBase
{
    private readonly IZhikuSeeder _seeder;

    public ZhikuController(IZhikuSeeder seeder) => _seeder = seeder;

    /// <summary>Last seeding report — what shipped, what upgraded, what was kept because the
    /// user modified it (those files miss template improvements until manually reconciled).</summary>
    [HttpGet("api/zhiku/status")]
    public async Task<IActionResult> Status()
    {
        var status = await _seeder.LastStatusAsync();
        return status is null ? Ok(new { seeded = false }) : Ok(status);
    }
}
