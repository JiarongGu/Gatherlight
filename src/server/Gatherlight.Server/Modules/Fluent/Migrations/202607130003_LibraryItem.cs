using FluentMigrator;

namespace Gatherlight.Server.Modules.Fluent.Migrations;

/// <summary>
/// The knowledge library: verified reference entities (attractions / restaurants / hotels /
/// experiences) the planner reuses across trips. Unlike plans (markdown, for display) this is
/// structured KNOWLEDGE — first-class columns so the browse gallery can filter by kind + region,
/// search name/summary, and sort by confidence. The agent curates it via the library_* MCP tools
/// (replacing the old hand-written JAPAN_ATTRACTIONS.md pattern).
/// </summary>
[Migration(202607130003)]
public sealed class LibraryItem : global::FluentMigrator.Migration
{
    public override void Up()
    {
        Create.Table("library_item")
            .WithColumn("id").AsInt64().PrimaryKey().Identity()
            .WithColumn("kind").AsString().NotNullable().Indexed()      // attraction / restaurant / hotel / experience / other
            .WithColumn("key").AsString().NotNullable()                 // slug, unique within a kind
            .WithColumn("name").AsString().NotNullable()
            .WithColumn("name_local").AsString().Nullable()             // local-language name
            .WithColumn("region").AsString().Nullable().Indexed()       // e.g. "Kyoto, Japan"
            .WithColumn("summary").AsString().Nullable()
            .WithColumn("url").AsString().Nullable()                    // official site
            .WithColumn("image_url").AsString().Nullable()
            .WithColumn("lat").AsDouble().Nullable()
            .WithColumn("lng").AsDouble().Nullable()
            .WithColumn("tags").AsString().Nullable()                   // comma-separated
            .WithColumn("source").AsString().Nullable()                 // provenance: wikipedia / tabelog / ...
            .WithColumn("confidence").AsDouble().NotNullable().WithDefaultValue(0.7)
            .WithColumn("verified_at").AsString().Nullable()
            .WithColumn("created_at").AsString().NotNullable()
            .WithColumn("updated_at").AsString().NotNullable();

        // Natural upsert key — one row per (kind, key). Enables ON CONFLICT(kind, key).
        Create.Index("ux_library_item_kind_key").OnTable("library_item")
            .OnColumn("kind").Ascending().OnColumn("key").Ascending()
            .WithOptions().Unique();
    }

    public override void Down() => Delete.Table("library_item");
}
