using System.Text.Json;
using Gatherlight.Server.Platform.Agent.Ui.Data;
using Gatherlight.Server.Platform.Agent.Ui.Models;
using Gatherlight.Server.Platform.Agent.Ui.Schemas;
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Agent.Ui.Services;

public sealed record UiValidation(bool Ok, string? Reason, UiNode? Node)
{
    public static UiValidation Fail(string reason) => new(false, reason, null);
    public static UiValidation Pass(UiNode node) => new(true, null, node);
}

public interface IUiTreeValidator
{
    /// <param name="allowBindings">False for a ```ui fence in a streamed turn. A binding is a PAGE
    /// feature: a page is durable and goes stale, while a chat block is the agent showing data it has
    /// in hand this second. Refusing it here is not a limitation dressed as a rule — the chat emit
    /// seam is synchronous and streaming, so a binding it could not resolve would reach the renderer
    /// with no rows, and an empty table is indistinguishable from "you have nothing", which is a lie
    /// told on the household's own data.</param>
    UiValidation ValidateJson(string json, bool allowBindings = true);
    UiValidation ValidateElement(JsonElement root, bool allowBindings = true);
    IReadOnlyList<IUiNodeSchema> Schemas { get; }
    IReadOnlyList<IUiDataSource> Sources { get; }
}

/// <summary>
/// Validation is total and positive: an unknown type, an unknown prop, a wrong-typed prop, children
/// on a leaf, or a tree past the depth/size limits all fail. Nothing is sanitized into safety —
/// what is not defined does not render.
/// </summary>
public sealed class UiTreeValidator : IUiTreeValidator
{
    public const int MaxDepth = 12;
    public const int MaxNodes = 500;

    private readonly Dictionary<string, IUiNodeSchema> _schemas;
    private readonly IUiActionValidator _actions;
    private readonly ISiteContext _site;
    private readonly Dictionary<string, IUiDataSource> _sources;
    private readonly IUiCompositeStore _composites;

    public UiTreeValidator(IEnumerable<IUiNodeSchema> schemas, IUiActionValidator actions, ISiteContext site,
        IEnumerable<IUiDataSource> sources, IUiCompositeStore composites)
    {
        _schemas = schemas.ToDictionary(s => s.Type, StringComparer.Ordinal);
        _actions = actions;
        _site = site;
        _sources = sources.ToDictionary(s => s.Id, StringComparer.Ordinal);
        _composites = composites;
    }

    public IReadOnlyList<IUiNodeSchema> Schemas => _schemas.Values.OrderBy(s => s.Type, StringComparer.Ordinal).ToList();

    public IReadOnlyList<IUiDataSource> Sources => _sources.Values.OrderBy(s => s.Id, StringComparer.Ordinal).ToList();

