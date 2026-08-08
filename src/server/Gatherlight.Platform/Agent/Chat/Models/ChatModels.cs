using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using Gatherlight.Server.Platform.Agent.Llm.Models;
using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Agent.Ui.Models;
using Gatherlight.Server.Platform.Capabilities.McpClient.Models;
using Gatherlight.Server.Platform.Capabilities.McpClient.Services;
using Gatherlight.Server.Platform.Capabilities.Models;
using Gatherlight.Server.Platform.Storage.DataRepo.Services;

// The chat MODEL types: the phase vocabulary, the live session, and the payloads its gates park
// with. Split out of ChatSessionService.cs, which had grown to hold the model, the run pipeline
// and all five gates in one file. Namespace unchanged — this is a file move, not a redesign.
namespace Gatherlight.Server.Platform.Agent.Chat.Services;

public static class ChatPhase
{
    public const string Idle = "idle";
    public const string Planning = "planning";
    public const string AwaitingPlanApproval = "awaiting-plan-approval";
    public const string Executing = "executing";
    public const string Validating = "validating";
    public const string AwaitingDiffApproval = "awaiting-diff-approval";
    // The agent paused mid-execute needing a human decision (a NEEDS_INPUT question, or it made no
    // committable change). NON-terminal: the session stays live, holding the agent slot, with any
    // partial edits kept on disk — the human's reply resumes execute from here.
    public const string AwaitingInput = "awaiting-input";
    // The agent proposed adding an external MCP server; parked for the human to confirm the CONCRETE
    // spec (+ enter any credentials) before anything connects. NON-terminal, holds the agent slot.
    public const string AwaitingMcpApproval = "awaiting-mcp-approval";
    // The agent hit a login-walled MCP server and asked for interactive login; a QR/URL is shown in
    // chat, and the agent resumes automatically once the human completes the scan. NON-terminal.
    public const string AwaitingLogin = "awaiting-login";
    // The agent drafted a new tool (.claude/tool-drafts/<id>/) and wants it enabled; parked showing a
    // card built from PermissionSentence over the draft's OWN grant, never from the agent's words.
    // NON-terminal, holds the agent slot — approving promotes it and resumes so the agent can use it.
    public const string AwaitingDraftApproval = "awaiting-draft-approval";
    // A capability call was refused (NotEnabled/Denied) and the agent surfaced it instead of working
    // around it; parked showing a card built from the runtime's OWN record of the denial
    // (ICapabilityDenialLog), never from the agent's account. NON-terminal, holds the agent slot.
    public const string AwaitingCapabilityApproval = "awaiting-capability-approval";
    public const string Committing = "committing";
    public const string Building = "building";
    public const string Committed = "committed";
    public const string Rejected = "rejected";
    public const string Cancelled = "cancelled";
    public const string Error = "error";

    public static readonly string[] Terminal = { Committed, Rejected, Cancelled, Error };
}

/// <summary>What the diff gate shows. <see cref="Pages"/> rides on the PAYLOAD rather than on
/// <see cref="DiffFile"/> deliberately: DiffFile is git's shape and three other modules consume it
/// (JobHandlers, UnattendedRunService, ZhikuMigrator).</summary>
public sealed record ReviewPayload(List<DiffFile> Files, bool HasClaudeInfra, ClaudeValidation? Validation,
    BuildResult? Build = null, List<PageDiffView>? Pages = null);

/// <summary>The action state behind a parked gate's buttons, stored in the session's own metadata.
/// See <c>ChatSessionService.GateStateOf</c> for why this is separate from the card.</summary>
public sealed record GateState(
    List<string> TrackedPaths,
    // Card: the phase event's own Data, exactly as it was emitted. Some gates — notably
    // awaiting-input — carry their question and their option buttons ONLY here; the snapshot endpoint
    // does not project them, so without this a restored input gate would ask the household to answer
    // a question it no longer displays.
    JsonElement? Card,
    McpProposal? McpProposal,
    McpLoginPrompt? McpLogin,
    CapabilityDraft? PendingDraft,
    CapabilityDenial? PendingDenial,
    string? PendingDenialReason,
    CapabilityGrant? PendingDenialGrant);

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
    /// <summary>The conversation this turn belongs to. A thread is ONE turn; the multi-turn
    /// conversation the user sees is the run of turns sharing this id (stored in the thread's
    /// app-owned metadata), so history can group them without a migration.</summary>
    public required string ConversationId { get; init; }
    /// <summary>Set when the agent proposed adding an external MCP server (phase awaiting-mcp-approval);
    /// the concrete draft the human confirms. Cleared on approve/reject. Never carries secrets — those
    /// are supplied by the human at the gate and go straight to the provision service.</summary>
    public McpProposal? McpProposal { get; set; }
    /// <summary>Set when the agent asked to log into an MCP server (phase awaiting-login): which
    /// server + the QR/URL challenge to show. Cleared when login completes and the agent resumes.</summary>
    public McpLoginPrompt? McpLogin { get; set; }
    /// <summary>Set when the agent proposed a tool draft (phase awaiting-draft-approval): the parsed
    /// draft the human is deciding on. Cleared on approve/reject.</summary>
    public CapabilityDraft? PendingDraft { get; set; }
    /// <summary>Set when a capability call was refused and the agent surfaced it (phase
    /// awaiting-capability-approval): the runtime's own record of the denial. Cleared on the
    /// allow/deny decision.</summary>
    public CapabilityDenial? PendingDenial { get; set; }
    /// <summary>The agent's OWN explanation accompanying a CAPABILITY_BLOCKED marker — carried
    /// separately from <see cref="PendingDenial"/> so the card can label it as the assistant's
    /// claim rather than the system's account of what happened.</summary>
    public string? PendingDenialReason { get; set; }
    /// <summary>The grant the card shown for <see cref="PendingDenial"/> was built from (null for a
    /// Platform/Mcp origin) — captured once at park time so a reconnecting client's snapshot renders
    /// the exact same clauses the live SSE card did, not a freshly re-derived (and possibly
    /// different) one.</summary>
    public CapabilityGrant? PendingDenialGrant { get; set; }
    /// <summary>The most recent phase event's Data — the card the client was last shown. Kept so a
    /// restart can re-emit it; see <see cref="GateState.Card"/>.</summary>
    public JsonElement? LastPhaseCard { get; set; }
    /// <summary>Sequential persistence chain so DB writes keep event order without
    /// blocking the emit path.</summary>
    public Task PersistChain = Task.CompletedTask;
}

/// <summary>A parsed, secret-free proposal to add an external MCP server (from an agent-emitted
/// <c>MCP_ADD:</c> marker). <see cref="NeededCredentials"/> are the credential KEYS the human must
/// fill in at the confirmation gate (e.g. <c>XHS_COOKIE</c>); their values never appear here.</summary>
public sealed record McpProposal(McpAddRequest Draft, IReadOnlyList<string> NeededCredentials);

/// <summary>The interactive-login prompt shown in chat when the agent hit a login-walled server:
/// which server, and the QR/URL challenge from its login tool.</summary>
public sealed record McpLoginPrompt(string ServerId, string ServerName, McpLoginChallenge Challenge);
