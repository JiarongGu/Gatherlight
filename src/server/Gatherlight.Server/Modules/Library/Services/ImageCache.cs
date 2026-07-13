using System.Net;
using System.Security.Cryptography;
using System.Text;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.Library.Services;

public sealed record CachedImage(byte[] Bytes, string ContentType);

/// <summary>
/// Fetch-once, disk-cache proxy for the library's remote cover images. The client points its
/// &lt;img&gt; at /api/library/image?url=… so images route through the server: cached under
/// {data}/cache/library-images (offline after first fetch) and never depend on a live CDN.
/// SSRF-guarded — only public http(s) hosts, image content-type, size + time capped.
/// </summary>
public interface IImageCache
{
    Task<CachedImage?> GetAsync(string url, CancellationToken ct);
}

public sealed class ImageCache : IImageCache
{
    private const long MaxBytes = 8 * 1024 * 1024;

    private readonly IHttpClientFactory _http;
    private readonly IDataContext _data;

    public ImageCache(IHttpClientFactory http, IDataContext data)
    {
        _http = http;
        _data = data;
    }

    public async Task<CachedImage?> GetAsync(string url, CancellationToken ct)
    {
        if (!IsAllowed(url)) return null;

        var dir = Path.Combine(_data.CachePath, "library-images");
        Directory.CreateDirectory(dir);
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(url))).ToLowerInvariant();
        var binPath = Path.Combine(dir, hash);
        var typePath = binPath + ".ct";

        if (File.Exists(binPath) && File.Exists(typePath))
        {
            var cached = await File.ReadAllBytesAsync(binPath, ct);
            var cachedType = (await File.ReadAllTextAsync(typePath, ct)).Trim();
            return new CachedImage(cached, cachedType.Length > 0 ? cachedType : "image/*");
        }

        try
        {
            var client = _http.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(12);
            client.DefaultRequestHeaders.UserAgent.ParseAdd("Gatherlight/1.0 (+library image cache)");
            using var resp = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
            if (!resp.IsSuccessStatusCode) return null;

            var type = resp.Content.Headers.ContentType?.MediaType ?? "";
            if (!type.StartsWith("image/", StringComparison.OrdinalIgnoreCase)) return null;
            if (resp.Content.Headers.ContentLength is > MaxBytes) return null;

            var bytes = await resp.Content.ReadAsByteArrayAsync(ct);
            if (bytes.Length == 0 || bytes.Length > MaxBytes) return null;

            await File.WriteAllBytesAsync(binPath, bytes, ct);
            await File.WriteAllTextAsync(typePath, type, ct);
            return new CachedImage(bytes, type);
        }
        catch
        {
            return null; // dead URL / offline / timeout → caller shows the glyph placeholder
        }
    }

    /// <summary>Absolute http(s) to a public host only (SSRF guard). The e2e sets
    /// GATHERLIGHT_IMAGE_ALLOW_PRIVATE=1 so a loopback fixture server can be tested.</summary>
    internal static bool IsAllowed(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return false;
        if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps) return false;
        if (Environment.GetEnvironmentVariable("GATHERLIGHT_IMAGE_ALLOW_PRIVATE") == "1") return true;
        if (u.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)) return false;
        if (IPAddress.TryParse(u.Host, out var ip) && IsPrivate(ip)) return false;
        return true;
    }

    private static bool IsPrivate(IPAddress ip)
    {
        if (IPAddress.IsLoopback(ip)) return true;
        var b = ip.GetAddressBytes();
        if (b.Length == 4)
            return b[0] == 10
                || (b[0] == 172 && b[1] >= 16 && b[1] <= 31)
                || (b[0] == 192 && b[1] == 168)
                || (b[0] == 169 && b[1] == 254)
                || b[0] == 0;
        return ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal;
    }
}
