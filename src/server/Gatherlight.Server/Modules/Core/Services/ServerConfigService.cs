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

    /// <summary>Minimum level for the file log ({data}/state/logs). One of Trace/Debug/Information/
    /// Warning/Error/Critical. Applied at startup; <c>GATHERLIGHT_LOG_LEVEL</c> overrides. Framework
    /// (Microsoft/System) noise stays capped at Warning regardless.</summary>
    public string LogLevel { get; set; } = "Information";

    /// <summary>Desktop-host behaviour when the window's close (✕) button is pressed: <c>ask</c>
    /// (prompt each time — default), <c>tray</c> (minimize to the tray, keep serving), or <c>exit</c>
    /// (quit). Set from the close prompt's "remember" option or in Settings. Ignored by `dotnet run`.</summary>
    public string HostCloseAction { get; set; } = "ask";

    /// <summary>Remote-access hardening (binding + auth). All values applied at startup.</summary>
    public SecurityConfig Security { get; set; } = new();

    /// <summary>Self-update source (GitHub releases).</summary>
    public UpdateConfig SelfUpdate { get; set; } = new();
}

/// <summary>
/// Access controls for exposing Gatherlight beyond localhost. The data folder is a family's
/// private life AND the server can spawn the authenticated <c>claude</c> CLI, so remote exposure
/// without a token is unauthenticated control of both — the binding fails closed on that.
/// </summary>
public sealed class SecurityConfig
{
    /// <summary>Shared secret required for remote (non-loopback) API/MCP access. Null/empty = no
    /// token (the server must then stay loopback-bound). <c>GATHERLIGHT_ACCESS_TOKEN</c> overrides.
    /// Loopback requests are always trusted — the local machine already controls the server.</summary>
    public string? AccessToken { get; set; }

    /// <summary>Address Kestrel binds. Default <c>127.0.0.1</c> (loopback only). Set <c>0.0.0.0</c>
    /// to expose on the network — which requires <see cref="AccessToken"/> or the server refuses to
    /// start. <c>GATHERLIGHT_BIND</c> overrides.</summary>
    public string BindAddress { get; set; } = "127.0.0.1";

    /// <summary>Whether loopback requests bypass the token. Default true (the local machine already
    /// controls the server). Set false when running behind a SAME-HOST reverse proxy (nginx →
    /// 127.0.0.1), where every request arrives from loopback and trusting it would bypass auth
    /// entirely. <c>GATHERLIGHT_TRUST_LOOPBACK=0</c> overrides.</summary>
    public bool TrustLoopback { get; set; } = true;

    /// <summary>Opt-in to expose the server beyond loopback WITHOUT a token (otherwise the binding
    /// fails closed). With no token the access gate is a no-op, so this grants anyone who can reach
    /// <see cref="BindAddress"/> full unauthenticated access — only for a trusted private LAN behind
    /// NAT. <c>GATHERLIGHT_ALLOW_LAN=1</c> overrides.</summary>
    public bool AllowLanWithoutToken { get; set; }

    /// <summary>HTTPS/TLS termination in Kestrel itself.</summary>
    public TlsConfig Tls { get; set; } = new();
}

/// <summary>
/// Where the app looks for updates. Set <see cref="GithubRepo"/> to <c>owner/name</c> and the app
/// checks that repo's latest GitHub release; the desktop console can then download + stage an update
/// which the native launcher applies on the next restart. <see cref="ApiUrl"/> overrides the release
/// API endpoint outright (self-hosted mirror, or a test double). Empty = updates disabled.
/// </summary>
public sealed class UpdateConfig
{
    /// <summary><c>owner/name</c> of the GitHub repo to pull releases from. Defaults to the official
    /// Gatherlight repo so auto-update works out of the box; set empty to disable, or point at a fork.
    /// <c>GATHERLIGHT_UPDATE_REPO</c> overrides.</summary>
    public string? GithubRepo { get; set; } = "JiarongGu/Gatherlight";
    /// <summary>Explicit release-API URL (wins over <see cref="GithubRepo"/>). <c>GATHERLIGHT_UPDATE_API</c> overrides.</summary>
    public string? ApiUrl { get; set; }
}

/// <summary>
/// TLS for direct HTTPS (no proxy). Off by default. When on, Kestrel serves HTTPS using
/// <see cref="CertPath"/> (a PKCS#12/PFX bundle) — or, when that's unset, a self-signed certificate
/// generated once and persisted to <c>{data}/state/gatherlight-tls.pfx</c>. A self-signed cert
/// encrypts the connection (so the access token isn't sent in the clear) but browsers will warn;
/// point <see cref="CertPath"/> at a real cert (e.g. Let's Encrypt) to remove the warning.
/// </summary>
public sealed class TlsConfig
{
    public bool Enabled { get; set; }
    /// <summary>Path to a PFX/PKCS#12 certificate. Null = generate + reuse a self-signed one.
    /// <c>GATHERLIGHT_TLS_CERT</c> overrides.</summary>
    public string? CertPath { get; set; }
    /// <summary>Password for <see cref="CertPath"/> (if any). <c>GATHERLIGHT_TLS_CERT_PASSWORD</c>
    /// overrides.</summary>
    public string? CertPassword { get; set; }
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
