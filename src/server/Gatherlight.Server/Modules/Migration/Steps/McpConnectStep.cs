using Gatherlight.Server.Modules.McpClient.Services;
using Gatherlight.Server.Modules.Migration.Services;

namespace Gatherlight.Server.Modules.Migration.Steps;

/// <summary>
/// Initial connect to the enabled external MCP servers, once the DB (and its <c>mcp_server</c>
/// table) is migrated. Best-effort: a server that's down must never block startup — it's marked
/// <c>error</c> in the store and contributes no tools. Must run AFTER <c>DbMigrateStep</c>.
/// </summary>
public sealed class McpConnectStep : IMigrationStep
{
    private readonly IMcpConnectionManager _mgr;
    public McpConnectStep(IMcpConnectionManager mgr) => _mgr = mgr;

    public string Id => "mcp-connect";
    public string Title => "连接外部 MCP 服务";
    public bool Essential => false;

    public Task RunAsync(CancellationToken ct) => _mgr.ReloadAsync(ct);
}
