using Gatherlight.Server.Modules.Files.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Files;

[ApiController]
public sealed class UploadsController : ControllerBase
{
    private readonly IUploadService _uploads;

    public UploadsController(IUploadService uploads) => _uploads = uploads;

    /// <summary>Attachment upload (multipart field `files`) — saves PDFs/images and returns
    /// the refs the frontend passes back into /api/chat.</summary>
    [HttpPost("api/uploads")]
    [RequestSizeLimit(300 * 1024 * 1024)]
    public async Task<IActionResult> Upload(CancellationToken ct)
    {
        if (!Request.HasFormContentType)
            return BadRequest(new { error = "上传失败:需要 multipart/form-data。" });
        var form = await Request.ReadFormAsync(ct);
        var files = form.Files.ToList();
        if (files.Count == 0)
            return BadRequest(new { error = "没有收到文件(仅支持 PDF / 图片)。" });
        if (files.Count > _uploads.MaxFiles)
            return BadRequest(new { error = $"一次最多上传 {_uploads.MaxFiles} 个文件。" });

        var saved = new List<UploadedFile>();
        foreach (var file in files)
        {
            if (!_uploads.IsAccepted(file.ContentType))
                return BadRequest(new { error = $"不支持的文件类型:{file.ContentType}(仅限 PDF / 图片)" });
            if (file.Length > _uploads.MaxFileBytes)
                return BadRequest(new { error = $"文件过大:{file.FileName}(上限 25 MB)" });
            saved.Add(await _uploads.SaveAsync(file, ct));
        }
        return Ok(new { files = saved });
    }
}
