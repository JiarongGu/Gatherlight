namespace Gatherlight.Server;

/// <summary>
/// Boot options for the Gatherlight server. The standalone <c>Program.cs</c> (headless dev:
/// <c>dotnet run</c>) builds from this; a future desktop host would pass explicit values.
/// Everything else (server name, chat model) is user configuration and lives in
/// <c>{data}/state/settings.json</c> — see <see cref="Modules.Core.Services.ServerConfigService"/>.
/// </summary>
public sealed class GatherlightServerOptions
{
    public const int DefaultPort = 5317;

    /// <summary>HTTP port Kestrel binds.</summary>
    public int Port { get; init; } = ResolvePort(DefaultPort);

    /// <summary>Address Kestrel binds. <c>127.0.0.1</c> (default) = loopback only; <c>0.0.0.0</c>
    /// exposes on the network (requires <see cref="AccessToken"/>). <c>GATHERLIGHT_BIND</c> wins.</summary>
    public string BindAddress { get; init; } = ResolveBindAddress("127.0.0.1");

    /// <summary>Shared secret required for remote (non-loopback) access; null = open (loopback only).
    /// <c>GATHERLIGHT_ACCESS_TOKEN</c> wins over the persisted setting.</summary>
    public string? AccessToken { get; init; } = ResolveAccessToken(null);

    /// <summary>Whether loopback requests bypass the token (default true). Set false behind a
    /// same-host reverse proxy. <c>GATHERLIGHT_TRUST_LOOPBACK=0</c> wins.</summary>
    public bool TrustLoopback { get; init; } = ResolveTrustLoopback(true);

    /// <summary>Serve HTTPS directly from Kestrel (self-signed cert by default). <c>GATHERLIGHT_TLS=1</c> wins.</summary>
    public bool TlsEnabled { get; init; } = ResolveTlsEnabled(false);

    /// <summary>PFX certificate path; null = generate/reuse a self-signed one. <c>GATHERLIGHT_TLS_CERT</c> wins.</summary>
    public string? TlsCertPath { get; init; } = ResolveTlsCertPath(null);

    /// <summary>Password for <see cref="TlsCertPath"/>. <c>GATHERLIGHT_TLS_CERT_PASSWORD</c> wins.</summary>
    public string? TlsCertPassword { get; init; } = ResolveTlsCertPassword(null);

    /// <summary>
    /// Data folder root: markdown plans/household + planner knowledge base (its own private git
    /// repo) and app state (SQLite, settings, uploads, caches) under <c>state/</c>. Default is
    /// <c>{repo}/local</c> (gitignored). Overridable via <c>GATHERLIGHT_DATA</c>.
    /// </summary>
    public string DataPath { get; init; } = ResolveDefaultDataPath();

    /// <summary>
    /// The Gatherlight CODE repo root — where 系统模式 (the UI-update chat mode) edits
    /// src/client and commits. Default: walk up from cwd to Gatherlight.slnx; e2e overrides
    /// with <c>GATHERLIGHT_CODE_ROOT</c> to point at a fixture.
    /// </summary>
    public string CodeRootPath { get; init; } =
        Environment.GetEnvironmentVariable("GATHERLIGHT_CODE_ROOT") ?? ResolveRepoRoot();

