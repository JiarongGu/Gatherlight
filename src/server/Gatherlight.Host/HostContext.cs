using Gatherlight.Server;

namespace Gatherlight.Host;

/// <summary>The host actions the native tray menu needs. (The management UI itself is the web
/// /manage page in the WebView2; it talks to the server API + posts host-bridge messages.)</summary>
internal sealed class HostContext
{
    public required GatherlightServerOptions Options { get; init; }
    public required string Url { get; init; }
    public required Action ShowWindow { get; init; }
    public required Action OpenBrowser { get; init; }
    public required Action OpenDataFolder { get; init; }
    public required Action Restart { get; init; }
    public required Action Exit { get; init; }
}
