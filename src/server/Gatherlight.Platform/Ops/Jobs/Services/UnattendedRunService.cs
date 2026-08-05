using System.Diagnostics;
using Gatherlight.Server.Platform.Agent.Chat.Services;
using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Storage.DataRepo.Services;
using Gatherlight.Server.Platform.Agent.Llm.Models;
using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Capabilities.Tools.Services;
using Lyntai.Providers.ClaudeCli;
using AgentToolPolicy = Lyntai.Agents.AgentToolPolicy;

namespace Gatherlight.Server.Platform.Ops.Jobs.Services;

public sealed record UnattendedRunSpec
{
    public required string RunId { get; init; }
    public required string JobName { get; init; }
    public required string Instructions { get; init; }
    /// <summary>true = report (read-only, no writes); false = agent task (may edit the data tree).</summary>
    public required bool ReadOnly { get; init; }
    /// <summary>Write jobs only: true commits immediately, false stages the diff for later review.</summary>
    public bool AutoCommit { get; init; }
    public required int TimeoutSeconds { get; init; }
    public Action<AgentEvent>? OnEvent { get; init; }
}

public sealed record UnattendedResult
{
    /// <summary>The agent slot was busy (chat or another job) — nothing ran; retry next tick.</summary>
    public bool Deferred { get; init; }
    /// <summary>Ran to completion without error/timeout.</summary>
    public bool Ok { get; init; }
    public bool TimedOut { get; init; }
    public string? Error { get; init; }
    public string FinalText { get; init; } = "";
    /// <summary>The real-change set (empty when the job wrote nothing).</summary>
    public List<DiffFile> Files { get; init; } = new();
    /// <summary>Staged patch to replay on approval (set when !AutoCommit and there were changes).</summary>
    public string? Patch { get; init; }
    /// <summary>Set when AutoCommit committed the edits.</summary>
    public string? CommitSha { get; init; }
    public bool Committed { get; init; }
    public long DurationMs { get; init; }
    public int? Tokens { get; init; }
}

/// <summary>
/// Runs the claude CLI headless for a background job — the primitive the whole scheduler is built on.
/// Unlike interactive chat there's no human at the gates, so ONE run does the task; the agent slot
/// (<see cref="IAgentGate"/>) serializes it with chat + other jobs. For write jobs it manages the
/// data tree so it's never left dirty: build the diff, then either commit (auto) or capture a patch
/// and restore the tree clean (stage-for-review). Errors/timeouts always discard partial edits.
/// </summary>
public interface IUnattendedRunService
{
    Task<UnattendedResult> RunAsync(UnattendedRunSpec spec, CancellationToken ct = default);
}

public sealed class UnattendedRunService : IUnattendedRunService
{
    private readonly IAgentGate _gate;
    private readonly IAgentRunner _agent;
    private readonly IPromptHarness _harness;
    private readonly ISiteContext _data;
    private readonly IGitCliService _git;
    private readonly DataWriteLock _writeLock;
    private readonly IToolRegistry _tools;
    private readonly IAppConfigService _appConfig;
    private readonly ChatEnvironmentService _env;
    private readonly Platform.Hosting.Security.Services.IInternalMcpEndpoint _internalMcp;
    private readonly ILogger<UnattendedRunService> _log;

    public UnattendedRunService(
        IAgentGate gate, IAgentRunner agent, IPromptHarness harness, ISiteContext data,
        IGitCliService git, DataWriteLock writeLock, IToolRegistry tools, IAppConfigService appConfig,
        ChatEnvironmentService env, Platform.Hosting.Security.Services.IInternalMcpEndpoint internalMcp,
        ILogger<UnattendedRunService> log)
    {
        _internalMcp = internalMcp;
        _gate = gate;
        _agent = agent;
        _harness = harness;
        _data = data;
        _git = git;
        _writeLock = writeLock;
        _tools = tools;
        _appConfig = appConfig;
        _env = env;
        _log = log;
    }

