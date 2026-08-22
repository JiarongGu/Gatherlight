using FluentMigrator;

namespace Gatherlight.Server.Platform.Hosting.Fluent.Migrations;

/// <summary>
/// Alternate phrasings for a fact, so a paraphrase finds it without a vector.
///
/// <para><b>Why this exists.</b> 语义 recall was defined as embeddings, which made it unavailable on any
/// install that cannot or will not run a model locally — a machine with no GPU to spare, or one whose GPU
/// is needed for something else, or a household that declines the download. On those installs the layer
/// simply had no option, and the panel explained why instead of offering one. Claude cannot embed (no
/// embeddings endpoint exists), but it can say the same fact several ways, and a stored phrasing is
/// findable by the trigram index we already have.</para>
///
/// <para><b>Why a column and not a table.</b> These are not facts. They carry no confidence, no source and
/// no history; they are a search aid for exactly one row, they are regenerated when the fact changes, and
/// they are worthless on their own. A side table would invite them to be read as content. Nullable because
/// the overwhelmingly common state is "not expanded" — this is off unless a household binds 语义 to the
/// CLI arm, and every fact written before that stays exactly as findable as it was.</para>
///
/// <para><b>The FTS table has to be rebuilt, not altered.</b> FTS5 has no ADD COLUMN: an external-content
/// virtual table's column list is fixed at creation, and its triggers name the columns explicitly. So the
/// table and all three triggers are dropped and recreated with <c>aka</c> included, then backfilled from
/// <c>knowledge</c>. That is the whole reason this is a migration rather than a settings change.</para>
///
/// <para><b>Nothing in the recall query changes.</b> An FTS5 <c>MATCH</c> with no column filter spans every
/// indexed column, so adding one makes phrasings searchable with no edit to <c>RecallAsync</c> — and with
/// bm25 still ranking, a fact matched only through a phrasing sorts below one matched in its own text,
/// which is the correct order.</para>
/// </summary>
[Migration(202608220001)]
public sealed class KnowledgeAka : global::FluentMigrator.Migration
{
    public override void Up()
    {
        Alter.Table("knowledge").AddColumn("aka").AsString().Nullable();

        // Triggers first: they reference the virtual table, and dropping it under them would leave three
        // triggers writing to something that no longer exists.
        Execute.Sql("DROP TRIGGER IF EXISTS knowledge_ai;");
        Execute.Sql("DROP TRIGGER IF EXISTS knowledge_ad;");
        Execute.Sql("DROP TRIGGER IF EXISTS knowledge_au;");
        Execute.Sql("DROP TABLE IF EXISTS knowledge_fts;");

        Execute.Sql("""
            CREATE VIRTUAL TABLE knowledge_fts USING fts5(
                topic, content, source, aka,
                content='knowledge', content_rowid='id', tokenize='trigram'
            );
            """);
        // COALESCE on every nullable column: an external-content FTS row with a NULL is a row that never
        // matches, which is silent — the same class of failure the whole index exists to avoid.
        Execute.Sql("""
            INSERT INTO knowledge_fts(rowid, topic, content, source, aka)
            SELECT id, topic, content, COALESCE(source,''), COALESCE(aka,'') FROM knowledge;
            """);
        Execute.Sql("""
            CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge BEGIN
              INSERT INTO knowledge_fts(rowid, topic, content, source, aka)
              VALUES (new.id, new.topic, new.content, COALESCE(new.source,''), COALESCE(new.aka,''));
            END;
            """);
        Execute.Sql("""
            CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge BEGIN
              INSERT INTO knowledge_fts(knowledge_fts, rowid, topic, content, source, aka)
              VALUES ('delete', old.id, old.topic, old.content, COALESCE(old.source,''), COALESCE(old.aka,''));
            END;
            """);
        Execute.Sql("""
            CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge BEGIN
              INSERT INTO knowledge_fts(knowledge_fts, rowid, topic, content, source, aka)
              VALUES ('delete', old.id, old.topic, old.content, COALESCE(old.source,''), COALESCE(old.aka,''));
              INSERT INTO knowledge_fts(rowid, topic, content, source, aka)
              VALUES (new.id, new.topic, new.content, COALESCE(new.source,''), COALESCE(new.aka,''));
            END;
            """);
    }

    /// <summary>Back to the three-column index. The phrasings themselves are dropped with the column —
    /// they are derived, and re-binding the CLI arm regenerates them.</summary>
    public override void Down()
    {
        Execute.Sql("DROP TRIGGER IF EXISTS knowledge_ai;");
        Execute.Sql("DROP TRIGGER IF EXISTS knowledge_ad;");
        Execute.Sql("DROP TRIGGER IF EXISTS knowledge_au;");
        Execute.Sql("DROP TABLE IF EXISTS knowledge_fts;");
        Delete.Column("aka").FromTable("knowledge");

        Execute.Sql("""
            CREATE VIRTUAL TABLE knowledge_fts USING fts5(
                topic, content, source,
                content='knowledge', content_rowid='id', tokenize='trigram'
            );
            """);
        Execute.Sql("""
            INSERT INTO knowledge_fts(rowid, topic, content, source)
            SELECT id, topic, content, COALESCE(source,'') FROM knowledge;
            """);
        Execute.Sql("""
            CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge BEGIN
              INSERT INTO knowledge_fts(rowid, topic, content, source)
              VALUES (new.id, new.topic, new.content, COALESCE(new.source,''));
            END;
            """);
        Execute.Sql("""
            CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge BEGIN
              INSERT INTO knowledge_fts(knowledge_fts, rowid, topic, content, source)
              VALUES ('delete', old.id, old.topic, old.content, COALESCE(old.source,''));
            END;
            """);
        Execute.Sql("""
            CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge BEGIN
              INSERT INTO knowledge_fts(knowledge_fts, rowid, topic, content, source)
              VALUES ('delete', old.id, old.topic, old.content, COALESCE(old.source,''));
              INSERT INTO knowledge_fts(rowid, topic, content, source)
              VALUES (new.id, new.topic, new.content, COALESCE(new.source,''));
            END;
            """);
    }
}
