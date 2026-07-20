using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.DataRepo.Services;
using Gatherlight.Server.Modules.Llm.Models;
using Gatherlight.Server.Modules.Llm.Services;
using Gatherlight.Server.Modules.Tools.Services;
using Lyntai.Providers.ClaudeCli;
using AgentToolPolicy = Lyntai.Agents.AgentToolPolicy;
using AgentSessionResult = Lyntai.Agents.AgentSessionResult;

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
    public const string Building = "building";
    public const string Committed = "committed";
    public const string Rejected = "rejected";
    public const string Cancelled = "cancelled";
    public const string Error = "error";

    public static readonly string[] Terminal = { Committed, Rejected, Cancelled, Error };
}

public sealed record ReviewPayload(List<DiffFile> Files, bool HasClaudeInfra, ClaudeValidation? Validation, BuildResult? Build = null);

public sealed class ChatSession
{
    public required string Id { get; init; }
    public string Phase { get; set; } = ChatPhase.Idle;
    /// <summary>"plan" (data workspace) or "system" (系统模式 — the agent edits src/client).</summary>
    public required string Mode { get; init; }
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
    // Each delivered event carries its stable seq = its index in Log (append-only), so a reconnecting
    // SSE client can resume past what it already saw (Last-Event-ID) instead of re-receiving everything.
    public ConcurrentDictionary<Channel<(int Seq, AgentEvent Ev)>, byte> Subscribers { get; } = new();
    public CancellationTokenSource? Abort { get; set; }
    public bool Cancelled { get; set; }
    /// <summary>The app-wide single-agent lease, held for this session's whole lifetime (start →
    /// terminal) so a background job can't mutate the data tree while a chat is live (incl. parked
    /// at the diff gate with uncommitted edits). Released in <c>SetPhase</c> on a terminal phase.</summary>
    public IDisposable? GateLease { get; set; }
    public required string ThreadContext { get; init; }
    /// <summary>Sequential persistence chain so DB writes keep event order without
    /// blocking the emit path.</summary>
    public Task PersistChain = Task.CompletedTask;
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

    private readonly IAgentRunner _agent;
    private readonly IPromptHarness _harness;
    private readonly IClaudeValidateService _validator;
    private readonly IGitCliService _git;
    private readonly IDataCommitRepository _commits;
    private readonly IChatRepository _repo;
    private readonly IDataContext _data;
    private readonly IAppConfigService _appConfig;
    private readonly ChatEnvironmentService _env;
    private readonly DataWriteLock _writeLock;
    private readonly IToolRegistry _tools;
    private readonly IZhikuRouter _router;
    private readonly CodeRepoGit _codeGit;
    private readonly BuildVerifyService _buildVerify;
    private readonly GatherlightServerOptions _options;
    private readonly Modules.Scoring.Services.IScoringService _scoring;
    private readonly IAgentGate _gate;
    private readonly ILogger<ChatSessionService> _log;

    private const int MaxBuildRepair = 2;

