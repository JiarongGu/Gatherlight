using Lyntai.Memory;
using Microsoft.Extensions.Logging;

namespace Gatherlight.Server.Platform.Storage.Knowledge.Services;

/// <summary>One ranked hit from the derived index: where the fact lives, and how well remembered it is.</summary>
/// <param name="GraphRef">Opaque address, resolved back to a <c>knowledge</c> row by the store.</param>
/// <param name="Retrievability">0..1, how far the entry has decayed. Reported to the agent so a faint
/// fact is visibly faint rather than silently equal to a fresh one.</param>
/// <param name="Degree">How many other facts this one is linked to.</param>
public sealed record FactHit(string GraphRef, double Retrievability, int Degree);

/// <summary>A fact opened up: its own text plus the headlines it is connected to.</summary>
public sealed record FactExpansion(string GraphRef, string Headline, string? Content,
    IReadOnlyList<string> Neighbours);

/// <summary>A ranking plus 3.0's abstention signal: <c>Answered</c> is true when a judge found an
/// answer, false when a judge looked and found none, null when nothing was judged (no judge
/// registered, or it failed — fail-open).</summary>
public sealed record FactRanking(IReadOnlyList<FactHit> Hits, bool? Answered)
{
    public static readonly FactRanking Empty = new([], null);
}

/// <summary>
/// The graph recall index over <c>knowledge</c> — Lyntai's <see cref="IMemoryEngine"/> in the shape this
/// app needs. DERIVED, always: <c>knowledge</c> is the record of truth, this ranks it.
///
/// <para>What it adds over the FTS recall it sits in front of: entries <b>decay</b> by what has happened
/// in the index rather than by the clock, so a scraped price nobody has used since sinks beneath fresher
/// material; recall <b>reinforces</b> what it returned, so facts that keep proving useful become durable;
/// and facts recalled together get <b>linked</b>, so a later query can reach material it never literally
/// matched. Decay only ever ranks — nothing is deleted here.</para>
///
/// <para><b>Every method degrades to nothing rather than throwing.</b> A fact store that fails closed is
/// worse than one that ranks by relevance alone: the caller falls back to FTS and the household still
/// finds what they know. That is why <see cref="Available"/> exists and why the operations swallow into
/// a log — the index is an optimisation over a store that already worked.</para>
/// </summary>
public interface IFactIndex
{
    /// <summary>False when no memory engine is registered — callers then use FTS alone.</summary>
    bool Available { get; }

    /// <summary>Index one fact; returns its address, or null if the index is unavailable or refused it.</summary>
    Task<string?> IndexAsync(string kind, string topic, string content, CancellationToken ct = default);

    /// <summary>Rank facts for a query, best first. Empty means "use FTS", never "you have nothing".</summary>
    Task<FactRanking> RankAsync(string query, string? kind, int limit, CancellationToken ct = default);

    /// <summary>Open one fact: full text plus what it is linked to.</summary>
    Task<FactExpansion?> ExpandAsync(string graphRef, CancellationToken ct = default);

    /// <summary>Index facts that have no entry yet, leaving indexed ones untouched. Cheap, idempotent,
    /// and safe to run at every startup — which is the point: it back-fills what the household already
    /// knew when this index first shipped, and picks up anything written while it was unavailable.</summary>
    Task<int> SyncAsync(CancellationToken ct = default);

    /// <summary>Discard the index and rebuild it from the record of truth. Returns facts indexed.
    /// <para><b>Destructive of everything the index has learned</b> — decay positions, reinforcement and
    /// links all go. Reserved for when the facts themselves were replaced underneath it (a backup
    /// import); at startup use <see cref="SyncAsync"/>, or every restart would erase the accumulated
    /// ranking this exists to build.</para></summary>
    Task<int> RebuildAsync(CancellationToken ct = default);
}

public sealed class FactIndex : IFactIndex
{
    /// <summary>The engine registered in <c>GatherlightApp</c>; its graph member is <c>facts/graph</c>.</summary>
    public const string EngineName = "facts";
    private const string GraphMember = EngineName + "/graph";

    /// <summary>Lyntai scopes memory by (task, scope). The task is this consumer — the household's
    /// granular facts — and the scope is the fact's own <c>kind</c>, so a kind-filtered recall is a
    /// scoped recall rather than a filter applied after ranking.</summary>
    private const string TaskKey = "facts";

    private readonly IMemoryEngine? _engine;
    private readonly IMemoryGraphStore? _graph;
    private readonly IKnowledgeStore _store;
    private readonly ILogger<FactIndex>? _log;

    public FactIndex(IMemoryEngineFactory? engines, IKnowledgeStore store,
        IMemoryGraphStore? graph = null, ILogger<FactIndex>? log = null)
    {
        _store = store;
        _graph = graph;
        _log = log;
        if (engines is not null && engines.TryGet(EngineName, out var engine)) _engine = engine;
    }

    public bool Available => _engine is not null;

