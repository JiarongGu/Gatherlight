using System.Text.Json;
using Gatherlight.Server.Platform.Storage.Knowledge.Services;
using Gatherlight.Server.Platform.Storage.Memory.Services;
using Gatherlight.Server.Platform.Hosting.Migration.Services;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

public sealed class MemorySeedStep : IMigrationStep
{
    private readonly IMemoryService _memory;
    private readonly DetachedFactBackfill _backfill;
    private readonly ILogger<MemorySeedStep> _log;
    public MemorySeedStep(IMemoryService memory, DetachedFactBackfill backfill, ILogger<MemorySeedStep> log)
    {
        _memory = memory;
        _backfill = backfill;
        _log = log;
    }
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
            // This step runs AFTER FactIndexStep, so the startup back-fill has already passed: the seeded facts would be
            // found by keyword only until the NEXT start. Detached, like the import endpoint's — each fact is a model
            // call when 判断 is on, and the gate should not wait on them. See DetachedFactBackfill.
            if (r.Knowledge > 0) _backfill.Start("the startup memory seed");
        }
    }
}
