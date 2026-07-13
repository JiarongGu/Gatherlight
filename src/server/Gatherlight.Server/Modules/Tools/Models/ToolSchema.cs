using System.Text;
using System.Text.Json;

namespace Gatherlight.Server.Modules.Tools.Models;

/// <summary>
/// Fluent builder for a tool's JSON argument schema (the MCP inputSchema shape) so tools don't
/// hand-write (and mis-type) JSON. Pattern lifted from a sibling project.
/// <code>
/// public string InputSchema => ToolSchema.Of(b => b
///     .Str("url", "Page to scrape", required: true)
///     .Int("timeout", "Navigation timeout ms (default 30000)"));
/// </code>
/// </summary>
public sealed class ToolSchema
{
    // Shape: "scalar" | "strArray" (array of strings) | "strMap" (object, string values).
    private readonly List<(string Name, string Type, string Desc, string[]? Enum, string Shape)> _props = new();
    private readonly List<string> _required = new();

    public ToolSchema Str(string name, string description, bool required = false, string[]? options = null)
        => Add(name, "string", description, required, options);
    public ToolSchema Int(string name, string description, bool required = false)
        => Add(name, "integer", description, required, null);
    public ToolSchema Bool(string name, string description, bool required = false)
        => Add(name, "boolean", description, required, null);
    public ToolSchema Num(string name, string description, bool required = false)
        => Add(name, "number", description, required, null);
    /// <summary>An array of strings.</summary>
    public ToolSchema StrArray(string name, string description, bool required = false)
        => Add(name, "array", description, required, null, "strArray");
    /// <summary>A free-form object with string values (e.g. an AcroForm field→value map).</summary>
    public ToolSchema StrMap(string name, string description, bool required = false)
        => Add(name, "object", description, required, null, "strMap");

    private ToolSchema Add(string name, string type, string description, bool required, string[]? options, string shape = "scalar")
    {
        _props.Add((name, type, description, options, shape));
        if (required) _required.Add(name);
        return this;
    }

    public string Build()
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteString("type", "object");
            w.WriteStartObject("properties");
            foreach (var p in _props)
            {
                w.WriteStartObject(p.Name);
                w.WriteString("type", p.Type);
                w.WriteString("description", p.Desc);
                if (p.Enum is { Length: > 0 })
                {
                    w.WriteStartArray("enum");
                    foreach (var e in p.Enum) w.WriteStringValue(e);
                    w.WriteEndArray();
                }
                if (p.Shape == "strArray")
                {
                    w.WriteStartObject("items");
                    w.WriteString("type", "string");
                    w.WriteEndObject();
                }
                else if (p.Shape == "strMap")
                {
                    w.WriteStartObject("additionalProperties");
                    w.WriteString("type", "string");
                    w.WriteEndObject();
                }
                w.WriteEndObject();
            }
            w.WriteEndObject();
            w.WriteStartArray("required");
            foreach (var r in _required) w.WriteStringValue(r);
            w.WriteEndArray();
            w.WriteBoolean("additionalProperties", false);
            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    public static string Of(Action<ToolSchema> configure)
    {
        var s = new ToolSchema();
        configure(s);
        return s.Build();
    }
}
