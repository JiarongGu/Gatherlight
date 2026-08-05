using Gatherlight.Server.Platform.Agent.Ui.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Platform.Agent.Ui;

/// <summary>Client-safe projection of one component's contract.</summary>
public sealed record UiComponentView(string Type, bool AcceptsChildren, Dictionary<string, string> Props);

[ApiController]
[Route("api/ui")]
public sealed class UiController : ControllerBase
{
    private readonly IUiTreeValidator _validator;
    public UiController(IUiTreeValidator validator) => _validator = validator;

    /// <summary>The component vocabulary. `dev.mjs check-ui-registry` compares this against the
    /// client's exported renderer keys — the two lists must agree and no compiler can see that.</summary>
    [HttpGet("registry")]
    public ActionResult<IEnumerable<UiComponentView>> Registry() =>
        Ok(_validator.Schemas.Select(s => new UiComponentView(
            s.Type,
            s.AcceptsChildren,
            s.Props.ToDictionary(p => p.Key, p => p.Value.Kind.ToString(), StringComparer.Ordinal))));
}
