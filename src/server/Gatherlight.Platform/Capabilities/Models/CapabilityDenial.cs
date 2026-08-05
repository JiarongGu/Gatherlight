namespace Gatherlight.Server.Platform.Capabilities.Models;

/// <summary>
/// A capability call the registry actually refused — the RUNTIME's own record of a denial, kept so
/// an escalation card is built from what was observed rather than from the agent's account of it. An
/// injected agent writes a reassuring explanation exactly when it matters most, so the thing the card
/// treats as fact must never come from the agent's own text.
/// </summary>
/// <param name="Id">The capability id the refused call named.</param>
/// <param name="Origin">Where it would come from if allowed. Decides what "allow" even means: a
/// Script capability needs a sandbox grant; Platform/Mcp need only the deny flag lifted.</param>
/// <param name="State">Why it was refused, at the moment it was refused (Denied or NotEnabled).</param>
/// <param name="At">When the refusal happened (UTC).</param>
public sealed record CapabilityDenial(string Id, CapabilityOrigin Origin, CapabilityState State, DateTime At);
