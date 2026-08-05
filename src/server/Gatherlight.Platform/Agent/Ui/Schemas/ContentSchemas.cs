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
        ("caption", new UiPropSpec(UiPropKind.String)));
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
        ("path", new UiPropSpec(UiPropKind.String, Required: true)),
        ("label", new UiPropSpec(UiPropKind.String)));
}
