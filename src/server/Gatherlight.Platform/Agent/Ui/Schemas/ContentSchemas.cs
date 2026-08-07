namespace Gatherlight.Server.Platform.Agent.Ui.Schemas;

public sealed class HeadingSchema : UiNodeSchema
{
    public override string Type => "Heading";
    public override IReadOnlyDictionary<string, UiPropSpec> Props => P(
        ("text", new UiPropSpec(UiPropKind.String, Required: true)),
        ("level", new UiPropSpec(UiPropKind.Number)));   // 2–4; range checked in the validator
}

public sealed class TextSchema : UiNodeSchema
{
    public override string Type => "Text";
    public override IReadOnlyDictionary<string, UiPropSpec> Props => P(
        ("text", new UiPropSpec(UiPropKind.String, Required: true)),
        ("weight", new UiPropSpec(UiPropKind.String, OneOf: ["normal", "bold"])),
        ("tone", new UiPropSpec(UiPropKind.String, OneOf: ["default", "muted", "positive", "warning"])));
}

public sealed class ListSchema : UiNodeSchema
{
    public override string Type => "List";
    public override IReadOnlyDictionary<string, UiPropSpec> Props => P(
        ("items", new UiPropSpec(UiPropKind.StringArray, Required: true)),
        ("ordered", new UiPropSpec(UiPropKind.Bool)));
}

public sealed class BadgeSchema : UiNodeSchema
{
    public override string Type => "Badge";
    public override IReadOnlyDictionary<string, UiPropSpec> Props => P(
        ("text", new UiPropSpec(UiPropKind.String, Required: true)),
        ("tone", new UiPropSpec(UiPropKind.String, OneOf: ["default", "muted", "positive", "warning"])));
}

public sealed class ImageSchema : UiNodeSchema
{
    public override string Type => "Image";
    public override IReadOnlyDictionary<string, UiPropSpec> Props => P(
        ("src", new UiPropSpec(UiPropKind.Src, Required: true)),
        ("alt", new UiPropSpec(UiPropKind.String)),
        ("caption", new UiPropSpec(UiPropKind.String)));
}

public sealed class TableSchema : UiNodeSchema
{
    public override string Type => "Table";
    public override IReadOnlyDictionary<string, UiPropSpec> Props => P(
        ("columns", new UiPropSpec(UiPropKind.StringArray, Required: true)),
        ("rows", new UiPropSpec(UiPropKind.Rows, Required: true)),
        ("bind", new UiPropSpec(UiPropKind.Binding)),
        ("caption", new UiPropSpec(UiPropKind.String)));
    public override IReadOnlyList<string> BindFills => ["rows"];
}

/// <summary>
/// The one primitive S3a left out. A household reading a budget on a phone gets eleven numbers in a
/// table where a bar would answer the question at a glance. No pie: a family budget has too many
/// categories for one to be readable, and the honest part-of-whole shape here is a stacked bar.
/// Rendered as inline SVG — no chart library, hence no dependency and nothing the CSP would refuse.
/// </summary>
public sealed class ChartSchema : UiNodeSchema
{
    public override string Type => "Chart";
    public override IReadOnlyDictionary<string, UiPropSpec> Props => P(
        ("kind", new UiPropSpec(UiPropKind.String, OneOf: ["bar", "line"])),
        ("labels", new UiPropSpec(UiPropKind.StringArray, Required: true)),
        ("values", new UiPropSpec(UiPropKind.Numbers, Required: true)),
        ("bind", new UiPropSpec(UiPropKind.Binding)),
        ("unit", new UiPropSpec(UiPropKind.String)),
        ("caption", new UiPropSpec(UiPropKind.String)));
    public override IReadOnlyList<string> BindFills => ["labels", "values"];
}

public sealed class MapSchema : UiNodeSchema
{
    public override string Type => "Map";
    public override IReadOnlyDictionary<string, UiPropSpec> Props => P(
        ("points", new UiPropSpec(UiPropKind.Points)),
        ("cities", new UiPropSpec(UiPropKind.StringArray)),
        ("connect", new UiPropSpec(UiPropKind.Bool)),
        ("title", new UiPropSpec(UiPropKind.String)));
}

public sealed class LinkSchema : UiNodeSchema
{
    public override string Type => "Link";
    public override IReadOnlyDictionary<string, UiPropSpec> Props => P(
        ("href", new UiPropSpec(UiPropKind.Href, Required: true)),
        ("text", new UiPropSpec(UiPropKind.String, Required: true)));
}

public sealed class FileRefSchema : UiNodeSchema
{
    public override string Type => "FileRef";
    public override IReadOnlyDictionary<string, UiPropSpec> Props => P(
        // A FileRef opens a record, exactly as a Button's `openRecord` does — so it resolves through
        // the same site boundary. It was a bare String, which left the contract ("a path inside the
        // site") stricter than the validator and the boundary enforced only downstream at open time.
        ("path", new UiPropSpec(UiPropKind.RecordPath, Required: true)),
        ("label", new UiPropSpec(UiPropKind.String)));
}
