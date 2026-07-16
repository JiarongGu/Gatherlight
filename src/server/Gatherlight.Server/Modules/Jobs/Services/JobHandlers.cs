using System.Text.Json;
using System.Text.Json.Nodes;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.DataRepo.Services;
using Gatherlight.Server.Modules.Jobs.Models;
using Gatherlight.Server.Modules.Tools.Services;

namespace Gatherlight.Server.Modules.Jobs.Services;

/// <summary>Shared config parsing for handlers.</summary>
internal static class JobConfig
{
    public static JsonElement Parse(string json)
    {
        try { return JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json).RootElement.Clone(); }
        catch { return JsonDocument.Parse("{}").RootElement.Clone(); }
    }

    public static string? Str(this JsonElement el, string prop) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;
}

/// <summary>kind=tool — invoke a registered IGatherlightTool with fixed args. Zero LLM, no gate,
/// no approval. config: <c>{ "tool": "index_reindex", "args": { ... } }</c>.</summary>
public sealed class ToolJobHandler : IJobHandler
{
    private readonly IToolRegistry _tools;
    public ToolJobHandler(IToolRegistry tools) => _tools = tools;

    public string Kind => JobKind.Tool;

    public async Task<JobHandlerResult> RunAsync(JobRunContext ctx)
    {
        var cfg = JobConfig.Parse(ctx.Job.ConfigJson);
        var tool = cfg.Str("tool");
        if (string.IsNullOrWhiteSpace(tool))
            return JobHandlerResult.Failed(JobRunStatus.Failed, "job config 缺少 tool 名称", retryable: false);

        var args = cfg.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Object
            ? a : JsonDocument.Parse("{}").RootElement;

        var result = await _tools.RunAsync(tool, args, surface: null, ctx.Ct);
        var detail = result.Length > 2000 ? result[..2000] + "…" : result;
        return JobHandlerResult.Success($"工具 {tool} 执行完成", detail);
    }
}

/// <summary>kind=notify — emit a notification at the scheduled time. No agent, no tokens.
/// config: <c>{ "title": "...", "body": "...", "kind": "reminder" }</c>.</summary>
public sealed class NotifyJobHandler : IJobHandler
{
    private readonly INotificationService _notifications;
    public NotifyJobHandler(INotificationService notifications) => _notifications = notifications;

    public string Kind => JobKind.Notify;

    public async Task<JobHandlerResult> RunAsync(JobRunContext ctx)
    {
        var cfg = JobConfig.Parse(ctx.Job.ConfigJson);
        var title = cfg.Str("title") ?? ctx.Job.Name;
        var body = cfg.Str("body");
        var kind = cfg.Str("kind") ?? NotificationKind.Reminder;
        await _notifications.CreateAsync(kind, title, body, link: null, sourceJobId: ctx.Job.Id);
        return JobHandlerResult.Success("已发送通知");
    }
}

/// <summary>kind=report — a read-only agent run whose final text is saved as a browsable markdown
/// artifact (never touches the data tree). config: <c>{ "instructions": "..." }</c>.</summary>
public sealed class ReportJobHandler : IJobHandler
{
    private readonly IUnattendedRunService _runner;
    private readonly INotificationService _notifications;
    private readonly IDataContext _data;
    public ReportJobHandler(IUnattendedRunService runner, INotificationService notifications, IDataContext data)
    {
        _runner = runner;
        _notifications = notifications;
        _data = data;
    }

    public string Kind => JobKind.Report;
    public bool UsesAgentGate => true;

    public async Task<JobHandlerResult> RunAsync(JobRunContext ctx)
    {
        var instructions = JobConfig.Parse(ctx.Job.ConfigJson).Str("instructions");
        if (string.IsNullOrWhiteSpace(instructions))
            return JobHandlerResult.Failed(JobRunStatus.Failed, "job config 缺少 instructions", retryable: false);

        var r = await _runner.RunAsync(new UnattendedRunSpec
        {
            RunId = ctx.Run.Id, JobName = ctx.Job.Name, Instructions = instructions,
            ReadOnly = true, TimeoutSeconds = ctx.TimeoutSeconds,
        }, ctx.Ct);

        if (r.Deferred) return JobHandlerResult.Defer();
        if (r.TimedOut) return JobHandlerResult.Failed(JobRunStatus.Timeout, "报告任务超时", retryable: false);
        if (!r.Ok) return JobHandlerResult.Failed(JobRunStatus.Failed, r.Error ?? "报告任务失败");
        if (r.FinalText.Length == 0) return JobHandlerResult.Failed(JobRunStatus.Failed, "报告未产出内容");

        // Persist the report as a markdown artifact under state/ (survives, backed up), and keep a
        // pointer + preview in the run's detail for the UI.
        var rel = $"state/jobs/reports/{ctx.Run.Id}.md";
        var abs = Path.Combine(_data.RootPath, rel.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(abs)!);
        await File.WriteAllTextAsync(abs, r.FinalText, ctx.Ct);

        await _notifications.CreateAsync(
            NotificationKind.JobResult, $"报告已生成:{ctx.Job.Name}",
            Preview(r.FinalText), link: $"jobrun:{ctx.Run.Id}", sourceJobId: ctx.Job.Id);

        var detail = new JsonObject { ["type"] = "report", ["path"] = rel, ["chars"] = r.FinalText.Length }.ToJsonString();
        return JobHandlerResult.Success("报告已生成", detail);
    }

