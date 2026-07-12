using System.Text.RegularExpressions;
using Dapper;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.Files.Services;

/// <summary>The server-side reference the frontend holds + passes back into /api/chat.
/// Field names match the legacy viewer wire shape (name/relPath/size/type).</summary>
public sealed record UploadedFile(string Name, string RelPath, long Size, string Type);

/// <summary>
/// Chat attachment storage. Uploaded PDFs/images land under {data}/uploads/ (inside the data
/// folder so the spawned agent — cwd = data root — Reads them by relative path; the data repo's
/// .gitignore keeps them out of the audit trail). Write-once here, validated on the way back in
/// (<see cref="ResolveAttachment"/>) so a crafted attachments value can't point the agent at an
/// arbitrary file.
/// </summary>
public interface IUploadService
{
    long MaxFileBytes { get; }
    int MaxFiles { get; }
    bool IsAccepted(string contentType);
    Task<UploadedFile> SaveAsync(IFormFile file, CancellationToken ct = default);
    /// <summary>Validate an attachment ref and return the canonical data-root-relative path.
    /// Throws ArgumentException when the path escapes uploads/ or no longer exists.</summary>
    string ResolveAttachment(string rawRelPath);
}

public sealed partial class UploadService : IUploadService
{
    private readonly IDataContext _data;
    private readonly IDbConnectionFactory _db;

    public UploadService(IDataContext data, IDbConnectionFactory db)
    {
        _data = data;
        _db = db;
    }

    public long MaxFileBytes => 25 * 1024 * 1024; // comfortable for scanned PDFs
    public int MaxFiles => 10;

    public bool IsAccepted(string contentType) =>
        contentType == "application/pdf" || contentType.StartsWith("image/");

    public async Task<UploadedFile> SaveAsync(IFormFile file, CancellationToken ct = default)
    {
        var display = file.FileName.Normalize(System.Text.NormalizationForm.FormC);
        var diskName = $"{UniqueId()}-{SafeDiskName(display)}";
        var abs = Path.Combine(_data.UploadsPath, diskName);
        await using (var stream = File.Create(abs))
        {
            await file.CopyToAsync(stream, ct);
        }
        var rel = _data.ToRelativePath(abs)!;

        using var conn = _db.Open();
        await conn.ExecuteAsync(
            "INSERT INTO upload(id, rel_path, original_name, mime, size_bytes, created_at) " +
            "VALUES (@id, @rel, @name, @mime, @size, @now)",
            new
            {
                id = diskName, rel, name = display, mime = file.ContentType,
                size = file.Length, now = DateTime.UtcNow.ToString("o"),
            });

        return new UploadedFile(display, rel, file.Length, file.ContentType);
    }

    public string ResolveAttachment(string rawRelPath)
    {
        var abs = _data.ResolveDataPath(rawRelPath)
            ?? throw new ArgumentException($"附件路径非法:{rawRelPath}");
        var uploadsWithSep = _data.UploadsPath.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!Path.GetFullPath(abs).StartsWith(uploadsWithSep, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException($"附件路径非法(不在上传目录内):{rawRelPath}");
        if (!File.Exists(abs))
            throw new ArgumentException($"附件不存在或已过期:{rawRelPath}");
        return _data.ToRelativePath(abs)!;
    }

    /// <summary>Make a display name safe on disk (keeps the extension, caps length at the tail).</summary>
    private static string SafeDiskName(string name)
    {
        var cleaned = IllegalChars().Replace(name, "_");
        cleaned = Whitespace().Replace(cleaned, "_").TrimStart('.');
        if (cleaned.Length > 80) cleaned = cleaned[^80..];
        return cleaned.Length > 0 ? cleaned : "file";
    }

    private static string UniqueId() =>
        $"{DateTime.UtcNow.Ticks:x}-{Random.Shared.Next(0x100000, 0xFFFFFF):x}";

    [GeneratedRegex("""[/\\?%*:|"<>\x00-\x1f]""")]
    private static partial Regex IllegalChars();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();
}
