using System.Text.Json;
using System.Text.Json.Nodes;
using Gatherlight.Server.Platform.Agent.Llm.Models;
using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Capabilities.Tools.Models;
using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Site.Services;

namespace Gatherlight.Server.Platform.Capabilities.Tools.Services.Tools;

/// <summary>
/// Scoped filesystem tools for the agent — MOVE/RENAME and DELETE within the write scope, plus a read-only
/// size/mtime probe. Platform, not Product: they operate on whatever the site manifest declares, not on
/// "plans" by name, so a different site keeps them.
///
/// <para><b>Why these exist.</b> The agent's shell (Bash) is the household's only when a real Git Bash is
/// present; on an install without one there is no shell at all (PowerShell and Monitor are removed from every
/// run), so moving, renaming or deleting a plan file — which the household does routinely — needs a tool. A
/// tool is better than a shell for exactly this: its scope is the SAME <c>ISiteWriteScope</c> the guard draws
/// for Edit/Write, every call lands in the audit trail (<c>AgentRunner.ToolDetail</c>), and the change shows
/// at the diff gate as a working-tree change — none of which raw <c>mv</c>/<c>rm</c> gives.</para>
///
/// <para><b>Write runs only.</b> The mutating two refuse unless an execute run is in flight
/// (<see cref="IAgentRunScope.WritesAllowed"/>) — a plan run is read-only, and a `--settings`-less plan run
/// registers no guard, so the tools must gate themselves. <c>ToolRegistry.McpAllowedToolNames(writable:false)</c>
/// also keeps a real CLI from offering them in a plan run; this is the enforcement a fake CLI cannot bypass.
/// The change is NOT committed here — <c>AgentRunner</c> records the touched paths into the run's
/// <c>EditTracker</c>, so the diff gate reviews and commits it like any Edit/Write.</para>
/// </summary>
public sealed class FsMoveTool : IGatherlightTool, IWriteScopedTool
{
    private readonly ISiteContext _site;
    private readonly ISiteWriteScope _scope;
    private readonly IAgentRunScope _run;

    public FsMoveTool(ISiteContext site, ISiteWriteScope scope, IAgentRunScope run)
    {
        _site = site;
        _scope = scope;
        _run = run;
    }

    public string Name => AgentFileTools.Move;
    public string Description =>
        "移动或重命名一个文件/文件夹(限计划与知识库的可写范围内)。改动会出现在改动审阅里,由人确认后再提交 —— "
        + "不会立即落库。默认不覆盖已存在的目标(overwrite:true 才覆盖)。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("from", "源路径(数据目录相对,如 plans/trips/old.md)", required: true)
        .Str("to", "目标路径(数据目录相对,同一可写范围内)", required: true)
        .Bool("overwrite", "目标已存在时是否覆盖(默认 false)"));

    public Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        if (!_run.WritesAllowed)
            throw new ToolException(403, "移动/重命名只在「执行」阶段可用 —— 计划(只读)阶段不能改动文件。");

        var fromRel = ToolArgs.Req(args, "from");
        var toRel = ToolArgs.Req(args, "to");
        var overwrite = args.TryGetProperty("overwrite", out var o) && o.ValueKind == JsonValueKind.True;

        var fromAbs = _scope.Resolve(fromRel, out var fromWhy) ?? throw new ToolException(400, fromWhy!);
        var toAbs = _scope.Resolve(toRel, out var toWhy) ?? throw new ToolException(400, toWhy!);

        var isFile = File.Exists(fromAbs);
        var isDir = Directory.Exists(fromAbs);
        if (!isFile && !isDir) throw new ToolException(400, $"源不存在:{fromRel}");
        if (!ReparseGuard.NoSymlinkEscape(fromAbs, _site.RootPath))
            throw new ToolException(400, $"源路径经由符号链接指向范围外:{fromRel}");

        var targetExists = File.Exists(toAbs) || Directory.Exists(toAbs);
        if (targetExists && !overwrite)
            throw new ToolException(409, $"目标已存在:{toRel} —— 要覆盖请传 overwrite:true。");
        if (targetExists && !ReparseGuard.NoSymlinkEscape(toAbs, _site.RootPath))
            throw new ToolException(400, $"目标路径经由符号链接指向范围外:{toRel}");

        Directory.CreateDirectory(Path.GetDirectoryName(toAbs)!);
        if (targetExists)
        {
            if (File.Exists(toAbs)) File.Delete(toAbs);
            else Directory.Delete(toAbs, recursive: true);
        }
        if (isFile) File.Move(fromAbs, toAbs);
        else Directory.Move(fromAbs, toAbs);

        return Task.FromResult(new JsonObject
        {
            ["moved"] = true,
            ["from"] = Norm(fromRel),
            ["to"] = Norm(toRel),
            ["note"] = "已在工作区移动,改动会出现在改动审阅里,提交后生效。",
        }.ToJsonString());
    }

    internal static string Norm(string rel) => rel.Replace('\\', '/').Trim().TrimEnd('/');
}

