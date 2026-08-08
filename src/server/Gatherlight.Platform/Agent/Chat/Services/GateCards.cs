using Gatherlight.Server.Platform.Capabilities.Models;

namespace Gatherlight.Server.Platform.Agent.Chat.Services;

/// <summary>
/// Builds the CARD a parked gate shows the household.
///
/// Every one of these is a pure projection from what the RUNTIME knows — a parsed proposal, a draft
/// and its own grant, the denial log's record — into the shape the client renders. That purity is the
/// design, not a coincidence: a card is the sentence a household agrees to, so it must be derivable
/// from enforced facts alone. A projection with no reach into session state or services cannot
/// quietly start describing something other than what will be enforced.
///
/// Kept apart from the gate ACTIONS for the same reason the markers are: the next card belongs in a
/// file about cards, not appended to the class that also drives runs and holds sessions.
/// </summary>
internal static class GateCards
{
    /// <summary>The concrete, secret-free spec shown at the awaiting-mcp-approval gate — rendered from
    /// the PARSED draft, so a prompt-injection can propose but the human sees the exact command/url
    /// before approving.
    ///
    /// <c>sandboxed:false</c> + <c>can</c> are the honesty half, and they are NOT decoration: unlike a
    /// Script capability, an external MCP server is spawned by a plain <c>Process.Start</c> and runs
    /// with the host account's full privileges. The household is being asked to trust a third-party
    /// package, so the card states what it will be able to do rather than staying silent and letting
    /// the launch command imply a containment that does not exist. Server-rendered from
    /// <see cref="PermissionSentence"/> like every other clause — the agent proposes the server, never
    /// the words describing what approving it means.</summary>
    internal static object McpProposal(McpProposal p) => new
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

    /// <summary>The approval card's data. <c>can</c>/<c>cannot</c> come from <see cref="PermissionSentence"/>
    /// over the draft's OWN grant — never from the draft's text — so they cannot be worded more
    /// reassuringly by whatever wrote the draft. <c>description</c> and <c>entrySource</c> ARE the
    /// draft's own text and ride in separate fields precisely so the client can label them as the
    /// assistant's claim rather than fold them into the enforced clauses.</summary>
    internal static object DraftApproval(CapabilityDraft draft) => new
    {
        id = draft.Id,
        title = draft.Title,
        description = draft.Description,
        can = PermissionSentence.Can(draft.Grant),
        cannot = PermissionSentence.Cannot(draft.Grant),
        entrySource = draft.EntrySource,
    };

    /// <summary>The escalation card's data. <c>can</c>/<c>cannot</c> describe the grant an "allow"
    /// would create — from <see cref="PermissionSentence"/>, never from the agent — and are empty for
    /// Platform/Mcp origins, where that vocabulary corresponds to no real enforcement.
    /// <c>agentReason</c> is whatever the agent said and MUST stay a separate field: the client labels
    /// it as the assistant's claim, never the system's account of the denial (that account is
    /// <c>id</c>/<c>origin</c>/<c>state</c>, from the runtime's own denial-log record).</summary>
    internal static object CapabilityApproval(CapabilityDenial denial, CapabilityGrant? grant, string agentReason) => new
    {
        id = denial.Id,
        origin = denial.Origin.ToString(),
        state = denial.State.ToString(),
        can = grant is null ? Array.Empty<string>() : PermissionSentence.Can(grant),
        cannot = grant is null ? Array.Empty<string>() : PermissionSentence.Cannot(grant),
        agentReason,
    };

    /// <summary>The QR/URL challenge shown in chat (secret-free — it's just a login prompt).</summary>
    internal static object McpLogin(McpLoginPrompt p) => new
    {
        serverId = p.ServerId,
        serverName = p.ServerName,
        kind = p.Challenge.Kind,
        imageDataUri = p.Challenge.ImageDataUri,
        url = p.Challenge.Url,
        text = p.Challenge.Text,
        message = p.Challenge.Message,
    };
}