    public ChatSessionService(
        IAgentRunner agent, IPromptHarness harness, IClaudeValidateService validator,
        IGitCliService git, IDataCommitRepository commits, IChatRepository repo,
        IDataContext data, IAppConfigService appConfig, ChatEnvironmentService env,
        DataWriteLock writeLock, IToolRegistry tools, IZhikuRouter router,
        CodeRepoGit codeGit, BuildVerifyService buildVerify, GatherlightServerOptions options,
        Modules.Scoring.Services.IScoringService scoring, IAgentGate gate, ILogger<ChatSessionService> log)
    {
        _gate = gate;
        _scoring = scoring;
        _router = router;
        _codeGit = codeGit;
        _buildVerify = buildVerify;
        _options = options;
        _agent = agent;
        _harness = harness;
        _validator = validator;
        _git = git;
        _commits = commits;
        _repo = repo;
        _data = data;
        _appConfig = appConfig;
        _env = env;
        _writeLock = writeLock;
        _tools = tools;
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
        // Append + fan out to subscribers under the SAME lock Subscribe snapshots under, so an event
        // emitted between a reconnect's snapshot and its subscribe can't be lost, and every subscriber
        // sees the same stable frame id (the log index).
        lock (s.Log)
        {
            s.Log.Add(ev);
            var idx = s.Log.Count - 1; // live SSE frame id (Last-Event-ID); persisted seq is Lyntai-assigned
            foreach (var ch in s.Subscribers.Keys) ch.Writer.TryWrite((idx, ev));
        }
        var payload = JsonSerializer.Serialize(ev, AgentEvent.WireJson);
        // Persist in order via the chain; Lyntai's conversation store assigns the durable per-thread seq
        // (append order) — used only for the DB transcript/scoring, not the live SSE resume.
        s.PersistChain = s.PersistChain.ContinueWith(
            _ => _repo.AppendEventAsync(s.Id, ev.Kind, payload),
            TaskContinuationOptions.ExecuteSynchronously).Unwrap();
    }

    private void SetPhase(ChatSession s, string phase, object? data = null)
    {
        s.Phase = phase;
        Emit(s, new AgentEvent { Kind = "phase", Phase = phase, Data = data });
        PersistSession(s);
        // Release the app-wide agent slot the moment this session is done, so background jobs
        // (and the next chat) can run. Idempotent — the lease disposes once.
        if (ChatPhase.Terminal.Contains(phase))
        {
            s.GateLease?.Dispose();
            s.GateLease = null;
        }
    }

    private void PersistSession(ChatSession s)
    {
        s.PersistChain = s.PersistChain.ContinueWith(
            _ => _repo.UpsertSessionAsync(
                s.Id, s.Phase, s.Mode, s.UserMessage,
                JsonSerializer.Serialize(s.Attachments), s.PlanText, s.ClaudeSessionId,
                s.CommitSha, s.Error, s.CreatedAt.ToString("o")),
            TaskContinuationOptions.ExecuteSynchronously).Unwrap();
    }

    private void Fail(ChatSession s, string message, Exception? ex = null)
    {
        // Every chat failure now lands in the file log — with the stack when there's an exception,
        // so a live-instance failure is diagnosable without reproducing it here.
        if (ex is not null) _log.LogError(ex, "Chat session {Session} ({Mode}) failed: {Msg}", s.Id, s.Mode, message);
        else _log.LogWarning("Chat session {Session} ({Mode}) failed: {Msg}", s.Id, s.Mode, message);
        s.Error = message;
        Emit(s, new AgentEvent { Kind = "error", Text = message });
        // Record the FAILED turn to our durable thread memory (chat_turn) so the NEXT chat sees what was
        // attempted and why it failed, and can recover — instead of starting blind. This is our own DB
        // memory (injected into the next plan prompt's thread context), NOT the claude CLI's temp resume.
        // The thread doesn't reset on a failed turn (only on commit / idle / length), so it carries over.
        var reason = message.Length > 160 ? message[..160] + "…" : message;
        RecordOutcome(s, "⚠️ 未完成(出错): " + reason);
        SetPhase(s, ChatPhase.Error);
        Emit(s, new AgentEvent { Kind = "done", Phase = ChatPhase.Error });
    }

    /// <summary>Turn an empty-output run into a DIAGNOSABLE failure. The SPECIFICS (exit code, error
    /// subtype, stderr tail, is_error) go to the file log — that's where we debug from. The user-facing
    /// message stays deliberately GENERAL (daily use): no guessing at causes on screen.</summary>
    // A plan run failed to produce an APPROVABLE plan — either it emitted nothing, or it reported an
    // error (turn limit / execution error) which can still leave partial text that must NOT be presented
    // as a real plan for the human to approve.
    private string DiagnoseFailedRun(ChatSession s, AgentSessionResult res, string zhPhase)
    {
        _log.LogWarning(
            "No usable plan ({Phase}) session={Session} isError={Err} subtype={Sub} chars={Chars} diag={Diag}",
            zhPhase, s.Id, res.IsError, res.Subtype ?? "(none)", res.FinalText.Trim().Length, res.Diagnostic ?? "(none)");
        var why = res.Subtype switch
        {
            "error_max_turns" => "(达到回合上限)",
            "error_during_execution" => "(执行出错)",
            _ => res.IsError ? "(CLI 报告错误)" : "(无内容)",
        };
        return $"{zhPhase}未能完成{why},请重试。若反复失败,请查看日志(state/logs)了解原因。";
    }

