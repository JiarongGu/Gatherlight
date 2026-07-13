using FluentMigrator;

namespace Gatherlight.Server.Modules.Fluent.Migrations;

/// <summary>
/// Generalized storage: a generic entity store (JSON documents by kind+key), a learned-knowledge
/// store the agent can write/query across sessions (confidence + EMA reinforcement), and a
/// unified process log. Markdown stays the source of truth for plans and curated rules — these
/// tables hold app data and granular learned facts.
/// </summary>
[Migration(202607130002)]
public sealed class GeneralizedStores : Migration
{
    public override void Up()
    {
        // Generic JSON document store — new data kinds need no migration.
        // Composite PK must be inline — SQLite has no ALTER TABLE ADD CONSTRAINT.
        Create.Table("entity")
            .WithColumn("kind").AsString().NotNullable().PrimaryKey()
            .WithColumn("key").AsString().NotNullable().PrimaryKey()
            .WithColumn("value_json").AsString().NotNullable()
            .WithColumn("updated_at").AsString().NotNullable();

        // Learned facts (agent-writable via remember_fact / recall_facts MCP tools).
        Create.Table("knowledge")
            .WithColumn("id").AsInt64().PrimaryKey().Identity()
            .WithColumn("kind").AsString().NotNullable().Indexed()
            .WithColumn("topic").AsString().NotNullable().Indexed()
            .WithColumn("content").AsString().NotNullable()
            .WithColumn("source").AsString().Nullable()
            .WithColumn("confidence").AsDouble().NotNullable().WithDefaultValue(0.7)
            .WithColumn("hits").AsInt32().NotNullable().WithDefaultValue(0)
            .WithColumn("created_at").AsString().NotNullable()
            .WithColumn("updated_at").AsString().NotNullable();

        // Unified process/update trail (seeder runs, imports, future jobs).
        Create.Table("process_log")
            .WithColumn("id").AsInt64().PrimaryKey().Identity()
            .WithColumn("kind").AsString().NotNullable().Indexed()
            .WithColumn("ref_id").AsString().Nullable()
            .WithColumn("status").AsString().NotNullable()
            .WithColumn("detail_json").AsString().Nullable()
            .WithColumn("created_at").AsString().NotNullable();
    }

    public override void Down()
    {
        Delete.Table("process_log");
        Delete.Table("knowledge");
        Delete.Table("entity");
    }
}
