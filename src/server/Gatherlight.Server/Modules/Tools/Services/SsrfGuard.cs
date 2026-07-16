using System.Net;
using System.Net.Sockets;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Tools.Services;

/// <summary>
/// SSRF guard for agent-driven fetches/scrapes. The spawned agent (or an MCP client) can pass any URL;
/// without this it could reach the cloud metadata endpoint (169.254.169.254) or a localhost/LAN admin
/// service and get the rendered body back. Resolves the host and refuses loopback / link-local /
/// private / unique-local / CGNAT / multicast targets. No-op under a test fixture origin (navigation is
/// rewritten to a trusted local server).
/// </summary>
public static class SsrfGuard
{
    public static async Task AssertPublicAsync(string url, CancellationToken ct = default)
    {
        // e2e rewrites navigation to a local fixture server — don't block that trusted redirect.
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("GATHERLIGHT_FIXTURE_ORIGIN"))) return;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return;   // scheme already validated by caller

        IPAddress[] addrs;
        if (IPAddress.TryParse(uri.Host, out var literal)) addrs = new[] { literal };
        else
        {
            try { addrs = await Dns.GetHostAddressesAsync(uri.Host, ct); }
            catch { throw new ToolException(400, $"无法解析主机:{uri.Host}"); }
        }
        // Refuse if ANY resolved address is internal (a public name could resolve to a private IP).
        foreach (var ip in addrs)
            if (IsInternal(ip))
                throw new ToolException(403, $"拒绝访问内网/本机地址:{uri.Host} → {ip}");
    }

    private static bool IsInternal(IPAddress ip)
    {
        if (IPAddress.IsLoopback(ip)) return true;
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        var b = ip.GetAddressBytes();

        if (ip.AddressFamily == AddressFamily.InterNetwork)
            return b[0] is 0 or 10 or 127                                   // "this", private-A, loopback
                || (b[0] == 172 && b[1] is >= 16 and <= 31)                 // private-B
                || (b[0] == 192 && b[1] == 168)                            // private-C
                || (b[0] == 169 && b[1] == 254)                            // link-local (incl. metadata 169.254.169.254)
                || (b[0] == 100 && b[1] is >= 64 and <= 127)               // CGNAT 100.64/10
                || (b[0] == 192 && b[1] == 0 && b[2] == 0)                 // IETF protocol assignments
                || b[0] >= 240;                                            // reserved / broadcast

        if (ip.AddressFamily == AddressFamily.InterNetworkV6)
            return ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal || ip.IsIPv6Multicast
                || ip.Equals(IPAddress.IPv6Any)
                || (b[0] & 0xfe) == 0xfc;                                  // unique-local fc00::/7

        return true;   // unknown family → refuse
    }
}