    /// <summary>SSE subscription: replay the buffered log (index = seq), then live (seq, event) pairs.
    /// Dispose to detach. Snapshot + subscribe happen under one lock so no event slips between them.</summary>
    public (List<AgentEvent> Replay, ChannelReader<(int Seq, AgentEvent Ev)> Live, IDisposable Unsubscribe) Subscribe(string id)
    {
        var s = _sessions[id];
        var ch = Channel.CreateUnbounded<(int, AgentEvent)>();
        List<AgentEvent> replay;
        lock (s.Log)
        {
            replay = s.Log.ToList();
            s.Subscribers.TryAdd(ch, 0);
        }
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

    public async Task<ChatSession> StartChatAsync(string userMessage, IReadOnlyList<string> attachments, string mode = "plan")
    {
        if (IsBusy()) throw new InvalidOperationException("BUSY");
        // Take the app-wide agent slot (shared with background jobs). Held until this session is
        // terminal — a live chat owns the data tree, so no job can mutate it underneath.
        var lease = _gate.TryBegin("chat");
        if (lease is null) throw new InvalidOperationException("BUSY");
        var threadContext = await PrepareThreadContextAsync();
        var isSystem = mode == "system";
        var s = new ChatSession
        {
            Id = $"s{DateTime.UtcNow.Ticks:x}_{Interlocked.Increment(ref _counter)}",
            Mode = isSystem ? "system" : "plan",
            UserMessage = userMessage,
            Attachments = attachments.ToList(),
            Tracker = new EditTracker(isSystem ? _options.CodeRootPath : _data.RootPath),
            ThreadContext = threadContext,
            GateLease = lease,
        };
        _sessions[s.Id] = s;
        _activeId = s.Id;
        PersistSession(s);
        // Log the effective chat model at start — a bad `llm.model.chat` override (set via the Cortex
        // console) is the classic cause of an instant empty plan, and this makes it visible up-front.
        _log.LogInformation("Chat start: session={Session} mode={Mode} msgChars={Len} attachments={Att} model={Model}",
            s.Id, s.Mode, userMessage.Length, s.Attachments.Count, _appConfig.Get("llm.model.chat") ?? "(cli-default)");
        _ = Task.Run(() => RunPlanningAsync(s));
        return s;
    }

    private bool IsSystem(ChatSession s) => s.Mode == "system";
    private IGitCliService GitFor(ChatSession s) => IsSystem(s) ? _codeGit : _git;
    private string WorkRootFor(ChatSession s) => IsSystem(s) ? _options.CodeRootPath : _data.RootPath;

    // Per-call chat budget: the old runner was unbounded (abort-only). Preserve "effectively unbounded"
    // with a generous per-call timeout (clamped to LyntaiOptions.MaxProviderTimeout = 2h); overridable
    // via llm.timeout.chat. The human can always abort.
    private int ChatTimeoutSeconds =>
        int.TryParse(_appConfig.Get("llm.timeout.chat"), out var s) && s > 0 ? s : 7200;

    private ClaudeAgentOptions BaseRunOptions(ChatSession s, string prompt, bool readOnly) => new()
    {
        Prompt = prompt,
        WorkingDirectory = WorkRootFor(s),
        ToolPolicy = readOnly ? AgentToolPolicy.ReadOnly : AgentToolPolicy.Write,
        Model = _appConfig.Get("llm.model.chat"),
        TimeoutSeconds = ChatTimeoutSeconds,
        McpConfigPath = File.Exists(_env.McpConfigPath) ? _env.McpConfigPath : null,
        // Pre-approve registry tools so the headless run never stalls on a permission prompt.
        AllowedTools = _tools.McpAllowedToolNames() is { Length: > 0 } names ? names : Array.Empty<string>(),
    };

    private async Task RunPlanningAsync(ChatSession s)
    {
        SetPhase(s, ChatPhase.Planning);
        string prompt;
        if (IsSystem(s))
        {
            Emit(s, new AgentEvent { Kind = "notice", Text = "🔧 系统模式:正在分析界面代码 + 拟定改动计划…" });
            prompt = await _harness.SystemPlanPrompt(s.UserMessage, s.ThreadContext);
        }
        else
        {
            // Deterministic pre-routing: for recognizable categories the discovery gate runs
            // server-side (zero tokens) and the routed docs ride in with the prompt.
            var routed = _router.Route(s.UserMessage);
            Emit(s, new AgentEvent
            {
                Kind = "notice",
                Text = routed is null
                    ? "🧭 正在按 CLAUDE.md gate 调研 + 拟定计划…"
                    : $"⚡ 已按「{routed.CategoryKey}」预路由知识库(免调研)— 正在拟定计划…",
            });
            prompt = await _harness.PlanPrompt(s.UserMessage, s.ThreadContext, s.Attachments, routed?.PromptBlock);
        }
        s.Abort = new CancellationTokenSource();
        try
        {
            var res = await _agent.RunAsync(
                BaseRunOptions(s, prompt, readOnly: true),
                label: $"chat:{s.Mode}:plan", onEvent: ev => Emit(s, ev), ct: s.Abort.Token);
            if (s.Cancelled) return; // cancel() owns the terminal state
            s.ClaudeSessionId = res.SessionId;
            s.PlanText = res.FinalText.Trim();
            // Fail on an error result even when partial text exists — a turn-limited/errored run is not a
            // plan to approve, only a fragment.
            if (res.IsError || s.PlanText.Length == 0)
            {
                Fail(s, DiagnoseFailedRun(s, res, "计划阶段"));
                return;
            }
            SetPhase(s, ChatPhase.AwaitingPlanApproval, new { plan = s.PlanText });
        }
        catch (OperationCanceledException) when (s.Cancelled) { /* cancel owns terminal state */ }
        catch (Exception ex)
        {
            if (s.Cancelled) return;
            Fail(s, $"计划阶段失败:{ex.Message}", ex);
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
            var res = await _agent.RunAsync(
                BaseRunOptions(s,
                    await (IsSystem(s) ? _harness.SystemExecutePrompt(s.PlanText) : _harness.ExecutePrompt(s.PlanText)),
                    readOnly: false) with
                {
                    ResumeToken = s.ClaudeSessionId,
                    SettingsPath = IsSystem(s) ? _env.SystemSettingsPath : _env.SettingsPath,
                },
                label: $"chat:{s.Mode}:exec", onEvent: ev => Emit(s, ev), tracker: s.Tracker, ct: s.Abort.Token);
            if (s.Cancelled) return;
            if (res.SessionId is not null) s.ClaudeSessionId = res.SessionId;

            BuildResult? build = null;
            if (IsSystem(s))
            {
                build = await BuildWithRepairAsync(s);
                if (s.Cancelled) return;
            }
            await PresentDiffAsync(s, build);
        }
        catch (OperationCanceledException) when (s.Cancelled) { }
        catch (Exception ex)
        {
            if (s.Cancelled) return;
            Fail(s, $"执行阶段失败:{ex.Message}", ex);
        }
    }

    /// <summary>系统模式 build gate with auto-repair: feed failing output back to the agent,
    /// up to <see cref="MaxBuildRepair"/> attempts (behavioral port of the legacy repair loop).</summary>
    private async Task<BuildResult> BuildWithRepairAsync(ChatSession s)
    {
        for (var attempt = 0; ; attempt++)
        {
            SetPhase(s, ChatPhase.Building);
            Emit(s, new AgentEvent
            {
                Kind = "notice",
                Text = attempt == 0 ? "🔧 构建验证中…" : $"🔧 重新构建(修复尝试 {attempt}/{MaxBuildRepair})…",
            });
            var result = await _buildVerify.BuildClientAsync(s.Abort?.Token ?? default);
            if (s.Cancelled) return result;
            if (result.Ok)
            {
                Emit(s, new AgentEvent { Kind = "notice", Text = "✅ 构建通过" });
                return result;
            }
            if (attempt >= MaxBuildRepair)
            {
                Emit(s, new AgentEvent { Kind = "notice", Text = "⚠️ 构建仍未通过,已停止自动修复 — 不能提交,请审阅错误。" });
                return result;
            }
            Emit(s, new AgentEvent { Kind = "notice", Text = $"❌ 构建失败,让 AI 修复(第 {attempt + 1} 次)…" });
            SetPhase(s, ChatPhase.Executing);
            await _agent.RunAsync(
                BaseRunOptions(s, await _harness.RepairPrompt(result.Output), readOnly: false) with
                {
                    ResumeToken = s.ClaudeSessionId,
                    SettingsPath = _env.SystemSettingsPath,
                },
                label: $"chat:{s.Mode}:repair", onEvent: ev => Emit(s, ev), tracker: s.Tracker,
                ct: s.Abort?.Token ?? default);
            if (s.Cancelled) return result;
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
            var revisePrompt = await (IsSystem(s)
                ? _harness.SystemRevisePlanPrompt(s.PlanText, feedback)
                : _harness.RevisePlanPrompt(s.PlanText, feedback));
            var res = await _agent.RunAsync(
                BaseRunOptions(s, revisePrompt, readOnly: true) with { ResumeToken = s.ClaudeSessionId },
                label: $"chat:{s.Mode}:revise-plan", onEvent: ev => Emit(s, ev), ct: s.Abort.Token);
            if (s.Cancelled) return;
            if (res.SessionId is not null) s.ClaudeSessionId = res.SessionId;
            var text = res.FinalText.Trim();
            if (res.IsError || text.Length == 0)
            {
                Fail(s, DiagnoseFailedRun(s, res, "修订计划"));
                return;
            }
            s.PlanText = text;
            SetPhase(s, ChatPhase.AwaitingPlanApproval, new { plan = s.PlanText });
        }
        catch (OperationCanceledException) when (s.Cancelled) { }
        catch (Exception ex)
        {
            if (s.Cancelled) return;
            Fail(s, $"修订计划失败:{ex.Message}", ex);
        }
    }

    // --- diff presentation (shared tail of execute / re-execute) ---------------------------

    private async Task PresentDiffAsync(ChatSession s, BuildResult? build = null)
    {
        var git = GitFor(s);
        var tracked = s.Tracker.List();
        List<DiffFile> files;
        if (tracked.Count == 0)
        {
            files = new List<DiffFile>();
        }
        else
        {
            using var _ = await _writeLock.AcquireAsync();
            files = await git.BuildDiffAsync(tracked);
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

        // 智库 (.claude) consistency validation only applies to the data workspace, not to
        // UI code edits in 系统模式.
        var claudeFiles = IsSystem(s) ? new List<DiffFile>() : files.Where(f => f.IsClaudeInfra).ToList();
        ClaudeValidation? validation = null;
        if (claudeFiles.Count > 0)
        {
            SetPhase(s, ChatPhase.Validating);
            validation = await _validator.ValidateAsync(claudeFiles, ev => Emit(s, ev), s.Abort?.Token ?? default);
            if (s.Cancelled) return;
        }

        s.Review = new ReviewPayload(files, claudeFiles.Count > 0, validation, build);
        SetPhase(s, ChatPhase.AwaitingDiffApproval, s.Review);
    }

    // --- gate 2: diff approval --------------------------------------------------------------

    public async Task ApproveDiffAsync(string id)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingDiffApproval);
        // 系统模式: a failing build must never be committed (the diff gate showed the error).
        if (s.Review?.Build is { Ok: false })
        {
            Emit(s, new AgentEvent { Kind = "error", Text = "构建未通过,不能提交。请「拒绝并还原」或让 AI 继续修复。" });
            return;
        }
        SetPhase(s, ChatPhase.Committing);
        try
        {
            // Commit exactly the real-change set shown in the review (not raw tracker,
            // which can include denied / no-op paths → "nothing to commit").
            var paths = (s.Review?.Files ?? new()).Select(f => f.Path).ToList();
            string sha;
            using (await _writeLock.AcquireAsync())
            {
                sha = await GitFor(s).CommitPathsAsync(paths, _harness.CommitMessage(s.UserMessage, paths));
            }
            s.CommitSha = sha;
            // System-mode commits land in the code repo, not the data-commit audit index.
            if (!IsSystem(s)) _commits.Record(sha, s.UserMessage, "chat", s.Id);
            RecordOutcome(s, $"已提交 {sha}");
            Emit(s, new AgentEvent { Kind = "notice", Text = $"✅ 已提交 {sha}" });
            SetPhase(s, ChatPhase.Committed, new { sha, files = paths });
            Emit(s, new AgentEvent { Kind = "done", Phase = ChatPhase.Committed, Data = new { sha } });
            // Auto-score the committed conversation (Mastra-style) off the request path — the LLM
            // judges take a few seconds; per-scorer failures are swallowed inside the service.
            var scoreCtx = Modules.Scoring.Services.ScoringContext.Build(
                s.Id, s.UserMessage, s.PlanText, s.Phase, s.Mode, s.CommitSha, paths);
            _ = Task.Run(() => _scoring.ScoreAsync(scoreCtx));
        }
        catch (Exception ex)
        {
            Fail(s, $"提交失败:{ex.Message}", ex);
        }
    }