    private static string ResolveRepoRoot()
    {
        for (var d = new DirectoryInfo(Environment.CurrentDirectory); d is not null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "Gatherlight.slnx")))
                return d.FullName;
        return Environment.CurrentDirectory;
    }

    /// <summary>
    /// <c>GATHERLIGHT_DATA</c> env wins; else walk up from cwd to the repo root (marked by
    /// Gatherlight.slnx) and use <c>{root}/local</c> — `dotnet run` sets the app's cwd to the
    /// PROJECT directory, so a plain <c>{cwd}/local</c> would land inside src/server/. Falls back
    /// to <c>{cwd}/local</c> outside a repo (published exe with no env set).
    /// </summary>
    public static string ResolveDefaultDataPath()
    {
        var env = Environment.GetEnvironmentVariable("GATHERLIGHT_DATA");
        if (!string.IsNullOrEmpty(env)) return env;
        // Structured production bundle: the exe lives in libs/, with res/ + data/ as siblings.
        if (Directory.Exists(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "res"))))
            return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "data"));
        // Dev: walk up from cwd to the repo root (Gatherlight.slnx) and use {root}/local.
        for (var d = new DirectoryInfo(Environment.CurrentDirectory); d is not null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "Gatherlight.slnx")))
                return Path.Combine(d.FullName, "local");
        return Path.Combine(Environment.CurrentDirectory, "local");
    }

    /// <summary>Effective port: the <c>GATHERLIGHT_PORT</c> env override wins (dev/e2e), else the
    /// persisted user setting, else <see cref="DefaultPort"/>.</summary>
    public static int ResolvePort(int settingPort)
    {
        if (int.TryParse(Environment.GetEnvironmentVariable("GATHERLIGHT_PORT"), out var env) && env is > 0 and < 65536)
            return env;
        return settingPort is > 0 and < 65536 ? settingPort : DefaultPort;
    }

    /// <summary>Effective bind address: <c>GATHERLIGHT_BIND</c> wins, else the persisted setting,
    /// else loopback.</summary>
    public static string ResolveBindAddress(string settingAddress) =>
        Environment.GetEnvironmentVariable("GATHERLIGHT_BIND") is { Length: > 0 } e ? e.Trim()
        : string.IsNullOrWhiteSpace(settingAddress) ? "127.0.0.1" : settingAddress.Trim();

    /// <summary>Effective access token: <c>GATHERLIGHT_ACCESS_TOKEN</c> wins, else the persisted
    /// setting, else null (no token → loopback-only enforced by the binding check).</summary>
    public static string? ResolveAccessToken(string? settingToken) =>
        Environment.GetEnvironmentVariable("GATHERLIGHT_ACCESS_TOKEN") is { Length: > 0 } e ? e
        : string.IsNullOrWhiteSpace(settingToken) ? null : settingToken;

    /// <summary>Effective loopback-trust: <c>GATHERLIGHT_TRUST_LOOPBACK=0/false</c> forces the token
    /// even on loopback (same-host reverse proxy); otherwise the persisted setting.</summary>
    public static bool ResolveTrustLoopback(bool settingValue) =>
        Environment.GetEnvironmentVariable("GATHERLIGHT_TRUST_LOOPBACK") is { Length: > 0 } e
            ? e is not ("0" or "false" or "False")
            : settingValue;

    /// <summary>Effective TLS toggle: <c>GATHERLIGHT_TLS=1/true</c> wins, else the persisted setting.</summary>
    public static bool ResolveTlsEnabled(bool settingValue) =>
        Environment.GetEnvironmentVariable("GATHERLIGHT_TLS") is { Length: > 0 } e
            ? e is "1" or "true" or "True"
            : settingValue;

    /// <summary>Effective TLS cert path: <c>GATHERLIGHT_TLS_CERT</c> wins, else the persisted setting.</summary>
    public static string? ResolveTlsCertPath(string? settingValue) =>
        Environment.GetEnvironmentVariable("GATHERLIGHT_TLS_CERT") is { Length: > 0 } e ? e
        : string.IsNullOrWhiteSpace(settingValue) ? null : settingValue;

    /// <summary>Effective TLS cert password: <c>GATHERLIGHT_TLS_CERT_PASSWORD</c> wins, else the setting.</summary>
    public static string? ResolveTlsCertPassword(string? settingValue) =>
        Environment.GetEnvironmentVariable("GATHERLIGHT_TLS_CERT_PASSWORD") is { Length: > 0 } e ? e
        : string.IsNullOrWhiteSpace(settingValue) ? null : settingValue;

    /// <summary>True when the address only ever accepts local connections (no token needed).</summary>
    public static bool IsLoopbackAddress(string address) =>
        address is "127.0.0.1" or "::1" or "[::1]" or "localhost";
}
