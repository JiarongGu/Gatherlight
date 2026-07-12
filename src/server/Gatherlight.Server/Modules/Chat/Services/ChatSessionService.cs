using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.DataRepo.Services;
using Gatherlight.Server.Modules.Llm.Models;
using Gatherlight.Server.Modules.Llm.Services;

namespace Gatherlight.Server.Modules.Chat.Services;

public static class ChatPhase
{
    public const string Idle = "idle";
    public const string Planning = "planning";
    public const string AwaitingPlanApproval = "awaiting-plan-approval";
    public const string Executing = "executing";
    public const string Validating = "validating";
    public const string AwaitingDiffApproval = "awaiting-diff-approval";
    public const string Committing = "committing";
    public const string Committed = "committed";
    public const string Rejected = "rejected";
    public const string Cancelled = "cancelled";
    public const string Error = "error";

    public static readonly string[] Terminal = { Committed, Rejected, Cancelled, Error };
}

public sealed record ReviewPayload(List<DiffFile> Files, bool HasClaudeInfra, ClaudeValidation? Validation);

public sealed class ChatSession
{
    public required string Id { get; init; }
    public string Phase { get; set; } = ChatPhase.Idle;
    public required string UserMessage { get; init; }
    public required List<string> Attachments { get; init; }
    public string? ClaudeSessionId { get; set; }
    public string PlanText { get; set; } = "";
    public required EditTracker Tracker { get; init; }
    public ReviewPayload? Review { get; set; }
    public string? CommitSha { get; set; }
    public string? Error { get; set; }
    public DateTime CreatedAt { get; } = DateTime.UtcNow;
    public List<AgentEvent> Log { get; } = new();
    public ConcurrentDictionary<Channel<AgentEvent>, byte> Subscribers { get; } = new();
    public CancellationTokenSource? Abort { get; set; }
    public bool Cancelled { get; set; }
    public required string ThreadContext { get; init; }
    /// <summary>Sequential persistence chain so DB writes keep event order without
    /// blocking the emit path.</summary>
    public Task PersistChain = Task.CompletedTask;
    public int EventSeq;
}

/// <summary>
/// Holds chat sessions and drives the two-gate flow (plan → human approve → execute →
/// human diff-review → commit to the data repo). Enforces a single active task at a time —
/// concurrent runs would corrupt the shared data tree. Behavioral port of the legacy viewer's
/// ChatController (session.ts), minus system mode.
/// </summary>
public sealed class ChatSessionService
{
    private static readonly TimeSpan ThreadIdle = TimeSpan.FromMinutes(30);
    private const int ThreadMaxTurns = 6;

    private readonly ConcurrentDictionary<string, ChatSession> _sessions = new();
    private string? _activeId;
    private int _counter;

    private readonly IClaudeCliRunner _runner;
    private readonly IPromptHarness _harness;
    private readonly IClaudeValidateService _validator;
    private readonly IGitCliService _git;
    private readonly IDataCommitRepository _commits;
    private readonly IChatRepository _repo;
    private readonly IDataContext _data;
    private readonly IAppConfigService _appConfig;
    private readonly ChatEnvironmentService _env;
    private readonly DataWriteLock _writeLock;
    private readonly ILogger<ChatSessionService> _log;

    public ChatSessionService(
        IClaudeCliRunner runner, IPromptHarness harness, IClaudeValidateService validator,
        IGitCliService git, IDataCommitRepository commits, IChatRepository repo,
        IDataContext data, IAppConfigService appConfig, ChatEnvironmentService env,
        DataWriteLock writeLock, ILogger<ChatSessionService> log)
    {
        _runner = runner;
        _harness = harness;
        _validator = validator;
        _git = git;
        _commits = commits;
        _repo = repo;
        _data = data;
        _appConfig = appConfig;
        _env = env;
        _writeLock = writeLock;
        _log = log;
    }

    public ChatSession? Get(string id) => _sessions.GetValueOrDefault(id);

    public bool IsBusy()
    {
        if (_activeId is null) return false;
        var s = _sessions.GetValueOrDefault(_activeId);
        return s is not null && !ChatPhase.Terminal.Contains(s.Phase);
    }

    // --- events -----------------------------------------------------------------------

    private void Emit(ChatSession s, AgentEvent ev)
    {
        lock (s.Log) s.Log.Add(ev);
        foreach (var ch in s.Subscribers.Keys) ch.Writer.TryWrite(ev);
        var seq = Interlocked.Increment(ref s.EventSeq);
        var payload = JsonSerializer.Serialize(ev, AgentEvent.WireJson);
        s.PersistChain = s.PersistChain.ContinueWith(
            _ => _repo.AppendEventAsync(s.Id, seq, ev.Kind, payload),
            TaskContinuationOptions.ExecuteSynchronously).Unwrap();
    }