    private static string Preview(string text)
    {
        var line = text.Replace('\n', ' ').Trim();
        return line.Length > 140 ? line[..140] + "…" : line;
    }
}

/// <summary>kind=agent — a headless plan/execute run that may write. Per the job's auto_commit:
/// commit immediately, or stage the captured diff for later human approval. config:
/// <c>{ "instructions": "..." }</c>.</summary>
public sealed class AgentJobHandler : IJobHandler
{
    private readonly IUnattendedRunService _runner;
    private readonly INotificationService _notifications;
    private readonly IDataCommitRepository _commits;
    public AgentJobHandler(IUnattendedRunService runner, INotificationService notifications, IDataCommitRepository commits)
    {
        _runner = runner;
        _notifications = notifications;
        _commits = commits;
    }

    public string Kind => JobKind.Agent;
    public bool UsesAgentGate => true;

    public async Task<JobHandlerResult> RunAsync(JobRunContext ctx)
    {
        var instructions = JobConfig.Parse(ctx.Job.ConfigJson).Str("instructions");
        if (string.IsNullOrWhiteSpace(instructions))
            return JobHandlerResult.Failed(JobRunStatus.Failed, "job config 缺少 instructions", retryable: false);

        var r = await _runner.RunAsync(new UnattendedRunSpec
        {
            RunId = ctx.Run.Id, JobName = ctx.Job.Name, Instructions = instructions,
            ReadOnly = false, AutoCommit = ctx.Job.AutoCommit, TimeoutSeconds = ctx.TimeoutSeconds,
        }, ctx.Ct);

        if (r.Deferred) return JobHandlerResult.Defer();
        if (r.TimedOut) return JobHandlerResult.Failed(JobRunStatus.Timeout, "任务超时", retryable: false);
        if (!r.Ok) return JobHandlerResult.Failed(JobRunStatus.Failed, r.Error ?? "任务失败");
        if (r.Files.Count == 0) return JobHandlerResult.Success("完成:无文件改动");

        if (r.Committed)
        {
            _commits.Record(r.CommitSha!, $"job: {ctx.Job.Name}", "job", ctx.Job.Id);
            await _notifications.CreateAsync(
                NotificationKind.JobResult, $"定时任务已自动提交:{ctx.Job.Name}",
                $"{r.Files.Count} 个文件 · {r.CommitSha}", link: $"jobrun:{ctx.Run.Id}", sourceJobId: ctx.Job.Id);
            return JobHandlerResult.Success($"已自动提交 {r.CommitSha}({r.Files.Count} 文件)", FilesDetail(r));
        }

        // Stage-for-review: persist the patch + rendered diff; a human approves it in the same
        // diff-review UI (the working tree is already clean — see UnattendedRunService).
        var detail = new JsonObject
        {
            ["type"] = "staged",
            ["patch"] = r.Patch,
            ["files"] = new JsonArray(r.Files.Select(f => (JsonNode)new JsonObject
            {
                ["path"] = f.Path, ["status"] = f.Status, ["isClaudeInfra"] = f.IsClaudeInfra, ["diff"] = f.Diff,
            }).ToArray()),
        }.ToJsonString();
        await _notifications.CreateAsync(
            NotificationKind.JobResult, $"定时任务待审阅:{ctx.Job.Name}",
            $"{r.Files.Count} 个文件改动待你批准", link: $"jobrun:{ctx.Run.Id}", sourceJobId: ctx.Job.Id);
        return JobHandlerResult.StagedForReview($"已暂存 {r.Files.Count} 个文件待审阅", detail);
    }

    private static string FilesDetail(UnattendedResult r) =>
        new JsonObject
        {
            ["type"] = "committed",
            ["sha"] = r.CommitSha,
            ["files"] = new JsonArray(r.Files.Select(f => (JsonNode)f.Path).ToArray()),
        }.ToJsonString();
}
