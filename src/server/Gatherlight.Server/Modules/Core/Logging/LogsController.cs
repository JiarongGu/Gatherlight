using System.Text;
using Gatherlight.Server.Modules.Core.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Core.Logging;

/// <summary>
/// Read the app's file logs from the management console — the newest daily file tailed to the last N
/// lines, plus the list of available files. Read-only; the files live in <c>{data}/state/logs</c>.
/// </summary>
[ApiController]
public sealed class LogsController : ControllerBase
{
    private readonly IDataContext _data;
    public LogsController(IDataContext data) => _data = data;

    [HttpGet("api/manage/logs")]
    public IActionResult Get([FromQuery] int lines = 400, [FromQuery] string? file = null)
    {
        var dir = _data.LogsPath;
        var files = Directory.Exists(dir)
            ? Directory.GetFiles(dir, "*.log").Select(f => Path.GetFileName(f)!).OrderByDescending(f => f).ToList()
            : new List<string>();
        // Only serve a filename from this dir (no traversal); default to the newest.
        var target = file is { Length: > 0 } && files.Contains(file) ? file : files.FirstOrDefault();

        var tail = new List<string>();
        if (target is not null)
        {
            try { tail = TailLines(Path.Combine(dir, target), Math.Clamp(lines, 20, 3000)); }
            catch (Exception ex) { tail = new List<string> { $"(无法读取日志 / cannot read log: {ex.Message})" }; }
        }
        return Ok(new { dir, files, file = target, lines = tail });
    }

    /// <summary>Last <paramref name="n"/> physical lines — reads at most the trailing 512 KB (logs can
    /// grow), sharing the file with the live writer.</summary>
    private static List<string> TailLines(string path, int n)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var take = Math.Min(fs.Length, 512 * 1024);
        fs.Seek(-take, SeekOrigin.End);
        using var sr = new StreamReader(fs, Encoding.UTF8);
        var text = sr.ReadToEnd();
        var arr = text.Replace("\r\n", "\n").Split('\n');
        // If we seeked into the middle of a line, drop the first (partial) one.
        var skip = take < fs.Length ? 1 : 0;
        return arr.Skip(skip).SkipLast(arr.Length > 0 && arr[^1].Length == 0 ? 1 : 0)
                  .TakeLast(n).ToList();
    }
}
