using FluentMigrator;

namespace Gatherlight.Server.Modules.Fluent.Migrations;

/// <summary>
/// Automated scorer results — one row per (conversation, scorer). Mastra-style: each scorer grades a
/// committed conversation on a named dimension (0–1) with a reason; deterministic (code) or LLM-judged.
/// Joined with chat_session + chat_feedback (the human rating) it makes the tuning/eval dataset richer:
/// human signal + machine signal. Upsert per (session, scorer) so re-scoring replaces.
/// </summary>
[Migration(202607130005)]
public sealed class ChatScore : global::FluentMigrator.Migration
{
    public override void Up()
    {
        // Composite PK inline at CreateTable (same named key on both columns) — SQLite has no
        // ALTER ADD CONSTRAINT, so a separate Create.PrimaryKey().OnTable() would throw.
        Create.Table("chat_score")
            .WithColumn("session_id").AsString().NotNullable().PrimaryKey("pk_chat_score")
            .WithColumn("scorer_id").AsString().NotNullable().PrimaryKey("pk_chat_score")
            .WithColumn("score").AsDouble().NotNullable()      // 0..1
            .WithColumn("reason").AsString().Nullable()
            .WithColumn("is_llm").AsInt32().NotNullable().WithDefaultValue(0)
            .WithColumn("created_at").AsString().NotNullable();
    }

    public override void Down() => Delete.Table("chat_score");
}
