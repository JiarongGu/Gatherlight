using System.Text.Json;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Jobs.Models;
using Gatherlight.Server.Modules.Jobs.Services;
using Gatherlight.Server.Modules.Tools.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Jobs;

public sealed record JobUpsertRequest(
    string? Id, string? Name, string? Kind, JsonElement Config,
    string? Schedule, string? Cron, string? RunAt, string? Timezone,
    bool? Enabled, bool? AutoCommit, int? TimeoutSeconds, int? MaxRuns);

public sealed record EnabledRequest(bool Enabled);
public sealed record JobsSettingsRequest(bool? Enabled, int? PollSeconds, int? CatchUpGraceHours, int? DefaultTimeoutSeconds, int? MaxConsecutiveFailures);

/// <summary>REST surface for the background-jobs console panel: list/create/update/enable/delete,
/// run-now, run history, staged-diff approve/reject, and the global scheduler settings (kill-switch).</summary>
[ApiController]
public sealed class JobsController : ControllerBase
{
    private readonly IJobService _jobs;
    private readonly IJobRepository _repo;
    private readonly ServerConfigService _config;
    private readonly IToolRegistry _tools;
    private readonly IDataContext _data;

    public JobsController(IJobService jobs, IJobRepository repo, ServerConfigService config, IToolRegistry tools, IDataContext data)
    {
        _jobs = jobs;
        _repo = repo;
        _config = config;
        _tools = tools;
        _data = data;
    }

    /// <summary>Metadata the create/edit form needs: the job kinds + tool names for tool-jobs.</summary>
    [HttpGet("api/jobs/meta")]
    public IActionResult Meta() => Ok(new
    {
        kinds = JobKind.All,
        tools = _tools.List("http").Select(t => new { t.Name, t.Description }),
        settings = _config.Current.Jobs,
    });

    [HttpGet("api/jobs")]
    public async Task<IActionResult> List() => Ok(new { jobs = await _jobs.ListAsync(), settings = _config.Current.Jobs });

    [HttpGet("api/jobs/{id}")]
    public async Task<IActionResult> Get(string id)
    {
        var job = await _jobs.GetAsync(id);
        if (job is null) return NotFound(new { error = "任务不存在" });
        return Ok(new { job, runs = await _jobs.RunsAsync(id, 20) });
    }

    [HttpPost("api/jobs")]
    public async Task<IActionResult> Upsert([FromBody] JobUpsertRequest req)
    {
        var input = new JobInput
        {
            Id = req.Id,
            Name = req.Name ?? "",
            Kind = req.Kind ?? "",
            ConfigJson = req.Config.ValueKind == JsonValueKind.Object ? req.Config.GetRawText()
                       : req.Config.ValueKind == JsonValueKind.String ? (req.Config.GetString() ?? "{}") : "{}",
            ScheduleKind = req.Schedule ?? ScheduleKind.Once,
            Cron = req.Cron,
            RunAt = req.RunAt,
            Timezone = req.Timezone,
            Enabled = req.Enabled ?? true,
            AutoCommit = req.AutoCommit ?? false,
            TimeoutSeconds = req.TimeoutSeconds,
            MaxRuns = req.MaxRuns,
        };
        var (job, error) = await _jobs.UpsertAsync(input);
        return error is not null ? BadRequest(new { error }) : Ok(new { job });
    }

    [HttpPut("api/jobs/{id}/enabled")]
    public async Task<IActionResult> SetEnabled(string id, [FromBody] EnabledRequest req) =>
        await _jobs.SetEnabledAsync(id, req.Enabled) ? Ok(new { ok = true }) : NotFound(new { error = "任务不存在" });

    [HttpDelete("api/jobs/{id}")]
    public async Task<IActionResult> Delete(string id) =>
        await _jobs.DeleteAsync(id) ? Ok(new { ok = true }) : NotFound(new { error = "任务不存在" });

    [HttpPost("api/jobs/{id}/run")]
    public async Task<IActionResult> RunNow(string id, CancellationToken ct)
    {
        var (run, error) = await _jobs.RunNowAsync(id, ct);
        return error is not null ? BadRequest(new { error }) : Ok(new { run });
    }

    [HttpGet("api/jobs/{id}/runs")]
    public async Task<IActionResult> Runs(string id, [FromQuery] int limit = 30) =>
        Ok(new { runs = await _jobs.RunsAsync(id, limit) });

    [HttpGet("api/jobs/runs/{runId}")]
    public async Task<IActionResult> Run(string runId)
    {
        var run = await _repo.GetRunAsync(runId);
        return run is null ? NotFound(new { error = "运行记录不存在" }) : Ok(new { run });
    }

    /// <summary>The saved markdown of a report-job run.</summary>
    [HttpGet("api/jobs/runs/{runId}/report")]
    public async Task<IActionResult> Report(string runId)
    {
        var run = await _repo.GetRunAsync(runId);
        if (run?.Detail is null) return NotFound(new { error = "无报告" });
        var rel = $"state/jobs/reports/{runId}.md";
        var abs = _data.ResolveDataPath(rel);
        if (abs is null || !System.IO.File.Exists(abs)) return NotFound(new { error = "报告文件不存在" });
        return Ok(new { markdown = await System.IO.File.ReadAllTextAsync(abs) });
    }

    [HttpPost("api/jobs/runs/{runId}/approve")]
    public async Task<IActionResult> Approve(string runId, CancellationToken ct)
    {
        var (ok, error, sha) = await _jobs.ApproveStagedRunAsync(runId, ct);
        return ok ? Ok(new { ok = true, sha }) : BadRequest(new { error });
    }

    [HttpPost("api/jobs/runs/{runId}/reject")]
    public async Task<IActionResult> Reject(string runId) =>
        await _jobs.RejectStagedRunAsync(runId) ? Ok(new { ok = true }) : BadRequest(new { error = "没有待审阅的改动" });

    /// <summary>Read/update the scheduler settings (the global kill-switch + cadence/limits).</summary>
    [HttpGet("api/jobs/settings")]
    public IActionResult GetSettings() => Ok(_config.Current.Jobs);

    [HttpPut("api/jobs/settings")]
    public IActionResult SetSettings([FromBody] JobsSettingsRequest req)
    {
        _config.Update(c =>
        {
            if (req.Enabled is { } e) c.Jobs.Enabled = e;
            if (req.PollSeconds is { } p) c.Jobs.PollSeconds = Math.Clamp(p, 5, 3600);
            if (req.CatchUpGraceHours is { } g) c.Jobs.CatchUpGraceHours = Math.Clamp(g, 1, 720);
            if (req.DefaultTimeoutSeconds is { } t) c.Jobs.DefaultTimeoutSeconds = Math.Clamp(t, 10, 3600);
            if (req.MaxConsecutiveFailures is { } m) c.Jobs.MaxConsecutiveFailures = Math.Clamp(m, 1, 100);
        });
        return Ok(_config.Current.Jobs);
    }
}
