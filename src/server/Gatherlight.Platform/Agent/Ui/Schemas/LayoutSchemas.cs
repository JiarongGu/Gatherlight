namespace Gatherlight.Server.Platform.Agent.Ui.Schemas;

public sealed class StackSchema : UiNodeSchema
{
    public override string Type => "Stack";
    public override bool AcceptsChildren => true;
    public override IReadOnlyDictionary<string, UiPropSpec> Props =>
        P(("gap", new UiPropSpec(UiPropKind.String, OneOf: ["none", "sm", "md", "lg"])));
}

public sealed class RowSchema : UiNodeSchema
{
    public override string Type => "Row";
    public override bool AcceptsChildren => true;
    public override IReadOnlyDictionary<string, UiPropSpec> Props => P(
        ("gap", new UiPropSpec(UiPropKind.String, OneOf: ["none", "sm", "md", "lg"])),
        ("align", new UiPropSpec(UiPropKind.String, OneOf: ["start", "center", "end", "baseline"])),
        ("wrap", new UiPropSpec(UiPropKind.Bool)));
}

public sealed class CardSchema : UiNodeSchema
{
    public override string Type => "Card";
    public override bool AcceptsChildren => true;
    public override IReadOnlyDictionary<string, UiPropSpec> Props => P(
        ("title", new UiPropSpec(UiPropKind.String)),
        ("subtitle", new UiPropSpec(UiPropKind.String)));
}

public sealed class DividerSchema : UiNodeSchema
{
    public override string Type => "Divider";
}
