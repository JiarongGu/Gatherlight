using Gatherlight.Server.Platform.Agent.Llm.Models;
using Gatherlight.Server.Platform.Capabilities.McpClient.Models;
using Gatherlight.Server.Platform.Capabilities.McpClient.Services;
using Gatherlight.Server.Platform.Capabilities.Models;
using Gatherlight.Server.Platform.Capabilities.Services;
using Gatherlight.Server.Platform.Capabilities.Tools.Services;
using Gatherlight.Server.Platform.Site.Services;

namespace Gatherlight.Server.Platform.Agent.Chat.Services;

/// <summary>
/// What a gate needs back from the session it is deciding for: find it, move its phase, speak to the
/// household, and resume the agent. Deliberately this small — it is the whole seam between the two,
/// so anything a gate wants beyond these six is a design question, not a convenience.
///
/// Passed per call rather than injected, which is what keeps the two services from depending on each
/// other in a cycle: <see cref="ChatSessionService"/> owns sessions and holds the gate service;
/// the gate service owns gate logic and is handed the session's host for the duration of one call.
/// </summary>
internal interface IChatGateHost
{
    ChatSession RequirePhase(string id, string phase);
    void SetPhase(ChatSession s, string phase, object? data = null);
    void Emit(ChatSession s, AgentEvent ev);
    void Fail(ChatSession s, string message, Exception? ex = null);
    void RecordOutcome(ChatSession s, string outcome);
    Task ContinueExecuteAsync(ChatSession s, string feedback, string notice);
    Task PresentDiffAsync(ChatSession s);
}

/// <summary>
/// The five BETWEEN-TURNS gates: awaiting-input, mcp-approval, draft-approval, capability-approval
/// and login. Each is a marker the agent left in its final text, a phase the session parks in, a card
/// the household decides on, and a decision that resumes a FRESH run.
///
/// A service of its own rather than more of <see cref="ChatSessionService"/>, because the sixth gate
/// should land in a file about gates. The dependencies say the same thing: this holds the provision,
/// login, draft, capability and manifest services, none of which the session pipeline needs — keeping
/// them together in one class was what made that class the place everything went.
/// </summary>
public sealed class ChatGateService
{
    private readonly IMcpProvisionService _mcpProvision;
    private readonly IMcpLoginService _mcpLogin;
    private readonly IMcpServerStore _mcpStore;
    private readonly IDraftStore _drafts;
    private readonly ICapabilityRegistry _capabilities;
    private readonly ISessionCapabilityAllowance _sessionAllowance;
    private readonly IScriptToolProvider _scripts;
    private readonly ISiteManifestStore _manifestStore;

    public ChatGateService(
        IMcpProvisionService mcpProvision, IMcpLoginService mcpLogin, IMcpServerStore mcpStore,
        IDraftStore drafts, ICapabilityRegistry capabilities, ISessionCapabilityAllowance sessionAllowance,
        IScriptToolProvider scripts, ISiteManifestStore manifestStore)
    {
        _mcpProvision = mcpProvision;
        _mcpLogin = mcpLogin;
        _mcpStore = mcpStore;
        _drafts = drafts;
        _capabilities = capabilities;
        _sessionAllowance = sessionAllowance;
        _scripts = scripts;
        _manifestStore = manifestStore;
    }

    // --- gate: reply to a paused agent (awaiting-input) -------------------------------------

    /// <summary>The human replies to an agent that paused for input. Resumes the SAME claude session
    /// with the reply and continues executing — any partial edits already on disk are kept + built on.</summary>
    internal Task RespondInputAsync(IChatGateHost host, string id, string message)
    {
        var s = host.RequirePhase(id, ChatPhase.AwaitingInput);
        return host.ContinueExecuteAsync(s, message, "✍️ 收到你的回复,正在继续…");
    }

