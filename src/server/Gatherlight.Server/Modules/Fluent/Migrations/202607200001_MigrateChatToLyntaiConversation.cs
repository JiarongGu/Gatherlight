using FluentMigrator;

namespace Gatherlight.Server.Modules.Fluent.Migrations;

/// <summary>
/// The two-gate conversation persistence moved onto Lyntai's generic conversation store
/// (<c>lyntai_thread</c>/<c>lyntai_message</c>); the app no longer reads or writes its own
/// <c>chat_session</c>/<c>chat_event</c>. Copy any historical rows forward, then drop the two dead tables.
///
/// This is a ONE-TIME, schema-coupled data migration (like <c>202607190001</c> for scores) — distinct from
/// runtime store access, which goes through the <c>IConversationStore</c> API. SQL here lets us preserve the
/// original <c>created_at</c> (the API assigns its own on create). Ordering is safe: Lyntai's
/// <c>UseSqliteStorage</c> migrates its tables EAGERLY during DI, so <c>lyntai_thread</c>/<c>lyntai_message</c>
/// already exist when this runs.
///
/// Session columns fold into the thread's opaque JSON <c>metadata</c> (camelCase keys matching
/// <c>SessionMetadata</c>, which the eval console + scoring parse back). Each event becomes a typed message
/// (kind + payload + preserved per-thread seq); message ids are fresh GUIDs. <c>INSERT OR IGNORE</c> so a
/// re-run (or a thread already created by the live app) is not clobbered.
/// </summary>
[Migration(202607200001)]
public sealed class MigrateChatToLyntaiConversation : Migration
{
    public override void Up()
    {
        Execute.Sql("""
            INSERT OR IGNORE INTO lyntai_thread (id, title, created_at, metadata)
            SELECT id, NULL, created_at,
                   json_object('phase', phase, 'mode', mode, 'userMessage', user_message, 'planText', plan_text,
                               'claudeSessionId', claude_session_id, 'commitSha', commit_sha, 'error', error,
                               'attachments', attachments_json)
            FROM chat_session;
            """);
        Execute.Sql("""
            INSERT OR IGNORE INTO lyntai_message (id, thread_id, seq, kind, payload, metadata, created_at)
            SELECT lower(hex(randomblob(16))), session_id, seq, kind, payload_json, NULL, created_at
            FROM chat_event;
            """);
        Delete.Table("chat_event");
        Delete.Table("chat_session");
    }

    public override void Down()
    {
        // One-way retirement: recreate empty shells so a rollback isn't a hard failure; the rows live in
        // Lyntai's conversation store now and are NOT moved back.
        Create.Table("chat_session")
            .WithColumn("id").AsString().NotNullable().PrimaryKey()
            .WithColumn("phase").AsString().NotNullable()
            .WithColumn("mode").AsString().NotNullable()
            .WithColumn("user_message").AsString().NotNullable()
            .WithColumn("attachments_json").AsString().Nullable()
            .WithColumn("plan_text").AsString().Nullable()
            .WithColumn("claude_session_id").AsString().Nullable()
            .WithColumn("commit_sha").AsString().Nullable()
            .WithColumn("error").AsString().Nullable()
            .WithColumn("created_at").AsString().NotNullable()
            .WithColumn("updated_at").AsString().NotNullable();
        Create.Table("chat_event")
            .WithColumn("session_id").AsString().NotNullable()
            .WithColumn("seq").AsInt32().NotNullable()
            .WithColumn("kind").AsString().NotNullable()
            .WithColumn("payload_json").AsString().NotNullable()
            .WithColumn("created_at").AsString().NotNullable();
    }
}
