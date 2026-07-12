using System.Text.Json;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Files.Services;
using Gatherlight.Server.Modules.Llm.Services;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Tools.Services.Tools;

/// <summary>
/// Reference Claude-backed tool: a one-shot, read-only pass over an uploaded file. Runs from a
/// neutral cwd with the file's absolute path so the knowledge base is NOT loaded — a simple
/// extraction must not pay the planner-gate token cost.
/// </summary>
public sealed class ExtractTool : IGatherlightTool
{
    private readonly IClaudeCliRunner _runner;
    private readonly IPromptHarness _harness;
    private readonly IUploadService _uploads;
    private readonly IDataContext _data;
    private readonly IAppConfigService _appConfig;

    public ExtractTool(
        IClaudeCliRunner runner, IPromptHarness harness, IUploadService uploads,
        IDataContext data, IAppConfigService appConfig)
    {
        _runner = runner;
        _harness = harness;
        _uploads = uploads;
        _data = data;
        _appConfig = appConfig;
    }

    public string Name => "extract";

    public string Description =>
        "读取上传的文件(PDF/图片),按指令提取或总结内容,返回文本结果(默认:结构化关键信息摘要)。只读,不修改任何文件。";

    public string InputSchema => ToolSchema.Of(b => b
        .Str("relPath", "上传文件的引用(来自 /api/uploads,位于 uploads/ 下)", required: true)
        .Str("instruction", "要提取或执行的内容;省略则输出该文件的结构化关键信息摘要"));

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        string relPath;
        try
        {
            relPath = _uploads.ResolveAttachment(args.GetProperty("relPath").GetString() ?? "");
        }
        catch (ArgumentException ex)
        {
            throw new ToolException(400, ex.Message);
        }
        var absPath = _data.ResolveDataPath(relPath)!;
        var instruction = args.TryGetProperty("instruction", out var i) && i.GetString() is { Length: > 0 } s
            ? s
            : "读取该文件,提取其中的关键信息,整理成简洁清晰的结构化摘要(用简体中文)。";

        var res = await _runner.RunAsync(new ClaudeRunOptions
        {
            Prompt = _harness.ProcessFilePrompt(absPath, instruction),
            Cwd = Path.GetTempPath(), // neutral: no CLAUDE.md / knowledge-base load
            ReadOnly = true,
            Model = _appConfig.Get("llm.model.extract") ?? "sonnet",
            OnEvent = _ => { }, // sync caller: only the final text matters
        }, ct);

        var outText = res.FinalText.Trim();
        if (outText.Length == 0)
            throw new ToolException(500, "处理没有产出内容(文件可能无法读取或为空)。");
        return outText;
    }
}
