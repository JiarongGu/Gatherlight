namespace Gatherlight.Server.Platform.Agent.Ui.Schemas;

public enum UiPropKind
{
    String,       // any string
    Number,       // int or double
    Bool,
    StringArray,  // ["a","b"]
    Rows,         // [["a","b"],["c","d"]] — array of string arrays
    Points,       // [{name,lat,lng}] — map points
    Action,       // {"send":"…"} | {"openRecord":"…"} — validated by IUiActionValidator
    Src,          // a record path or an https URL
    Href,         // an http/https URL
    Numbers,      // [1, 2, 3] — array of numbers
    Binding,      // {"query":"records","params":{…}} — names a registered IUiDataSource
}

public sealed record UiPropSpec(UiPropKind Kind, bool Required = false, string[]? OneOf = null);

/// <summary>
/// One component's contract. Registered as a DI collection
/// (<c>AddSingleton&lt;IUiNodeSchema, …&gt;</c>) so adding a component is a class plus one
/// registration — never a switch. An unregistered <c>type</c> has no schema and fails validation
/// in exactly one place.
/// </summary>
public interface IUiNodeSchema
{
    string Type { get; }
    bool AcceptsChildren { get; }
    IReadOnlyDictionary<string, UiPropSpec> Props { get; }

    /// <summary>The props a <c>bind</c> supplies in place of literal values — <c>rows</c> for a
    /// Table, <c>labels</c>+<c>values</c> for a Chart. Empty means the component cannot be bound.
    /// A node may carry the binding OR the literals, never both: two sources of truth for the same
    /// cells is a page that can disagree with itself, and no rule about which one wins is one a
    /// household could be expected to know.</summary>
    IReadOnlyList<string> BindFills { get; }
}

/// <summary>Convenience base — schemas are pure data.</summary>
public abstract class UiNodeSchema : IUiNodeSchema
{
    public abstract string Type { get; }
    public virtual bool AcceptsChildren => false;
    public virtual IReadOnlyDictionary<string, UiPropSpec> Props =>
        new Dictionary<string, UiPropSpec>(StringComparer.Ordinal);
    public virtual IReadOnlyList<string> BindFills => Array.Empty<string>();

    protected static Dictionary<string, UiPropSpec> P(params (string Name, UiPropSpec Spec)[] items)
    {
        var d = new Dictionary<string, UiPropSpec>(StringComparer.Ordinal);
        foreach (var (n, s) in items) d[n] = s;
        return d;
    }
}
