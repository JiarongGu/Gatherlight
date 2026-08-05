using System.Collections.Concurrent;
using Gatherlight.Server.Platform.Capabilities.Models;

namespace Gatherlight.Server.Platform.Capabilities.Services;

/// <summary>
/// Capability grants allowed for the CURRENT agent run only — the chat escalation gate's "allow
/// once" (<c>remember:false</c>), never written to <c>site.json</c>. A Script capability's sandbox
/// grant is baked into its <c>ScriptTool</c> instance at load time (<c>ScriptToolProvider.Reload</c>),
/// so even a one-time allow has to flow through a reload — <see cref="Tools.Services.IScriptToolProvider.Reload"/>
/// merges <see cref="Current"/> alongside <c>site.json</c>'s persisted <c>capabilities.enabled</c> —
/// it is just never written to disk, and a reload after <see cref="Clear"/> makes it un-happen.
///
/// Implemented as ONE global set, not one keyed by a session id. The whole app runs at most one agent
/// task at a time — chat and background jobs share a single lease (<c>IAgentGate</c>) — so whichever
/// run is live is the only thing that can ever populate or consult this, and
/// <c>ChatSessionService</c> clears it the moment ITS session reaches a terminal phase, before any
/// later run could ever observe it. That invariant is what makes a global set an honest
/// implementation of "this run only" rather than a shortcut around it.
/// </summary>
public interface ISessionCapabilityAllowance
{
    IReadOnlyList<CapabilityGrant> Current { get; }
    void Allow(CapabilityGrant grant);
    void Clear();
}

public sealed class SessionCapabilityAllowance : ISessionCapabilityAllowance
{
    private readonly ConcurrentDictionary<string, CapabilityGrant> _grants = new(StringComparer.OrdinalIgnoreCase);

    public IReadOnlyList<CapabilityGrant> Current => _grants.Values.ToList();
    public void Allow(CapabilityGrant grant) => _grants[grant.Id] = grant;
    public void Clear() => _grants.Clear();
}
