using System.Text.Json;
using System.Text.Json.Nodes;
using Gatherlight.Server.Modules.Jobs.Models;
using Gatherlight.Server.Modules.Jobs.Services;
using Gatherlight.Server.Modules.Tools.Models;
using Microsoft.Extensions.DependencyInjection;

namespace Gatherlight.Server.Modules.Jobs.Tools;

// The job-management tools are themselves IGatherlightTool, so they live in the same registry the
// job execution graph (handlers → UnattendedRunService → IToolRegistry) enumerates. Taking IJobService
// in the constructor would close a DI cycle (registry → these tools → IJobService → … → registry), so
// they resolve IJobService lazily from IServiceProvider at call time. IJobService is a singleton, so
// this is a plain lookup, not a scope escape.

/// <summary>Create or update a background job. The planner uses this when the user asks for recurring
/// work ("每月分析预算并告诉我", "每周日提醒我做计划").</summary>
public sealed class JobScheduleTool : IGatherlightTool
{
    private readonly IServiceProvider _sp;
    public JobScheduleTool(IServiceProvider sp) => _sp = sp;

    public string Name => "job_schedule";

    public string Description =>
        "创建或更新一个后台定时任务(一次性或周期)。类型:agent=交给 AI 执行会改文件的任务(auto_commit=false 时改动会暂存待你审阅)、report=只读分析并生成报告、tool=调用某个确定性工具、notify=定时提醒。schedule=cron 用 cron 表达式,schedule=once 用 runAt(ISO 时间)。";

    public string InputSchema => ToolSchema.Of(b => b
        .Str("name", "任务名称", required: true)
        .Str("kind", "任务类型", required: true, options: JobKind.All)
        .Str("schedule", "调度方式", required: true, options: new[] { ScheduleKind.Once, ScheduleKind.Cron })
        .Str("cron", "cron 表达式(schedule=cron 必填,如 \"0 9 * * 1\" = 每周一 09:00;支持 5 段或含秒 6 段)")
        .Str("runAt", "一次性执行时间 ISO-8601(schedule=once 必填,如 2026-08-01T09:00:00Z)")
        .Str("timezone", "IANA 时区(cron 按此时区计算,如 Asia/Shanghai;默认 UTC)")
        .Str("instructions", "kind=agent/report:交给 AI 的任务或报告指令")
        .Str("tool", "kind=tool:要调用的工具名")
        .StrMap("toolArgs", "kind=tool:工具参数(键值均为字符串)")
        .Str("notifyTitle", "kind=notify:通知标题")
        .Str("notifyBody", "kind=notify:通知内容")
        .Bool("autoCommit", "kind=agent:true=自动提交改动,false=暂存待人工审阅(默认 false,更安全)")
        .Int("timeoutSeconds", "单次运行超时秒数(默认取全局设置)")
        .Int("maxRuns", "最多运行次数,达到后自动停用(默认不限)")
        .Str("id", "要更新的已有任务 id(留空=新建)"));

    private sealed record Args(
        string? Name, string? Kind, string? Schedule, string? Cron, string? RunAt, string? Timezone,
        string? Instructions, string? Tool, Dictionary<string, string>? ToolArgs,
        string? NotifyTitle, string? NotifyBody, bool? AutoCommit, int? TimeoutSeconds, int? MaxRuns, string? Id);

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var a = ToolArgs.Parse<Args>(args);
        var kind = ToolArgs.Req(a.Kind, "kind");
        var configJson = kind switch
        {
            JobKind.Agent or JobKind.Report => new JsonObject { ["instructions"] = a.Instructions ?? "" }.ToJsonString(),
            JobKind.Tool => new JsonObject { ["tool"] = a.Tool ?? "", ["args"] = ToObj(a.ToolArgs) }.ToJsonString(),
            JobKind.Notify => new JsonObject { ["title"] = a.NotifyTitle ?? a.Name, ["body"] = a.NotifyBody }.ToJsonString(),
            _ => "{}",
        };

        var (job, error) = await _sp.GetRequiredService<IJobService>().UpsertAsync(new JobInput
        {
            Id = a.Id,
            Name = ToolArgs.Req(a.Name, "name"),
            Kind = kind,
            ConfigJson = configJson,
            ScheduleKind = a.Schedule ?? ScheduleKind.Once,
            Cron = a.Cron,
            RunAt = a.RunAt,
            Timezone = a.Timezone,
            Enabled = true,
            AutoCommit = a.AutoCommit ?? false,
            TimeoutSeconds = a.TimeoutSeconds,
            MaxRuns = a.MaxRuns,
        });
        if (error is not null) throw new ToolException(400, error);