    private void SetPhase(ChatSession s, string phase, object? data = null)
    {
        s.Phase = phase;
        Emit(s, new AgentEvent { Kind = "phase", Phase = phase, Data = data });
        PersistSession(s);
    }

    private void PersistSession(ChatSession s)
    {
        s.PersistChain = s.PersistChain.ContinueWith(
            _ => _repo.UpsertSessionAsync(
                s.Id, s.Phase, "plan", s.UserMessage,
                JsonSerializer.Serialize(s.Attachments), s.PlanText, s.ClaudeSessionId,
                s.CommitSha, s.Error, s.ThreadContext, s.CreatedAt.ToString("o")),
            TaskContinuationOptions.ExecuteSynchronously).Unwrap();
    }

    private void Fail(ChatSession s, string message)
    {
        s.Error = message;
        Emit(s, new AgentEvent { Kind = "error", Text = message });
        SetPhase(s, ChatPhase.Error);
        Emit(s, new AgentEvent { Kind = "done", Phase = ChatPhase.Error });
    }

    /// <summary>SSE subscription: replay the buffered log, then live events. Dispose to detach.</summary>
    public (List<AgentEvent> Replay, ChannelReader<AgentEvent> Live, IDisposable Unsubscribe) Subscribe(string id)
    {
        var s = _sessions[id];
        var ch = Channel.CreateUnbounded<AgentEvent>();
        List<AgentEvent> replay;
        lock (s.Log) replay = s.Log.ToList();
        s.Subscribers.TryAdd(ch, 0);
        return (replay, ch.Reader, new Unsubscriber(() =>
        {
            s.Subscribers.TryRemove(ch, out _);
            ch.Writer.TryComplete();
        }));
    }

    private sealed class Unsubscriber(Action dispose) : IDisposable
    {
        public void Dispose() => dispose();
    }

    // --- thread context (compact turn summaries; durable in chat_turn) ------------------

    private async Task<string> PrepareThreadContextAsync()
    {
        var turns = await _repo.TurnsAsync();
        var last = turns.LastOrDefault();
        var idle = last is not null
            && DateTime.TryParse(last.CreatedAt, null, System.Globalization.DateTimeStyles.RoundtripKind, out var at)
            && DateTime.UtcNow - at > ThreadIdle;
        var tooLong = turns.Count >= ThreadMaxTurns;
        // After a committed turn the work is durably in files → fresh slate.
        var lastCommitted = last?.Outcome.StartsWith("已提交") ?? false;
        if (idle || tooLong || lastCommitted)
        {
            await _repo.ClearTurnsAsync();
            return "";
        }
        return string.Join('\n', turns.Select(t => $"- \"{t.Message}\" → {t.Outcome}"));
    }

