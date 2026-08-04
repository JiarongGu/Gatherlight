using System.Text;
using System.Text.Json;
using Gatherlight.Server.Platform.Site.Models;

namespace Gatherlight.Server.Platform.Site.Services;

public interface ISiteManifestStore
{
    /// <summary>The manifest, loaded once. Throws if the file exists but will not parse.</summary>
    SiteManifest Current { get; }
    string ManifestPath { get; }
    bool Exists { get; }
    SiteManifest Load();
    void Write(SiteManifest manifest);
}

/// <summary>
/// Reads and writes <c>{data}/site.json</c>. An unparseable manifest is FATAL and loud rather than
/// silently defaulted: the manifest is what the scope guard is generated from, and building a
/// security boundary out of guessed defaults is precisely the failure mode to avoid.
/// </summary>
public sealed class SiteManifestStore : ISiteManifestStore
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };
    private static readonly UTF8Encoding Utf8NoBom = new(false);

    private readonly string _root;
    private SiteManifest? _cached;

    public SiteManifestStore(GatherlightServerOptions options) => _root = Path.GetFullPath(options.DataPath);

    public string ManifestPath => Path.Combine(_root, "site.json");
    public bool Exists => File.Exists(ManifestPath);
    public SiteManifest Current => _cached ??= Load();

    public SiteManifest Load()
    {
        if (!Exists) return _cached = new SiteManifest();
        var body = File.ReadAllText(ManifestPath);
        try
        {
            return _cached = JsonSerializer.Deserialize<SiteManifest>(body, Json)
                ?? throw new JsonException("site.json is empty");
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException(
                $"site.json 无法解析,拒绝以默认值启动(scope guard 由它生成):{ManifestPath} — {ex.Message}", ex);
        }
    }

    public void Write(SiteManifest manifest)
    {
        File.WriteAllText(ManifestPath, JsonSerializer.Serialize(manifest, Json) + "\n", Utf8NoBom);
        _cached = manifest;
    }
}
