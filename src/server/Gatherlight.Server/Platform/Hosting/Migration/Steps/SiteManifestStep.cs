using Gatherlight.Server.Platform.Hosting.Migration.Services;
using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Site.Models;
using Gatherlight.Server.Platform.Site.Services;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

/// <summary>
/// Writes <c>site.json</c> into a data folder that predates it, inferring the record directories
/// from what is already on disk, then ensures those directories exist. Deliberately dull: no file
/// moves, no path rewrites, no database changes — the manifest DECLARES the layout rather than
/// imposing one, so an existing planner folder needs nothing but this file. Idempotent; a crash
/// leaves a missing manifest the next boot rewrites.
/// </summary>
public sealed class SiteManifestStep : IMigrationStep
{
    private static readonly string[] KnownRecordDirs = ["plans", "household"];

    private readonly ISiteManifestStore _manifest;
    private readonly ISiteContext _site;
    private readonly ILogger<SiteManifestStep> _log;

    public SiteManifestStep(ISiteManifestStore manifest, ISiteContext site, ILogger<SiteManifestStep> log)
    {
        _manifest = manifest;
        _site = site;
        _log = log;
    }

    public string Id => "site-manifest";
    public string Title => "站点清单 · Site manifest";
    public bool Essential => true;

    public Task RunAsync(CancellationToken ct)
    {
        if (!_manifest.Exists)
        {
            var records = KnownRecordDirs
                .Where(d => Directory.Exists(Path.Combine(_site.RootPath, d)))
                .ToArray();
            if (records.Length == 0) records = KnownRecordDirs;

            _manifest.Write(new SiteManifest { Records = records });
            _log.LogInformation("site.json written (records: {Records})", string.Join(", ", records));
        }

        // Touch RecordPaths so the declared directories exist. The old DataContext created
        // plans/ + household/ eagerly in its constructor; that guarantee moved here when the
        // set became manifest-driven, and nothing else calls RecordPaths — without this line
        // the directories only appear as a side effect of whichever subsystem happens to write
        // into them first, which for plans/ is an index write inside a swallowing try/catch.
        _ = _site.RecordPaths;
        return Task.CompletedTask;
    }
}