public sealed class FsDeleteTool : IGatherlightTool, IWriteScopedTool
{
    private readonly ISiteContext _site;
    private readonly ISiteWriteScope _scope;
    private readonly IAgentRunScope _run;

    public FsDeleteTool(ISiteContext site, ISiteWriteScope scope, IAgentRunScope run)
    {
        _site = site;
        _scope = scope;
        _run = run;
    }

    public string Name => AgentFileTools.Delete;
    public string Description =>
        "删除一个文件/文件夹(限计划与知识库的可写范围内)。改动会出现在改动审阅里,由人确认后再提交 —— 不会立即落库。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("path", "要删除的路径(数据目录相对,如 plans/drafts/old.md)", required: true));

    public Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        if (!_run.WritesAllowed)
            throw new ToolException(403, "删除只在「执行」阶段可用 —— 计划(只读)阶段不能改动文件。");

        var rel = ToolArgs.Req(args, "path");
        var abs = _scope.Resolve(rel, out var why) ?? throw new ToolException(400, why!);
        if (!ReparseGuard.NoSymlinkEscape(abs, _site.RootPath))
            throw new ToolException(400, $"路径经由符号链接指向范围外:{rel}");

        var isFile = File.Exists(abs);
        var isDir = Directory.Exists(abs);
        if (!isFile && !isDir) throw new ToolException(400, $"不存在:{rel}");
        if (isFile) File.Delete(abs);
        else Directory.Delete(abs, recursive: true);

        return Task.FromResult(new JsonObject
        {
            ["deleted"] = FsMoveTool.Norm(rel),
            ["note"] = "已在工作区删除,改动会出现在改动审阅里,提交后生效。",
        }.ToJsonString());
    }
}

/// <summary>
/// Read-only size + mtime of a path inside the READ jail (the whole data folder minus <c>state/</c>, via
/// <c>ResolveSitePath</c>) — so the KB's <c>/cleanup</c> skill can inspect a scratch file's size/age without
/// reaching for <c>ls -l</c>. Available in any run: it writes nothing.
/// </summary>
public sealed class FsInfoTool : IGatherlightTool
{
    private readonly ISiteContext _site;

    public FsInfoTool(ISiteContext site) => _site = site;

    public string Name => AgentFileTools.Info;
    public string Description =>
        "查看一个路径的大小和最后修改时间(数据目录相对,只读)。用来替代 ls -l / stat。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("path", "要查看的路径(数据目录相对)", required: true));

    public Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var rel = ToolArgs.Req(args, "path");
        var abs = _site.ResolveSitePath(rel) ?? throw new ToolException(400, $"路径越界:{rel}");
        if (!ReparseGuard.NoSymlinkEscape(abs, _site.RootPath))
            throw new ToolException(400, $"路径经由符号链接指向范围外:{rel}");

        var isFile = File.Exists(abs);
        var isDir = Directory.Exists(abs);
        if (!isFile && !isDir)
            return Task.FromResult(new JsonObject { ["path"] = FsMoveTool.Norm(rel), ["exists"] = false }.ToJsonString());

        var obj = new JsonObject { ["path"] = FsMoveTool.Norm(rel), ["exists"] = true, ["isDir"] = isDir };
        if (isFile)
        {
            var fi = new FileInfo(abs);
            obj["bytes"] = fi.Length;
            obj["modified"] = fi.LastWriteTimeUtc.ToString("o");
        }
        else
        {
            var di = new DirectoryInfo(abs);
            obj["entries"] = di.EnumerateFileSystemInfos().Count();
            obj["modified"] = di.LastWriteTimeUtc.ToString("o");
        }
        return Task.FromResult(obj.ToJsonString());
    }
}
