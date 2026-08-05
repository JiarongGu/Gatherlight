using System.Text.Json;
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
    UiValidation ValidateJson(string json);
    UiValidation ValidateElement(JsonElement root);
    IReadOnlyList<IUiNodeSchema> Schemas { get; }
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

    public UiTreeValidator(IEnumerable<IUiNodeSchema> schemas, IUiActionValidator actions, ISiteContext site)
    {
        _schemas = schemas.ToDictionary(s => s.Type, StringComparer.Ordinal);
        _actions = actions;
        _site = site;
    }

    public IReadOnlyList<IUiNodeSchema> Schemas => _schemas.Values.OrderBy(s => s.Type, StringComparer.Ordinal).ToList();

    public UiValidation ValidateJson(string json)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException ex) { return UiValidation.Fail($"not valid JSON: {ex.Message}"); }
        using (doc) return ValidateElement(doc.RootElement);
    }

    public UiValidation ValidateElement(JsonElement root)
    {
        var count = 0;
        try { return UiValidation.Pass(Walk(root, 1, ref count)); }
        catch (UiInvalidException ex) { return UiValidation.Fail(ex.Message); }
    }

    private sealed class UiInvalidException(string message) : Exception(message);

    private UiNode Walk(JsonElement el, int depth, ref int count)
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
            throw new UiInvalidException($"unknown component '{type}'");

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
                    node.Children.Add(Walk(child, depth + 1, ref count));
                continue;
            }
            if (!schema.Props.TryGetValue(prop.Name, out var spec))
                throw new UiInvalidException($"'{type}' has no prop '{prop.Name}'");
            CheckProp(type, prop.Name, spec, prop.Value);
            node.Props[prop.Name] = prop.Value.Clone();
        }

        foreach (var (name, spec) in schema.Props)
            if (spec.Required && !node.Props.ContainsKey(name))
                throw new UiInvalidException($"'{type}' requires prop '{name}'");

        return node;
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

            case UiPropKind.Action:
                if (_actions.Validate(v) is { } reason) throw new UiInvalidException($"'{type}.{name}': {reason}");
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
}
