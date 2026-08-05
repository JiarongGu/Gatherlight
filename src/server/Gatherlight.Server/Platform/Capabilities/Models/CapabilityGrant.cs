using System.Text.Json;
using System.Text.Json.Serialization;

namespace Gatherlight.Server.Platform.Capabilities.Models;

/// <summary>
/// What a non-platform capability is permitted to do. Every field is DENY-BY-DEFAULT, so the
/// least-specified form is the most restricted — which matters because a bare id string is both
/// the shape S1 shipped and the shape a hand-edit is likeliest to take.
/// </summary>
public sealed class CapabilityGrant
{
    public string Id { get; init; } = "";
    public CapabilityFs Fs { get; init; } = new();
    /// <summary>Outbound network. False = the platform preload removes it entirely.</summary>
    public bool Net { get; init; }
}

/// <summary>Filesystem reach, named in manifest vocabulary: a declared record directory, or the
/// literal <c>cache</c>. Never an absolute path, never <c>state</c>, never outside the site.</summary>
public sealed class CapabilityFs
{
    public IReadOnlyList<string> Read { get; init; } = [];
    /// <summary>Absent means the scratch area only.</summary>
    public IReadOnlyList<string> Write { get; init; } = ["cache"];
}

/// <summary>
/// Reads an <c>enabled</c> entry that may be either a bare id string or a full grant object.
/// S1 shipped the string form and promised S2 would be additive; this converter is that promise.
/// </summary>
public sealed class CapabilityGrantConverter : JsonConverter<CapabilityGrant>
{
    public override CapabilityGrant Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.String)
            return new CapabilityGrant { Id = reader.GetString() ?? "" };

        using var doc = JsonDocument.ParseValue(ref reader);
        var root = doc.RootElement;
        var fs = root.TryGetProperty("fs", out var fsEl)
            ? fsEl.Deserialize<CapabilityFs>(options) ?? new CapabilityFs()
            : new CapabilityFs();
        return new CapabilityGrant
        {
            Id = root.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? "" : "",
            Fs = fs,
            Net = root.TryGetProperty("net", out var netEl) && netEl.ValueKind == JsonValueKind.True,
        };
    }

    public override void Write(Utf8JsonWriter writer, CapabilityGrant value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        writer.WriteString("id", value.Id);
        writer.WritePropertyName("fs");
        JsonSerializer.Serialize(writer, value.Fs, options);
        writer.WriteBoolean("net", value.Net);
        writer.WriteEndObject();
    }
}
