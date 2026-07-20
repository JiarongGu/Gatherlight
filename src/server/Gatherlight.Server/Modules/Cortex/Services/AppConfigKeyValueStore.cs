using Gatherlight.Server.Modules.Core.Services;
using Lyntai.Storage;

namespace Gatherlight.Server.Modules.Cortex.Services;

/// <summary>
/// Plugs Gatherlight's own <c>app_config</c> table into Lyntai's cortex as its <see cref="IKeyValueStore"/>,
/// so Lyntai's <c>IPromptRegistry</c> + <c>IModelRoutingStore</c> read/write the app's EXISTING
/// <c>cortex.prompt.*</c> / <c>llm.model.*</c> keys directly (via the configurable key prefixes) — single
/// source of truth, no <c>lyntai_kv</c> duplicate. Lyntai owns the cortex LOGIC (render / validate / route);
/// the app owns the one storage table. The sync, in-process <see cref="IAppConfigService"/> is wrapped as the
/// async KV seam.
/// </summary>
public sealed class AppConfigKeyValueStore(IAppConfigService config) : IKeyValueStore
{
    public Task<string?> GetAsync(string key, CancellationToken ct = default) => Task.FromResult(config.Get(key));

    public Task SetAsync(string key, string value, CancellationToken ct = default)
    {
        config.Set(key, value);
        return Task.CompletedTask;
    }

    public Task DeleteAsync(string key, CancellationToken ct = default)
    {
        config.Delete(key);
        return Task.CompletedTask;
    }
}