    public async Task<string?> IndexAsync(string kind, string topic, string content, CancellationToken ct = default)
    {
        if (_engine is null) return null;
        try
        {
            // Headline = the topic the household chose. Left null, the engine would derive one by
            // truncating the content, and a fact's own topic is a better one-line form than its first
            // eighty characters. Grade stays associative (Inherit → the graph's role): the curated
            // markdown is this product's authoritative tier, and marking facts authoritative would
            // exempt them from the decay that is the whole reason for indexing them.
            var reference = await _engine.RememberAsync(
                new MemoryWrite(TaskKey, kind, content, Headline: topic), ct);
            return Encode(reference);
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "fact index: could not index {Kind}/{Topic}; it stays findable by FTS", kind, topic);
            return null;
        }
    }

    public async Task<FactRanking> RankAsync(string query, string? kind, int limit,
        CancellationToken ct = default)
    {
        if (_engine is null) return FactRanking.Empty;
        try
        {
            // Over-ask. The graph dedups by CONTENT HASH, so editing a fact leaves its previous node
            // behind with no row pointing at it; those resolve to nothing and would otherwise shrink
            // the page the agent asked for. Orphans are cleared by RebuildAsync, not by recall.
            var want = Math.Min(limit * 3, 100);
            var recall = await _engine.RecallAsync(
                new MemoryQuery(TaskKey, Scope: kind, Query: query, Limit: want), ct);
            return new FactRanking(
                [.. recall.Items.Select(i => new FactHit(Encode(i.Reference), i.Retrievability, i.Degree))],
                recall.Answered);
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "fact index: recall failed; falling back to FTS");
            return FactRanking.Empty;
        }
    }

    public async Task<FactExpansion?> ExpandAsync(string graphRef, CancellationToken ct = default)
    {
        if (_engine is null || Decode(graphRef) is not { } reference) return null;
        try
        {
            if (_engine is not IExpandableMemory expandable) return null;
            var recall = await expandable.ExpandAsync(reference, ct: ct);
            if (recall.Items.Count == 0) return null;
            // The expanded entry comes back first; anything after it is what it is linked to.
            var self = recall.Items[0];
            return new FactExpansion(Encode(self.Reference), self.Headline, self.Content,
                [.. recall.Items.Skip(1).Select(i => i.Headline)]);
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "fact index: expand failed for {Ref}", graphRef);
            return null;
        }
    }

    public async Task<int> SyncAsync(CancellationToken ct = default)
    {
        if (_engine is null) return 0;
        try
        {
            var pending = (await _store.AllAsync()).Where(f => string.IsNullOrEmpty(f.GraphRef)).ToList();
            if (pending.Count == 0) return 0;
            var indexed = await IndexEachAsync(pending.Select(p => p.Row), ct);
            _log?.LogInformation("fact index: back-filled {Indexed}/{Pending} previously unindexed facts",
                indexed, pending.Count);
            return indexed;
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "fact index: back-fill failed; those facts stay findable by FTS");
            return 0;
        }
    }

    public async Task<int> RebuildAsync(CancellationToken ct = default)
    {
        if (_engine is null) return 0;
        try
        {
            // Discard first. Anything that replaces the facts underneath the index — a backup import
            // above all — leaves it describing material the household no longer has, and a stale index
            // is worse than none: it ranks confidently for facts that are gone. This is also why this
            // is NOT wired to IRecordIndex, whose step runs at every startup: the discard would erase
            // the decay positions, reinforcement and links that are the whole point.
            if (_graph is not null) await _graph.ForgetAsync(GraphMember, TaskKey, scope: null, ct);

            var facts = await _store.AllAsync();
            var indexed = await IndexEachAsync(facts.Select(f => f.Row), ct);
            _log?.LogInformation("fact index: rebuilt — {Indexed}/{Total} facts indexed", indexed, facts.Count);
            return indexed;
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "fact index: rebuild failed; recall stays on FTS");
            return 0;
        }
    }

    private async Task<int> IndexEachAsync(IEnumerable<KnowledgeRow> facts, CancellationToken ct)
    {
        var indexed = 0;
        foreach (var fact in facts)
        {
            ct.ThrowIfCancellationRequested();
            var reference = await IndexAsync(fact.Kind, fact.Topic, fact.Content, ct);
            // Written even when null: it clears a ref left over from a discarded index, so a row is
            // never pointing at a node that no longer exists.
            await _store.SetGraphRefAsync(fact.Id, reference);
            if (reference is not null) indexed++;
        }
        return indexed;
    }

    // A MemoryRef is (engine, id) and has to survive a round trip through a TEXT column. '#' cannot
    // appear in an engine name (they are hierarchical on '/'), so the split is unambiguous.
    private static string Encode(MemoryRef reference) => $"{reference.Engine}#{reference.Id}";

    private static MemoryRef? Decode(string graphRef)
    {
        var cut = graphRef.LastIndexOf('#');
        return cut > 0 ? new MemoryRef(graphRef[..cut], graphRef[(cut + 1)..]) : null;
    }
}
