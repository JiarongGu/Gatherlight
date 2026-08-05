using System.Security.Cryptography;

namespace Gatherlight.Server.Platform.Hosting.Security.Services;

/// <summary>
/// The agent's own way in. The app's public listener carries whatever TLS and authentication the
/// household configured for REMOTE HUMANS — controls a child process on this machine has no way to
/// satisfy, and whose failure the CLI does not surface (the server simply contributes no tools, and
/// the agent reports them missing). So the agent gets a loopback-only, plain-HTTP endpoint instead.
///
/// It is not a hole in the controls it bypasses: it serves ONLY /mcp, requires a bearer token
/// generated fresh each start and never persisted, and is bound to 127.0.0.1 so it is unreachable
/// off-box by construction rather than by policy.
/// </summary>
public interface IInternalMcpEndpoint
{
    /// <summary>The bound port, or 0 before the server has started.</summary>
    int Port { get; }
    string Token { get; }
    string Url { get; }
    void Bound(int port);
}

public sealed class InternalMcpEndpoint : IInternalMcpEndpoint
{
    public int Port { get; private set; }
    // In memory only. Nothing on disk to leak, go stale, or be read by the next process.
    public string Token { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
    public string Url => $"http://127.0.0.1:{Port}/mcp";
    public void Bound(int port) => Port = port;
}