    private void RecordOutcome(ChatSession s, string outcome)
    {
        var message = string.Join(' ', s.UserMessage.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (message.Length > 80) message = message[..80];
        s.PersistChain = s.PersistChain.ContinueWith(
            _ => _repo.AddTurnAsync(message, outcome),
            TaskContinuationOptions.ExecuteSynchronously).Unwrap();
    }

    // --- gate 0: start ------------------------------------------------------------------

    public async Task<ChatSession> StartChatAsync(string userMessage, IReadOnlyList<string> attachments)
    {
        if (IsBusy()) throw new InvalidOperationException("BUSY");
        var threadContext = await PrepareThreadContextAsync();
        var s = new ChatSession
        {
            Id = $"s{DateTime.UtcNow.Ticks:x}_{Interlocked.Increment(ref _counter)}",
            UserMessage = userMessage,
            Attachments = attachments.ToList(),
            Tracker = new EditTracker(_data.RootPath),
            ThreadContext = threadContext,
        };
        _sessions[s.Id] = s;
        _activeId = s.Id;
        PersistSession(s);
        _ = Task.Run(() => RunPlanningAsync(s));
        return s;
    }

    private ClaudeRunOptions BaseRunOptions(ChatSession s, string prompt, bool readOnly) => new()
    {
        Prompt = prompt,
        Cwd = _data.RootPath,
        ReadOnly = readOnly,
        Model = _appConfig.Get("llm.model.chat"),
        McpConfigPath = File.Exists(_env.McpConfigPath) ? _env.McpConfigPath : null,
        OnEvent = ev => Emit(s, ev),
    };

    private async Task RunPlanningAsync(ChatSession s)
    {
        SetPhase(s, ChatPhase.Planning);
        Emit(s, new AgentEvent { Kind = "notice", Text = "🧭 正在按 CLAUDE.md gate 调研 + 拟定计划…" });
        s.Abort = new CancellationTokenSource();
        try
        {
            var res = await _runner.RunAsync(
                BaseRunOptions(s, _harness.PlanPrompt(s.UserMessage, s.ThreadContext, s.Attachments), readOnly: true),
                s.Abort.Token);
            if (s.Cancelled) return; // cancel() owns the terminal state
            s.ClaudeSessionId = res.SessionId;
            s.PlanText = res.FinalText.Trim();
            if (s.PlanText.Length == 0)
            {
                Fail(s, "计划阶段没有产出内容,请重试或换个说法。");
                return;
            }
            SetPhase(s, ChatPhase.AwaitingPlanApproval, new { plan = s.PlanText });
        }
        catch (OperationCanceledException) when (s.Cancelled) { /* cancel owns terminal state */ }
        catch (Exception ex)
        {
            if (s.Cancelled) return;
            Fail(s, $"计划阶段失败:{ex.Message}");
        }
    }

    // --- gate 1: plan approval ------------------------------------------------------------

    public void RejectPlan(string id)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingPlanApproval);
        RecordOutcome(s, "已放弃计划");
        Emit(s, new AgentEvent { Kind = "notice", Text = "已放弃该计划。" });
        SetPhase(s, ChatPhase.Rejected);
        Emit(s, new AgentEvent { Kind = "done", Phase = ChatPhase.Rejected });
    }

    public async Task ApprovePlanAsync(string id)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingPlanApproval);
        SetPhase(s, ChatPhase.Executing);
        Emit(s, new AgentEvent { Kind = "notice", Text = "✍️ 正在按已批准的计划修改文件…" });
        s.Abort = new CancellationTokenSource();
        try
        {
            var res = await _runner.RunAsync(BaseRunOptions(s, _harness.ExecutePrompt(s.PlanText), readOnly: false) with
            {
                ResumeSessionId = s.ClaudeSessionId,
                SettingsPath = _env.SettingsPath,
                Tracker = s.Tracker,
            }, s.Abort.Token);
            if (s.Cancelled) return;
            if (res.SessionId is not null) s.ClaudeSessionId = res.SessionId;
            await PresentDiffAsync(s);
        }
        catch (OperationCanceledException) when (s.Cancelled) { }
        catch (Exception ex)
        {
            if (s.Cancelled) return;
            Fail(s, $"执行阶段失败:{ex.Message}");
        }
    }

    public async Task RefinePlanAsync(string id, string feedback)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingPlanApproval);
        SetPhase(s, ChatPhase.Planning);
        Emit(s, new AgentEvent { Kind = "notice", Text = "🧭 收到你的补充,正在据此修订计划…" });
        s.Abort = new CancellationTokenSource();
        try
        {
            var res = await _runner.RunAsync(
                BaseRunOptions(s, _harness.RevisePlanPrompt(s.PlanText, feedback), readOnly: true) with
                {
                    ResumeSessionId = s.ClaudeSessionId,
                }, s.Abort.Token);
            if (s.Cancelled) return;
            if (res.SessionId is not null) s.ClaudeSessionId = res.SessionId;
            var text = res.FinalText.Trim();
            if (text.Length == 0)
            {
                Fail(s, "修订计划时没有产出内容,请重试或换个说法。");
                return;
            }
            s.PlanText = text;
            SetPhase(s, ChatPhase.AwaitingPlanApproval, new { plan = s.PlanText });
        }
        catch (OperationCanceledException) when (s.Cancelled) { }
        catch (Exception ex)
        {
            if (s.Cancelled) return;
            Fail(s, $"修订计划失败:{ex.Message}");
        }
    }

    // --- diff presentation (shared tail of execute / re-execute) ---------------------------

    private async Task PresentDiffAsync(ChatSession s)
    {
        var tracked = s.Tracker.List();
        List<DiffFile> files;
        if (tracked.Count == 0)
        {
            files = new List<DiffFile>();
        }
        else
        {
            using var _ = await _writeLock.AcquireAsync();
            files = await _git.BuildDiffAsync(tracked);
        }
        // `files` is the REAL-change set (BuildDiff drops denied / no-op edits).
        if (files.Count == 0)
        {
            RecordOutcome(s, "无实际改动");
            Emit(s, new AgentEvent { Kind = "notice", Text = "没有文件被实际修改(可能被范围限制拦截,或无需改动)。" });
            SetPhase(s, ChatPhase.Rejected);
            Emit(s, new AgentEvent { Kind = "done", Phase = ChatPhase.Rejected });
            return;
        }

        var claudeFiles = files.Where(f => f.IsClaudeInfra).ToList();
        ClaudeValidation? validation = null;
        if (claudeFiles.Count > 0)
        {
            SetPhase(s, ChatPhase.Validating);
            validation = await _validator.ValidateAsync(claudeFiles, ev => Emit(s, ev), s.Abort?.Token ?? default);
            if (s.Cancelled) return;
        }

        s.Review = new ReviewPayload(files, claudeFiles.Count > 0, validation);
        SetPhase(s, ChatPhase.AwaitingDiffApproval, s.Review);
    }

    // --- gate 2: diff approval --------------------------------------------------------------

    public async Task ApproveDiffAsync(string id)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingDiffApproval);
        SetPhase(s, ChatPhase.Committing);
        try
        {
            // Commit exactly the real-change set shown in the review (not raw tracker,
            // which can include denied / no-op paths → "nothing to commit").
            var paths = (s.Review?.Files ?? new()).Select(f => f.Path).ToList();
            string sha;
            using (await _writeLock.AcquireAsync())
            {
                sha = await _git.CommitPathsAsync(paths, _harness.CommitMessage(s.UserMessage, paths));
            }
            s.CommitSha = sha;
            _commits.Record(sha, s.UserMessage, "chat", s.Id);
            RecordOutcome(s, $"已提交 {sha}");
            Emit(s, new AgentEvent { Kind = "notice", Text = $"✅ 已提交 {sha}" });
            SetPhase(s, ChatPhase.Committed, new { sha, files = paths });
            Emit(s, new AgentEvent { Kind = "done", Phase = ChatPhase.Committed, Data = new { sha } });
        }
        catch (Exception ex)
        {
            Fail(s, $"提交失败:{ex.Message}");
        }
    }

    public async Task RejectDiffAsync(string id)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingDiffApproval);
        try
        {
            using (await _writeLock.AcquireAsync())
            {
                await _git.RestorePathsAsync(s.Tracker.List());
            }
            RecordOutcome(s, "已撤销改动");
            Emit(s, new AgentEvent { Kind = "notice", Text = "已撤销改动,工作区已还原。" });
            SetPhase(s, ChatPhase.Rejected);
            Emit(s, new AgentEvent { Kind = "done", Phase = ChatPhase.Rejected });
        }
        catch (Exception ex)
        {
            Fail(s, $"还原失败:{ex.Message}");
        }
    }

    public async Task RefineDiffAsync(string id, string feedback)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingDiffApproval);
        SetPhase(s, ChatPhase.Executing);
        Emit(s, new AgentEvent { Kind = "notice", Text = "✍️ 收到调整意见,正在修改文件…" });
        s.Review = null; // the prior diff is now stale
        s.Abort = new CancellationTokenSource();
        try
        {
            var res = await _runner.RunAsync(
                BaseRunOptions(s, _harness.ReviseExecutePrompt(feedback), readOnly: false) with
                {
                    ResumeSessionId = s.ClaudeSessionId,
                    SettingsPath = _env.SettingsPath,
                    Tracker = s.Tracker,
                }, s.Abort.Token);
            if (s.Cancelled) return;
            if (res.SessionId is not null) s.ClaudeSessionId = res.SessionId;
            await PresentDiffAsync(s);
        }
        catch (OperationCanceledException) when (s.Cancelled) { }
        catch (Exception ex)
        {
            if (s.Cancelled) return;
            Fail(s, $"调整阶段失败:{ex.Message}");
        }
    }

    // --- force stop ---------------------------------------------------------------------

    public async Task CancelAsync(string id)
    {
        var s = _sessions.GetValueOrDefault(id) ?? throw new InvalidOperationException("NOT_FOUND");
        if (ChatPhase.Terminal.Contains(s.Phase)) return; // already done — no-op
        if (s.Cancelled) return;

        s.Cancelled = true;
        s.Abort?.Cancel(); // kills the running claude process tree (if any)
        Emit(s, new AgentEvent { Kind = "notice", Text = "⛔ 已强制停止当前任务。" });

        // Discard anything the agent wrote so the working tree is left clean.
        var tracked = s.Tracker.List();
        if (tracked.Count > 0)
        {
            try
            {
                using var _ = await _writeLock.AcquireAsync();
                await _git.RestorePathsAsync(tracked);
                Emit(s, new AgentEvent { Kind = "notice", Text = "已还原本次产生的改动。" });
            }
            catch (Exception ex)
            {
                Emit(s, new AgentEvent { Kind = "notice", Text = $"还原时出错:{ex.Message}" });
            }
        }

        RecordOutcome(s, "已强制停止");
        SetPhase(s, ChatPhase.Cancelled);
        Emit(s, new AgentEvent { Kind = "done", Phase = ChatPhase.Cancelled });
    }

    private ChatSession RequirePhase(string id, string expected)
    {
        var s = _sessions.GetValueOrDefault(id) ?? throw new InvalidOperationException("NOT_FOUND");
        if (s.Phase != expected) throw new InvalidOperationException($"BAD_PHASE:{s.Phase}");
        return s;
    }
}