        return new JsonObject { ["ok"] = true, ["id"] = job!.Id, ["nextRunAt"] = job.NextRunAt }.ToJsonString();
    }

    private static JsonObject ToObj(Dictionary<string, string>? m)
    {
        var o = new JsonObject();
        if (m is not null) foreach (var kv in m) o[kv.Key] = kv.Value;
        return o;
    }
}

/// <summary>List the defined background jobs.</summary>
public sealed class JobListTool : IGatherlightTool
{
    private readonly IServiceProvider _sp;
    public JobListTool(IServiceProvider sp) => _sp = sp;

    public string Name => "job_list";
    public string Description => "列出已定义的后台定时任务(含类型、调度、启用状态、下次运行时间、上次结果)。";
    public string InputSchema => ToolSchema.Of(_ => { });

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var jobs = await _sp.GetRequiredService<IJobService>().ListAsync();
        var arr = new JsonArray();
        foreach (var jbo in jobs)
            arr.Add(new JsonObject
            {
                ["id"] = jbo.Id, ["name"] = jbo.Name, ["kind"] = jbo.Kind, ["enabled"] = jbo.Enabled,
                ["schedule"] = jbo.ScheduleKind == ScheduleKind.Cron ? $"cron {jbo.Cron}" : $"once {jbo.RunAt}",
                ["nextRunAt"] = jbo.NextRunAt, ["lastStatus"] = jbo.LastStatus, ["runCount"] = jbo.RunCount,
                ["autoCommit"] = jbo.AutoCommit,
            });
        return new JsonObject { ["jobs"] = arr }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }
}

/// <summary>Disable (default) or delete a job.</summary>
public sealed class JobCancelTool : IGatherlightTool
{
    private readonly IServiceProvider _sp;
    public JobCancelTool(IServiceProvider sp) => _sp = sp;

    public string Name => "job_cancel";
    public string Description => "停用或删除一个后台任务。默认停用(可再启用);delete=true 则彻底删除。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("id", "任务 id", required: true)
        .Bool("delete", "true=删除,false=停用(默认)"));

    private sealed record Args(string? Id, bool? Delete);

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var a = ToolArgs.Parse<Args>(args);
        var id = ToolArgs.Req(a.Id, "id");
        var jobs = _sp.GetRequiredService<IJobService>();
        var ok = (a.Delete ?? false) ? await jobs.DeleteAsync(id) : await jobs.SetEnabledAsync(id, false);
        if (!ok) throw new ToolException(404, "任务不存在");
        return new JsonObject { ["ok"] = true, ["action"] = (a.Delete ?? false) ? "deleted" : "disabled" }.ToJsonString();
    }
}

/// <summary>Run a job immediately (for testing / on-demand).</summary>
public sealed class JobRunNowTool : IGatherlightTool
{
    private readonly IServiceProvider _sp;
    public JobRunNowTool(IServiceProvider sp) => _sp = sp;

    public string Name => "job_run_now";
    public string Description => "立即运行一个后台任务(用于测试或按需触发)。";
    public string InputSchema => ToolSchema.Of(b => b.Str("id", "任务 id", required: true));

    private sealed record Args(string? Id);

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var a = ToolArgs.Parse<Args>(args);
        var (run, error) = await _sp.GetRequiredService<IJobService>().RunNowAsync(ToolArgs.Req(a.Id, "id"), ct);
        if (error is not null) throw new ToolException(409, error);
        return new JsonObject
        {
            ["ok"] = true, ["runId"] = run!.Id, ["status"] = run.Status, ["outcome"] = run.Outcome,
        }.ToJsonString();
    }
}

/// <summary>Send the user an immediate in-app / browser notification (mid-plan reminder).</summary>
public sealed class NotifyUserTool : IGatherlightTool
{
    private readonly INotificationService _notifications;
    public NotifyUserTool(INotificationService notifications) => _notifications = notifications;

    public string Name => "notify_user";
    public string Description => "立即给用户发送一条应用内/浏览器通知(如规划中需要提醒或告知某事)。这是即时通知,定时提醒请用 job_schedule(kind=notify)。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("title", "通知标题", required: true)
        .Str("body", "通知内容")
        .Str("kind", "分类", options: new[] { NotificationKind.Info, NotificationKind.Reminder }));

    private sealed record Args(string? Title, string? Body, string? Kind);

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var a = ToolArgs.Parse<Args>(args);
        var n = await _notifications.CreateAsync(a.Kind ?? NotificationKind.Info, ToolArgs.Req(a.Title, "title"), a.Body);
        return new JsonObject { ["ok"] = true, ["id"] = n.Id }.ToJsonString();
    }
}
