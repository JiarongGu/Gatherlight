using FluentMigrator;

namespace Gatherlight.Server.Modules.Fluent.Migrations;

/// <summary>
/// Initial schema. App state + derived indexes only — the markdown artifacts themselves live as
/// files in the data folder under its own git repo; SQLite never stores plan content as the
/// source of truth (plan_index carries a content hash + extracted metadata for zero-LLM browse).
/// </summary>
[Migration(202607130001)]
public sealed class InitialSchema : global::FluentMigrator.Migration
{
    public override void Up()
    {
        // Dynamic key→value config (prompt overrides, model routing, timeouts, flags).
        Create.Table("app_config")
            .WithColumn("key").AsString().PrimaryKey()
            .WithColumn("value").AsString().NotNullable();

        // One chat task = one session row; rehydrated on restart for inspection (an in-flight
        // run that dies with the server is marked error).
        Create.Table("chat_session")
            .WithColumn("id").AsString().PrimaryKey()
            .WithColumn("phase").AsString().NotNullable().Indexed()
            .WithColumn("mode").AsString().NotNullable()
            .WithColumn("user_message").AsString().NotNullable()
            .WithColumn("attachments_json").AsString().Nullable()
            .WithColumn("plan_text").AsString().Nullable()
            .WithColumn("claude_session_id").AsString().Nullable()
            .WithColumn("commit_sha").AsString().Nullable()
            .WithColumn("error").AsString().Nullable()
            .WithColumn("created_at").AsString().NotNullable()
            .WithColumn("updated_at").AsString().NotNullable();

        // Agent event log per session — SSE replay on reconnect + history/inspection.
        Create.Table("chat_event")
            .WithColumn("id").AsInt64().PrimaryKey().Identity()
            .WithColumn("session_id").AsString().NotNullable().Indexed()
            .WithColumn("seq").AsInt32().NotNullable()
            .WithColumn("kind").AsString().NotNullable()
            .WithColumn("payload_json").AsString().NotNullable()
            .WithColumn("created_at").AsString().NotNullable();

        // Durable thread context: one-line summaries of recent turns injected into the next
        // plan prompt (reset rules: idle window / turn cap / post-commit).
        Create.Table("chat_turn")
            .WithColumn("id").AsInt64().PrimaryKey().Identity()
            .WithColumn("message").AsString().NotNullable()
            .WithColumn("outcome").AsString().NotNullable()
            .WithColumn("created_at").AsString().NotNullable();

        // Derived index over the markdown tree — powers browse/search with zero LLM tokens.
        Create.Table("plan_index")
            .WithColumn("path").AsString().PrimaryKey()
            .WithColumn("category").AsString().NotNullable().Indexed()
            .WithColumn("subgroup").AsString().Nullable()
            .WithColumn("name").AsString().NotNullable()
            .WithColumn("title").AsString().NotNullable()
            .WithColumn("plan_date").AsString().Nullable()
            .WithColumn("content_hash").AsString().NotNullable()
            .WithColumn("size_bytes").AsInt64().NotNullable().WithDefaultValue(0)
            .WithColumn("updated_at").AsString().NotNullable();

        // Non-markdown assets paired with a trip slug (visa PDFs, data JSON).
        Create.Table("plan_asset")
            .WithColumn("path").AsString().PrimaryKey()
            .WithColumn("slug").AsString().NotNullable().Indexed()
            .WithColumn("category").AsString().NotNullable()
            .WithColumn("kind").AsString().NotNullable()
            .WithColumn("filename").AsString().NotNullable()
            .WithColumn("size_bytes").AsInt64().NotNullable().WithDefaultValue(0);

        // Cacheable tool results (scrapers etc.) keyed by args hash, TTL per tool.
        // Composite PK must be inline — SQLite has no ALTER TABLE ADD CONSTRAINT.
        Create.Table("tool_cache")
            .WithColumn("tool").AsString().NotNullable().PrimaryKey()
            .WithColumn("args_hash").AsString().NotNullable().PrimaryKey()
            .WithColumn("result_json").AsString().NotNullable()
            .WithColumn("created_at").AsString().NotNullable()
            .WithColumn("expires_at").AsString().Nullable();

        // Chat attachment uploads ({data}/uploads/...).
        Create.Table("upload")
            .WithColumn("id").AsString().PrimaryKey()
            .WithColumn("rel_path").AsString().NotNullable()
            .WithColumn("original_name").AsString().NotNullable()
            .WithColumn("mime").AsString().NotNullable()
            .WithColumn("size_bytes").AsInt64().NotNullable().WithDefaultValue(0)
            .WithColumn("created_at").AsString().NotNullable();

        // Audit index over the data repo's commits (who/what kind: chat / fs-op / seed).
        Create.Table("data_commit")
            .WithColumn("sha").AsString().PrimaryKey()
            .WithColumn("message").AsString().NotNullable()
            .WithColumn("session_id").AsString().Nullable()
            .WithColumn("kind").AsString().NotNullable()
            .WithColumn("created_at").AsString().NotNullable();

        // Knowledge-base seeder bookkeeping (shipped-file hashes, template version).
        Create.Table("zhiku_state")
            .WithColumn("key").AsString().PrimaryKey()
            .WithColumn("value").AsString().NotNullable();
    }

    public override void Down()
    {
        Delete.Table("zhiku_state");
        Delete.Table("data_commit");
        Delete.Table("upload");
        Delete.Table("tool_cache");
        Delete.Table("plan_asset");
        Delete.Table("plan_index");
        Delete.Table("chat_turn");
        Delete.Table("chat_event");
        Delete.Table("chat_session");
        Delete.Table("app_config");
    }
}