    public async Task<UnattendedResult> RunAsync(UnattendedRunSpec spec, CancellationToken ct = default)
    {
        var lease = _gate.TryBegin($"job:{spec.RunId}");
        if (lease is null)
        {
            _log.LogInformation("Job {Run} deferred — agent slot held by {Owner}", spec.RunId, _gate.CurrentOwner);
            return new UnattendedResult { Deferred = true };
        }
        using var _l = lease;

        var sw = Stopwatch.StartNew();
        var tracker = spec.ReadOnly ? null : new EditTracker(_data.RootPath);
        var prompt = await (spec.ReadOnly
            ? _harness.JobReportPrompt(spec.JobName, spec.Instructions)
            : _harness.JobExecutePrompt(spec.JobName, spec.Instructions));

        var opts = new ClaudeAgentOptions
        {
            Prompt = prompt,
            WorkingDirectory = _data.RootPath,
            ToolPolicy = spec.ReadOnly ? AgentToolPolicy.ReadOnly : AgentToolPolicy.Write,
            Model = _appConfig.Get("llm.model.chat"),
            TimeoutSeconds = Math.Clamp(spec.TimeoutSeconds, 10, 3600),
            // Same loopback channel the interactive chat uses — a background job needs the registry
            // tools just as much, and an unattended run has nobody to notice they went missing.
            McpServers = AgentMcpWiring.ServersFor(_internalMcp, _tools),
            AllowedTools = _tools.McpAllowedToolNames() is { Length: > 0 } names ? names : Array.Empty<string>(),
            SettingsPath = spec.ReadOnly ? null : (File.Exists(_env.SettingsPath) ? _env.SettingsPath : null),
        };

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(spec.TimeoutSeconds, 10, 3600)));

        Lyntai.Agents.AgentSessionResult? res = null;
        string? error = null;
        var timedOut = false;
        try
        {
            res = await _agent.RunAsync(opts, label: $"job:{spec.RunId}", onEvent: spec.OnEvent,
                tracker: tracker, ct: timeoutCts.Token);
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            timedOut = true;
            error = "任务超时,已终止。";
        }
        catch (Exception ex)
        {
            error = ex.Message;
        }

        var finalText = res?.FinalText.Trim() ?? "";

        // Read-only report: no tree to manage.
        if (spec.ReadOnly || tracker is null)
            return Base(error is null && !timedOut, timedOut, error, finalText, sw.ElapsedMilliseconds);

        var tracked = tracker.List();
        if (tracked.Count == 0)
            return Base(error is null && !timedOut, timedOut, error, finalText, sw.ElapsedMilliseconds);

        try
        {
            using var _w = await _writeLock.AcquireAsync(ct);
            var files = await _git.BuildDiffAsync(tracked, ct);

            // Errored / timed out / no real change → discard whatever landed; never commit or stage
            // a half-done edit.
            if (error is not null || files.Count == 0)
            {
                await _git.RestorePathsAsync(tracked, ct);
                return Base(error is null && !timedOut && files.Count == 0, timedOut, error, finalText, sw.ElapsedMilliseconds);
            }

            var paths = files.Select(f => f.Path).ToList();
            if (spec.AutoCommit)
            {
                var sha = await _git.CommitPathsAsync(paths, _harness.JobCommitMessage(spec.JobName, paths, autoApproved: true), ct);
                return new UnattendedResult
                {
                    Ok = true, Committed = true, CommitSha = sha, Files = files,
                    FinalText = finalText, DurationMs = sw.ElapsedMilliseconds,
                };
            }

            var patch = await _git.CapturePatchAsync(paths, ct);
            await _git.RestorePathsAsync(tracked, ct);
            return new UnattendedResult
            {
                Ok = true, Files = files, Patch = patch,
                FinalText = finalText, DurationMs = sw.ElapsedMilliseconds,
            };
        }
        catch (Exception ex)
        {
            _log.LogWarning("Job {Run} tree handling failed: {Msg}", spec.RunId, ex.Message);
            try { using var _w2 = await _writeLock.AcquireAsync(ct); await _git.RestorePathsAsync(tracked, ct); }
            catch { /* best-effort cleanup */ }
            return Base(false, timedOut, ex.Message, finalText, sw.ElapsedMilliseconds);
        }
    }

    private static UnattendedResult Base(bool ok, bool timedOut, string? error, string finalText, long ms) =>
        new() { Ok = ok, TimedOut = timedOut, Error = error, FinalText = finalText, DurationMs = ms };
}
