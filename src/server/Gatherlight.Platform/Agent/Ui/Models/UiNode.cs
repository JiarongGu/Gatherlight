using System.Text.Json;
using System.Text.Json.Serialization;

namespace Gatherlight.Server.Platform.Agent.Ui.Models;

/// <summary>
/// One node of an agent-authored UI tree. The wire form is flat — `type` and `children` are
/// reserved and every other key is a prop — because fewer nesting levels is fewer things for a
/// model to get wrong. Props stay as <see cref="JsonElement"/> until a schema says what they are.
/// </summary>
[JsonConverter(typeof(UiNodeJsonConverter))]
public sealed record UiNode
{
    public required string Type { get; init; }
    public Dictionary<string, JsonElement> Props { get; init; } = new(StringComparer.Ordinal);
    public List<UiNode> Children { get; init; } = new();
}

/// <summary>
/// Writes a node back in the SAME flat shape the agent authored — `{type, …props, children}` —
/// rather than the C# field layout `{type, props:{…}, children}`. The client renderer reads props
/// flat, and a page's `root` has to round-trip through this type unchanged; default serialization
/// would silently reshape both.
/// </summary>
public sealed class UiNodeJsonConverter : JsonConverter<UiNode>
{
    public override UiNode Read(ref Utf8JsonReader reader, Type t, JsonSerializerOptions o) =>
        throw new NotSupportedException("UiNode is produced by UiTreeValidator, never deserialized directly.");

    public override void Write(Utf8JsonWriter writer, UiNode value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        writer.WriteString("type", value.Type);
        foreach (var (name, prop) in value.Props)
        {
            writer.WritePropertyName(name);
            prop.WriteTo(writer);
        }
        if (value.Children.Count > 0)
        {
            writer.WritePropertyName("children");
            writer.WriteStartArray();
            foreach (var child in value.Children) Write(writer, child, options);
            writer.WriteEndArray();
        }
        writer.WriteEndObject();
    }
}
