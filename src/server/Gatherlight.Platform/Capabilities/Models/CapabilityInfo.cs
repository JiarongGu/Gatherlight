namespace Gatherlight.Server.Platform.Capabilities.Models;

/// <summary>Where a capability came from. Provenance decides its treatment: what we shipped is
/// trusted and unsandboxed; anything else is off until enabled, and contained when it runs.</summary>
public enum CapabilityOrigin { Platform, Script, Mcp, Draft }

public enum CapabilityState { Available, NotEnabled, Denied }

/// <summary>One capability as the console and the agent see it — the single projection, so what the
/// agent can call and what the console displays can never disagree.</summary>
public sealed record CapabilityInfo(
    string Id,
    CapabilityOrigin Origin,
    string Title,
    string Description,
    string InputSchema,
    CapabilityState State);
