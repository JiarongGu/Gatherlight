using System.Reflection;

namespace Gatherlight.Server.Modules.Core.Services;

/// <summary>The application version, as a clean <c>major.minor.patch</c> string. Sourced from the
/// assembly version (set by <c>src/Directory.Build.props</c> — one source of truth for the app),
/// trimmed of the 4th ("revision") component so the banner, backup manifest, and update check all
/// report the same proper semver rather than <c>0.1.0.0</c>.</summary>
public static class AppVersion
{
    /// <summary><c>major.minor.patch</c> (e.g. <c>0.1.0</c>); <c>0.0.0</c> if unresolved.</summary>
    public static string Semver { get; } = Resolve();

    private static string Resolve()
    {
        var v = (Assembly.GetEntryAssembly() ?? typeof(AppVersion).Assembly).GetName().Version;
        // Build is -1 for a 2-part assembly version; clamp so it reads 1.0.0, not 1.0.-1.
        return v is null ? "0.0.0" : $"{v.Major}.{v.Minor}.{Math.Max(v.Build, 0)}";
    }
}
