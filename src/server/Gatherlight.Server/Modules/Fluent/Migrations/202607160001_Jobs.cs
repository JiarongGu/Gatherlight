using FluentMigrator;

namespace Gatherlight.Server.Modules.Fluent.Migrations;

/// <summary>
/// Background jobs: generic one-off / recurring scheduled work (agent tasks, tool calls,
/// notifications, reports) driven by <c>JobSchedulerService</c>. A job kind is an
/// <c>IJobHandler</c>; <c>config_json</c> is the opaque per-handler payload. Runs are logged in
/// <c>job_run</c> (cost/history + staged-for-review agent diffs); user-facing pings land in
/// <c>notification</c>. See <c>docs/background-jobs-design.md</c>.
/// </summary>
[Migration(202607160001)]
public sealed class Jobs : global::FluentMigrator.Migration
{
    public override void Up()
    {
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
    }

    public override void Down()
    {
        Delete.Table("notification");
        Delete.Table("job_run");
        Delete.Table("job");
    }
}
