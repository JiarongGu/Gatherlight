using FluentMigrator;

namespace Gatherlight.Server.Modules.Fluent.Migrations;

/// <summary>
/// Scoring moved onto Lyntai's store (<c>lyntai_score_result</c>); the app no longer reads or writes the
/// legacy <c>chat_score</c> table. Copy any historical rows forward, then drop the dead table.
///
/// Ordering is safe: Lyntai's <c>UseSqliteStorage(dbPath)</c> runs its migrations EAGERLY during DI
/// composition (inside <c>AddLyntai</c> in <c>GatherlightApp.Build</c>), so <c>lyntai_score_result</c>
/// already exists when this FluentMigrator migration runs at startup (<c>MigrationRunnerService.MigrateToLatest</c>).
/// The two runners keep separate version tables in the one db, so this is the correct place for an
/// app→Lyntai data backfill — Lyntai owns its own schema; the app owns its legacy tables.
///
/// <c>INSERT OR IGNORE</c> on Lyntai's <c>UNIQUE(session_id, scorer_id)</c> key: a session already
/// re-scored under Lyntai keeps its newer verdict (the stale chat_score row is dropped, not restored).
/// <c>chat_score</c> lacks <c>scorer_name</c>/<c>score_group</c> (Lyntai requires them NOT NULL) and nothing
/// reads those off a stored row — the app derives the display name/group from the live <c>IScorer</c> list —
/// so backfill name = scorer_id, group = '' purely to satisfy the constraint.
/// </summary>
[Migration(202607190001)]
public sealed class MigrateChatScoreToLyntai : global::FluentMigrator.Migration
{
    public override void Up()
    {
        Execute.Sql("""
            INSERT OR IGNORE INTO lyntai_score_result
                (session_id, scorer_id, scorer_name, score_group, is_llm, score, reason, created_at)
            SELECT session_id, scorer_id, scorer_id, '', is_llm, score, reason, created_at
            FROM chat_score;
            """);
        Delete.Table("chat_score");
    }

    public override void Down()
    {
        // One-way retirement: recreate the empty shell so a rollback isn't a hard failure, but the copied
        // rows are NOT moved back — they live in lyntai_score_result now.
        Create.Table("chat_score")
            .WithColumn("session_id").AsString().NotNullable().PrimaryKey("pk_chat_score")
            .WithColumn("scorer_id").AsString().NotNullable().PrimaryKey("pk_chat_score")
            .WithColumn("score").AsDouble().NotNullable()
            .WithColumn("reason").AsString().Nullable()
            .WithColumn("is_llm").AsInt32().NotNullable().WithDefaultValue(0)
            .WithColumn("created_at").AsString().NotNullable();
    }
}
