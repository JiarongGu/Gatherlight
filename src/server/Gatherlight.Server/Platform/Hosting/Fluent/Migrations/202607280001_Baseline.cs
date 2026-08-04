using FluentMigrator;

namespace Gatherlight.Server.Platform.Hosting.Fluent.Migrations;

/// <summary>
/// The 1.0 baseline — a one-time squash of the accreted 0.x ledger (11 migrations) into a single
/// clean starting point, mirroring Lyntai's own 1.0 baseline reset. It builds the current NET
/// app-owned schema directly: the tables the old migrations netted out to, minus the ones they
/// created and then retired. Specifically ABSENT (superseded by Lyntai's stores, dropped by the old
/// 0.x→Lyntai data bridges): <c>chat_score</c> (→ <c>lyntai_score_result</c>) and
/// <c>chat_session</c>/<c>chat_event</c> (→ <c>lyntai_thread</c>/<c>lyntai_message</c>). Those bridges
/// were one-time data moves; a fresh DB has nothing to migrate, and durable data travels via the
/// whole-install backup (records + memory bundle), so a full reset loses nothing durable.
///
/// This is post-squash a normal append-only ledger again: the NEXT schema change is a new
/// <c>YYYYMMDDNNNN</c> migration on top of this, never an edit here. Lyntai owns its own <c>lyntai_*</c>
/// tables + <c>lyntai_version_info</c> (migrated eagerly by <c>UseSqliteStorage</c>); this baseline is
/// the app's half of the shared <c>gatherlight.db</c>.
/// </summary>
[Migration(202607280001)]
public sealed class Baseline : global::FluentMigrator.Migration
{
    public override void Up()
    {
        // --- app state + derived indexes (was InitialSchema, minus the retired chat_session/chat_event) ---

        // Dynamic key→value config (prompt overrides, model routing, timeouts, flags).
        Create.Table("app_config")
            .WithColumn("key").AsString().PrimaryKey()
            .WithColumn("value").AsString().NotNullable();

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

        // --- generalized stores (was GeneralizedStores) ---

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

        // Unified process/update trail (seeder runs, imports, jobs).
        Create.Table("process_log")
            .WithColumn("id").AsInt64().PrimaryKey().Identity()
            .WithColumn("kind").AsString().NotNullable().Indexed()
            .WithColumn("ref_id").AsString().Nullable()
            .WithColumn("status").AsString().NotNullable()
            .WithColumn("detail_json").AsString().Nullable()
            .WithColumn("created_at").AsString().NotNullable();

        // --- knowledge library (was LibraryItem) ---
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

        // --- per-conversation feedback (was ChatFeedback) ---
        Create.Table("chat_feedback")
            .WithColumn("session_id").AsString().NotNullable().PrimaryKey()
            .WithColumn("rating").AsInt32().NotNullable()     // 1..5
            .WithColumn("note").AsString().Nullable()
            .WithColumn("created_at").AsString().NotNullable()
            .WithColumn("updated_at").AsString().NotNullable();

        // --- FTS5-trigram search over the library + fact store (was SearchFts) ---
        // External-content tables mirror library_item/knowledge by rowid, kept in sync by triggers.
        // The trigram tokenizer gives indexed CJK substring recall (unicode61 treats a whole Chinese
        // phrase as one token). Backfills below are no-ops on a fresh DB (empty content tables) but
        // kept for fidelity. Raw SQL: FluentMigrator has no fts5 / trigger builder.

        // knowledge library
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

        // fact store
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

        // --- background jobs (was Jobs) ---
        Create.Table("job")
            .WithColumn("id").AsString().NotNullable().PrimaryKey()
            .WithColumn("name").AsString().NotNullable()
            .WithColumn("kind").AsString().NotNullable()            // agent | tool | notify | report
            .WithColumn("config_json").AsString().NotNullable()     // opaque per-handler payload
            .WithColumn("schedule_kind").AsString().NotNullable()   // once | cron
            .WithColumn("cron").AsString().Nullable()               // cron expr when schedule_kind=cron
            .WithColumn("run_at").AsString().Nullable()             // ISO-8601 UTC when schedule_kind=once
            .WithColumn("timezone").AsString().Nullable()           // IANA tz for cron evaluation (null = UTC)
            .WithColumn("enabled").AsBoolean().NotNullable().WithDefaultValue(true)
            .WithColumn("auto_commit").AsBoolean().NotNullable().WithDefaultValue(false)
            .WithColumn("timeout_seconds").AsInt32().Nullable()     // null = jobs.defaultTimeoutSeconds
            .WithColumn("max_runs").AsInt32().Nullable()            // null = unlimited
            .WithColumn("run_count").AsInt32().NotNullable().WithDefaultValue(0)
            .WithColumn("consecutive_failures").AsInt32().NotNullable().WithDefaultValue(0)
            .WithColumn("next_run_at").AsString().Nullable()        // ISO-8601 UTC; the scheduler polls this
            .WithColumn("last_run_at").AsString().Nullable()
            .WithColumn("last_status").AsString().Nullable()
            .WithColumn("created_at").AsString().NotNullable()
            .WithColumn("updated_at").AsString().NotNullable();

        // The scheduler's hot query: enabled jobs whose next_run_at has passed.
        Create.Index("ix_job_due").OnTable("job").OnColumn("next_run_at").Ascending();

        Create.Table("job_run")
            .WithColumn("id").AsString().NotNullable().PrimaryKey()
            .WithColumn("job_id").AsString().NotNullable()
            .WithColumn("started_at").AsString().NotNullable()
            .WithColumn("finished_at").AsString().Nullable()
            // running | success | failed | timeout | staged | rejected | skipped
            .WithColumn("status").AsString().NotNullable()
            .WithColumn("outcome").AsString().Nullable()            // short one-line summary
            .WithColumn("detail").AsString().Nullable()             // output / error / report path / staged patch+diff json
            .WithColumn("tokens").AsInt32().Nullable()              // best-effort from the CLI result
            .WithColumn("duration_ms").AsInt64().Nullable();

        Create.Index("ix_job_run_job").OnTable("job_run").OnColumn("job_id").Ascending();

        Create.Table("notification")
            .WithColumn("id").AsString().NotNullable().PrimaryKey()
            .WithColumn("created_at").AsString().NotNullable()
            .WithColumn("kind").AsString().NotNullable()            // info | job-result | reminder | error
            .WithColumn("title").AsString().NotNullable()
            .WithColumn("body").AsString().Nullable()
            .WithColumn("link").AsString().Nullable()               // deep-link (e.g. a staged run to review)
            .WithColumn("read").AsBoolean().NotNullable().WithDefaultValue(false)
            .WithColumn("source_job_id").AsString().Nullable();

        Create.Index("ix_notification_unread").OnTable("notification").OnColumn("read").Ascending();

        // --- external MCP servers (was McpServers + McpServerLogin; login columns appended last to
        //     preserve the original ALTER-ADD-COLUMN ordering) ---
        Create.Table("mcp_server")
            .WithColumn("id").AsString().NotNullable().PrimaryKey()
            .WithColumn("name").AsString().NotNullable()
            .WithColumn("transport").AsString().NotNullable()            // stdio | http
            .WithColumn("command").AsString().Nullable()                 // stdio: executable
            .WithColumn("args_json").AsString().Nullable()               // stdio: JSON string[]
            .WithColumn("env_json").AsString().Nullable()                // stdio: JSON {k:v} (non-secret)
            .WithColumn("url").AsString().Nullable()                     // http: endpoint
            .WithColumn("headers_json").AsString().Nullable()            // http: JSON {k:v} (non-secret)
            .WithColumn("secrets_json").AsString().Nullable()            // SERVER-ONLY: JSON {k:v} → env/headers
            .WithColumn("enabled").AsBoolean().NotNullable().WithDefaultValue(true)
            .WithColumn("status").AsString().NotNullable().WithDefaultValue("pending") // pending|connected|error|disabled
            .WithColumn("last_error").AsString().Nullable()
            .WithColumn("discovered_tools_json").AsString().Nullable()   // cache of the last tools/list
            .WithColumn("created_at").AsString().NotNullable()
            .WithColumn("updated_at").AsString().NotNullable()
            .WithColumn("login_kind").AsString().NotNullable().WithDefaultValue("none") // none | qr | browser
            .WithColumn("login_tool").AsString().Nullable()          // tool that starts login (returns QR/URL)
            .WithColumn("login_check_tool").AsString().Nullable();   // tool polled for login success
    }

    public override void Down()
    {
        Execute.Sql("DROP TRIGGER IF EXISTS knowledge_ai; DROP TRIGGER IF EXISTS knowledge_ad; DROP TRIGGER IF EXISTS knowledge_au; DROP TABLE IF EXISTS knowledge_fts;");
        Execute.Sql("DROP TRIGGER IF EXISTS library_item_ai; DROP TRIGGER IF EXISTS library_item_ad; DROP TRIGGER IF EXISTS library_item_au; DROP TABLE IF EXISTS library_fts;");
        Delete.Table("mcp_server");
        Delete.Table("notification");
        Delete.Table("job_run");
        Delete.Table("job");
        Delete.Table("chat_feedback");
        Delete.Table("library_item");
        Delete.Table("process_log");
        Delete.Table("knowledge");
        Delete.Table("entity");
        Delete.Table("zhiku_state");
        Delete.Table("data_commit");
        Delete.Table("upload");
        Delete.Table("tool_cache");
        Delete.Table("plan_asset");
        Delete.Table("plan_index");
        Delete.Table("chat_turn");
        Delete.Table("app_config");
    }
}
