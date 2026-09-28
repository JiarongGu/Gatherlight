using System.Text.Json;
using System.Text.Json.Nodes;
using Gatherlight.Server.Platform.Agent.Llm.Models;
using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Capabilities.Tools.Models;
using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Site.Services;

namespace Gatherlight.Server.Platform.Capabilities.Tools.Services.Tools;

/// <summary>
/// Scoped filesystem tools for the agent — MOVE/RENAME and DELETE of ONE FILE within the write scope, plus a
/// read-only size/mtime probe. Platform, not Product: they operate on whatever the site manifest declares, not on
/// "plans" by name, so a different site keeps them.
///
/// <para><b>Why these exist.</b> The agent's shell (Bash) is the household's only when a real Git Bash is
/// present; on an install without one there is no shell at all (PowerShell and Monitor are removed from every
/// run), so moving, renaming or deleting a plan file — which the household does routinely — needs a tool. A
/// tool is better than a shell for exactly this: its scope is the SAME <c>ISiteWriteScope</c> the guard draws
/// for Edit/Write, every call lands in the audit trail (<c>AgentRunner.ToolDetail</c>), and the change shows
/// at the diff gate as a working-tree change — none of which raw <c>mv</c>/<c>rm</c> gives.</para>
///
/// <para><b>Files only, never a folder</b> (round-6 review). The diff gate is file-level — <c>BuildDiffAsync</c>
/// reviews files, <c>CommitPathsAsync</c> stages files, <c>RestorePathsAsync</c> restores and deletes files — and
/// <c>EditTracker</c> records each operand as ONE path, so a moved folder reached the gate as one entry nobody could
/// review, commit or undo. A folder operand was also the escape: <c>.claude</c> moved out, <c>settings.json</c>
/// rewritten inside the copy, moved back — a hook file the agent may never write, loaded by the next agent run and
/// left behind by Reject. So both operands must be files, a write-dir ROOT (<c>plans</c>, <c>.claude</c>…) is
/// refused by name, and the write scope itself refuses a path CONTAINING a protected entry.</para>
///
/// <para><b>Write runs only, MCP only.</b> The mutating two refuse unless an execute run is in flight
/// (<see cref="IAgentRunScope.WritesAllowed"/>) — a plan run is read-only, and a `--settings`-less plan run
/// registers no guard, so the tools must gate themselves. <c>ToolRegistry.McpAllowedToolNames(writable:false)</c>
/// also keeps a real CLI from offering them in a plan run; and they are exposed on the MCP surface only, since the
/// HTTP surface is never inside an agent run. The change is NOT committed here — <c>AgentRunner</c> records the
/// touched paths into the run's <c>EditTracker</c>, so the diff gate reviews and commits it like any Edit/Write.</para>
/// </summary>
public sealed class FsMoveTool : IGatherlightTool, IWriteScopedTool
{
    /// <summary>The refusal a folder operand gets — one sentence, shared by both tools and by the tool contract.</summary>
    public const string FileOnly = "一次只能移动或删除一个文件;要整理文件夹,请逐个移动其中的文件。";

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
        "移动或重命名一个文件(限计划与知识库的可写范围内)。一次只处理一个文件:文件夹不能整体移动 —— 要整理文件夹,请逐个移动其中的文件。"
        + "改动会出现在改动审阅里,由人确认后再提交 —— 不会立即落库。默认不覆盖已存在的目标文件(overwrite:true 才覆盖)。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("from", "源文件路径(数据目录相对,如 plans/trips/old.md)", required: true)
        .Str("to", "目标文件路径(数据目录相对,同一可写范围内)", required: true)
        .Bool("overwrite", "目标文件已存在时是否覆盖(默认 false)"));
    public IReadOnlyList<string>? Surfaces => ["mcp"];

    public Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        if (!_run.WritesAllowed)
            throw new ToolException(403, "移动/重命名只在「执行」阶段可用 —— 计划(只读)阶段不能改动文件。");

        var fromRel = ToolArgs.Req(args, "from");
        var toRel = ToolArgs.Req(args, "to");
        var overwrite = args.TryGetProperty("overwrite", out var o) && o.ValueKind == JsonValueKind.True;

        var fromAbs = _scope.Resolve(fromRel, out var fromWhy) ?? throw new ToolException(400, fromWhy!);
        var toAbs = _scope.Resolve(toRel, out var toWhy) ?? throw new ToolException(400, toWhy!);
        RefuseRoot(_site, _scope, fromAbs);
        RefuseRoot(_site, _scope, toAbs);

        if (Directory.Exists(fromAbs)) throw new ToolException(400, $"\"{Norm(fromRel)}\" 是一个文件夹。{FileOnly}");
        if (!File.Exists(fromAbs)) throw new ToolException(400, $"源不存在:{fromRel}");
        if (!ReparseGuard.NoSymlinkEscape(fromAbs, _site.RootPath))
            throw new ToolException(400, $"源路径经由符号链接指向范围外:{fromRel}");

        if (Directory.Exists(toAbs)) throw new ToolException(400, $"目标 \"{Norm(toRel)}\" 是一个文件夹。{FileOnly}");
        if (File.Exists(toAbs) && !overwrite)
            throw new ToolException(409, $"目标已存在:{toRel} —— 要覆盖请传 overwrite:true。");
        // Checked whether or not the target exists: a target that does not exist yet can still sit under a
        // symlinked or junctioned PARENT, and the move would then write outside the data folder. The check used to
        // run only for an existing target.
        if (!ReparseGuard.NoSymlinkEscape(toAbs, _site.RootPath))
            throw new ToolException(400, $"目标路径经由符号链接指向范围外:{toRel}");

        Directory.CreateDirectory(Path.GetDirectoryName(toAbs)!);
        File.Move(fromAbs, toAbs, overwrite);

        return Task.FromResult(new JsonObject
        {
            ["moved"] = true,
            ["from"] = Norm(fromRel),
            ["to"] = Norm(toRel),
            ["note"] = "已在工作区移动,改动会出现在改动审阅里,提交后生效。",
        }.ToJsonString());
    }

    internal static string Norm(string rel) => rel.Replace('\\', '/').Trim().TrimEnd('/');

    /// <summary>A write-dir ROOT — <c>plans</c>, <c>household</c>, <c>.claude</c>, the UI dir — is no operand. It is a
    /// folder, so <see cref="FileOnly"/> would refuse it anyway, but it is named so a household reads which rule it
    /// hit, and it holds where the root does not exist yet (a move whose TARGET is <c>household</c> would otherwise
    /// create a FILE of that name). Compared on the RESOLVED path, so every spelling Windows folds is covered.</summary>
    internal static void RefuseRoot(ISiteContext site, ISiteWriteScope scope, string abs)
    {
        var rel = Path.GetRelativePath(site.RootPath, abs).Replace('\\', '/');
        if (scope.WriteDirs.Any(d => string.Equals(d, rel, StringComparison.OrdinalIgnoreCase)))
            throw new ToolException(400, $"\"{rel}\" 是可写范围的根目录,不能整体移动或删除。");
    }
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
        "删除一个文件(限计划与知识库的可写范围内)。一次只处理一个文件:文件夹不能整体删除 —— 要清理文件夹,请逐个删除其中的文件。"
        + "改动会出现在改动审阅里,由人确认后再提交 —— 不会立即落库。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("path", "要删除的文件路径(数据目录相对,如 plans/drafts/old.md)", required: true));
    public IReadOnlyList<string>? Surfaces => ["mcp"];

    public Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        if (!_run.WritesAllowed)
            throw new ToolException(403, "删除只在「执行」阶段可用 —— 计划(只读)阶段不能改动文件。");

        var rel = ToolArgs.Req(args, "path");
        var abs = _scope.Resolve(rel, out var why) ?? throw new ToolException(400, why!);
        FsMoveTool.RefuseRoot(_site, _scope, abs);
        if (Directory.Exists(abs)) throw new ToolException(400, $"\"{FsMoveTool.Norm(rel)}\" 是一个文件夹。{FsMoveTool.FileOnly}");
        if (!File.Exists(abs)) throw new ToolException(400, $"不存在:{rel}");
        if (!ReparseGuard.NoSymlinkEscape(abs, _site.RootPath))
            throw new ToolException(400, $"路径经由符号链接指向范围外:{rel}");
        File.Delete(abs);

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
