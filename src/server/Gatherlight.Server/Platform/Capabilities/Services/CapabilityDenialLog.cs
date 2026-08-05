using System.Collections.Concurrent;
using Gatherlight.Server.Platform.Capabilities.Models;

namespace Gatherlight.Server.Platform.Capabilities.Services;

/// <summary>
/// The most recent refusal per capability id. <c>ToolRegistry</c> records one every time it turns
/// away a Denied/NotEnabled call, and the chat escalation gate (S2b) reads it back to build the
/// approval card from what the RUNTIME saw, never from the agent's own words. One entry per id (a
/// fresh refusal simply overwrites the last), which is exactly what a <c>CAPABILITY_BLOCKED: &lt;id&gt;</c>
/// marker that follows it refers to.
/// </summary>
public interface ICapabilityDenialLog
{
    void Record(string id, CapabilityOrigin origin, CapabilityState state);

    /// <summary>The last recorded refusal for <paramref name="id"/>, or null if none was ever
    /// recorded — an unknown id, so the marker naming it must not park a gate with nothing to
    /// decide.</summary>
    CapabilityDenial? Last(string id);
}

public sealed class CapabilityDenialLog : ICapabilityDenialLog
{
    private readonly ConcurrentDictionary<string, CapabilityDenial> _last = new(StringComparer.OrdinalIgnoreCase);

    public void Record(string id, CapabilityOrigin origin, CapabilityState state) =>
        _last[id] = new CapabilityDenial(id, origin, state, DateTime.UtcNow);

    public CapabilityDenial? Last(string id) => _last.TryGetValue(id, out var d) ? d : null;
}
