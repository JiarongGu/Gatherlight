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
}

/// <summary>Convenience base — schemas are pure data.</summary>
public abstract class UiNodeSchema : IUiNodeSchema
{
    public abstract string Type { get; }
    public virtual bool AcceptsChildren => false;
    public virtual IReadOnlyDictionary<string, UiPropSpec> Props =>
        new Dictionary<string, UiPropSpec>(StringComparer.Ordinal);

    protected static Dictionary<string, UiPropSpec> P(params (string Name, UiPropSpec Spec)[] items)
    {
        var d = new Dictionary<string, UiPropSpec>(StringComparer.Ordinal);
        foreach (var (n, s) in items) d[n] = s;
        return d;
    }
}
