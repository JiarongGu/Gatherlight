using Dapper;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.McpClient.Models;

namespace Gatherlight.Server.Modules.McpClient.Services;

/// <summary>
/// Persistence for external MCP server config (the <c>mcp_server</c> table). Dapper + hand-written
/// SQL; snake_case columns map onto the model via the global <c>MatchNamesWithUnderscores</c>.
/// Secrets live in <c>secrets_json</c> and never leave this layer except into a live connection's
/// env/headers — the DTO projection drops them.
/// </summary>
public interface IMcpServerStore
{
    Task<List<McpServerConfig>> ListAsync();
    Task<List<McpServerConfig>> ListEnabledAsync();
    Task<McpServerConfig?> GetAsync(string id);
    Task UpsertAsync(McpServerConfig cfg);
    Task SetEnabledAsync(string id, bool enabled);
    Task SetStatusAsync(string id, string status, string? lastError, string? discoveredToolsJson);
    Task DeleteAsync(string id);
}

public sealed class McpServerStore : IMcpServerStore
{
    private readonly IDbConnectionFactory _db;
    public McpServerStore(IDbConnectionFactory db) => _db = db;

    private const string Cols =
        "id, name, transport, command, args_json, env_json, url, headers_json, secrets_json, " +
        "enabled, status, last_error, discovered_tools_json, login_kind, login_tool, login_check_tool, " +
        "created_at, updated_at";

    public async Task<List<McpServerConfig>> ListAsync()
    {
        using var conn = _db.Open();
        return (await conn.QueryAsync<McpServerConfig>(
            $"SELECT {Cols} FROM mcp_server ORDER BY created_at ASC")).ToList();
    }

    public async Task<List<McpServerConfig>> ListEnabledAsync()
    {
        using var conn = _db.Open();
        return (await conn.QueryAsync<McpServerConfig>(
            $"SELECT {Cols} FROM mcp_server WHERE enabled = 1 ORDER BY created_at ASC")).ToList();
    }

    public async Task<McpServerConfig?> GetAsync(string id)
    {
        using var conn = _db.Open();
        return await conn.QuerySingleOrDefaultAsync<McpServerConfig>(
            $"SELECT {Cols} FROM mcp_server WHERE id = @id", new { id });
    }

    public async Task UpsertAsync(McpServerConfig cfg)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            $"""
            INSERT INTO mcp_server({Cols})
            VALUES (@Id, @Name, @Transport, @Command, @ArgsJson, @EnvJson, @Url, @HeadersJson,
                    @SecretsJson, @Enabled, @Status, @LastError, @DiscoveredToolsJson,
                    @LoginKind, @LoginTool, @LoginCheckTool, @CreatedAt, @UpdatedAt)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name, transport = excluded.transport, command = excluded.command,
                args_json = excluded.args_json, env_json = excluded.env_json, url = excluded.url,
                headers_json = excluded.headers_json, secrets_json = excluded.secrets_json,
                login_kind = excluded.login_kind, login_tool = excluded.login_tool,
                login_check_tool = excluded.login_check_tool,
                enabled = excluded.enabled, updated_at = excluded.updated_at
            """,
            cfg);
    }

    public async Task SetEnabledAsync(string id, bool enabled)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            "UPDATE mcp_server SET enabled = @enabled, updated_at = @now WHERE id = @id",
            new { id, enabled, now = DateTime.UtcNow.ToString("o") });
    }

    public async Task SetStatusAsync(string id, string status, string? lastError, string? discoveredToolsJson)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync(
            """
            UPDATE mcp_server SET status = @status, last_error = @lastError,
                discovered_tools_json = COALESCE(@discoveredToolsJson, discovered_tools_json),
                updated_at = @now
            WHERE id = @id
            """,
            new { id, status, lastError, discoveredToolsJson, now = DateTime.UtcNow.ToString("o") });
    }

    public async Task DeleteAsync(string id)
    {
        using var conn = _db.Open();
        await conn.ExecuteAsync("DELETE FROM mcp_server WHERE id = @id", new { id });
    }
}
