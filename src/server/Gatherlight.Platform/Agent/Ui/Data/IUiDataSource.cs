namespace Gatherlight.Server.Platform.Agent.Ui.Data;

public enum UiParamKind { String, Number, Bool }

/// <summary>One declared parameter of a data source. The set is CLOSED — a param the source did not
/// declare fails validation, so an agent cannot smuggle an extra key past a source that ignores it
/// today and grows a meaning for it tomorrow.</summary>
public sealed record UiParamSpec(UiParamKind Kind, bool Required = false, string[]? OneOf = null);

/// <summary>The parameters a binding supplied, already shape-validated against the source's
/// declaration. Values are scalars only; there is no structure to unpack and nothing to evaluate.</summary>
public sealed record UiBindArgs(IReadOnlyDictionary<string, string> Values)
{
    public string? Str(string name) => Values.TryGetValue(name, out var v) ? v : null;

    public int Int(string name, int fallback)
        => Values.TryGetValue(name, out var v) && int.TryParse(v, out var n) ? n : fallback;
}

/// <summary>
/// What a source returns. ONE shape — rows of strings — deliberately, so a source can be written
/// without knowing which component will bind to it, and so adding a source never widens this type.
/// <paramref name="Truncated"/> is not decoration: a capped result that does not say it was capped
/// is a false readout of the household's own data, so the resolver renders the cap into the node.
/// </summary>
public sealed record UiData(IReadOnlyList<IReadOnlyList<string>> Rows, bool Truncated = false)
{
    public static readonly UiData Empty = new(Array.Empty<IReadOnlyList<string>>());
}

/// <summary>
/// One named, parameterized query a page may bind to. Registered as a DI collection
/// (<c>AddSingleton&lt;IUiDataSource, …&gt;</c>) — one class plus one registration per query, never a
/// switch, the same shape as <c>IUiNodeSchema</c>, <c>IScorer</c> and <c>IGatherlightTool</c>.
///
/// The agent NAMES a source and supplies declared parameters; it never writes the query. That is
/// <c>runCapability</c>'s rule applied to reading: a filter expression authored by the agent is a
/// program authored by the one participant the threat model says can be prompt-injected, evaluated
/// against the household's own database. An id and a closed parameter set cannot be one.
///
/// This interface is Platform; a source that knows what a "trip" is belongs in Planner.
/// </summary>
public interface IUiDataSource
{
    /// <summary>The id a binding names. Stable — it is written into pages the household keeps.</summary>
    string Id { get; }

    /// <summary>One line, rendered into <c>.claude/ui-spec.md</c>: what the agent is told this returns.</summary>
    string Description { get; }

    /// <summary>The columns, in order, that <see cref="UiData.Rows"/> carries. Also rendered into the
    /// contract so the agent can write matching `columns` on a bound Table.</summary>
    IReadOnlyList<string> Columns { get; }

    IReadOnlyDictionary<string, UiParamSpec> Params { get; }

    Task<UiData> FetchAsync(UiBindArgs args, CancellationToken ct);
}

/// <summary>Convenience base — a source is a query plus a declaration.</summary>
public abstract class UiDataSource : IUiDataSource
{
    /// <summary>The most rows any source may return. A page is a readout, not an export; past this
    /// the table stops being readable on a phone long before it stops being expensive.</summary>
    public const int MaxRows = 200;

    public abstract string Id { get; }
    public abstract string Description { get; }
    public abstract IReadOnlyList<string> Columns { get; }

    public virtual IReadOnlyDictionary<string, UiParamSpec> Params =>
        new Dictionary<string, UiParamSpec>(StringComparer.Ordinal);

    public abstract Task<UiData> FetchAsync(UiBindArgs args, CancellationToken ct);

    protected static Dictionary<string, UiParamSpec> P(params (string Name, UiParamSpec Spec)[] items)
    {
        var d = new Dictionary<string, UiParamSpec>(StringComparer.Ordinal);
        foreach (var (n, s) in items) d[n] = s;
        return d;
    }

    /// <summary>
    /// Cut a result to <paramref name="limit"/> and SAY when there was more. "Truncated" means
    /// exactly that — there is more than you are seeing — which is why the source must hand in what
    /// it found rather than a pre-cut list: a list already cut to the limit cannot tell the
    /// difference between "that is all of it" and "there is more", and quietly showing the first ten
    /// of fifty as though it were fifty is a false readout of the household's own records.
    /// </summary>
    protected static UiData Limited(IReadOnlyList<IReadOnlyList<string>> found, int limit)
    {
        var take = Math.Clamp(limit, 1, MaxRows);
        return found.Count > take
            ? new UiData(found.Take(take).ToList(), Truncated: true)
            : new UiData(found);
    }

    /// <summary>For a source with no limit of its own — the platform cap still applies, and is still
    /// announced.</summary>
    protected static UiData Capped(IReadOnlyList<IReadOnlyList<string>> found) => Limited(found, MaxRows);
}
