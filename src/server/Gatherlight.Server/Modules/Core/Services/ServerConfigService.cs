using System.Text.Json;
using System.Text.Json.Serialization;

namespace Gatherlight.Server.Modules.Core.Services;

/// <summary>User configuration persisted as {data}/state/settings.json (created on first save).
/// Dynamic/tunable values (prompt overrides, per-consumer models, timeouts) live in the
/// <c>app_config</c> table instead — this file is only what must exist before the DB opens.</summary>
public sealed class ServerConfig
{
    /// <summary>Display name (multi-family/multi-instance setups later).</summary>
    public string ServerName { get; set; } = Environment.MachineName is { Length: > 0 } m ? $"Gatherlight on {m}" : "Gatherlight";

    /// <summary>HTTP port Kestrel binds. Applied at startup (a change needs a server restart);
    /// the <c>GATHERLIGHT_PORT</c> env var overrides it for dev/e2e.</summary>
    public int Port { get; set; } = GatherlightServerOptions.DefaultPort;
}

/// <summary>
/// Loads/saves <see cref="ServerConfig"/>. Constructed before <see cref="DataContext"/> is usable,
/// so it derives the settings path from the options directly.
/// </summary>
public sealed class ServerConfigService
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _path;
    private readonly object _lock = new();

    public ServerConfigService(GatherlightServerOptions options)
    {
        var stateDir = Path.Combine(Path.GetFullPath(options.DataPath), "state");
        Directory.CreateDirectory(stateDir);
        _path = Path.Combine(stateDir, "settings.json");
        Current = Load();
    }

    public ServerConfig Current { get; private set; }

    public void Update(Action<ServerConfig> mutate)
    {
        lock (_lock)
        {
            mutate(Current);
            var tmp = _path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(Current, JsonOpts));
            File.Move(tmp, _path, overwrite: true);
        }
    }

    private ServerConfig Load()
    {
        try
        {
            if (File.Exists(_path))
                return JsonSerializer.Deserialize<ServerConfig>(File.ReadAllText(_path), JsonOpts) ?? new ServerConfig();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[Config] Failed to read {_path}: {ex.Message} — using defaults");
        }
        return new ServerConfig();
    }
}
