using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.Formats.Png;
using SixLabors.ImageSharp.Formats.Webp;
using SixLabors.ImageSharp.Processing;

namespace Gatherlight.Server.Modules.Documents.Services;

public sealed record ImageInfo(string Format, int Width, int Height, int BitsPerPixel);

/// <summary>
/// General image processing via ImageSharp (pinned 3.1.x = Apache-2.0). Add an operation = a
/// method here + a tool. All ops auto-orient from EXIF so rotated phone photos come out upright.
/// </summary>
public interface IImageProcessor
{
    ImageInfo Info(string absPath);
    /// <summary>Resize to fit within maxW×maxH (aspect preserved, never upscales). Format inferred
    /// from the output extension. Returns the new dimensions.</summary>
    (int Width, int Height) Resize(string absPath, string outAbs, int maxW, int maxH);
    /// <summary>Re-encode to png / jpeg / webp (by <paramref name="format"/> or the out extension).</summary>
    void Convert(string absPath, string outAbs, string? format, int quality);
}

public sealed class ImageProcessor : IImageProcessor
{
    public ImageInfo Info(string absPath)
    {
        var info = Image.Identify(absPath);
        return new ImageInfo(
            info.Metadata.DecodedImageFormat?.Name ?? "unknown",
            info.Width, info.Height, info.PixelType.BitsPerPixel);
    }

    public (int, int) Resize(string absPath, string outAbs, int maxW, int maxH)
    {
        using var image = Image.Load(absPath);
        image.Mutate(x => x.AutoOrient());
        if (image.Width > maxW || image.Height > maxH)
        {
            image.Mutate(x => x.Resize(new ResizeOptions
            {
                Size = new Size(Math.Max(1, maxW), Math.Max(1, maxH)),
                Mode = ResizeMode.Max, // fit inside the box, keep aspect, no upscale
            }));
        }
        Directory.CreateDirectory(Path.GetDirectoryName(outAbs)!);
        image.Save(outAbs);
        return (image.Width, image.Height);
    }

    public void Convert(string absPath, string outAbs, string? format, int quality)
    {
        using var image = Image.Load(absPath);
        image.Mutate(x => x.AutoOrient());
        Directory.CreateDirectory(Path.GetDirectoryName(outAbs)!);
        var fmt = (format ?? Path.GetExtension(outAbs).TrimStart('.')).ToLowerInvariant();
        var q = Math.Clamp(quality, 1, 100);
        switch (fmt)
        {
            case "png": image.Save(outAbs, new PngEncoder()); break;
            case "webp": image.Save(outAbs, new WebpEncoder { Quality = q }); break;
            case "jpg" or "jpeg": image.Save(outAbs, new JpegEncoder { Quality = q }); break;
            default: throw new ArgumentException($"unsupported image format: {fmt} (png/jpeg/webp)");
        }
    }
}
