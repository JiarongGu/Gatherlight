using FluentMigrator;

namespace Gatherlight.Server.Modules.Fluent.Migrations;

/// <summary>
/// Generic interactive-login config for external MCP servers. A server that needs a browser/QR
/// login (e.g. Xiaohongshu) declares <c>login_kind</c> + the tool names to drive it — the
/// <c>McpLoginService</c> calls <c>login_tool</c> (which returns a QR image / URL), renders it, and
/// polls <c>login_check_tool</c> until logged in. Reusable across any server that follows that
/// shape; the session persists in the server's own storage under the data folder. See
/// docs/mcp-client-design.md.
/// </summary>
[Migration(202607220002)]
public sealed class McpServerLogin : global::FluentMigrator.Migration
{
    public override void Up()
    {
        Alter.Table("mcp_server")
            .AddColumn("login_kind").AsString().NotNullable().WithDefaultValue("none") // none | qr | browser
            .AddColumn("login_tool").AsString().Nullable()          // tool that starts login (returns QR/URL)
            .AddColumn("login_check_tool").AsString().Nullable();   // tool polled for login success
    }

    public override void Down()
    {
        Delete.Column("login_kind").FromTable("mcp_server");
        Delete.Column("login_tool").FromTable("mcp_server");
        Delete.Column("login_check_tool").FromTable("mcp_server");
    }
}
