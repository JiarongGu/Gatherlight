using System.Text.Json;
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Agent.Ui.Services;

/// <summary>
/// A Button's action is a container verb, never a URL and never a script. `send` composes the
/// user's next message and nothing more — an agent that labels a button "Approve" gets a message,
/// not an approval, because every consequential step still passes its own gate. `openRecord`
/// resolves through <see cref="ISiteContext.ResolveSitePath"/>, which refuses `state/`.
/// </summary>
public interface IUiActionValidator
{
    /// <summary>Null when valid, else the reason.</summary>
    string? Validate(JsonElement action);
}

public sealed class UiActionValidator : IUiActionValidator
{
    private readonly ISiteContext _site;
    public UiActionValidator(ISiteContext site) => _site = site;

    public string? Validate(JsonElement action)
    {
        if (action.ValueKind != JsonValueKind.Object) return "action must be an object";
        var props = action.EnumerateObject().ToList();
        if (props.Count != 1) return "action must name exactly one verb";
        var (verb, value) = (props[0].Name, props[0].Value);
        if (value.ValueKind != JsonValueKind.String) return $"action '{verb}' takes a string";
        var arg = value.GetString() ?? "";

        return verb switch
        {
            "send" => string.IsNullOrWhiteSpace(arg) ? "action 'send' needs text" : null,
            "openRecord" => _site.ResolveSitePath(arg) is null
                ? $"action 'openRecord' path is outside the site: {arg}"
                : null,
            _ => $"unknown action verb '{verb}'",
        };
    }
}
