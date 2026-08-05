namespace Gatherlight.Server.Platform.Agent.Ui.Schemas;

public sealed class ButtonSchema : UiNodeSchema
{
    public override string Type => "Button";
    public override IReadOnlyDictionary<string, UiPropSpec> Props => P(
        ("label", new UiPropSpec(UiPropKind.String, Required: true)),
        ("action", new UiPropSpec(UiPropKind.Action, Required: true)));
}
