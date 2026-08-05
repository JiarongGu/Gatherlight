namespace Gatherlight.Server.Platform.Agent.Ui.Models;

/// <summary>
/// The <c>ui-block</c> SSE payload. <c>status</c> is partial | ready | invalid. A partial block
/// carries no payload at all — half a JSON tree is not something to put on the wire — and an
/// invalid one carries the raw text so the user can see what the app could not display.
/// </summary>
public sealed record UiBlockEvent(int Segment, string Status, UiNode? Node = null, string? Raw = null, string? Reason = null);
