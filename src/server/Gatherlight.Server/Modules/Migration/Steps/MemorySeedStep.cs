using System.Text.Json;
using Gatherlight.Server.Modules.Memory.Services;
using Gatherlight.Server.Modules.Migration.Services;

namespace Gatherlight.Server.Modules.Migration.Steps;

public sealed class MemorySeedStep : IMigrationStep
{
    private readonly IMemoryService _memory;
    private readonly ILogger<MemorySeedStep> _log;
    public MemorySeedStep(IMemoryService memory, ILogger<MemorySeedStep> log) { _memory = memory; _log = log; }
    public string Id => "memory-seed";
    public string Title => "导入初始记忆(可选)";
    public bool Essential => false;
    public async Task RunAsync(CancellationToken ct)
    {
        var seedPath = Environment.GetEnvironmentVariable("GATHERLIGHT_SEED_MEMORY");
        if (string.IsNullOrEmpty(seedPath) || !File.Exists(seedPath)) return;
        var bundle = JsonSerializer.Deserialize<MemoryBundle>(
            await File.ReadAllTextAsync(seedPath, ct), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        if (bundle is { GatherlightMemory: >= 1 })
        {
            var r = await _memory.ImportAsync(bundle);
            _log.LogInformation("Seeded memory from {Path}: {Lib} library, {Kn} knowledge, {Ent} entities, {Cx} cortex",
                seedPath, r.Library, r.Knowledge, r.Entities, r.Cortex);
        }
    }
}