    public UiValidation ValidateJson(string json, bool allowBindings = true)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException ex) { return UiValidation.Fail($"not valid JSON: {ex.Message}"); }
        using (doc) return ValidateElement(doc.RootElement, allowBindings);
    }

    public UiValidation ValidateElement(JsonElement root, bool allowBindings = true)
    {
        var count = 0;
        // Composites are read ONCE per validation, not per node: a tree using the same composite forty
        // times must not mean forty directory walks, and a definition changing mid-walk would validate
        // a tree that never existed.
        var composites = _composites.All();
        try { return UiValidation.Pass(Walk(root, 1, ref count, allowBindings, composites, insideComposite: false)); }
        catch (UiInvalidException ex) { return UiValidation.Fail(ex.Message); }
    }

    private sealed class UiInvalidException(string message) : Exception(message);

    private UiNode Walk(JsonElement el, int depth, ref int count, bool allowBindings,
        IReadOnlyDictionary<string, UiComposite> composites, bool insideComposite)
    {
        if (depth > MaxDepth) throw new UiInvalidException($"tree deeper than {MaxDepth} levels");
        if (++count > MaxNodes) throw new UiInvalidException($"tree larger than {MaxNodes} nodes");

        // A bare string child is shorthand for a Text node.
        if (el.ValueKind == JsonValueKind.String)
            return new UiNode
            {
                Type = "Text",
                Props = new(StringComparer.Ordinal) { ["text"] = el.Clone() },
            };

        if (el.ValueKind != JsonValueKind.Object) throw new UiInvalidException("a node must be an object or a string");
        if (!el.TryGetProperty("type", out var typeEl) || typeEl.ValueKind != JsonValueKind.String)
            throw new UiInvalidException("a node needs a string 'type'");

        var type = typeEl.GetString()!;
        if (!_schemas.TryGetValue(type, out var schema))
        {
            if (composites.TryGetValue(type, out var composite))
                return Expand(composite, el, depth, ref count, allowBindings, composites, insideComposite);
            throw new UiInvalidException($"unknown component '{type}'");
        }

        var node = new UiNode { Type = type };

        foreach (var prop in el.EnumerateObject())
        {
            if (prop.Name is "type") continue;
            if (prop.Name is "children")
            {
                if (!schema.AcceptsChildren) throw new UiInvalidException($"'{type}' does not take children");
                if (prop.Value.ValueKind != JsonValueKind.Array)
                    throw new UiInvalidException($"'{type}' children must be an array");
                foreach (var child in prop.Value.EnumerateArray())
                    node.Children.Add(Walk(child, depth + 1, ref count, allowBindings, composites, insideComposite));
                continue;
            }
            if (!schema.Props.TryGetValue(prop.Name, out var spec))
                throw new UiInvalidException($"'{type}' has no prop '{prop.Name}'");
            if (spec.Kind == UiPropKind.Binding && !allowBindings)
                throw new UiInvalidException($"'{type}.{prop.Name}': bindings work on pages (ui/<name>.json), not in a ```ui block — put the values in directly here");
            CheckProp(type, prop.Name, spec, prop.Value);
            node.Props[prop.Name] = prop.Value.Clone();
        }

        // A bound node takes its data from the query, so the literal props it replaces must be absent
        // (two sources of truth for the same cells is a page that can disagree with itself) and are
        // not required. Everything else about the node validates exactly as it would unbound.
        var bound = node.Props.ContainsKey("bind");
        if (bound)
            foreach (var filled in schema.BindFills)
                if (node.Props.ContainsKey(filled))
                    throw new UiInvalidException($"'{type}' has both 'bind' and '{filled}' — use one or the other");

        foreach (var (name, spec) in schema.Props)
            if (spec.Required && !node.Props.ContainsKey(name)
                && !(bound && schema.BindFills.Contains(name, StringComparer.Ordinal)))
                throw new UiInvalidException($"'{type}' requires prop '{name}'");

        // A chart plots pairs. Unequal lengths render a chart that silently drops or invents a bar,
        // so it fails here instead. Only checkable when both are literal; a bound pair is built by
        // the resolver from one row set and cannot be uneven.
        if (type == "Chart" && !bound
            && node.Props.TryGetValue("labels", out var labels) && node.Props.TryGetValue("values", out var values)
            && labels.GetArrayLength() != values.GetArrayLength())
            throw new UiInvalidException("'Chart.labels' and 'Chart.values' must be the same length");

        return node;
    }

    /// <summary>
    /// Replace a composite usage with its body, parameters substituted, and validate THAT. Expansion
    /// happens before validation on purpose: the depth and node limits then apply to what actually
    /// renders, so 500 nodes stays 500 nodes no matter how the tree was written.
    ///
    /// Three rules do the safety work, and each is a construction rather than a check-after-the-fact:
    /// a composite may not use another composite (so recursion cannot exist, rather than being
    /// detected); substitution is whole-value only (so a parameter can inject a value into a slot the
    /// definition chose, never structure); and a definition may not take the name of a primitive
    /// (so no page can quietly redefine what `Table` means).
    /// </summary>
    private UiNode Expand(UiComposite composite, JsonElement use, int depth, ref int count, bool allowBindings,
        IReadOnlyDictionary<string, UiComposite> composites, bool insideComposite)
    {
        if (insideComposite)
            throw new UiInvalidException($"'{composite.Name}' is used inside another component definition — a definition may only use built-in components");

        var args = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var prop in use.EnumerateObject())
        {
            if (prop.Name == "type") continue;
            if (prop.Name == "children")
                throw new UiInvalidException($"'{composite.Name}' does not take children — pass what it needs as parameters");
            if (!composite.Params.TryGetValue(prop.Name, out var kind))
                throw new UiInvalidException($"'{composite.Name}' has no parameter '{prop.Name}'");
            CheckParam(composite.Name, prop.Name, new UiParamSpec(kind), prop.Value);
            args[prop.Name] = prop.Value;
        }

        foreach (var pn in composite.Params.Keys)
            if (!args.ContainsKey(pn))
                throw new UiInvalidException($"'{composite.Name}' needs parameter '{pn}'");

        var body = Substitute(composite.Body, args, composite.Name);
        return Walk(body, depth, ref count, allowBindings, composites, insideComposite: true);
    }

    /// <summary>
    /// Whole-value substitution. A string that IS <c>{{name}}</c> becomes that argument; a string that
    /// merely contains one is an error, not a partial replacement — "Day {{day}}" would otherwise
    /// reach the household with the braces still in it, and supporting it properly would mean an
    /// expression language, which is the thing this design refuses to have.
    /// </summary>
    private static JsonElement Substitute(JsonElement el, IReadOnlyDictionary<string, JsonElement> args, string name)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.String:
            {
                var s = el.GetString()!;
                if (s.StartsWith("{{", StringComparison.Ordinal) && s.EndsWith("}}", StringComparison.Ordinal)
                    && s.IndexOf("{{", 2, StringComparison.Ordinal) < 0)
                {
                    var key = s[2..^2].Trim();
                    if (!args.TryGetValue(key, out var v))
                        throw new UiInvalidException($"'{name}' uses '{{{{{key}}}}}', which is not one of its parameters");
                    return v;
                }
                if (s.Contains("{{", StringComparison.Ordinal))
                    throw new UiInvalidException($"'{name}' mixes text with a placeholder in \"{s}\" — a placeholder must be the whole value");
                return el;
            }
            case JsonValueKind.Object:
            {
                using var buf = new MemoryStream();
                using (var w = new Utf8JsonWriter(buf))
                {
                    w.WriteStartObject();
                    foreach (var p in el.EnumerateObject())
                    {
                        w.WritePropertyName(p.Name);
                        Substitute(p.Value, args, name).WriteTo(w);
                    }
                    w.WriteEndObject();
                }
                return JsonDocument.Parse(buf.ToArray()).RootElement.Clone();
            }
            case JsonValueKind.Array:
            {
                using var buf = new MemoryStream();
                using (var w = new Utf8JsonWriter(buf))
                {
                    w.WriteStartArray();
                    foreach (var item in el.EnumerateArray()) Substitute(item, args, name).WriteTo(w);
                    w.WriteEndArray();
                }
                return JsonDocument.Parse(buf.ToArray()).RootElement.Clone();
            }
            default:
                return el;
        }
    }

    private void CheckProp(string type, string name, UiPropSpec spec, JsonElement v)
    {
        string Bad(string what) => $"'{type}.{name}' {what}";

        switch (spec.Kind)
        {
            case UiPropKind.String:
                if (v.ValueKind != JsonValueKind.String) throw new UiInvalidException(Bad("must be a string"));
                if (spec.OneOf is { } allowed && !allowed.Contains(v.GetString()!, StringComparer.Ordinal))
                    throw new UiInvalidException(Bad($"must be one of: {string.Join(", ", allowed)}"));
                break;

            case UiPropKind.Number:
                if (v.ValueKind != JsonValueKind.Number) throw new UiInvalidException(Bad("must be a number"));
                break;

            case UiPropKind.Bool:
                if (v.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    throw new UiInvalidException(Bad("must be true or false"));
                break;

            case UiPropKind.StringArray:
                if (v.ValueKind != JsonValueKind.Array) throw new UiInvalidException(Bad("must be an array"));
                foreach (var item in v.EnumerateArray())
                    if (item.ValueKind != JsonValueKind.String) throw new UiInvalidException(Bad("must hold strings"));
                break;

            case UiPropKind.Rows:
                if (v.ValueKind != JsonValueKind.Array) throw new UiInvalidException(Bad("must be an array of rows"));
                foreach (var row in v.EnumerateArray())
                {
                    if (row.ValueKind != JsonValueKind.Array) throw new UiInvalidException(Bad("each row must be an array"));
                    foreach (var cell in row.EnumerateArray())
                        if (cell.ValueKind != JsonValueKind.String) throw new UiInvalidException(Bad("cells must be strings"));
                }
                break;

            case UiPropKind.Points:
                if (v.ValueKind != JsonValueKind.Array) throw new UiInvalidException(Bad("must be an array of points"));
                foreach (var p in v.EnumerateArray())
                {
                    if (p.ValueKind != JsonValueKind.Object) throw new UiInvalidException(Bad("each point must be an object"));
                    if (!p.TryGetProperty("lat", out var lat) || lat.ValueKind != JsonValueKind.Number ||
                        !p.TryGetProperty("lng", out var lng) || lng.ValueKind != JsonValueKind.Number)
                        throw new UiInvalidException(Bad("each point needs numeric lat and lng"));
                }
                break;

            case UiPropKind.Numbers:
                if (v.ValueKind != JsonValueKind.Array) throw new UiInvalidException(Bad("must be an array"));
                foreach (var item in v.EnumerateArray())
                    if (item.ValueKind != JsonValueKind.Number) throw new UiInvalidException(Bad("must hold numbers"));
                break;

            case UiPropKind.Action:
                if (_actions.Validate(v) is { } reason) throw new UiInvalidException($"'{type}.{name}': {reason}");
                break;

            case UiPropKind.Binding:
                CheckBinding(type, name, v);
                break;

            case UiPropKind.Src:
            {
                if (v.ValueKind != JsonValueKind.String) throw new UiInvalidException(Bad("must be a string"));
                var s = v.GetString()!;
                // https is allowed — it matches what plan markdown already renders and what the app's
                // CSP permits (img-src … https:, for Leaflet tiles). Anything else must be a record path.
                if (s.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) break;
                if (s.Contains("://") || s.StartsWith("data:", StringComparison.OrdinalIgnoreCase)
                    || s.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase))
                    throw new UiInvalidException(Bad("must be a record path or an https URL"));
                if (_site.ResolveSitePath(s) is null) throw new UiInvalidException(Bad($"path is outside the site: {s}"));
                break;
            }

            case UiPropKind.Href:
            {
                if (v.ValueKind != JsonValueKind.String) throw new UiInvalidException(Bad("must be a string"));
                var s = v.GetString()!;
                if (!s.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                    && !s.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                    throw new UiInvalidException(Bad("must be an http or https URL"));
                break;
            }
        }

        if (type == "Heading" && name == "level")
        {
            var level = v.GetDouble();
            if (level is < 2 or > 4) throw new UiInvalidException("'Heading.level' must be 2, 3 or 4");
        }
    }

    /// <summary>
    /// A binding names a registered source and supplies parameters that source declared. It is
    /// validated by SHAPE, exactly like a Button's <c>runCapability</c>: the agent picks from a list
    /// the platform owns and fills declared slots — it never writes the query. Anything looser is an
    /// expression language evaluated against the household's database, authored by the participant
    /// most likely to have been prompt-injected.
    ///
    /// Every failure here is a COMMIT-blocking failure (S3b): a page whose binding cannot be
    /// satisfied in principle must not reach the household at all. That is a different class from a
    /// source failing at fetch time, which renders visibly and leaves the rest of the page standing.
    /// </summary>
    private void CheckBinding(string type, string name, JsonElement v)
    {
        string Bad(string what) => $"'{type}.{name}' {what}";

        if (v.ValueKind != JsonValueKind.Object) throw new UiInvalidException(Bad("must be an object"));
        if (!v.TryGetProperty("query", out var q) || q.ValueKind != JsonValueKind.String)
            throw new UiInvalidException(Bad("needs a string 'query'"));

        var id = q.GetString()!;
        if (!_sources.TryGetValue(id, out var source))
            throw new UiInvalidException(Bad($"names no such data source '{id}' (available: {string.Join(", ", _sources.Keys.OrderBy(k => k, StringComparer.Ordinal))})"));

        var supplied = new HashSet<string>(StringComparer.Ordinal);
        foreach (var prop in v.EnumerateObject())
        {
            if (prop.Name == "query") continue;
            if (prop.Name != "params") throw new UiInvalidException(Bad($"has no key '{prop.Name}' — only 'query' and 'params'"));
            if (prop.Value.ValueKind != JsonValueKind.Object) throw new UiInvalidException(Bad("'params' must be an object"));

            foreach (var p in prop.Value.EnumerateObject())
            {
                if (!source.Params.TryGetValue(p.Name, out var spec))
                    throw new UiInvalidException(Bad($"passes '{p.Name}', which '{id}' does not take"));
                CheckParam(id, p.Name, spec, p.Value);
                supplied.Add(p.Name);
            }
        }

        foreach (var (pn, spec) in source.Params)
            if (spec.Required && !supplied.Contains(pn))
                throw new UiInvalidException(Bad($"needs param '{pn}' for '{id}'"));
    }

    private static void CheckParam(string sourceId, string name, UiParamSpec spec, JsonElement v)
    {
        string Bad(string what) => $"'{sourceId}.{name}' {what}";

        switch (spec.Kind)
        {
            case UiParamKind.String:
                if (v.ValueKind != JsonValueKind.String) throw new UiInvalidException(Bad("must be a string"));
                if (spec.OneOf is { } allowed && !allowed.Contains(v.GetString()!, StringComparer.Ordinal))
                    throw new UiInvalidException(Bad($"must be one of: {string.Join(", ", allowed)}"));
                break;
            case UiParamKind.Number:
                if (v.ValueKind != JsonValueKind.Number) throw new UiInvalidException(Bad("must be a number"));
                break;
            case UiParamKind.Bool:
                if (v.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    throw new UiInvalidException(Bad("must be true or false"));
                break;
        }
    }
}
