using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Text;

namespace Gatherlight.Server.Modules.Update.Services;

/// <summary>
/// Reads individual entries out of a remote zip over HTTP range requests, so a differential update
/// fetches only the changed files' compressed bytes instead of the whole archive. No zip64 (bundles
/// are ~20 MB). Compress-Archive of a folder wraps every entry under a single top-level folder; that
/// root is stripped so entry keys are bundle-relative, matching the manifest paths (the same wrinkle
/// <c>FlattenSingleRoot</c> handles for full extracts). Range requests go to the ORIGINAL asset URL —
/// HttpClient follows GitHub's 302 to a fresh pre-signed CDN URL each time (which honors Range), so
/// there is no pre-signed-URL expiry to manage.
/// </summary>
public sealed class RemoteZip
{
    public sealed record Entry(string Path, long LocalHeaderOffset, long CompressedSize, ushort Method);

    private readonly HttpClient _http;
    private readonly string _url;
    private readonly long _length;
    private Dictionary<string, Entry> _entries = new(StringComparer.OrdinalIgnoreCase);

    public RemoteZip(HttpClient http, string url, long length)
    {
        _http = http;
        _url = url;
        _length = length;
    }

    // Range GET [from, from+count). Throws on non-206 or a short read.
    private async Task<byte[]> RangeAsync(long from, long count, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, _url);
        req.Headers.Range = new RangeHeaderValue(from, from + count - 1);
        using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseContentRead, ct);
        if (resp.StatusCode != HttpStatusCode.PartialContent)
            throw new InvalidOperationException($"range not honored (status {(int)resp.StatusCode})");
        var bytes = await resp.Content.ReadAsByteArrayAsync(ct);
        if (bytes.Length < count) throw new InvalidOperationException("short range read");
        return bytes;
    }

    /// <summary>Parse the End-Of-Central-Directory + central directory into the entry map (once).</summary>
    public async Task LoadAsync(CancellationToken ct = default)
    {
        var tailLen = (int)Math.Min(_length, 65_557); // max EOCD comment (65535) + EOCD record (22)
        var tail = await RangeAsync(_length - tailLen, tailLen, ct);

        int eocd = -1;
        for (int i = tail.Length - 22; i >= 0; i--)
            if (tail[i] == 0x50 && tail[i + 1] == 0x4b && tail[i + 2] == 0x05 && tail[i + 3] == 0x06) { eocd = i; break; }
        if (eocd < 0) throw new InvalidOperationException("EOCD not found");

        uint cdSize = BitConverter.ToUInt32(tail, eocd + 12);
        uint cdOffset = BitConverter.ToUInt32(tail, eocd + 16);

        byte[] cd;
        long tailStart = _length - tailLen;
        if (cdOffset >= tailStart)
        {
            int start = (int)(cdOffset - tailStart);
            cd = tail[start..(start + (int)cdSize)];
        }
        else cd = await RangeAsync(cdOffset, cdSize, ct);

        var entries = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
        int p = 0;
        while (p + 46 <= cd.Length && BitConverter.ToUInt32(cd, p) == 0x02014b50)
        {
            ushort method = BitConverter.ToUInt16(cd, p + 10);
            uint compSize = BitConverter.ToUInt32(cd, p + 20);
            ushort fnLen = BitConverter.ToUInt16(cd, p + 28);
            ushort exLen = BitConverter.ToUInt16(cd, p + 30);
            ushort cmLen = BitConverter.ToUInt16(cd, p + 32);
            uint lho = BitConverter.ToUInt32(cd, p + 42);
            string name = Encoding.UTF8.GetString(cd, p + 46, fnLen);
            if (!name.EndsWith('/')) entries[name] = new Entry(name, lho, compSize, method);
            p += 46 + fnLen + exLen + cmLen;
        }
        _entries = StripSingleRoot(entries);
    }

    // Drop a single shared top-level folder so keys are bundle-relative. No shared root → unchanged.
    private static Dictionary<string, Entry> StripSingleRoot(Dictionary<string, Entry> entries)
    {
        string? root = null;
        foreach (var k in entries.Keys)
        {
            var slash = k.IndexOf('/');
            if (slash <= 0) return entries; // a top-level file → no single wrapping root
            var top = k[..slash];
            if (root is null) root = top;
            else if (!root.Equals(top, StringComparison.OrdinalIgnoreCase)) return entries;
        }
        if (root is null) return entries;
        var prefix = root + "/";
        var remapped = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
        foreach (var (k, v) in entries)
        {
            var nk = k[prefix.Length..];
            remapped[nk] = v with { Path = nk };
        }
        return remapped;
    }

    public bool TryGet(string path, out Entry entry) => _entries.TryGetValue(path.Replace('\\', '/'), out entry!);

    /// <summary>Range-fetch one entry and inflate it (method 8 = raw deflate; 0 = stored).</summary>
    public async Task<byte[]> FetchAsync(Entry e, CancellationToken ct = default)
    {
        // Grab the local header (30 fixed + a generous 512 for name/extra) + the compressed data in one
        // request; re-fetch the data exactly if name+extra overflowed the slack (rare).
        long grab = Math.Min(30 + 512 + e.CompressedSize, _length - e.LocalHeaderOffset);
        var buf = await RangeAsync(e.LocalHeaderOffset, grab, ct);
        if (BitConverter.ToUInt32(buf, 0) != 0x04034b50) throw new InvalidOperationException("bad local header");
        ushort fnLen = BitConverter.ToUInt16(buf, 26);
        ushort exLen = BitConverter.ToUInt16(buf, 28);
        int dataStart = 30 + fnLen + exLen;

        byte[] comp;
        if (dataStart + e.CompressedSize <= buf.Length)
            comp = buf.AsSpan(dataStart, (int)e.CompressedSize).ToArray();
        else
            comp = await RangeAsync(e.LocalHeaderOffset + dataStart, e.CompressedSize, ct);

        if (e.Method == 0) return comp;                         // stored
        if (e.Method != 8) throw new InvalidOperationException($"unsupported zip method {e.Method}");
        using var msIn = new MemoryStream(comp);
        using var inflate = new DeflateStream(msIn, CompressionMode.Decompress);
        using var msOut = new MemoryStream();
        await inflate.CopyToAsync(msOut, ct);
        return msOut.ToArray();
    }
}