    public async Task RejectDiffAsync(string id)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingDiffApproval);
        try
        {
            using (await _writeLock.AcquireAsync())
            {
                await GitFor(s).RestorePathsAsync(s.Tracker.List());
            }
            RecordOutcome(s, "已撤销改动");
            Emit(s, new AgentEvent { Kind = "notice", Text = "已撤销改动,工作区已还原。" });
            SetPhase(s, ChatPhase.Rejected);
            Emit(s, new AgentEvent { Kind = "done", Phase = ChatPhase.Rejected });
        }
        catch (Exception ex)
        {
            Fail(s, $"还原失败:{ex.Message}", ex);
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
            var res = await _agent.RunAsync(
                BaseRunOptions(s,
                    await (IsSystem(s) ? _harness.SystemReviseExecutePrompt(feedback) : _harness.ReviseExecutePrompt(feedback)),
                    readOnly: false) with
                {
                    ResumeToken = s.ClaudeSessionId,
                    SettingsPath = IsSystem(s) ? _env.SystemSettingsPath : _env.SettingsPath,
                },
                label: $"chat:{s.Mode}:revise-exec", onEvent: ev => Emit(s, ev), tracker: s.Tracker, ct: s.Abort.Token);
            if (s.Cancelled) return;
            if (res.SessionId is not null) s.ClaudeSessionId = res.SessionId;

            BuildResult? build = null;
            if (IsSystem(s))
            {
                build = await BuildWithRepairAsync(s);
                if (s.Cancelled) return;
            }
            await PresentDiffAsync(s, build);
        }
        catch (OperationCanceledException) when (s.Cancelled) { }
        catch (Exception ex)
        {
            if (s.Cancelled) return;
            Fail(s, $"调整阶段失败:{ex.Message}", ex);
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
                await GitFor(s).RestorePathsAsync(tracked);
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
