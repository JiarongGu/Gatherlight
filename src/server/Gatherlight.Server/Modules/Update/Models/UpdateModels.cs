namespace Gatherlight.Server.Modules.Update.Models;

/// <summary>Result of a version check against the release source.</summary>
public sealed class UpdateInfo
{
    public bool Configured { get; set; }
    public string CurrentVersion { get; set; } = "";
    public string? LatestVersion { get; set; }
    public bool UpdateAvailable { get; set; }
    public string? ReleaseName { get; set; }
    public string? ReleaseNotes { get; set; }
    public string? ReleaseUrl { get; set; }
    public string? PublishedAt { get; set; }
    public string? Error { get; set; }
}

/// <summary>Live staging state — whether a download is in flight or a staged update is waiting.</summary>
public sealed class UpdateState
{
    public bool Configured { get; set; }
    public bool Downloading { get; set; }
    public int Progress { get; set; }          // 0–100
    public bool Pending { get; set; }          // staged + ready.json present → applies on next restart
    public string? PendingVersion { get; set; }
    public string? Error { get; set; }
}

// The shipped manifest.json shape ({ files: [{ path, sha256, size }] }) — used to verify staged files.
public sealed class UpdateManifest
{
    public List<ManifestFile> Files { get; set; } = new();
}

public sealed class ManifestFile
{
    public string Path { get; set; } = "";
    public string? Sha256 { get; set; }
    public long Size { get; set; }
}
