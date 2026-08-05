namespace Gatherlight.Server.Platform.Capabilities.Models;

/// <summary>
/// An agent-drafted tool sitting in <c>{site}/.claude/tool-drafts/&lt;id&gt;/</c> — already inside
/// the agent's own write scope, so no scope-guard change was needed to let it write there. Nothing
/// in the platform loads a draft as a capability (<see cref="Services.CapabilityRegistry"/> projects
/// Platform/Script/Mcp origins only), so an unapproved draft is inert BY CONSTRUCTION: there is no
/// source that reads it in, not merely a rule saying not to. See
/// <see cref="Gatherlight.Server.Platform.Capabilities.Services.IDraftStore"/> for enumeration and
/// promotion.
/// </summary>
/// <param name="Id">The draft's folder name under <c>tool-drafts/</c>, and the id it will register
/// under once promoted. Guaranteed (by the store that produced this record) to agree with the
/// manifest's own declared <c>name</c> and the grant's own <c>id</c> — see <c>DraftStore.Load</c>.</param>
/// <param name="Title">Card heading, e.g. <c>"合并行程 PDF · Merge itinerary PDFs"</c>.</param>
/// <param name="Description">The agent's own claim about what the tool does — carried separately
/// from the enforced <see cref="Grant"/> so a caller can label it as the assistant's account rather
/// than a fact.</param>
/// <param name="Grant">What the draft asks to be granted. Promotion copies this into
/// <c>site.json</c> unchanged — the approval card shows exactly this object, so widening it during
/// promotion would make the card a lie.</param>
/// <param name="EntrySource">The literal text of the draft's entry script, for the card's "show
/// code" — never executed by the store itself, only displayed.</param>
/// <param name="DirPath">Absolute path to the draft's own folder on disk.</param>
public sealed record CapabilityDraft(
    string Id,
    string Title,
    string Description,
    CapabilityGrant Grant,
    string EntrySource,
    string DirPath);
