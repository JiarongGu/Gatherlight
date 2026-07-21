using FluentMigrator;

namespace Gatherlight.Server.Modules.Fluent.Migrations;

/// <summary>
/// Per-conversation feedback (a 1–5 ranking + optional note) collected from the planner chat. Joined
/// with chat_session/chat_event it becomes the tuning/eval dataset for the LLM (cortex) — surfaced +
/// exportable from the management console's observability view. One row per session (upsert).
/// </summary>
[Migration(202607130004)]
public sealed class ChatFeedback : global::FluentMigrator.Migration
{
    public override void Up()
    {
        Create.Table("chat_feedback")
            .WithColumn("session_id").AsString().NotNullable().PrimaryKey()
            .WithColumn("rating").AsInt32().NotNullable()     // 1..5
            .WithColumn("note").AsString().Nullable()
            .WithColumn("created_at").AsString().NotNullable()
            .WithColumn("updated_at").AsString().NotNullable();
    }

    public override void Down() => Delete.Table("chat_feedback");
}
