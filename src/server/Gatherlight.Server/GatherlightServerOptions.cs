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

    /// <summary>HTTP port Kestrel binds on loopback. LAN exposure waits for an auth story.</summary>
    public int Port { get; init; } = ResolvePort(DefaultPort);

    /// <summary>
    /// Data folder root: markdown plans/household + planner knowledge base (its own private git
    /// repo) and app state (SQLite, settings, uploads, caches) under <c>state/</c>. Default is
    /// <c>{repo}/local</c> (gitignored). Overridable via <c>GATHERLIGHT_DATA</c>.
    /// </summary>
    public string DataPath { get; init; } = ResolveDefaultDataPath();

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
}
