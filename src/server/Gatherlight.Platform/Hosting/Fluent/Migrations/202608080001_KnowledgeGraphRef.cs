using FluentMigrator;

namespace Gatherlight.Server.Platform.Hosting.Fluent.Migrations;

/// <summary>
/// A fact's address in the graph recall index (Lyntai's <c>IMemoryGraphStore</c>, tables
/// <c>lyntai_memory_*</c>, migrated by Lyntai itself).
///
/// <para>The index is DERIVED: <c>knowledge</c> stays the record of truth, keeps travelling in the
/// backup, and can rebuild the graph from itself at any time — the same relationship the plan index
/// has to the markdown. This column is the join between the two, and it exists because recall has to
/// come back the other way: the graph ranks and returns <see cref="Lyntai.Memory.MemoryRef"/>s, and
/// those must resolve to the exact row that owns <c>source</c>, <c>confidence</c> and the id, with no
/// guessing. Matching on (kind, topic) instead would be ambiguous the moment two kinds share a topic,
/// and a fact attributed to the wrong source is worse than one that did not surface.</para>
///
/// <para>Nullable on purpose. A row with no ref is simply not indexed yet — which is the state of
/// every existing fact until the first rebuild, and the state of any fact written while the index is
/// unavailable. Recall falls back to FTS for those, so an un-indexed fact is still findable.</para>
/// </summary>
[Migration(202608080001)]
public sealed class KnowledgeGraphRef : global::FluentMigrator.Migration
{
    public override void Up() =>
        Alter.Table("knowledge").AddColumn("graph_ref").AsString().Nullable().Indexed();

    public override void Down() =>
        Delete.Column("graph_ref").FromTable("knowledge");
}
