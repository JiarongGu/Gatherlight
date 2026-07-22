using FluentMigrator;

namespace Gatherlight.Server.Modules.Fluent.Migrations;

/// <summary>
/// External MCP servers: Gatherlight-as-MCP-client config. Each row is one server Gatherlight
/// connects OUT to (stdio subprocess or remote http/SSE); its discovered tools are proxied into
/// the tool registry (namespaced <c>{serverId}__{tool}</c>) and become callable by the agent.
/// <c>secrets_json</c> holds login material (e.g. an XHS cookie) and is SERVER-SIDE ONLY — never in
/// list DTOs, the agent's read-scope, the chat transcript, or git. See docs/mcp-client-design.md.
/// </summary>
[Migration(202607220001)]
public sealed class McpServers : global::FluentMigrator.Migration
{
    public override void Up()
    {
        Create.Table("mcp_server")
            .WithColumn("id").AsString().NotNullable().PrimaryKey()
            .WithColumn("name").AsString().NotNullable()
            .WithColumn("transport").AsString().NotNullable()            // stdio | http
            .WithColumn("command").AsString().Nullable()                 // stdio: executable
            .WithColumn("args_json").AsString().Nullable()               // stdio: JSON string[]
            .WithColumn("env_json").AsString().Nullable()                // stdio: JSON {k:v} (non-secret)
            .WithColumn("url").AsString().Nullable()                     // http: endpoint
            .WithColumn("headers_json").AsString().Nullable()            // http: JSON {k:v} (non-secret)
            .WithColumn("secrets_json").AsString().Nullable()            // SERVER-ONLY: JSON {k:v} → env/headers
            .WithColumn("enabled").AsBoolean().NotNullable().WithDefaultValue(true)
            .WithColumn("status").AsString().NotNullable().WithDefaultValue("pending") // pending|connected|error|disabled
            .WithColumn("last_error").AsString().Nullable()
            .WithColumn("discovered_tools_json").AsString().Nullable()   // cache of the last tools/list
            .WithColumn("created_at").AsString().NotNullable()
            .WithColumn("updated_at").AsString().NotNullable();
    }

    public override void Down()
    {
        Delete.Table("mcp_server");
    }
}
