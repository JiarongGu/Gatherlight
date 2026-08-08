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


// The BETWEEN-TURNS gates: awaiting-input, mcp-approval, draft-approval, capability-approval and
// login — each one a marker the agent leaves in its final text, a phase the server parks in, a card
// built here, and a decision that resumes a FRESH run. Split out of ChatSessionService.cs so the
// two-gate pipeline (plan -> execute -> diff) and these five are readable apart; they are one class
// because they share the session state and the agent lease, and partial keeps that exactly true.
namespace Gatherlight.Server.Platform.Agent.Chat.Services;

public sealed partial class ChatSessionService
{
    // --- gate: reply to a paused agent (awaiting-input) -------------------------------------

    /// <summary>The human replies to an agent that paused for input. Resumes the SAME claude session
    /// with the reply and continues executing — any partial edits already on disk are kept + built on.</summary>
    public Task RespondInputAsync(string id, string message)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingInput);
        return ContinueExecuteAsync(s, message, "✍️ 收到你的回复,正在继续…");
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
        if (TryExtractMcpAdd(res.FinalText, out var proposal))
        {
            EnterAwaitingMcpApproval(s, proposal);
            return;
        }
        // The agent hit a login-walled server and asked for interactive login — show the QR/URL in
        // chat and pause; the agent resumes once the human completes the scan (login is LLM-decided).
        if (TryExtractLoginRequired(res.FinalText, out var serverRef))
        {
            await EnterAwaitingLoginAsync(s, serverRef);
            return;
        }
        // The agent drafted a new tool and wants it enabled — park for the human's decision, built
        // from PermissionSentence over the draft's OWN grant, never the agent's description of it. A
        // marker naming a draft that does not exist (or fails to parse) must NOT park: there is
        // nothing to decide, and parking anyway would wedge the session holding the agent lease with
        // no way forward. Notice and fall through to the normal finish tail below instead.
        if (TryExtractToolDraft(res.FinalText, out var draftId))
        {
            var draft = _drafts.Get(draftId);
            if (draft is null)
                Emit(s, new AgentEvent { Kind = "notice", Text = $"⚠️ 找不到草稿工具「{draftId}」,已忽略该标记。" });
            else
            {
                EnterAwaitingDraftApproval(s, draft);
                return;
            }
        }
        // A capability call was refused and the agent surfaced it rather than working around it —
        // park for the human's decision, built from the RUNTIME's own record of the denial (never the
        // agent's account of it). A marker naming an id with no recorded refusal must NOT park: same
        // reasoning as TOOL_DRAFT above, nothing to decide.
        if (TryExtractCapabilityBlocked(res.FinalText, out var capId, out var agentReason))
        {
            var denial = _denials.Last(capId);
            if (denial is null)
                Emit(s, new AgentEvent { Kind = "notice", Text = $"⚠️ 找不到能力「{capId}」的拒绝记录,已忽略该标记。" });
            else
            {
                EnterAwaitingCapabilityApproval(s, denial, agentReason);
                return;
            }
        }
        if (TryExtractNeedsInput(res.FinalText, out var question, out var options))
        {
            EnterAwaitingInput(s, question, options);
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

    // Park the session waiting for the human's reply. NOT a terminal phase: the agent-slot lease stays
    // held and any edits made so far stay on disk, so the reply resumes the same claude session. When
    // the agent offered discrete choices (OPTION: lines), they ride in the phase data so the UI can
    // render click-to-select buttons; the chosen label comes back as the reply message either way.
    private void EnterAwaitingInput(ChatSession s, string question, IReadOnlyList<string>? options = null)
    {
        var q = string.IsNullOrWhiteSpace(question) ? "AI 需要你的补充信息才能继续。" : question.Trim();
        var opts = options ?? Array.Empty<string>();
        // Only mention "选择一个选项" when the agent actually offered choices — otherwise it's a free-text
        // question and telling the user to pick an option (with none shown) is confusing.
        var how = opts.Count > 0 ? "请选择一个选项或在下方输入框回复" : "请在下方输入框回复";
        Emit(s, new AgentEvent { Kind = "notice", Text = $"⏸️ AI 需要你的回复才能继续 — {how}(或点「放弃任务」)。" });
        SetPhase(s, ChatPhase.AwaitingInput, new { question = q, options = opts });
    }

    // The execute prompt tells the agent to end its final message with a `NEEDS_INPUT: <question>` line
    // (plus optional `OPTION: <label>` lines) when it genuinely needs a human decision — instead of
    // guessing, or (as seen in the field) inventing a non-existent "confirm in the UI" step. Detecting
    // it lets us pause the flow for a reply, offering the agent's own choices as clickable options.
    private static readonly System.Text.RegularExpressions.Regex NeedsInputRe = new(
        @"^[ \t>*_-]*NEEDS_INPUT:[ \t]*(?<q>.*)$",
        System.Text.RegularExpressions.RegexOptions.Multiline
        | System.Text.RegularExpressions.RegexOptions.IgnoreCase
        | System.Text.RegularExpressions.RegexOptions.Compiled);
    private static readonly System.Text.RegularExpressions.Regex OptionRe = new(
        @"^[ \t>*_-]*OPTION:[ \t]*(?<o>.+?)[ \t]*$",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase
        | System.Text.RegularExpressions.RegexOptions.Compiled);

    private static bool TryExtractNeedsInput(string? finalText, out string question, out List<string> options)
    {
        question = "";
        options = new List<string>();
        if (string.IsNullOrWhiteSpace(finalText)) return false;
        var m = NeedsInputRe.Match(finalText);
        if (!m.Success) return false;
        // The marker line's own text is the question head; after it, `OPTION:` lines are the choices and
        // any other non-empty line extends the question text shown in the UI.
        var questionLines = new List<string>();
        var head = m.Groups["q"].Value.Trim();
        if (head.Length > 0) questionLines.Add(head);
        foreach (var raw in finalText[(m.Index + m.Value.Length)..].Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0) continue;
            var om = OptionRe.Match(line);
            if (om.Success) options.Add(om.Groups["o"].Value.Trim());
            else questionLines.Add(line);
        }
        question = string.Join("\n", questionLines);
        return true;
    }

    // --- gate: approve/reject adding an external MCP server (awaiting-mcp-approval) ----------

    /// <summary>Human confirmed the proposed MCP server. Merge in any credentials they entered, then
    /// register + connect via the provision service and report the outcome. Uses the SERVER-held draft
    /// (not client input) for command/url — the client only supplies secret values.</summary>
    public async Task ApproveMcpAsync(string id, IReadOnlyDictionary<string, string>? secrets)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingMcpApproval);
        var proposal = s.McpProposal ?? throw new InvalidOperationException("NO_PROPOSAL");
        SetPhase(s, ChatPhase.Executing);
        Emit(s, new AgentEvent { Kind = "notice", Text = $"🔌 正在连接 MCP 服务「{proposal.Draft.Name}」…" });
        try
        {
            var draft = proposal.Draft with
            {
                Secrets = secrets is { Count: > 0 } ? new Dictionary<string, string>(secrets) : null,
            };
            var cfg = await _mcpProvision.AddAsync(draft, s.Abort?.Token ?? default);
            s.McpProposal = null;
            if (cfg.Status == McpServerStatus.Connected)
            {
                var tools = cfg.DiscoveredTools();
                Emit(s, new AgentEvent
                {
                    Kind = "notice",
                    Text = $"✅ 已连接「{cfg.Name}」,发现 {tools.Count} 个工具:{string.Join("、", tools.Select(t => t.Name))}",
                });
                RecordOutcome(s, $"已添加 MCP 服务 {cfg.Id}");
                SetPhase(s, ChatPhase.Committed, new { mcpServerId = cfg.Id, tools = tools.Select(t => t.Name).ToArray() });
                Emit(s, new AgentEvent { Kind = "done", Phase = ChatPhase.Committed });
            }
            else
            {
                s.Error = cfg.LastError;
                Emit(s, new AgentEvent { Kind = "error", Text = $"⚠️ 已保存「{cfg.Name}」,但连接失败:{cfg.LastError}" });
                RecordOutcome(s, $"MCP 服务连接失败 {cfg.Id}");
                SetPhase(s, ChatPhase.Error, new { mcpServerId = cfg.Id });
                Emit(s, new AgentEvent { Kind = "done", Phase = ChatPhase.Error });
            }
        }
        catch (Exception ex)
        {
            Fail(s, $"添加 MCP 服务失败:{ex.Message}", ex);
        }
    }

    /// <summary>Human declined the proposed MCP server — discard the draft, nothing connects.</summary>
    public Task RejectMcpAsync(string id)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingMcpApproval);
        s.McpProposal = null;
        RecordOutcome(s, "已拒绝添加 MCP 服务");
        Emit(s, new AgentEvent { Kind = "notice", Text = "已取消,未添加任何 MCP 服务。" });
        SetPhase(s, ChatPhase.Rejected);
        Emit(s, new AgentEvent { Kind = "done", Phase = ChatPhase.Rejected });
        return Task.CompletedTask;
    }

    // Park waiting for the human to confirm the CONCRETE spec. Non-terminal (holds the agent slot).
    private void EnterAwaitingMcpApproval(ChatSession s, McpProposal proposal)
    {
        s.McpProposal = proposal;
        Emit(s, new AgentEvent
        {
            Kind = "notice",
            Text = "⏸️ AI 想添加一个外部 MCP 服务 — 请核对下面的启动方式后确认(或点「放弃任务」)。",
        });
        SetPhase(s, ChatPhase.AwaitingMcpApproval, McpProposalView(proposal));
    }

    /// <summary>The concrete, secret-free spec shown at the gate — rendered from the PARSED draft, so a
    /// prompt-injection can propose but the human sees the exact command/url before approving.
    ///
    /// <c>sandboxed:false</c> + <c>can</c> are the honesty half, and they are NOT decoration: unlike a
    /// Script capability, an external MCP server is spawned by a plain <c>Process.Start</c> and runs
    /// with the host account's full privileges. The household is being asked to trust a third-party
    /// package, so the card states what it will be able to do rather than staying silent and letting
    /// the launch command imply a containment that does not exist. Server-rendered from
    /// <see cref="PermissionSentence"/> like every other clause — the agent proposes the server, never
    /// the words describing what approving it means.</summary>
    internal static object McpProposalView(McpProposal p) => new
    {
        name = p.Draft.Name,
        transport = p.Draft.Transport,
        command = p.Draft.Command,
        args = p.Draft.Args ?? Array.Empty<string>(),
        url = p.Draft.Url,
        neededCredentials = p.NeededCredentials,
        sandboxed = false,
        can = PermissionSentence.ExternalMcp(),
    };

    // --- gate: approve/reject an agent-drafted tool (awaiting-draft-approval) ----------------

    /// <summary>Human enabled the drafted tool — promote it (copies the folder into
    /// <c>{data}/tools/</c> and appends its grant to <c>site.json</c> unchanged) then resume the SAME
    /// claude session so the agent can actually use what it just gained.</summary>
    public Task ApproveDraftAsync(string id)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingDraftApproval);
        var draft = s.PendingDraft ?? throw new InvalidOperationException("NO_DRAFT");
        s.PendingDraft = null;
        try
        {
            _drafts.Promote(draft.Id);
        }
        catch (Exception ex)
        {
            Fail(s, $"启用工具失败:{ex.Message}", ex);
            return Task.CompletedTask;
        }
        RecordOutcome(s, $"已启用草稿工具 {draft.Id}");
        return ContinueExecuteAsync(s,
            $"我已启用工具「{draft.Title}」(id: {draft.Id}),请继续之前的操作。",
            $"✅ 已启用「{draft.Title}」,正在继续…");
    }

    /// <summary>Human declined the drafted tool — discard it, then resume so the agent carries on
    /// without it (never silently retried; the agent's own next turn decides what to do instead).</summary>
    public Task RejectDraftAsync(string id)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingDraftApproval);
        var draft = s.PendingDraft ?? throw new InvalidOperationException("NO_DRAFT");
        s.PendingDraft = null;
        _drafts.Discard(draft.Id);
        RecordOutcome(s, $"已拒绝草稿工具 {draft.Id}");
        return ContinueExecuteAsync(s,
            $"我没有启用工具「{draft.Title}」(id: {draft.Id}),请在没有它的情况下继续。",
            "已拒绝该工具草稿,正在继续…");
    }

    // Park waiting for the human's enable/decline decision. Non-terminal (holds the agent slot).
    private void EnterAwaitingDraftApproval(ChatSession s, CapabilityDraft draft)
    {
        s.PendingDraft = draft;
        Emit(s, new AgentEvent
        {
            Kind = "notice",
            Text = $"⏸️ AI 起草了一个新工具「{draft.Title}」— 请核对下面的权限后决定是否启用(或点「放弃任务」)。",
        });
        SetPhase(s, ChatPhase.AwaitingDraftApproval, DraftApprovalView(draft));
    }

    /// <summary>The approval card's data. <c>can</c>/<c>cannot</c> come from <see cref="PermissionSentence"/>
    /// over the draft's OWN grant — never from the draft's text — so they cannot be worded more
    /// reassuringly by whatever wrote the draft. <c>description</c> and <c>entrySource</c> ARE the
    /// draft's own text and ride in separate fields precisely so the client can label them as the
    /// assistant's claim rather than fold them into the enforced clauses.</summary>
    internal static object DraftApprovalView(CapabilityDraft draft) => new
    {
        id = draft.Id,
        title = draft.Title,
        description = draft.Description,
        can = PermissionSentence.Can(draft.Grant),
        cannot = PermissionSentence.Cannot(draft.Grant),
        entrySource = draft.EntrySource,
    };

    // The execute prompt tells the agent: to propose a new reusable tool, write
    // `.claude/tool-drafts/<id>/tool.json` (+ its entry script), then end the final message with a
    // TOOL_DRAFT marker and STOP — never call the tool itself, it does not exist until a human
    // approves it (IDraftStore.Promote is the only thing that makes it real).
    private static readonly System.Text.RegularExpressions.Regex ToolDraftRe = new(
        @"^[ \t>*_-]*TOOL_DRAFT:[ \t]*(?<id>.+?)[ \t]*$",
        System.Text.RegularExpressions.RegexOptions.Multiline
        | System.Text.RegularExpressions.RegexOptions.IgnoreCase
        | System.Text.RegularExpressions.RegexOptions.Compiled);

    private static bool TryExtractToolDraft(string? finalText, out string draftId)
    {
        draftId = "";
        if (string.IsNullOrWhiteSpace(finalText)) return false;
        var m = ToolDraftRe.Match(finalText);
        if (!m.Success) return false;
        draftId = m.Groups["id"].Value.Trim();
        return draftId.Length > 0;
    }

    // --- gate: allow/deny a refused capability call (awaiting-capability-approval) -----------

    /// <summary>Human allowed the blocked capability. <paramref name="remember"/> true persists the
    /// grant into <c>site.json</c> (survives restart, un-denies as well as enables); false grants it
    /// for this run only via <see cref="ISessionCapabilityAllowance"/>. Either way, resume the SAME
    /// claude session so the agent can retry the call it was refused.</summary>
    public Task AllowCapabilityAsync(string id, bool remember)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingCapabilityApproval);
        var denial = s.PendingDenial ?? throw new InvalidOperationException("NO_DENIAL");
        s.PendingDenial = null;
        s.PendingDenialReason = null;
        s.PendingDenialGrant = null;
        try
        {
            // The session-allowance / site.json write both need an actual grant object even for a
            // Platform/Mcp origin (it is used as a plain dictionary/list key there, never shown as a
            // sandbox promise) — fall back to the id-only default when ScriptOriginGrant returns null.
            var grant = ScriptOriginGrant(denial) ?? new CapabilityGrant { Id = denial.Id };
            if (remember) PersistCapabilityAllow(denial, grant);
            else _sessionAllowance.Allow(grant);
            _scripts.Reload();
        }
        catch (Exception ex)
        {
            Fail(s, $"授权失败:{ex.Message}", ex);
            return Task.CompletedTask;
        }
        RecordOutcome(s, $"已{(remember ? "永久" : "本次")}允许能力 {denial.Id}");
        return ContinueExecuteAsync(s,
            $"你可以使用「{denial.Id}」了,请重试之前被拒绝的调用。",
            $"✅ 已允许「{denial.Id}」,正在继续…");
    }

    /// <summary>Human denied the blocked capability — resume so the agent proceeds without it (the
    /// default: closing the card or ignoring it must not grant anything, so only this explicit call
    /// or a fresh CAPABILITY_BLOCKED marker moves the session on).</summary>
    public Task DenyCapabilityAsync(string id)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingCapabilityApproval);
        var denial = s.PendingDenial ?? throw new InvalidOperationException("NO_DENIAL");
        s.PendingDenial = null;
        s.PendingDenialReason = null;
        s.PendingDenialGrant = null;
        RecordOutcome(s, $"已拒绝允许能力 {denial.Id}");
        return ContinueExecuteAsync(s,
            $"「{denial.Id}」未获允许,请在没有它的情况下继续。",
            "已拒绝该能力请求,正在继续…");
    }

    /// <summary>The grant a Script-origin "allow" is about to create: the one the registry already
    /// knows for it (a re-grant on an already-Denied-but-still-enabled entry), or, when there is none
    /// (the ordinary NotEnabled case), the most-restricted default — deny-by-default is
    /// <see cref="CapabilityGrant"/>'s own documented shape, so an id-only grant IS that default, not
    /// a guess at one. Null for Platform/Mcp origins: neither carries any fs/net grant vocabulary at
    /// all (Platform is unsandboxed by design; Mcp sandboxing is an explicit non-goal), so there is
    /// nothing here for either the card or a persisted write to say beyond the id itself.</summary>
    private CapabilityGrant? ScriptOriginGrant(CapabilityDenial denial) =>
        denial.Origin == CapabilityOrigin.Script
            ? _capabilities.GrantFor(denial.Id) ?? new CapabilityGrant { Id = denial.Id }
            : null;

    /// <summary>Persists an "allow and remember" decision. Handles BOTH refusal reasons with one
    /// write: NotEnabled (Script only) needs the grant appended to <c>enabled</c>; Denied needs the id
    /// removed from <c>deny</c> — and, since a Script capability can be denied while never having been
    /// enabled at all, ALSO needs the grant appended if it is not there yet. Mirrors
    /// <see cref="IDraftStore.Promote"/>'s own full-manifest read/mutate/write shape.</summary>
    private void PersistCapabilityAllow(CapabilityDenial denial, CapabilityGrant grant)
    {
        var current = _manifestStore.Load();
        var deny = current.Capabilities.Deny
            .Where(d => !string.Equals(d, denial.Id, StringComparison.OrdinalIgnoreCase))
            .ToList();
        var enabled = current.Capabilities.Enabled.ToList();
        if (denial.Origin == CapabilityOrigin.Script
            && !enabled.Any(g => string.Equals(g.Id, denial.Id, StringComparison.OrdinalIgnoreCase)))
        {
            enabled.Add(grant);
        }
        _manifestStore.Write(new Platform.Site.Models.SiteManifest
        {
            Name = current.Name,
            Template = current.Template,
            Agent = current.Agent,
            Records = current.Records,
            Capabilities = new Platform.Site.Models.SiteCapabilities { Deny = deny, Enabled = enabled },
            Ui = current.Ui,
        });
    }

    // Park waiting for the human's allow/deny decision. Non-terminal (holds the agent slot).
    private void EnterAwaitingCapabilityApproval(ChatSession s, CapabilityDenial denial, string agentReason)
    {
        s.PendingDenial = denial;
        s.PendingDenialReason = agentReason;
        s.PendingDenialGrant = ScriptOriginGrant(denial);
        Emit(s, new AgentEvent
        {
            Kind = "notice",
            Text = $"⏸️ 有一次调用被拦下(「{denial.Id}」)— 请核对后决定是否允许(或点「放弃任务」)。",
        });
        SetPhase(s, ChatPhase.AwaitingCapabilityApproval, CapabilityApprovalView(denial, s.PendingDenialGrant, agentReason));
    }

    /// <summary>The escalation card's data. <c>can</c>/<c>cannot</c> describe the grant an "allow"
    /// would create — from <see cref="PermissionSentence"/>, never from the agent — and are empty for
    /// Platform/Mcp origins, where that vocabulary corresponds to no real enforcement (see
    /// <see cref="ScriptOriginGrant"/>). <c>agentReason</c> is whatever the agent said and MUST
    /// stay a separate field: the client labels it as the assistant's claim, never the system's
    /// account of the denial (that account is <c>id</c>/<c>origin</c>/<c>state</c>, from the runtime's
    /// own <see cref="ICapabilityDenialLog"/> record).</summary>
    internal static object CapabilityApprovalView(CapabilityDenial denial, CapabilityGrant? grant, string agentReason) => new
    {
        id = denial.Id,
        origin = denial.Origin.ToString(),
        state = denial.State.ToString(),
        can = grant is null ? Array.Empty<string>() : PermissionSentence.Can(grant),
        cannot = grant is null ? Array.Empty<string>() : PermissionSentence.Cannot(grant),
        agentReason,
    };

    // ToolRegistry's refusal message (Denied/NotEnabled) tells the agent to stop and end its final
    // message with a CAPABILITY_BLOCKED marker instead of working around the refusal. Whatever the
    // agent wrote BEFORE the marker line is its own explanation — carried as agentReason, kept
    // strictly separate from the runtime's denial record.
    private static readonly System.Text.RegularExpressions.Regex CapabilityBlockedRe = new(
        @"^[ \t>*_-]*CAPABILITY_BLOCKED:[ \t]*(?<id>.+?)[ \t]*$",
        System.Text.RegularExpressions.RegexOptions.Multiline
        | System.Text.RegularExpressions.RegexOptions.IgnoreCase
        | System.Text.RegularExpressions.RegexOptions.Compiled);

    private static bool TryExtractCapabilityBlocked(string? finalText, out string id, out string agentReason)
    {
        id = "";
        agentReason = "";
        if (string.IsNullOrWhiteSpace(finalText)) return false;
        var m = CapabilityBlockedRe.Match(finalText);
        if (!m.Success) return false;
        id = m.Groups["id"].Value.Trim();
        if (id.Length == 0) return false;
        agentReason = finalText[..m.Index].Trim();
        return true;
    }

    // The (system-mode) execute prompt tells the agent: to add an external MCP server, end its final
    // message with `MCP_ADD:` followed by a JSON object (name, transport, command/args | url,
    // needsCredentials[]) — never try to register it itself (it's sandboxed out). We parse the block,
    // strip any secrets (the human enters those at the gate), and park for confirmation.
    private static readonly System.Text.RegularExpressions.Regex McpAddRe = new(
        @"^[ \t>*_-]*MCP_ADD:",
        System.Text.RegularExpressions.RegexOptions.Multiline
        | System.Text.RegularExpressions.RegexOptions.IgnoreCase
        | System.Text.RegularExpressions.RegexOptions.Compiled);

    private static bool TryExtractMcpAdd(string? finalText, out McpProposal proposal)
    {
        proposal = null!;
        if (string.IsNullOrWhiteSpace(finalText)) return false;
        var m = McpAddRe.Match(finalText);
        if (!m.Success) return false;
        var json = ExtractFirstJsonObject(finalText, m.Index + m.Length);
        if (json is null) return false;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            string? Str(string k) => r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            string[] Arr(string k) => r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Array
                ? v.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).ToArray()
                : Array.Empty<string>();
            Dictionary<string, string> Obj(string k)
            {
                var map = new Dictionary<string, string>(StringComparer.Ordinal);
                if (r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Object)
                    foreach (var p in v.EnumerateObject())
                        if (p.Value.ValueKind == JsonValueKind.String) map[p.Name] = p.Value.GetString()!;
                return map;
            }

            var transport = Str("transport") == McpTransportKind.Http ? McpTransportKind.Http : McpTransportKind.Stdio;
            var draft = new McpAddRequest(
                Name: Str("name"),
                Transport: transport,
                Command: Str("command"),
                Args: Arr("args"),
                Env: Obj("env"),
                Url: Str("url"),
                Headers: Obj("headers"),
                Secrets: null,               // secrets NEVER come from the agent — human enters at the gate
                LoginKind: Str("loginKind"),
                LoginTool: Str("loginTool"),
                LoginCheckTool: Str("loginCheckTool"),
                Enabled: true);
            proposal = new McpProposal(draft, Arr("needsCredentials"));
            return true;
        }
        catch { return false; }
    }

    /// <summary>First balanced <c>{...}</c> block at/after <paramref name="from"/>, string-aware.</summary>
    private static string? ExtractFirstJsonObject(string text, int from)
    {
        var start = text.IndexOf('{', Math.Clamp(from, 0, text.Length));
        if (start < 0) return null;
        int depth = 0;
        bool inStr = false, esc = false;
        for (var i = start; i < text.Length; i++)
        {
            var c = text[i];
            if (inStr)
            {
                if (esc) esc = false;
                else if (c == '\\') esc = true;
                else if (c == '"') inStr = false;
            }
            else if (c == '"') inStr = true;
            else if (c == '{') depth++;
            else if (c == '}' && --depth == 0) return text.Substring(start, i - start + 1);
        }
        return null;
    }

    // --- gate: interactive login for an MCP server (awaiting-login) -------------------------

    /// <summary>The human finished the scan → verify the server reports logged-in, then resume the
    /// agent from where it paused (it retries the login-walled call, now authenticated).</summary>
    public async Task ContinueLoginAsync(string id)
    {
        var s = RequirePhase(id, ChatPhase.AwaitingLogin);
        var prompt = s.McpLogin ?? throw new InvalidOperationException("NO_LOGIN");
        var status = await _mcpLogin.StatusAsync(prompt.ServerId, s.Abort?.Token ?? default);
        if (!status.LoggedIn)
        {
            Emit(s, new AgentEvent { Kind = "notice", Text = "还没检测到登录成功,请完成扫码后再继续。" });
            return;
        }
        s.McpLogin = null;
        await ContinueExecuteAsync(s, $"我已登录「{prompt.ServerName}」,请继续之前的操作。", "✅ 登录成功,正在继续…");
    }

    // Park showing the login QR/URL. Non-terminal (holds the agent slot); the client polls the
    // server's login status and calls ContinueLogin once logged in.
    private async Task EnterAwaitingLoginAsync(ChatSession s, string serverRef)
    {
        var cfg = await ResolveServerAsync(serverRef);
        if (cfg is null)
        {
            Emit(s, new AgentEvent { Kind = "notice", Text = $"⚠️ 找不到要登录的 MCP 服务「{serverRef}」。" });
            await PresentDiffAsync(s);
            return;
        }
        try
        {
            var challenge = await _mcpLogin.StartAsync(cfg.Id, s.Abort?.Token ?? default);
            s.McpLogin = new McpLoginPrompt(cfg.Id, cfg.Name, challenge);
            Emit(s, new AgentEvent
            {
                Kind = "notice",
                Text = $"🔐 「{cfg.Name}」需要登录 — {challenge.Message}。登录完成后我会自动继续。",
            });
            SetPhase(s, ChatPhase.AwaitingLogin, McpLoginView(s.McpLogin));
        }
        catch (Exception ex)
        {
            Emit(s, new AgentEvent { Kind = "error", Text = $"启动登录失败:{ex.Message}" });
            await PresentDiffAsync(s);
        }
    }

    private async Task<McpServerConfig?> ResolveServerAsync(string serverRef)
    {
        var byId = await _mcpStore.GetAsync(serverRef.Trim());
        if (byId is not null) return byId;
        var all = await _mcpStore.ListAsync();
        return all.FirstOrDefault(c => string.Equals(c.Name, serverRef.Trim(), StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>The QR/URL challenge shown in chat (secret-free — it's just a login prompt).</summary>
    internal static object McpLoginView(McpLoginPrompt p) => new
    {
        serverId = p.ServerId,
        serverName = p.ServerName,
        kind = p.Challenge.Kind,
        imageDataUri = p.Challenge.ImageDataUri,
        url = p.Challenge.Url,
        text = p.Challenge.Text,
        message = p.Challenge.Message,
    };

    // The execute prompt tells the agent: when a server needs an interactive login before you can use
    // it, end your message with `LOGIN_REQUIRED: <server id or name>` — the app shows the QR/URL and
    // resumes you once the human has logged in.
    private static readonly System.Text.RegularExpressions.Regex LoginRequiredRe = new(
        @"^[ \t>*_-]*LOGIN_REQUIRED:[ \t]*(?<s>.+?)[ \t]*$",
        System.Text.RegularExpressions.RegexOptions.Multiline
        | System.Text.RegularExpressions.RegexOptions.IgnoreCase
        | System.Text.RegularExpressions.RegexOptions.Compiled);

    private static bool TryExtractLoginRequired(string? finalText, out string serverRef)
    {
        serverRef = "";
        if (string.IsNullOrWhiteSpace(finalText)) return false;
        var m = LoginRequiredRe.Match(finalText);
        if (!m.Success) return false;
        serverRef = m.Groups["s"].Value.Trim();
        return serverRef.Length > 0;
    }

}