    // Park the session waiting for the human's reply. NOT a terminal phase: the agent-slot lease stays
    // held and any edits made so far stay on disk, so the reply resumes the same claude session. When
    // the agent offered discrete choices (OPTION: lines), they ride in the phase data so the UI can
    // render click-to-select buttons; the chosen label comes back as the reply message either way.
    internal void EnterAwaitingInput(IChatGateHost host, ChatSession s, string question, IReadOnlyList<string>? options = null)
    {
        var q = string.IsNullOrWhiteSpace(question) ? "AI 需要你的补充信息才能继续。" : question.Trim();
        var opts = options ?? Array.Empty<string>();
        // Only mention "选择一个选项" when the agent actually offered choices — otherwise it's a free-text
        // question and telling the user to pick an option (with none shown) is confusing.
        var how = opts.Count > 0 ? "请选择一个选项或在下方输入框回复" : "请在下方输入框回复";
        host.Emit(s, new AgentEvent { Kind = "notice", Text = $"⏸️ AI 需要你的回复才能继续 — {how}(或点「放弃任务」)。" });
        host.SetPhase(s, ChatPhase.AwaitingInput, new { question = q, options = opts });
    }

    // --- gate: approve/reject adding an external MCP server (awaiting-mcp-approval) ----------

    /// <summary>Human confirmed the proposed MCP server. Merge in any credentials they entered, then
    /// register + connect via the provision service and report the outcome. Uses the SERVER-held draft
    /// (not client input) for command/url — the client only supplies secret values.</summary>
    internal async Task ApproveMcpAsync(IChatGateHost host, string id, IReadOnlyDictionary<string, string>? secrets)
    {
        var s = host.RequirePhase(id, ChatPhase.AwaitingMcpApproval);
        var proposal = s.McpProposal ?? throw new InvalidOperationException("NO_PROPOSAL");
        host.SetPhase(s, ChatPhase.Executing);
        host.Emit(s, new AgentEvent { Kind = "notice", Text = $"🔌 正在连接 MCP 服务「{proposal.Draft.Name}」…" });
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
                host.Emit(s, new AgentEvent
                {
                    Kind = "notice",
                    Text = $"✅ 已连接「{cfg.Name}」,发现 {tools.Count} 个工具:{string.Join("、", tools.Select(t => t.Name))}",
                });
                host.RecordOutcome(s, $"已添加 MCP 服务 {cfg.Id}");
                host.SetPhase(s, ChatPhase.Committed, new { mcpServerId = cfg.Id, tools = tools.Select(t => t.Name).ToArray() });
                host.Emit(s, new AgentEvent { Kind = "done", Phase = ChatPhase.Committed });
            }
            else
            {
                s.Error = cfg.LastError;
                host.Emit(s, new AgentEvent { Kind = "error", Text = $"⚠️ 已保存「{cfg.Name}」,但连接失败:{cfg.LastError}" });
                host.RecordOutcome(s, $"MCP 服务连接失败 {cfg.Id}");
                host.SetPhase(s, ChatPhase.Error, new { mcpServerId = cfg.Id });
                host.Emit(s, new AgentEvent { Kind = "done", Phase = ChatPhase.Error });
            }
        }
        catch (Exception ex)
        {
            host.Fail(s, $"添加 MCP 服务失败:{ex.Message}", ex);
        }
    }

    /// <summary>Human declined the proposed MCP server — discard the draft, nothing connects.</summary>
    internal Task RejectMcpAsync(IChatGateHost host, string id)
    {
        var s = host.RequirePhase(id, ChatPhase.AwaitingMcpApproval);
        s.McpProposal = null;
        host.RecordOutcome(s, "已拒绝添加 MCP 服务");
        host.Emit(s, new AgentEvent { Kind = "notice", Text = "已取消,未添加任何 MCP 服务。" });
        host.SetPhase(s, ChatPhase.Rejected);
        host.Emit(s, new AgentEvent { Kind = "done", Phase = ChatPhase.Rejected });
        return Task.CompletedTask;
    }

    // Park waiting for the human to confirm the CONCRETE spec. Non-terminal (holds the agent slot).
    internal void EnterAwaitingMcpApproval(IChatGateHost host, ChatSession s, McpProposal proposal)
    {
        s.McpProposal = proposal;
        host.Emit(s, new AgentEvent
        {
            Kind = "notice",
            Text = "⏸️ AI 想添加一个外部 MCP 服务 — 请核对下面的启动方式后确认(或点「放弃任务」)。",
        });
        host.SetPhase(s, ChatPhase.AwaitingMcpApproval, GateCards.McpProposal(proposal));
    }

    // --- gate: approve/reject an agent-drafted tool (awaiting-draft-approval) ----------------

    /// <summary>Human enabled the drafted tool — promote it (copies the folder into
    /// <c>{data}/tools/</c> and appends its grant to <c>site.json</c> unchanged) then resume the SAME
    /// claude session so the agent can actually use what it just gained.</summary>
    internal Task ApproveDraftAsync(IChatGateHost host, string id)
    {
        var s = host.RequirePhase(id, ChatPhase.AwaitingDraftApproval);
        var draft = s.PendingDraft ?? throw new InvalidOperationException("NO_DRAFT");
        s.PendingDraft = null;
        try
        {
            _drafts.Promote(draft.Id);
        }
        catch (Exception ex)
        {
            host.Fail(s, $"启用工具失败:{ex.Message}", ex);
            return Task.CompletedTask;
        }
        host.RecordOutcome(s, $"已启用草稿工具 {draft.Id}");
        return host.ContinueExecuteAsync(s,
            $"我已启用工具「{draft.Title}」(id: {draft.Id}),请继续之前的操作。",
            $"✅ 已启用「{draft.Title}」,正在继续…");
    }

    /// <summary>Human declined the drafted tool — discard it, then resume so the agent carries on
    /// without it (never silently retried; the agent's own next turn decides what to do instead).</summary>
    internal Task RejectDraftAsync(IChatGateHost host, string id)
    {
        var s = host.RequirePhase(id, ChatPhase.AwaitingDraftApproval);
        var draft = s.PendingDraft ?? throw new InvalidOperationException("NO_DRAFT");
        s.PendingDraft = null;
        _drafts.Discard(draft.Id);
        host.RecordOutcome(s, $"已拒绝草稿工具 {draft.Id}");
        return host.ContinueExecuteAsync(s,
            $"我没有启用工具「{draft.Title}」(id: {draft.Id}),请在没有它的情况下继续。",
            "已拒绝该工具草稿,正在继续…");
    }

    // Park waiting for the human's enable/decline decision. Non-terminal (holds the agent slot).
    internal void EnterAwaitingDraftApproval(IChatGateHost host, ChatSession s, CapabilityDraft draft)
    {
        s.PendingDraft = draft;
        host.Emit(s, new AgentEvent
        {
            Kind = "notice",
            Text = $"⏸️ AI 起草了一个新工具「{draft.Title}」— 请核对下面的权限后决定是否启用(或点「放弃任务」)。",
        });
        host.SetPhase(s, ChatPhase.AwaitingDraftApproval, GateCards.DraftApproval(draft));
    }

    // --- gate: allow/deny a refused capability call (awaiting-capability-approval) -----------

    /// <summary>Human allowed the blocked capability. <paramref name="remember"/> true persists the
    /// grant into <c>site.json</c> (survives restart, un-denies as well as enables); false grants it
    /// for this run only via <see cref="ISessionCapabilityAllowance"/>. Either way, resume the SAME
    /// claude session so the agent can retry the call it was refused.</summary>
    internal Task AllowCapabilityAsync(IChatGateHost host, string id, bool remember)
    {
        var s = host.RequirePhase(id, ChatPhase.AwaitingCapabilityApproval);
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
            host.Fail(s, $"授权失败:{ex.Message}", ex);
            return Task.CompletedTask;
        }
        host.RecordOutcome(s, $"已{(remember ? "永久" : "本次")}允许能力 {denial.Id}");
        return host.ContinueExecuteAsync(s,
            $"你可以使用「{denial.Id}」了,请重试之前被拒绝的调用。",
            $"✅ 已允许「{denial.Id}」,正在继续…");
    }

    /// <summary>Human denied the blocked capability — resume so the agent proceeds without it (the
    /// default: closing the card or ignoring it must not grant anything, so only this explicit call
    /// or a fresh CAPABILITY_BLOCKED marker moves the session on).</summary>
    internal Task DenyCapabilityAsync(IChatGateHost host, string id)
    {
        var s = host.RequirePhase(id, ChatPhase.AwaitingCapabilityApproval);
        var denial = s.PendingDenial ?? throw new InvalidOperationException("NO_DENIAL");
        s.PendingDenial = null;
        s.PendingDenialReason = null;
        s.PendingDenialGrant = null;
        host.RecordOutcome(s, $"已拒绝允许能力 {denial.Id}");
        return host.ContinueExecuteAsync(s,
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
    internal CapabilityGrant? ScriptOriginGrant(CapabilityDenial denial) =>
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
    internal void EnterAwaitingCapabilityApproval(IChatGateHost host, ChatSession s, CapabilityDenial denial, string agentReason)
    {
        s.PendingDenial = denial;
        s.PendingDenialReason = agentReason;
        s.PendingDenialGrant = ScriptOriginGrant(denial);
        host.Emit(s, new AgentEvent
        {
            Kind = "notice",
            Text = $"⏸️ 有一次调用被拦下(「{denial.Id}」)— 请核对后决定是否允许(或点「放弃任务」)。",
        });
        host.SetPhase(s, ChatPhase.AwaitingCapabilityApproval, GateCards.CapabilityApproval(denial, s.PendingDenialGrant, agentReason));
    }

    // --- gate: interactive login for an MCP server (awaiting-login) -------------------------

    /// <summary>The human finished the scan → verify the server reports logged-in, then resume the
    /// agent from where it paused (it retries the login-walled call, now authenticated).</summary>
    internal async Task ContinueLoginAsync(IChatGateHost host, string id)
    {
        var s = host.RequirePhase(id, ChatPhase.AwaitingLogin);
        var prompt = s.McpLogin ?? throw new InvalidOperationException("NO_LOGIN");
        var status = await _mcpLogin.StatusAsync(prompt.ServerId, s.Abort?.Token ?? default);
        if (!status.LoggedIn)
        {
            host.Emit(s, new AgentEvent { Kind = "notice", Text = "还没检测到登录成功,请完成扫码后再继续。" });
            return;
        }
        s.McpLogin = null;
        await host.ContinueExecuteAsync(s, $"我已登录「{prompt.ServerName}」,请继续之前的操作。", "✅ 登录成功,正在继续…");
    }

    // Park showing the login QR/URL. Non-terminal (holds the agent slot); the client polls the
    // server's login status and calls ContinueLogin once logged in.
    internal async Task EnterAwaitingLoginAsync(IChatGateHost host, ChatSession s, string serverRef)
    {
        var cfg = await ResolveServerAsync(serverRef);
        if (cfg is null)
        {
            host.Emit(s, new AgentEvent { Kind = "notice", Text = $"⚠️ 找不到要登录的 MCP 服务「{serverRef}」。" });
            await host.PresentDiffAsync(s);
            return;
        }
        try
        {
            var challenge = await _mcpLogin.StartAsync(cfg.Id, s.Abort?.Token ?? default);
            s.McpLogin = new McpLoginPrompt(cfg.Id, cfg.Name, challenge);
            host.Emit(s, new AgentEvent
            {
                Kind = "notice",
                Text = $"🔐 「{cfg.Name}」需要登录 — {challenge.Message}。登录完成后我会自动继续。",
            });
            host.SetPhase(s, ChatPhase.AwaitingLogin, GateCards.McpLogin(s.McpLogin));
        }
        catch (Exception ex)
        {
            host.Emit(s, new AgentEvent { Kind = "error", Text = $"启动登录失败:{ex.Message}" });
            await host.PresentDiffAsync(s);
        }
    }

    private async Task<McpServerConfig?> ResolveServerAsync(string serverRef)
    {
        var byId = await _mcpStore.GetAsync(serverRef.Trim());
        if (byId is not null) return byId;
        var all = await _mcpStore.ListAsync();
        return all.FirstOrDefault(c => string.Equals(c.Name, serverRef.Trim(), StringComparison.OrdinalIgnoreCase));
    }
}
