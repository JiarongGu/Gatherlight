using FluentMigrator;

namespace Gatherlight.Server.Modules.Fluent.Migrations;

/// <summary>
/// Full-text search indexes for the knowledge library + fact store (replaces LIKE scans with
/// BM25-ranked FTS5). The content is heavily Chinese, so the <c>trigram</c> tokenizer is used — it
/// indexes overlapping 3-character sequences, giving indexed, case-insensitive SUBSTRING matching
/// that works for CJK (unicode61 would treat a whole Chinese phrase as one token). External-content
/// tables mirror <c>library_item</c>/<c>knowledge</c> by rowid and are kept in sync by triggers;
/// existing rows are backfilled here. The repositories fall back to LIKE for &lt;3-char queries.
/// </summary>
[Migration(202607130006)]
public sealed class SearchFts : Migration
{
    public override void Up()
    {
        // --- knowledge library ---
        Execute.Sql("""
            CREATE VIRTUAL TABLE library_fts USING fts5(
                name, name_local, region, summary, tags,
                content='library_item', content_rowid='id', tokenize='trigram'
            );
            """);
        Execute.Sql("""
            INSERT INTO library_fts(rowid, name, name_local, region, summary, tags)
            SELECT id, name, COALESCE(name_local,''), COALESCE(region,''), COALESCE(summary,''), COALESCE(tags,'')
            FROM library_item;
            """);
        Execute.Sql("""
            CREATE TRIGGER library_item_ai AFTER INSERT ON library_item BEGIN
              INSERT INTO library_fts(rowid, name, name_local, region, summary, tags)
              VALUES (new.id, new.name, COALESCE(new.name_local,''), COALESCE(new.region,''), COALESCE(new.summary,''), COALESCE(new.tags,''));
            END;
            """);
        Execute.Sql("""
            CREATE TRIGGER library_item_ad AFTER DELETE ON library_item BEGIN
              INSERT INTO library_fts(library_fts, rowid, name, name_local, region, summary, tags)
              VALUES ('delete', old.id, old.name, COALESCE(old.name_local,''), COALESCE(old.region,''), COALESCE(old.summary,''), COALESCE(old.tags,''));
            END;
            """);
        Execute.Sql("""
            CREATE TRIGGER library_item_au AFTER UPDATE ON library_item BEGIN
              INSERT INTO library_fts(library_fts, rowid, name, name_local, region, summary, tags)
              VALUES ('delete', old.id, old.name, COALESCE(old.name_local,''), COALESCE(old.region,''), COALESCE(old.summary,''), COALESCE(old.tags,''));
              INSERT INTO library_fts(rowid, name, name_local, region, summary, tags)
              VALUES (new.id, new.name, COALESCE(new.name_local,''), COALESCE(new.region,''), COALESCE(new.summary,''), COALESCE(new.tags,''));
            END;
            """);

        // --- fact store ---
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

    public override void Down()
    {
        Execute.Sql("DROP TRIGGER IF EXISTS library_item_ai; DROP TRIGGER IF EXISTS library_item_ad; DROP TRIGGER IF EXISTS library_item_au; DROP TABLE IF EXISTS library_fts;");
        Execute.Sql("DROP TRIGGER IF EXISTS knowledge_ai; DROP TRIGGER IF EXISTS knowledge_ad; DROP TRIGGER IF EXISTS knowledge_au; DROP TABLE IF EXISTS knowledge_fts;");
    }
}
