using Gatherlight.Server.Platform.Storage.Library.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Platform.Capabilities.Documents;

/// <summary>
/// The one same-origin door for every remote image the app renders — library covers, map tiles, an
/// <c>Image</c> node's https src, and a picture in plan markdown.
///
/// It exists so <c>img-src</c> can be <c>'self' data: blob:</c> instead of <c>https:</c>. With
/// <c>https:</c> allowed, any URL that reached a rendered page caused the HOUSEHOLD'S BROWSER to
/// call that host directly — leaking their IP and the fact they were reading, on render, with no
/// record anywhere. That was the documented remote-image residual, and it was reachable from agent
/// text, since a page or a plan can carry an image URL.
///
/// Routing through here does not make an arbitrary URL safe to fetch; it moves the fetch to the
/// server, where <see cref="ImageCache"/> already applies the SSRF guard, an image-content-type
/// check, a size cap and a disk cache — the same treatment library covers have had all along, and an
/// egress path we can see. What it removes is the browser's ability to be pointed anywhere.
/// </summary>
[ApiController]
public sealed class ImageProxyController : ControllerBase
{
    // The basemap. Pinned HERE rather than taken from the caller: a tile request carries only three
    // integers, so nothing an agent (or a page, or a plan) writes reaches the outbound URL at all.
    private const string TileHost = "a.basemaps.cartocdn.com";
    private const int MaxZoom = 19;

    private readonly IImageCache _images;

    public ImageProxyController(IImageCache images) => _images = images;

    /// <summary>A remote image, fetched and cached server-side.</summary>
    [HttpGet("api/img")]
    public async Task<IActionResult> Image([FromQuery] string url, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(url)) return BadRequest(new { error = "url is required" });
        var img = await _images.GetAsync(url, ct);
        if (img is null) return NotFound();
        Response.Headers.CacheControl = "public, max-age=604800";
        return File(img.Bytes, img.ContentType);
    }

    /// <summary>
    /// One basemap tile. The upstream URL is built from three bounded integers and a pinned host, so
    /// this is a proxy for exactly one thing and can never be aimed somewhere else — which is what
    /// makes it safe to keep working after the CSP tightens.
    /// </summary>
    [HttpGet("api/img/tile/{z:int}/{x:int}/{y:int}")]
    public async Task<IActionResult> Tile(int z, int x, int y, CancellationToken ct)
    {
        if (z < 0 || z > MaxZoom) return NotFound();
        var span = 1L << z;                       // tiles per axis at this zoom
        if (x < 0 || y < 0 || x >= span || y >= span) return NotFound();

        var img = await _images.GetAsync($"https://{TileHost}/rastertiles/voyager/{z}/{x}/{y}.png", ct);
        if (img is null) return NotFound();
        // Tiles are immutable for a given z/x/y — cache hard, so a map pan is not a burst of fetches.
        Response.Headers.CacheControl = "public, max-age=2592000, immutable";
        return File(img.Bytes, img.ContentType);
    }
}
