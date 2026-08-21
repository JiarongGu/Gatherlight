using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Storage.DataRepo.Services;
using Gatherlight.Server.Platform.Agent.Llm.Models;
using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Agent.Ui.Models;
using Gatherlight.Server.Platform.Agent.Ui.Services;
using Gatherlight.Server.Platform.Capabilities.McpClient.Models;
using Gatherlight.Server.Platform.Capabilities.McpClient.Services;
using Gatherlight.Server.Platform.Capabilities.McpClient.Services.Transport;
using Gatherlight.Server.Platform.Capabilities.Models;
using Gatherlight.Server.Platform.Capabilities.Services;
using Gatherlight.Server.Platform.Capabilities.Tools.Services;
using Lyntai.Providers.ClaudeCli;
using AgentToolPolicy = Lyntai.Agents.AgentToolPolicy;
using AgentSessionResult = Lyntai.Agents.AgentSessionResult;

namespace Gatherlight.Server.Platform.Agent.Chat.Services;


/// <summary>
/// Holds chat sessions and drives the two-gate flow (plan → human approve → execute →
/// human diff-review → commit to the data repo). Enforces a single active task at a time —
/// concurrent runs would corrupt the shared data tree. Behavioral port of the legacy viewer's
/// ChatController (session.ts), minus system mode.
/// </summary>
public sealed class ChatSessionService : IChatGateHost
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
    private readonly ISiteContext _data;
    private readonly IAppConfigService _appConfig;
    private readonly ChatEnvironmentService _env;
    private readonly DataWriteLock _writeLock;
    private readonly IToolRegistry _tools;
    private readonly IZhikuRouter _router;
    private readonly CodeRepoGit _codeGit;
    private readonly BuildVerifyService _buildVerify;
    private readonly GatherlightServerOptions _options;
    private readonly Platform.Ops.Scoring.Services.IScoringService _scoring;
    private readonly IAgentGate _gate;
    private readonly IMcpProvisionService _mcpProvision;
    private readonly IMcpLoginService _mcpLogin;
    private readonly IMcpServerStore _mcpStore;
    private readonly IDraftStore _drafts;
    private readonly IScriptToolProvider _scripts;
    private readonly ICapabilityRegistry _capabilities;
    private readonly ICapabilityDenialLog _denials;
    private readonly Platform.Site.Services.ISiteManifestStore _manifestStore;
    private readonly ISessionCapabilityAllowance _sessionAllowance;
    private readonly IUiTreeValidator _uiValidator;
    private readonly IPageReviewService _pageReview;
    private readonly Platform.Hosting.Security.Services.IInternalMcpEndpoint _internalMcp;
    // Only for DIAGNOSIS: when a run fails, ask what the CLI actually is rather than guessing from a
    // localized OS error string. Nothing here spawns the agent — that stays with IAgentRunner.
    private readonly Llm.Services.IClaudeCliRuntime _claude;
    private readonly ChatGateService _gates;
    private readonly ILogger<ChatSessionService> _log;

    private const int MaxBuildRepair = 2;

    public ChatSessionService(
        IAgentRunner agent, IPromptHarness harness, IClaudeValidateService validator,
        IGitCliService git, IDataCommitRepository commits, IChatRepository repo,
        ISiteContext data, IAppConfigService appConfig, ChatEnvironmentService env,
        DataWriteLock writeLock, IToolRegistry tools, IZhikuRouter router,
        CodeRepoGit codeGit, BuildVerifyService buildVerify, GatherlightServerOptions options,
        Platform.Ops.Scoring.Services.IScoringService scoring, IAgentGate gate,
        IMcpProvisionService mcpProvision, IMcpLoginService mcpLogin, IMcpServerStore mcpStore,
        IDraftStore drafts, IScriptToolProvider scripts, ICapabilityRegistry capabilities,
        ICapabilityDenialLog denials, Platform.Site.Services.ISiteManifestStore manifestStore,
        ISessionCapabilityAllowance sessionAllowance, IUiTreeValidator uiValidator,
        IPageReviewService pageReview, Platform.Hosting.Security.Services.IInternalMcpEndpoint internalMcp,
        ChatGateService gates, Llm.Services.IClaudeCliRuntime claude, ILogger<ChatSessionService> log)
    {
        _claude = claude;
        _uiValidator = uiValidator;
        _pageReview = pageReview;
        _internalMcp = internalMcp;
        _gate = gate;
        _mcpProvision = mcpProvision;
        _mcpLogin = mcpLogin;
        _mcpStore = mcpStore;
        _drafts = drafts;
        _scripts = scripts;
        _capabilities = capabilities;
        _denials = denials;
        _manifestStore = manifestStore;
        _sessionAllowance = sessionAllowance;
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
        _gates = gates;
        _log = log;
    }

    public ChatSession? Get(string id) => _sessions.GetValueOrDefault(id);

    public bool IsBusy()
    {
        if (_activeId is null) return false;
        var s = _sessions.GetValueOrDefault(_activeId);
        return s is not null && !ChatPhase.Terminal.Contains(s.Phase);
    }

    /// <summary>The current non-terminal session (the one holding the agent lease), or null. Lets a
    /// client that lost its local session id (blip, reload, other browser) re-attach to a live session —
    /// e.g. one parked at awaiting-input — instead of hitting BUSY with no way to reply or cancel.</summary>
    public ChatSession? ActiveSession()
    {
        if (_activeId is null) return null;
        var s = _sessions.GetValueOrDefault(_activeId);
        return s is not null && !ChatPhase.Terminal.Contains(s.Phase) ? s : null;
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

    /// <summary>The chat emit seam: agent text passes through a per-run UiBlockScanner so a ```ui
    /// fence becomes a validated block event instead of raw JSON in the transcript. Non-text events
    /// pass through untouched.</summary>
    private void EmitScanned(ChatSession s, UiBlockScanner scanner, AgentEvent ev)
    {
        foreach (var outEv in scanner.Feed(ev)) Emit(s, outEv);
    }

    /// <summary>Drain what a finished run left in its scanner. EVERY run gets its own scanner and its
    /// own flush — a scanner reused across runs would carry a half-open fence into the next turn.</summary>
    private void FlushScanned(ChatSession s, UiBlockScanner scanner)
    {
        foreach (var outEv in scanner.Flush()) Emit(s, outEv);
    }

    private void SetPhase(ChatSession s, string phase, object? data = null)
    {
        s.Phase = phase;
        // Keep the card so a restart can put it back on screen verbatim. Round-tripped through JSON
        // here rather than held as the live object: what has to survive is what the client was SHOWN.
        s.LastPhaseCard = data is null
            ? null
            : JsonSerializer.SerializeToElement(data, AgentEvent.WireJson);
        Emit(s, new AgentEvent { Kind = "phase", Phase = phase, Data = data });
        PersistSession(s);
        // Release the app-wide agent slot the moment this session is done, so background jobs
        // (and the next chat) can run. Idempotent — the lease disposes once.
        if (ChatPhase.Terminal.Contains(phase))
        {
            s.GateLease?.Dispose();
            s.GateLease = null;
            // A capability-escalation "allow once" must not outlive the run that asked for it. Safe to
            // clear unconditionally: the allowance is ONE global set precisely because at most one
            // agent task ever runs app-wide, so whatever is in it can only have come from THIS
            // session's own escalation gate. Reload so any ScriptTool that picked up an ephemeral grant
            // reverts to its persisted (or absent) one.
            if (_sessionAllowance.Current.Count > 0)
            {
                _sessionAllowance.Clear();
                _scripts.Reload();
            }
        }
    }

    private void PersistSession(ChatSession s)
    {
        var gate = GateStateOf(s);
        s.PersistChain = s.PersistChain.ContinueWith(
            _ => _repo.UpsertSessionAsync(
                s.Id, s.Phase, s.Mode, s.UserMessage,
                JsonSerializer.Serialize(s.Attachments), s.PlanText, s.ClaudeSessionId,
                s.CommitSha, s.Error, s.CreatedAt.ToString("o"), s.ConversationId, gate),
            TaskContinuationOptions.ExecuteSynchronously).Unwrap();
    }

    /// <summary>
    /// What a parked gate needs in order to ACT after a restart — deliberately not the same as what
    /// it needs to display. The card is already durable (every phase event's Data is persisted
    /// verbatim); what is not is the state behind the buttons: the parsed MCP request the card
    /// deliberately strips secrets from, the parsed draft, the denial the clauses were built from,
    /// and — for the diff gate — the tracked path list, without which a restored review would rebuild
    /// an EMPTY diff and approve a commit of nothing.
    ///
    /// Null while the session is running: there is no decision outstanding, and a mid-run session is
    /// not restorable anyway.
    /// </summary>
    private static string? GateStateOf(ChatSession s) => s.Phase switch
    {
        ChatPhase.AwaitingPlanApproval or ChatPhase.AwaitingInput or ChatPhase.AwaitingDiffApproval
            or ChatPhase.AwaitingMcpApproval or ChatPhase.AwaitingLogin
            or ChatPhase.AwaitingDraftApproval or ChatPhase.AwaitingCapabilityApproval =>
            JsonSerializer.Serialize(new GateState(
                s.Tracker.List(), s.LastPhaseCard, s.McpProposal, s.McpLogin, s.PendingDraft,
                s.PendingDenial, s.PendingDenialReason, s.PendingDenialGrant)),
        _ => null,
    };

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
    /// message stays GENERAL for anything we can only speculate about: no guessing at causes on screen.
    ///
    /// <para>The exception is the runtime itself, and the distinction is guessing vs KNOWING. A CLI that is
    /// absent or signed out is not an inference from an error string — it is a fact we can go and check,
    /// so we do (<see cref="IClaudeCliRuntime.ProbeAsync"/>) and say exactly that. This matters because the
    /// generic sentence told a household with no CLI to "请重试" — a retry that could not ever succeed, on
    /// the one failure with a concrete fix. Note we deliberately do NOT pattern-match the Win32 message in
    /// <c>res.Diagnostic</c>: it is localized ("系统找不到指定的文件" here, English elsewhere), so matching it
    /// would work on the developer's machine and quietly stop working on the household's.</para></summary>
    // A plan run failed to produce an APPROVABLE plan — either it emitted nothing, or it reported an
    // error (turn limit / execution error) which can still leave partial text that must NOT be presented
    // as a real plan for the human to approve.
    private async Task<string> DiagnoseFailedRun(ChatSession s, AgentSessionResult res, string zhPhase)
    {
        _log.LogWarning(
            "No usable plan ({Phase}) session={Session} isError={Err} subtype={Sub} chars={Chars} diag={Diag}",
            zhPhase, s.Id, res.IsError, res.Subtype ?? "(none)", res.FinalText.Trim().Length, res.Diagnostic ?? "(none)");

        // Cheap in the common case: the probe is cached, and a healthy install answers from memory.
        var cli = await _claude.ProbeAsync();
        if (!cli.Ready && cli.Problem is { Length: > 0 } problem)
            return $"{zhPhase}未能完成 —— {problem}";

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

    /// <summary>The working context for the turn about to start, plus whether it reset. <c>Fresh</c>
    /// is what a NEW conversation begins on: the grouping the user sees in history is then exactly
    /// the grouping the agent gets as context.</summary>
    private async Task<(string Context, bool Fresh)> PrepareThreadContextAsync()
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
            return ("", true);
        }
        return (string.Join('\n', turns.Select(t => $"- \"{t.Message}\" → {t.Outcome}")), false);
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

    public async Task<ChatSession> StartChatAsync(string userMessage, IReadOnlyList<string> attachments,
        string mode = "plan", string? continuesConversationId = null)
    {
        if (IsBusy()) throw new InvalidOperationException("BUSY");
        // Take the app-wide agent slot (shared with background jobs). Held until this session is
        // terminal — a live chat owns the data tree, so no job can mutate it underneath.
        var lease = _gate.TryBegin("chat");
        if (lease is null) throw new InvalidOperationException("BUSY");
        var (threadContext, freshThread) = await PrepareThreadContextAsync();
        // A conversation is the run of turns sharing a working context. An explicit
        // continuesConversationId (the user typed into an opened history item) wins; otherwise the
        // same idle / turn-cap / post-commit rule that resets the context also starts a new
        // conversation, so the grouping the user sees matches the grouping the agent gets.
        var conversationId = continuesConversationId
            ?? (freshThread ? null : await _repo.LatestConversationIdAsync())
            ?? $"c{DateTime.UtcNow.Ticks:x}";
        // Continuing an OLD conversation: chat_turn no longer holds it (cleared on idle/commit), so
        // rebuild the context from that conversation's own stored turns. Only when the live window
        // is empty — an active thread's own context is fresher and already correct.
        if (continuesConversationId is not null && threadContext.Length == 0)
            threadContext = await _repo.ConversationContextAsync(continuesConversationId);
        var isSystem = mode == "system";
        var s = new ChatSession
        {
            Id = $"s{DateTime.UtcNow.Ticks:x}_{Interlocked.Increment(ref _counter)}",
            Mode = isSystem ? "system" : "plan",
            UserMessage = userMessage,
            Attachments = attachments.ToList(),
            Tracker = new EditTracker(isSystem ? _options.CodeRootPath : _data.RootPath),
            ThreadContext = threadContext,
            ConversationId = conversationId,
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

    /// <summary>
    /// Bring back the one session a restart left parked on a human decision, so the decision can
    /// still be made. Called by the self-heal startup step with what
    /// <see cref="IChatRepository.ReconcileInterruptedAsync"/> chose to keep.
    ///
    /// The restored session RE-TAKES the app-wide agent lease. A parked session holds it for a
    /// reason — a background job must not mutate the tree under an unreviewed diff — so restoring the
    /// gate without the lease would quietly remove the guarantee the gate exists to provide. If the
    /// lease cannot be taken, the session falls back to the old behaviour rather than half-existing.
    ///
    /// The diff gate is rebuilt rather than remembered: <see cref="PresentDiffAsync"/> re-reads the
    /// WORKING TREE, so the household approves what is on disk now. A remembered file list could
    /// commit something other than what the reviewer was shown, which is the one thing a review
    /// surface must never do. It also means a restored diff gate whose edits are gone ends cleanly
    /// instead of committing an empty set.
    /// </summary>
    public async Task<bool> RestoreParkedAsync(string id, SessionMetadata meta)
    {
        GateState? gate = null;
        try { gate = meta.Gate is null ? null : JsonSerializer.Deserialize<GateState>(meta.Gate); }
        catch (JsonException ex) { _log.LogWarning(ex, "restore: session {Session} has unreadable gate state", id); }

        var lease = _gate.TryBegin("chat");
        if (lease is null)
        {
            _log.LogWarning("restore: session {Session} could not take the agent lease — left interrupted", id);
            return false;
        }

        var isSystem = meta.Mode == "system";
        var tracker = new EditTracker(isSystem ? _options.CodeRootPath : _data.RootPath);
        foreach (var rel in gate?.TrackedPaths ?? []) tracker.Record("Write", rel);

        var s = new ChatSession
        {
            Id = id,
            Mode = isSystem ? "system" : "plan",
            UserMessage = meta.UserMessage ?? "",
            Attachments = Attachments(meta.Attachments),
            Tracker = tracker,
            ThreadContext = "",                        // the next run rebuilds it from stored turns
            ConversationId = meta.ConversationId ?? id,
            GateLease = lease,
            Phase = meta.Phase ?? ChatPhase.Idle,
            PlanText = meta.PlanText ?? "",
            ClaudeSessionId = meta.ClaudeSessionId,
            McpProposal = gate?.McpProposal,
            McpLogin = gate?.McpLogin,
            PendingDraft = gate?.PendingDraft,
            PendingDenial = gate?.PendingDenial,
            PendingDenialReason = gate?.PendingDenialReason,
            PendingDenialGrant = gate?.PendingDenialGrant,
            LastPhaseCard = gate?.Card,
        };
        _sessions[s.Id] = s;
        _activeId = s.Id;

        // The diff gate is the one phase whose card cannot simply be re-shown: approving it commits a
        // file list, so that list is rebuilt from the working tree here. PresentDiffAsync sets the
        // phase itself (including ending the session cleanly when nothing is left to commit).
        if (s.Phase == ChatPhase.AwaitingDiffApproval)
        {
            try { await PresentDiffAsync(s); }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "restore: session {Session} could not rebuild its diff", id);
                Fail(s, "重启后无法重建改动预览,请重新发起。");
                return false;
            }
        }

        _log.LogInformation("restore: session {Session} resumed at {Phase}", id, s.Phase);
        Emit(s, new AgentEvent { Kind = "notice", Text = "服务已重启 —— 这个待办决定还在,可以继续。" });
        // Put the card back on screen. The diff gate already re-emitted its own, rebuilt one above;
        // for every other gate this is the ONLY way the question and its buttons come back, because
        // the snapshot endpoint does not project them.
        if (s.Phase != ChatPhase.AwaitingDiffApproval && s.LastPhaseCard is { } card)
            Emit(s, new AgentEvent { Kind = "phase", Phase = s.Phase, Data = card });
        return true;
    }

    private static List<string> Attachments(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try { return JsonSerializer.Deserialize<List<string>>(json) ?? []; }
        catch (JsonException) { return []; }
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
        // The agent's tools come from the loopback channel, not the public listener — so they work
        // whatever TLS/token/bind the household configured. Built per run from the live port: no
        // generated file, nothing on disk to go stale. Naming a server does not pre-approve its
        // tools, so AllowedTools below still does that job.
        McpServers = AgentMcpWiring.ServersFor(_internalMcp, _tools),
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
            var scanner = new UiBlockScanner(_uiValidator);
            var res = await _agent.RunAsync(
                BaseRunOptions(s, prompt, readOnly: true),
                label: $"chat:{s.Mode}:plan", onEvent: ev => EmitScanned(s, scanner, ev), ct: s.Abort.Token);
            FlushScanned(s, scanner);
            if (s.Cancelled) return; // cancel() owns the terminal state
            s.ClaudeSessionId = res.SessionId;
            s.PlanText = res.FinalText.Trim();
            // Fail on an error result even when partial text exists — a turn-limited/errored run is not a
            // plan to approve, only a fragment.
            if (res.IsError || s.PlanText.Length == 0)
            {
                Fail(s, await DiagnoseFailedRun(s, res, "计划阶段"));
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
            var scanner = new UiBlockScanner(_uiValidator);
            var res = await _agent.RunAsync(
                BaseRunOptions(s,
                    await (IsSystem(s) ? _harness.SystemExecutePrompt(s.PlanText) : _harness.ExecutePrompt(s.PlanText)),
                    readOnly: false) with
                {
                    ResumeToken = s.ClaudeSessionId,
                    SettingsPath = IsSystem(s) ? _env.SystemSettingsPath : _env.SettingsPath,
                },
                label: $"chat:{s.Mode}:exec", onEvent: ev => EmitScanned(s, scanner, ev), tracker: s.Tracker, ct: s.Abort.Token);
            FlushScanned(s, scanner);
            if (s.Cancelled) return;
            if (res.SessionId is not null) s.ClaudeSessionId = res.SessionId;
            await FinishExecuteAsync(s, res);
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
            var scanner = new UiBlockScanner(_uiValidator);
            await _agent.RunAsync(
                BaseRunOptions(s, await _harness.RepairPrompt(result.Output), readOnly: false) with
                {
                    ResumeToken = s.ClaudeSessionId,
                    SettingsPath = _env.SystemSettingsPath,
                },
                label: $"chat:{s.Mode}:repair", onEvent: ev => EmitScanned(s, scanner, ev), tracker: s.Tracker,
                ct: s.Abort?.Token ?? default);
            FlushScanned(s, scanner);
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
            var scanner = new UiBlockScanner(_uiValidator);
            var res = await _agent.RunAsync(
                BaseRunOptions(s, revisePrompt, readOnly: true) with { ResumeToken = s.ClaudeSessionId },
                label: $"chat:{s.Mode}:revise-plan", onEvent: ev => EmitScanned(s, scanner, ev), ct: s.Abort.Token);
            FlushScanned(s, scanner);
            if (s.Cancelled) return;
            if (res.SessionId is not null) s.ClaudeSessionId = res.SessionId;
            var text = res.FinalText.Trim();
            if (res.IsError || text.Length == 0)
            {
                Fail(s, await DiagnoseFailedRun(s, res, "修订计划"));
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
        // `files` is the REAL-change set (BuildDiff drops denied / no-op / phantom edits).
        if (files.Count == 0)
        {
            // No committable change → end cleanly (releases the agent lease). A pure no-op must NOT park
            // at awaiting-input holding the lease — only an explicit NEEDS_INPUT question does that
            // (handled in FinishExecuteAsync before we reach here). Parking on every no-op would wedge
            // the whole app with no reply/redirect to give.
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

        // Page previews: the gate reviews a page by rendering it, so a non-technical household can
        // judge what they are approving. Only for the data workspace — 系统模式 edits code, not pages.
        List<PageDiffView>? pages = null;
        if (!IsSystem(s))
        {
            var pageFiles = files.Where(f => _pageReview.IsPagePath(f.Path)).ToList();
            if (pageFiles.Count > 0)
            {
                // The committed version — what approval would replace. Null for a page being created.
                // PagesToReview expands a changed COMPONENT DEFINITION into the pages it alters, whose
                // own files did not change — deduped, so two edited definitions sharing a page render
                // it once.
                pages = new List<PageDiffView>();
                var reviewed = new HashSet<string>(StringComparer.Ordinal);
                foreach (var f in pageFiles)
                    foreach (var target in _pageReview.PagesToReview(f.Path))
                        if (reviewed.Add(target))
                            pages.Add(await _pageReview.ReviewAsync(target, await git.ShowAsync($"HEAD:{target}")));
            }
        }

        s.Review = new ReviewPayload(files, claudeFiles.Count > 0, validation, build, pages);
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
        // A page that would not render cannot be committed — the same rule as a failed build. The
        // thing being approved has already been through the validator, so this is enforcement, not
        // advice.
        if (s.Review?.Pages?.FirstOrDefault(p => p.Status == "invalid") is { } bad)
        {
            Emit(s, new AgentEvent
            {
                Kind = "error",
                Text = $"页面 {bad.Path} 无法显示({bad.Reason}),不能提交。请让 AI 修正后再试。",
            });
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
            var scoreCtx = Platform.Ops.Scoring.Services.ScoringContext.Build(
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

    public Task RefineDiffAsync(string id, string feedback)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingDiffApproval);
        s.Review = null; // the prior diff is now stale
        return ContinueExecuteAsync(s, feedback, "✍️ 收到调整意见,正在修改文件…");
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
    // Resume execute with the human's text (a diff-refine OR an input-reply), then run the shared finish
    // tail. Identical to the initial execute except it carries the human's feedback as the prompt.
    private async Task ContinueExecuteAsync(ChatSession s, string feedback, string notice)
    {
        SetPhase(s, ChatPhase.Executing);
        Emit(s, new AgentEvent { Kind = "notice", Text = notice });
        s.Abort = new CancellationTokenSource();
        try
        {
            var scanner = new UiBlockScanner(_uiValidator);
            var res = await _agent.RunAsync(
                BaseRunOptions(s,
                    await (IsSystem(s) ? _harness.SystemReviseExecutePrompt(feedback) : _harness.ReviseExecutePrompt(feedback)),
                    readOnly: false) with
                {
                    ResumeToken = s.ClaudeSessionId,
                    SettingsPath = IsSystem(s) ? _env.SystemSettingsPath : _env.SettingsPath,
                },
                label: $"chat:{s.Mode}:revise-exec", onEvent: ev => EmitScanned(s, scanner, ev), tracker: s.Tracker, ct: s.Abort.Token);
            FlushScanned(s, scanner);
            if (s.Cancelled) return;
            if (res.SessionId is not null) s.ClaudeSessionId = res.SessionId;
            await FinishExecuteAsync(s, res);
        }
        catch (OperationCanceledException) when (s.Cancelled) { }
        catch (Exception ex)
        {
            if (s.Cancelled) return;
            Fail(s, $"调整阶段失败:{ex.Message}", ex);
        }
    }

    // Shared tail of every EXECUTE run (initial approve, diff-refine, input-reply). If the agent
    // signalled it needs a human decision (a NEEDS_INPUT marker), PAUSE for a reply instead of
    // presenting a (partial) diff — the tracked edits stay on disk and are built on when the human
    // replies. Otherwise: (system-mode build then) present the diff.
    private async Task FinishExecuteAsync(ChatSession s, AgentSessionResult res)
    {
        // An MCP_ADD proposal is a privileged, out-of-band action (register a server that runs with
        // server privileges) — park for explicit human confirmation of the concrete spec, never edit
        // files for it. Checked before NEEDS_INPUT so a proposal isn't mistaken for a free-text pause.
        if (GateMarkers.TryExtractMcpAdd(res.FinalText, out var proposal))
        {
            _gates.EnterAwaitingMcpApproval(this, s, proposal);
            return;
        }
        // The agent hit a login-walled server and asked for interactive login — show the QR/URL in
        // chat and pause; the agent resumes once the human completes the scan (login is LLM-decided).
        if (GateMarkers.TryExtractLoginRequired(res.FinalText, out var serverRef))
        {
            await _gates.EnterAwaitingLoginAsync(this, s, serverRef);
            return;
        }
        // The agent drafted a new tool and wants it enabled — park for the human's decision, built
        // from PermissionSentence over the draft's OWN grant, never the agent's description of it. A
        // marker naming a draft that does not exist (or fails to parse) must NOT park: there is
        // nothing to decide, and parking anyway would wedge the session holding the agent lease with
        // no way forward. Notice and fall through to the normal finish tail below instead.
        if (GateMarkers.TryExtractToolDraft(res.FinalText, out var draftId))
        {
            var draft = _drafts.Get(draftId);
            if (draft is null)
                Emit(s, new AgentEvent { Kind = "notice", Text = $"⚠️ 找不到草稿工具「{draftId}」,已忽略该标记。" });
            else
            {
                _gates.EnterAwaitingDraftApproval(this, s, draft);
                return;
            }
        }
        // A capability call was refused and the agent surfaced it rather than working around it —
        // park for the human's decision, built from the RUNTIME's own record of the denial (never the
        // agent's account of it). A marker naming an id with no recorded refusal must NOT park: same
        // reasoning as TOOL_DRAFT above, nothing to decide.
        if (GateMarkers.TryExtractCapabilityBlocked(res.FinalText, out var capId, out var agentReason))
        {
            var denial = _denials.Last(capId);
            if (denial is null)
                Emit(s, new AgentEvent { Kind = "notice", Text = $"⚠️ 找不到能力「{capId}」的拒绝记录,已忽略该标记。" });
            else
            {
                _gates.EnterAwaitingCapabilityApproval(this, s, denial, agentReason);
                return;
            }
        }
        if (GateMarkers.TryExtractNeedsInput(res.FinalText, out var question, out var options))
        {
            _gates.EnterAwaitingInput(this, s, question, options);
            return;
        }
        BuildResult? build = null;
        if (IsSystem(s))
        {
            build = await BuildWithRepairAsync(s);
            if (s.Cancelled) return;
        }
        await PresentDiffAsync(s, build);
    }


    // --- the five between-turns gates -----------------------------------------------------
    // Thin by design: ChatGateService owns what each decision DOES; this stays the one door the
    // controller knocks on, and hands it the session host for the duration of the call.
    public Task RespondInputAsync(string id, string message) => _gates.RespondInputAsync(this, id, message);
    public Task ApproveMcpAsync(string id, IReadOnlyDictionary<string, string>? secrets) => _gates.ApproveMcpAsync(this, id, secrets);
    public Task RejectMcpAsync(string id) => _gates.RejectMcpAsync(this, id);
    public Task ApproveDraftAsync(string id) => _gates.ApproveDraftAsync(this, id);
    public Task RejectDraftAsync(string id) => _gates.RejectDraftAsync(this, id);
    public Task AllowCapabilityAsync(string id, bool remember) => _gates.AllowCapabilityAsync(this, id, remember);
    public Task DenyCapabilityAsync(string id) => _gates.DenyCapabilityAsync(this, id);
    public Task ContinueLoginAsync(string id) => _gates.ContinueLoginAsync(this, id);

    // IChatGateHost — explicit, so the gate seam does not widen ChatSessionService's public surface.
    ChatSession IChatGateHost.RequirePhase(string id, string phase) => RequirePhase(id, phase);
    void IChatGateHost.SetPhase(ChatSession s, string phase, object? data) => SetPhase(s, phase, data);
    void IChatGateHost.Emit(ChatSession s, AgentEvent ev) => Emit(s, ev);
    void IChatGateHost.Fail(ChatSession s, string message, Exception? ex) => Fail(s, message, ex);
    void IChatGateHost.RecordOutcome(ChatSession s, string outcome) => RecordOutcome(s, outcome);
    Task IChatGateHost.ContinueExecuteAsync(ChatSession s, string feedback, string notice) => ContinueExecuteAsync(s, feedback, notice);
    Task IChatGateHost.PresentDiffAsync(ChatSession s) => PresentDiffAsync(s);

}
