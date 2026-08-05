using System.Text.Json;
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Agent.Ui.Services;

/// <summary>
/// A Button's action is a container verb, never a URL and never a script. `send` composes the
/// user's next message and nothing more — an agent that labels a button "Approve" gets a message,
/// not an approval, because every consequential step still passes its own gate. `openRecord`
/// resolves through <see cref="ISiteContext.ResolveSitePath"/>, which refuses `state/`.
/// `runCapability` names code a human already approved — the page cannot supply the code, only the
/// id, and the click confirms against the ENFORCED grant before anything runs, because the label
/// beside it is the agent's own words.
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
            // Validated by SHAPE, not by state: a page may legitimately name a capability enabled
            // later, and failing validation for that would make the page uncommittable for a reason
            // that has nothing to do with the page. Enablement is enforced at invocation by
            // ToolRegistry, which already refuses a NotEnabled capability with a 4xx.
            "runCapability" => System.Text.RegularExpressions.Regex.IsMatch(arg, @"^[a-z0-9_]{1,64}$")
                ? null
                : $"action 'runCapability' needs a capability id (lower-case, digits, underscore): {arg}",
            _ => $"unknown action verb '{verb}'",
        };
    }
}
