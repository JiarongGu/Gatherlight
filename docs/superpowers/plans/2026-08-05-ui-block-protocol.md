# S3a — the site's declarative UI: format, registry and renderer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent one declarative UI format — validated server-side, streamed into chat and mounted as a site page — and delete the raw-HTML path it uses today.

**Architecture:** A node tree (`{type, …flat props, children}`) is validated against a DI collection of `IUiNodeSchema` on the server. In chat, a scanner sits between the agent's streaming text and the SSE emit, splitting a turn into ordered segments and emitting one `ui-block` event per fence. As a page, the same tree is read from `{data}/ui/<name>.json` by the same validator. One React renderer serves both mounts. `rehype-raw` and the sanitize allow-list are removed; a remark plugin keeps existing `trip-map`/`city-map` documents rendering.

**Tech Stack:** ASP.NET Core net10.0 (`Gatherlight.Platform`), `System.Text.Json`, React 18 + Vite, react-markdown/remark, node e2e suites in `devtools/scripts/e2e/`.

**Spec:** `docs/superpowers/specs/2026-08-05-ui-block-protocol-design.md`

---

## Before you start

Read these — the plan depends on how they already work:

- `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatSessionService.cs:229` — `Emit(s, ev)`, the seam the scanner wraps. Four call sites pass `onEvent: ev => Emit(s, ev)`.
- `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatEnvironmentService.cs:87-104` — the `GUARD_VERSION` re-issue pattern the UI contract file copies.
- `src/server/Gatherlight.Platform/Site/Seed/Services/ZhikuSeeder.cs:73-107` — the hash guard. A file the household edited is **never** overwritten, which is why the contract file is written by `ChatEnvironmentService` and not shipped in the template.
- `src/client/src/ui/organisms/MarkdownView.tsx` — the `div` dispatch and `REHYPE_PLUGINS` that Task 6 removes.
- `devtools/scripts/e2e/p40.mjs` — the suite style to copy: fixtures written into the data folder, SSE replay reader, positive controls beside every rejection.

**Two conventions this repo enforces and this plan obeys:**

1. **Platform must never reference Product.** Everything here is Platform — none of it knows what a plan is. That is why the button verb is `openRecord`, not `openPlan`.
2. **Variation points are DI collections, never `if`/`switch` chains** — see `IGatherlightTool`, `IScorer`. `IUiNodeSchema` follows suit.

**Never commit without the user's approval is NOT in force for this plan** — per-task commits on the feature branch are the agreed workflow. Do not push.

Create the branch first:

```bash
cd D:/Development/Games/Gatherlight
git checkout -b feat/s3a-ui-blocks
```

---

## File structure

**Server — `src/server/Gatherlight.Platform/Agent/Ui/`** (Platform: no plan/trip/household knowledge)

| File | Responsibility |
|---|---|
| `Models/UiNode.cs` | the parsed node: `Type`, flat `Props`, `Children` |
| `Models/UiBlockEvent.cs` | the `ui-block` wire payload |
| `Models/SitePage.cs` | `{title, root}` — a page file |
| `Schemas/IUiNodeSchema.cs` | the DI seam + `UiPropSpec`/`UiPropKind` |
| `Schemas/LayoutSchemas.cs` | `Stack` `Row` `Card` `Divider` |
| `Schemas/ContentSchemas.cs` | `Heading` `Text` `List` `Badge` `Image` `Table` `Map` `Link` `FileRef` |
| `Schemas/InteractiveSchemas.cs` | `Button` |
| `Services/UiTreeValidator.cs` | JSON → `UiNode`, schema walk, depth/count limits |
| `Services/UiActionValidator.cs` | the `send`/`openRecord` allow-list |
| `Services/UiBlockScanner.cs` | streaming text → ordered segments + `ui-block` events |
| `Services/SitePageStore.cs` | reads + validates `{data}/ui/<name>.json` |
| `UiController.cs` | `/api/ui/registry`, `/api/ui/pages`, `/api/ui/pages/{name}` |

**Client — `src/client/src/ui/blocks/`**

| File | Responsibility |
|---|---|
| `registry.ts` | `UI_COMPONENTS` (the key list `check-ui-registry` reads) + the type→component map |
| `layout.tsx` · `content.tsx` · `interactive.tsx` | renderers, grouped to match the schemas |
| `UiTree.tsx` | renders a validated tree — used by both mounts |
| `BlockSegment.tsx` | one chat segment: ready tree · partial placeholder · fallback card |
| `legacyMaps.ts` | remark plugin rewriting `trip-map`/`city-map` html nodes |
| `../../screens/SitePage.tsx` | the page mount |

**Also modified:** `GatherlightApp.cs` (registrations), `ChatSessionService.cs` (scanner seam), `ChatEnvironmentService.cs` (contract file), `KnowledgeBaseStep.cs` (commit list), `MarkdownView.tsx`, `ChatPanel.tsx`, `App.tsx`, `sanitize.ts`, `devtools/dev.mjs`, `devtools/scripts/check-ui-registry.mjs` (new), `devtools/scripts/e2e/p41.mjs` (new).

---

### Task 1: The node model, schemas and validator

**Files:**
- Create: `src/server/Gatherlight.Platform/Agent/Ui/Models/UiNode.cs`
- Create: `src/server/Gatherlight.Platform/Agent/Ui/Schemas/IUiNodeSchema.cs`
- Create: `src/server/Gatherlight.Platform/Agent/Ui/Schemas/LayoutSchemas.cs`
- Create: `src/server/Gatherlight.Platform/Agent/Ui/Schemas/ContentSchemas.cs`
- Create: `src/server/Gatherlight.Platform/Agent/Ui/Schemas/InteractiveSchemas.cs`
- Create: `src/server/Gatherlight.Platform/Agent/Ui/Services/UiActionValidator.cs`
- Create: `src/server/Gatherlight.Platform/Agent/Ui/Services/UiTreeValidator.cs`
- Create: `src/server/Gatherlight.Platform/Agent/Ui/UiController.cs`
- Modify: `src/server/Gatherlight.Server/GatherlightApp.cs`

- [ ] **Step 1: The node model**

`Models/UiNode.cs`:

```csharp
using System.Text.Json;

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
```

Add `using System.Text.Json.Serialization;` to the file.

- [ ] **Step 2: The schema seam**

`Schemas/IUiNodeSchema.cs`:

```csharp
namespace Gatherlight.Server.Platform.Agent.Ui.Schemas;

public enum UiPropKind
{
    String,       // any string
    Number,       // int or double
    Bool,
    StringArray,  // ["a","b"]
    Rows,         // [["a","b"],["c","d"]] — array of string arrays
    Points,       // [{name,lat,lng}] — map points
    Action,       // {"send":"…"} | {"openRecord":"…"} — validated by IUiActionValidator
    Src,          // a record path or an https URL
    Href,         // an http/https URL
}

public sealed record UiPropSpec(UiPropKind Kind, bool Required = false, string[]? OneOf = null);

/// <summary>
/// One component's contract. Registered as a DI collection
/// (<c>AddSingleton&lt;IUiNodeSchema, …&gt;</c>) so adding a component is a class plus one
/// registration — never a switch. An unregistered <c>type</c> has no schema and fails validation
/// in exactly one place.
/// </summary>
public interface IUiNodeSchema
{
    string Type { get; }
    bool AcceptsChildren { get; }
    IReadOnlyDictionary<string, UiPropSpec> Props { get; }
}

/// <summary>Convenience base — schemas are pure data.</summary>
public abstract class UiNodeSchema : IUiNodeSchema
{
    public abstract string Type { get; }
    public virtual bool AcceptsChildren => false;
    public virtual IReadOnlyDictionary<string, UiPropSpec> Props =>
        new Dictionary<string, UiPropSpec>(StringComparer.Ordinal);

    protected static Dictionary<string, UiPropSpec> P(params (string Name, UiPropSpec Spec)[] items)
    {
        var d = new Dictionary<string, UiPropSpec>(StringComparer.Ordinal);
        foreach (var (n, s) in items) d[n] = s;
        return d;
    }
}
```

- [ ] **Step 3: The fourteen schemas**

`Schemas/LayoutSchemas.cs`:

```csharp
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
```

`Schemas/ContentSchemas.cs`:

```csharp
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
```

`Schemas/InteractiveSchemas.cs`:

```csharp
namespace Gatherlight.Server.Platform.Agent.Ui.Schemas;

public sealed class ButtonSchema : UiNodeSchema
{
    public override string Type => "Button";
    public override IReadOnlyDictionary<string, UiPropSpec> Props => P(
        ("label", new UiPropSpec(UiPropKind.String, Required: true)),
        ("action", new UiPropSpec(UiPropKind.Action, Required: true)));
}
```

- [ ] **Step 4: The action validator**

`Services/UiActionValidator.cs`:

```csharp
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
```

- [ ] **Step 5: The tree validator**

`Services/UiTreeValidator.cs`:

```csharp
using System.Text.Json;
using Gatherlight.Server.Platform.Agent.Ui.Models;
using Gatherlight.Server.Platform.Agent.Ui.Schemas;
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Agent.Ui.Services;

public sealed record UiValidation(bool Ok, string? Reason, UiNode? Node)
{
    public static UiValidation Fail(string reason) => new(false, reason, null);
    public static UiValidation Pass(UiNode node) => new(true, null, node);
}

public interface IUiTreeValidator
{
    UiValidation ValidateJson(string json);
    UiValidation ValidateElement(JsonElement root);
    IReadOnlyList<IUiNodeSchema> Schemas { get; }
}

/// <summary>
/// Validation is total and positive: an unknown type, an unknown prop, a wrong-typed prop, children
/// on a leaf, or a tree past the depth/size limits all fail. Nothing is sanitized into safety —
/// what is not defined does not render.
/// </summary>
public sealed class UiTreeValidator : IUiTreeValidator
{
    public const int MaxDepth = 12;
    public const int MaxNodes = 500;

    private readonly Dictionary<string, IUiNodeSchema> _schemas;
    private readonly IUiActionValidator _actions;
    private readonly ISiteContext _site;

    public UiTreeValidator(IEnumerable<IUiNodeSchema> schemas, IUiActionValidator actions, ISiteContext site)
    {
        _schemas = schemas.ToDictionary(s => s.Type, StringComparer.Ordinal);
        _actions = actions;
        _site = site;
    }

    public IReadOnlyList<IUiNodeSchema> Schemas => _schemas.Values.OrderBy(s => s.Type, StringComparer.Ordinal).ToList();

    public UiValidation ValidateJson(string json)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException ex) { return UiValidation.Fail($"not valid JSON: {ex.Message}"); }
        using (doc) return ValidateElement(doc.RootElement);
    }

    public UiValidation ValidateElement(JsonElement root)
    {
        var count = 0;
        try { return UiValidation.Pass(Walk(root, 1, ref count)); }
        catch (UiInvalidException ex) { return UiValidation.Fail(ex.Message); }
    }

    private sealed class UiInvalidException(string message) : Exception(message);

    private UiNode Walk(JsonElement el, int depth, ref int count)
    {
        if (depth > MaxDepth) throw new UiInvalidException($"tree deeper than {MaxDepth} levels");
        if (++count > MaxNodes) throw new UiInvalidException($"tree larger than {MaxNodes} nodes");

        // A bare string child is shorthand for a Text node.
        if (el.ValueKind == JsonValueKind.String)
            return new UiNode
            {
                Type = "Text",
                Props = new(StringComparer.Ordinal) { ["text"] = el.Clone() },
            };

        if (el.ValueKind != JsonValueKind.Object) throw new UiInvalidException("a node must be an object or a string");
        if (!el.TryGetProperty("type", out var typeEl) || typeEl.ValueKind != JsonValueKind.String)
            throw new UiInvalidException("a node needs a string 'type'");

        var type = typeEl.GetString()!;
        if (!_schemas.TryGetValue(type, out var schema))
            throw new UiInvalidException($"unknown component '{type}'");

        var node = new UiNode { Type = type };

        foreach (var prop in el.EnumerateObject())
        {
            if (prop.Name is "type") continue;
            if (prop.Name is "children")
            {
                if (!schema.AcceptsChildren) throw new UiInvalidException($"'{type}' does not take children");
                if (prop.Value.ValueKind != JsonValueKind.Array)
                    throw new UiInvalidException($"'{type}' children must be an array");
                foreach (var child in prop.Value.EnumerateArray())
                    node.Children.Add(Walk(child, depth + 1, ref count));
                continue;
            }
            if (!schema.Props.TryGetValue(prop.Name, out var spec))
                throw new UiInvalidException($"'{type}' has no prop '{prop.Name}'");
            CheckProp(type, prop.Name, spec, prop.Value);
            node.Props[prop.Name] = prop.Value.Clone();
        }

        foreach (var (name, spec) in schema.Props)
            if (spec.Required && !node.Props.ContainsKey(name))
                throw new UiInvalidException($"'{type}' requires prop '{name}'");

        return node;
    }

    private void CheckProp(string type, string name, UiPropSpec spec, JsonElement v)
    {
        string Bad(string what) => $"'{type}.{name}' {what}";

        switch (spec.Kind)
        {
            case UiPropKind.String:
                if (v.ValueKind != JsonValueKind.String) throw new UiInvalidException(Bad("must be a string"));
                if (spec.OneOf is { } allowed && !allowed.Contains(v.GetString(), StringComparer.Ordinal))
                    throw new UiInvalidException(Bad($"must be one of: {string.Join(", ", allowed)}"));
                break;

            case UiPropKind.Number:
                if (v.ValueKind != JsonValueKind.Number) throw new UiInvalidException(Bad("must be a number"));
                break;

            case UiPropKind.Bool:
                if (v.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    throw new UiInvalidException(Bad("must be true or false"));
                break;

            case UiPropKind.StringArray:
                if (v.ValueKind != JsonValueKind.Array) throw new UiInvalidException(Bad("must be an array"));
                foreach (var item in v.EnumerateArray())
                    if (item.ValueKind != JsonValueKind.String) throw new UiInvalidException(Bad("must hold strings"));
                break;

            case UiPropKind.Rows:
                if (v.ValueKind != JsonValueKind.Array) throw new UiInvalidException(Bad("must be an array of rows"));
                foreach (var row in v.EnumerateArray())
                {
                    if (row.ValueKind != JsonValueKind.Array) throw new UiInvalidException(Bad("each row must be an array"));
                    foreach (var cell in row.EnumerateArray())
                        if (cell.ValueKind != JsonValueKind.String) throw new UiInvalidException(Bad("cells must be strings"));
                }
                break;

            case UiPropKind.Points:
                if (v.ValueKind != JsonValueKind.Array) throw new UiInvalidException(Bad("must be an array of points"));
                foreach (var p in v.EnumerateArray())
                {
                    if (p.ValueKind != JsonValueKind.Object) throw new UiInvalidException(Bad("each point must be an object"));
                    if (!p.TryGetProperty("lat", out var lat) || lat.ValueKind != JsonValueKind.Number ||
                        !p.TryGetProperty("lng", out var lng) || lng.ValueKind != JsonValueKind.Number)
                        throw new UiInvalidException(Bad("each point needs numeric lat and lng"));
                }
                break;

            case UiPropKind.Action:
                if (_actions.Validate(v) is { } reason) throw new UiInvalidException($"'{type}.{name}': {reason}");
                break;

            case UiPropKind.Src:
            {
                if (v.ValueKind != JsonValueKind.String) throw new UiInvalidException(Bad("must be a string"));
                var s = v.GetString()!;
                // https is allowed — it matches what plan markdown already renders and what the app's
                // CSP permits (img-src … https:, for Leaflet tiles). Anything else must be a record path.
                if (s.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) break;
                if (s.Contains("://") || s.StartsWith("data:", StringComparison.OrdinalIgnoreCase)
                    || s.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase))
                    throw new UiInvalidException(Bad("must be a record path or an https URL"));
                if (_site.ResolveSitePath(s) is null) throw new UiInvalidException(Bad($"path is outside the site: {s}"));
                break;
            }

            case UiPropKind.Href:
            {
                if (v.ValueKind != JsonValueKind.String) throw new UiInvalidException(Bad("must be a string"));
                var s = v.GetString()!;
                if (!s.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                    && !s.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                    throw new UiInvalidException(Bad("must be an http or https URL"));
                break;
            }
        }

        if (type == "Heading" && name == "level")
        {
            var level = v.GetDouble();
            if (level is < 2 or > 4) throw new UiInvalidException("'Heading.level' must be 2, 3 or 4");
        }
    }
}
```

- [ ] **Step 6: The registry endpoint**

`UiController.cs` (the page routes arrive in Task 2):

```csharp
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
```

- [ ] **Step 7: Register everything**

In `src/server/Gatherlight.Server/GatherlightApp.cs`, beside the existing `AddSingleton<IGatherlightTool, …>` block, add:

```csharp
            // --- declarative UI (S3a): schemas are a DI collection, so adding a component is a
            // class + one registration and never a switch.
            .AddSingleton<IUiActionValidator, UiActionValidator>()
            .AddSingleton<IUiTreeValidator, UiTreeValidator>()
            .AddSingleton<IUiNodeSchema, StackSchema>()
            .AddSingleton<IUiNodeSchema, RowSchema>()
            .AddSingleton<IUiNodeSchema, CardSchema>()
            .AddSingleton<IUiNodeSchema, DividerSchema>()
            .AddSingleton<IUiNodeSchema, HeadingSchema>()
            .AddSingleton<IUiNodeSchema, TextSchema>()
            .AddSingleton<IUiNodeSchema, ListSchema>()
            .AddSingleton<IUiNodeSchema, BadgeSchema>()
            .AddSingleton<IUiNodeSchema, ImageSchema>()
            .AddSingleton<IUiNodeSchema, TableSchema>()
            .AddSingleton<IUiNodeSchema, MapSchema>()
            .AddSingleton<IUiNodeSchema, LinkSchema>()
            .AddSingleton<IUiNodeSchema, FileRefSchema>()
            .AddSingleton<IUiNodeSchema, ButtonSchema>()
```

Add the `using` lines the file needs:

```csharp
using Gatherlight.Server.Platform.Agent.Ui.Schemas;
using Gatherlight.Server.Platform.Agent.Ui.Services;
```

- [ ] **Step 8: Build and verify the registry over HTTP**

```bash
cd D:/Development/Games/Gatherlight
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
```
Expected: `0 Warning(s)`, `0 Error(s)`.

Start the server (leave it running in a second shell — `node devtools/dev.mjs server`), then read the
registry back:

```bash
curl -s http://127.0.0.1:5317/api/ui/registry | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const r=JSON.parse(s);console.log('components:',r.length);console.log(r.map(c=>c.type).join(' '));console.log('Button.action kind:',r.find(c=>c.type==='Button').props.action);console.log('Card children:',r.find(c=>c.type==='Card').acceptsChildren);})"
```

Expected exactly:
```
components: 14
Badge Button Card Divider FileRef Heading Image Link List Map Row Stack Table Text
Button.action kind: Action
Card children: true
```

Stop the server.

- [ ] **Step 9: Commit**

```bash
git add src/server/Gatherlight.Platform/Agent/Ui src/server/Gatherlight.Server/GatherlightApp.cs
git commit -m "feat(ui): the node model, fourteen component schemas and the tree validator

Validation is positive and total — unknown type, unknown prop, wrong type,
children on a leaf, or past the depth/size limits all fail. Schemas are a DI
collection so a new component is a class and a registration, never a switch.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Site pages — store, routes, seeded starter page, and the first e2e rows

**Files:**
- Create: `src/server/Gatherlight.Platform/Agent/Ui/Models/SitePage.cs`
- Create: `src/server/Gatherlight.Platform/Agent/Ui/Services/SitePageStore.cs`
- Modify: `src/server/Gatherlight.Platform/Agent/Ui/UiController.cs`
- Modify: `src/server/Gatherlight.Server/GatherlightApp.cs`
- Create: `src/server/Gatherlight.Server/Assets/SiteTemplate/ui/welcome.json`
- Create: `devtools/scripts/e2e/p41.mjs`

- [ ] **Step 1: The page model**

`Models/SitePage.cs`:

```csharp
using System.Text.Json;

namespace Gatherlight.Server.Platform.Agent.Ui.Models;

/// <summary>A page file: <c>{data}/ui/&lt;name&gt;.json</c>.</summary>
public sealed record SitePageFile(string Title, JsonElement Root);

/// <summary>What the client receives. A page that fails validation is reported, never rendered.</summary>
public sealed record SitePageView(string Name, string Title, string Status, UiNode? Root, string? Reason);

public sealed record SitePageSummary(string Name, string Title);
```

- [ ] **Step 2: The store**

`Services/SitePageStore.cs`:

```csharp
using System.Text.Json;
using Gatherlight.Server.Platform.Agent.Ui.Models;
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Agent.Ui.Services;

/// <summary>
/// Reads page specs from the site's UI directory (site.json's <c>ui.spec</c>, default <c>ui/</c>).
/// A page is the SAME validated tree the chat mount renders — a page is not a second system, just
/// the same data somewhere durable. A corrupted page reports its reason like an invalid block does;
/// it never throws a 500 and never renders unvalidated.
/// </summary>
public interface ISitePageStore
{
    IReadOnlyList<SitePageSummary> List();
    SitePageView? Get(string name);
}

public sealed class SitePageStore : ISitePageStore
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    private readonly ISiteContext _site;
    private readonly IUiTreeValidator _validator;
    private readonly ISiteManifestStore _manifest;

    public SitePageStore(ISiteContext site, IUiTreeValidator validator, ISiteManifestStore manifest)
    {
        _site = site;
        _validator = validator;
        _manifest = manifest;
    }

    private string Dir => _site.ResolveSitePath(_manifest.Current.Ui.Spec.TrimEnd('/')) ?? "";

    // A page name is a bare file stem — no separators, no dots — so a name can never walk out of
    // the UI directory before ResolveSitePath is even consulted.
    private static bool ValidName(string name) =>
        name.Length is > 0 and <= 64 && name.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    public IReadOnlyList<SitePageSummary> List()
    {
        if (Dir is "" || !Directory.Exists(Dir)) return [];
        var pages = new List<SitePageSummary>();
        foreach (var file in Directory.EnumerateFiles(Dir, "*.json").OrderBy(f => f, StringComparer.Ordinal))
        {
            var name = Path.GetFileNameWithoutExtension(file);
            if (!ValidName(name)) continue;
            var title = name;
            try
            {
                var parsed = JsonSerializer.Deserialize<SitePageFile>(File.ReadAllText(file), Json);
                if (!string.IsNullOrWhiteSpace(parsed?.Title)) title = parsed!.Title;
            }
            catch (JsonException) { /* listed with its file name; Get() reports the real reason */ }
            pages.Add(new SitePageSummary(name, title));
        }
        return pages;
    }

    public SitePageView? Get(string name)
    {
        if (!ValidName(name) || Dir is "") return null;
        var path = Path.Combine(Dir, name + ".json");
        if (!File.Exists(path)) return null;

        SitePageFile? parsed;
        try { parsed = JsonSerializer.Deserialize<SitePageFile>(File.ReadAllText(path), Json); }
        catch (JsonException ex) { return new SitePageView(name, name, "invalid", null, $"not valid JSON: {ex.Message}"); }
        if (parsed is null) return new SitePageView(name, name, "invalid", null, "page file is empty");

        var result = _validator.ValidateElement(parsed.Root);
        return result.Ok
            ? new SitePageView(name, parsed.Title ?? name, "ready", result.Node, null)
            : new SitePageView(name, parsed.Title ?? name, "invalid", null, result.Reason);
    }
}
```

- [ ] **Step 3: The page routes**

Add to `UiController.cs` (and `using Gatherlight.Server.Platform.Agent.Ui.Models;`):

```csharp
    [HttpGet("pages")]
    public ActionResult<IEnumerable<SitePageSummary>> Pages() => Ok(_pages.List());

    [HttpGet("pages/{name}")]
    public ActionResult<SitePageView> Page(string name) =>
        _pages.Get(name) is { } page ? Ok(page) : NotFound();
```

Inject `ISitePageStore _pages` alongside `_validator` in the constructor.

- [ ] **Step 3b: Serve record-path images**

`Image.src` may name a file inside the site, and **nothing serves those today** — `/api/assets/{**path}`
(in `Gatherlight.Planner`) is restricted to `plans/` with `.pdf`/`.json` MIME types. Without this
route a record-path image is a broken promise.

Add to `UiController.cs` (with `using Microsoft.AspNetCore.StaticFiles;` not needed — the MIME map is
explicit):

```csharp
    /// <summary>Images referenced by an Image node's record path. Deliberately narrow: image MIME
    /// types only, inside the site (ResolveSitePath already refuses state/), and no symlink anywhere
    /// in the chain — the jailed agent can write under the record dirs, and ResolveSitePath blocks
    /// `..` textually but a symlink whose target sits outside the data root would still resolve
    /// inside the prefix. Same guard PlansController.Asset applies to trip assets.</summary>
    [HttpGet("asset/{**path}")]
    public IActionResult Asset(string path)
    {
        var rel = path.Replace('\\', '/');
        var mime = Path.GetExtension(rel).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".svg" => "image/svg+xml",
            _ => (string?)null,
        };
        if (mime is null) return NotFound();
        var abs = _site.ResolveSitePath(rel);
        if (abs is null || !System.IO.File.Exists(abs)) return NotFound();
        if (!NoSymlinkEscape(abs)) return NotFound();
        return PhysicalFile(abs, mime, enableRangeProcessing: true);
    }

    private bool NoSymlinkEscape(string abs)
    {
        try
        {
            var root = Path.GetFullPath(_site.RootPath).TrimEnd(Path.DirectorySeparatorChar);
            var fi = new FileInfo(abs);
            if (fi.Attributes.HasFlag(FileAttributes.ReparsePoint)) return false;
            for (var dir = fi.Directory; dir is not null; dir = dir.Parent)
            {
                if (string.Equals(Path.GetFullPath(dir.FullName).TrimEnd(Path.DirectorySeparatorChar),
                        root, StringComparison.OrdinalIgnoreCase)) break;
                if (dir.Attributes.HasFlag(FileAttributes.ReparsePoint)) return false;
            }
            return true;
        }
        catch { return false; }
    }
```

Inject `ISiteContext _site` into the controller too. (`PlansController` carries an equivalent private
helper; consolidating the two is a separate change and Product→Platform would be the legal direction —
do not attempt it here.)

- [ ] **Step 4: Register the store**

In `GatherlightApp.cs`, beside the Task 1 block:

```csharp
            .AddSingleton<ISitePageStore, SitePageStore>()
```

- [ ] **Step 5: Ship a starter page**

`src/server/Gatherlight.Server/Assets/SiteTemplate/ui/welcome.json`:

```json
{
  "title": "欢迎 · Welcome",
  "root": {
    "type": "Stack",
    "gap": "md",
    "children": [
      { "type": "Heading", "text": "这是一个由助手编写的页面 · A page your assistant can write", "level": 2 },
      { "type": "Text", "tone": "muted", "text": "页面由组件搭成,改动会作为一次可审阅的改动提交。 · Pages are built from components; every change arrives as a diff you approve." },
      {
        "type": "Card",
        "title": "可用的组件 · What it can build with",
        "children": [
          { "type": "List", "items": ["Stack · Row · Card · Divider", "Heading · Text · List · Badge", "Image · Table · Map · Link · FileRef", "Button"] }
        ]
      },
      { "type": "Row", "gap": "sm", "children": [
        { "type": "Button", "label": "问助手能做什么 · Ask what it can do", "action": { "send": "这个站点的页面能做什么?" } }
      ] }
    ]
  }
}
```

This is content the household may edit, so it goes through `ZhikuSeeder` like the rest of the template — **not** through the version-gated path Task 7 builds. The contract file is app-managed; a starter page is theirs.

- [ ] **Step 6: Write the failing e2e — page rows**

Create `devtools/scripts/e2e/p41.mjs`:

```javascript
#!/usr/bin/env node
// e2e P41 — the declarative UI protocol (S3a). Two mounts, one validator: a page spec read from
// {data}/ui/ and a ```ui fence inside a streamed chat turn both go through UiTreeValidator, and
// every rejection here sits beside a positive control so a blanket-reject bug cannot pass.
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p41');
const { ok, fail, done } = makeReporter('p41');
makeTestData(dataDir);

// Free port — checked against every startServer({ port }) in devtools/scripts/e2e/*.mjs
// (p40 is the closest neighbour at 5480).
const PORT = 5482;

const uiDir = path.join(dataDir, 'ui');
fs.mkdirSync(uiDir, { recursive: true });

const writePage = (name, body) =>
  fs.writeFileSync(path.join(uiDir, `${name}.json`), typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf8');

// A page that must render …
writePage('good', {
  title: 'Good page',
  root: {
    type: 'Stack', gap: 'md', children: [
      { type: 'Heading', text: 'Hello', level: 2 },
      { type: 'Table', columns: ['Item', 'Cost'], rows: [['Flights', '82000']] },
      { type: 'Button', label: 'Ask', action: { send: 'tell me more' } },
    ],
  },
});
// … and three that must not, each failing for a different reason.
writePage('unknown', { title: 'Unknown', root: { type: 'Gantt', text: 'nope' } });
writePage('badprop', { title: 'Bad prop', root: { type: 'Text', text: 'hi', colour: 'red' } });
writePage('broken', '{ "title": "Broken", "root": { ');

// startServer returns a handle carrying `.base`; makeClient exposes { j, post, waitPhase, getJson }
// where j(path) → { status, body }. Match the harness — there is no `api.get`.
let server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const base = server.base ?? `http://127.0.0.1:${PORT}`;
const { j, post } = makeClient(base);   // `post` is used by the chat rows added in Task 4

try {
  await waitHealthy(base);

  // --- the registry -----------------------------------------------------------------------
  const registry = (await j('/api/ui/registry')).body ?? [];
  ok('registry lists 14 components', registry.length === 14, `got ${registry.length}`);
  ok('registry carries Button.action as an Action prop',
    registry.find((c) => c.type === 'Button')?.props?.action === 'Action');

  // --- the page mount ---------------------------------------------------------------------
  const good = (await j('/api/ui/pages/good')).body;
  ok('good page is ready', good?.status === 'ready', good?.reason ?? '');
  ok('good page keeps its title', good?.title === 'Good page');
  ok('good page root is the Stack', good?.root?.type === 'Stack');
  ok('good page children survive validation', good?.root?.children?.length === 3);
  // The wire shape is FLAT — props sit beside `type`, never nested under `props`.
  ok('the node is serialized flat', good?.root?.gap === 'md' && good?.root?.props === undefined,
    JSON.stringify(good?.root)?.slice(0, 120));

  const unknown = (await j('/api/ui/pages/unknown')).body;
  ok('unknown component is invalid', unknown?.status === 'invalid');
  ok('unknown component reason names the type', /Gantt/.test(unknown?.reason ?? ''), unknown?.reason ?? '');

  const badprop = (await j('/api/ui/pages/badprop')).body;
  ok('unknown prop is invalid', badprop?.status === 'invalid');
  ok('unknown prop reason names the prop', /colour/.test(badprop?.reason ?? ''), badprop?.reason ?? '');

  const broken = (await j('/api/ui/pages/broken')).body;
  ok('malformed page is invalid, not a 500', broken?.status === 'invalid');
  ok('malformed page reason names the parse failure', /JSON/i.test(broken?.reason ?? ''), broken?.reason ?? '');

  const listed = (await j('/api/ui/pages')).body ?? [];
  ok('page list includes the seeded welcome page', listed.some((p) => p.name === 'welcome'),
    listed.map((p) => p.name).join(','));

  ok('a missing page is 404', (await j('/api/ui/pages/nope')).status === 404);
  const escaped = await j('/api/ui/pages/..%2F..%2Fsite');
  ok('a traversing page name is refused', escaped.status === 404 || escaped.status === 400, String(escaped.status));

  // --- the image route is narrow ----------------------------------------------------------
  const dbGrab = await fetch(`${base}/api/ui/asset/state/gatherlight.db`);
  ok('the asset route refuses a non-image path', dbGrab.status === 404, String(dbGrab.status));
  fs.mkdirSync(path.join(dataDir, 'plans'), { recursive: true });
  // 1x1 transparent PNG — a real image, so the positive control proves the route works at all.
  fs.writeFileSync(path.join(dataDir, 'plans', 'pixel.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'));
  const pixel = await fetch(`${base}/api/ui/asset/plans/pixel.png`);
  ok('the asset route serves a record image', pixel.status === 200, String(pixel.status));
  ok('the asset route sets an image content type',
    (pixel.headers.get('content-type') ?? '').startsWith('image/'), pixel.headers.get('content-type') ?? '');
} catch (e) {
  fail(e?.stack || String(e));
} finally {
  server.kill();
}

done();
```

- [ ] **Step 7: Run it and watch it fail**

```bash
node devtools/dev.mjs e2e p41
```
Expected: **FAIL** — the page routes do not exist yet if you have not built, or the assertions fail. This is the point: confirm the suite can fail before you make it pass.

- [ ] **Step 8: Build and make it pass**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
node devtools/dev.mjs e2e p41
```
Expected: `e2e-p41 PASS`.

If `page list includes the seeded welcome page` fails, the template file did not reach the build output — check that `Assets/SiteTemplate/**` is copied (it is a `<Content Include>` in `Gatherlight.Server.csproj`) and that the fixture data folder was seeded on startup.

- [ ] **Step 9: Commit**

```bash
git add src/server/Gatherlight.Platform/Agent/Ui src/server/Gatherlight.Server/GatherlightApp.cs src/server/Gatherlight.Server/Assets/SiteTemplate/ui devtools/scripts/e2e/p41.mjs
git commit -m "feat(ui): site pages read through the same validator, with e2e proof

A page is not a second system — it is the same validated tree, mounted somewhere
durable. A corrupted page reports its reason the way an invalid block does rather
than throwing a 500, and page names are bare stems so one cannot walk out of the
UI directory.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The client renderer and the page mount

**Files:**
- Create: `src/client/src/ui/blocks/registry.ts`
- Create: `src/client/src/ui/blocks/layout.tsx`
- Create: `src/client/src/ui/blocks/content.tsx`
- Create: `src/client/src/ui/blocks/interactive.tsx`
- Create: `src/client/src/ui/blocks/UiTree.tsx`
- Create: `src/client/src/screens/SitePage.tsx`
- Modify: `src/client/src/screens/index.ts`
- Modify: `src/client/src/App.tsx`

- [ ] **Step 1: The node type and the registry**

`src/client/src/ui/blocks/registry.ts`:

```typescript
import type { ComponentType } from 'react';
import { Stack, Row, Card, Divider } from './layout';
import { Heading, Text, List, Badge, Image, Table, Map, Link, FileRef } from './content';
import { Button } from './interactive';

/** A validated node, as the server sends it: flat props, plus children. */
export interface UiNode {
  type: string;
  children?: UiNode[];
  [prop: string]: unknown;
}

export interface UiNodeProps {
  node: UiNode;
  /** Rendered children, already resolved by UiTree. */
  children?: React.ReactNode;
  /** Send text back to the agent — supplied by the chat mount, absent on a page. */
  onSend?: (text: string) => void;
  /** Open a record file in the reader. */
  onOpenRecord?: (path: string) => void;
}

/**
 * The type→component map. `UI_COMPONENTS` is the list `dev.mjs check-ui-registry` compares against
 * the server's registered IUiNodeSchema types: the schema lives in C# and the renderer lives here,
 * so nothing but that check would notice the two drifting apart.
 */
export const RENDERERS: Record<string, ComponentType<UiNodeProps>> = {
  Stack, Row, Card, Divider,
  Heading, Text, List, Badge, Image, Table, Map, Link, FileRef,
  Button,
};

export const UI_COMPONENTS = Object.keys(RENDERERS).sort();
```

- [ ] **Step 2: The layout renderers**

`src/client/src/ui/blocks/layout.tsx`:

```tsx
import { Card as AntCard, Divider as AntDivider } from 'antd';
import type { UiNodeProps } from './registry';

const GAP: Record<string, number> = { none: 0, sm: 8, md: 16, lg: 24 };
const gapOf = (node: UiNodeProps['node']) => GAP[String(node.gap ?? 'md')] ?? 16;

export function Stack({ node, children }: UiNodeProps) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: gapOf(node) }}>{children}</div>;
}

export function Row({ node, children }: UiNodeProps) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'row',
      gap: gapOf(node),
      alignItems: String(node.align ?? 'start') === 'start' ? 'flex-start' : String(node.align),
      flexWrap: node.wrap ? 'wrap' : 'nowrap',
    }}>{children}</div>
  );
}

export function Card({ node, children }: UiNodeProps) {
  return (
    <AntCard size="small" title={node.title as string | undefined} className="ui-card">
      {node.subtitle ? <div className="ui-card-subtitle">{node.subtitle as string}</div> : null}
      {children}
    </AntCard>
  );
}

export function Divider() {
  return <AntDivider style={{ margin: '8px 0' }} />;
}
```

- [ ] **Step 3: The content renderers**

`src/client/src/ui/blocks/content.tsx`:

```tsx
import { Table as AntTable, Tag, Image as AntImage } from 'antd';
import { CityMap } from '@/ui/organisms/CityMap';
import { TripMap } from '@/ui/organisms/TripMap';
import type { UiNodeProps } from './registry';

const TONE: Record<string, string> = {
  default: 'inherit', muted: 'var(--text-muted, #8d94a5)',
  positive: 'var(--ok, #3ba55d)', warning: 'var(--warn, #d99b32)',
};

export function Heading({ node }: UiNodeProps) {
  const level = Number(node.level ?? 2);
  const Tag_ = (level === 4 ? 'h4' : level === 3 ? 'h3' : 'h2') as 'h2' | 'h3' | 'h4';
  return <Tag_>{String(node.text)}</Tag_>;
}

export function Text({ node }: UiNodeProps) {
  return (
    <p style={{
      margin: 0,
      fontWeight: node.weight === 'bold' ? 600 : 400,
      color: TONE[String(node.tone ?? 'default')],
    }}>{String(node.text)}</p>
  );
}

export function List({ node }: UiNodeProps) {
  const items = (node.items as string[]) ?? [];
  const Tag_ = node.ordered ? 'ol' : 'ul';
  return <Tag_>{items.map((it, i) => <li key={i}>{it}</li>)}</Tag_>;
}

export function Badge({ node }: UiNodeProps) {
  const tone = String(node.tone ?? 'default');
  const color = tone === 'positive' ? 'green' : tone === 'warning' ? 'orange' : tone === 'muted' ? 'default' : 'blue';
  return <Tag color={color}>{String(node.text)}</Tag>;
}

export function Image({ node }: UiNodeProps) {
  const src = String(node.src);
  // A record path is served by the narrow asset route added in Task 2 (image MIME types only,
  // inside the site, no symlinks); https URLs pass straight through.
  const url = src.startsWith('https://')
    ? src
    : `/api/ui/asset/${src.split('/').map(encodeURIComponent).join('/')}`;
  return (
    <figure style={{ margin: 0 }}>
      <AntImage src={url} alt={(node.alt as string) ?? ''} style={{ maxWidth: '100%', borderRadius: 6 }} />
      {node.caption ? <figcaption className="ui-caption">{String(node.caption)}</figcaption> : null}
    </figure>
  );
}

export function Table({ node }: UiNodeProps) {
  const columns = ((node.columns as string[]) ?? []).map((c, i) => ({ title: c, dataIndex: String(i), key: String(i) }));
  const rows = ((node.rows as string[][]) ?? []).map((r, ri) => {
    const rec: Record<string, string> = { key: String(ri) };
    r.forEach((cell, ci) => { rec[String(ci)] = cell; });
    return rec;
  });
  return (
    <div style={{ overflowX: 'auto' }}>
      <AntTable size="small" pagination={false} columns={columns} dataSource={rows} />
      {node.caption ? <div className="ui-caption">{String(node.caption)}</div> : null}
    </div>
  );
}

export function Map({ node }: UiNodeProps) {
  const cities = (node.cities as string[]) ?? [];
  if (cities.length > 0) return <TripMap cities={cities} />;
  const points = (node.points as { name?: string; lat: number; lng: number }[]) ?? [];
  // CityMap.parsePoints reads "lat,lng|label" lines separated by newline or semicolon — verified
  // against src/client/src/ui/organisms/CityMap.tsx:14. Do not reorder these fields.
  const raw = points.map((p) => `${p.lat},${p.lng}|${p.name ?? ''}`).join(';');
  return <CityMap pointsRaw={raw} connect={Boolean(node.connect)} title={node.title as string | undefined} />;
}

export function Link({ node }: UiNodeProps) {
  const href = String(node.href);
  let host = '';
  try { host = new URL(href).host; } catch { host = ''; }
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {String(node.text)}{host ? <span className="ui-link-host"> ({host})</span> : null}
    </a>
  );
}

export function FileRef({ node, onOpenRecord }: UiNodeProps) {
  const path = String(node.path);
  return (
    <button type="button" className="ui-fileref" onClick={() => onOpenRecord?.(path)}>
      {String(node.label ?? path)}
    </button>
  );
}
```

- [ ] **Step 4: The interactive renderer**

`src/client/src/ui/blocks/interactive.tsx`:

```tsx
import { Button as AntButton } from 'antd';
import type { UiNodeProps } from './registry';

/**
 * A button's action is a container verb. `send` composes the user's next message and nothing more —
 * a button labelled "Approve" produces a message, not an approval, because every consequential step
 * still passes its own gate.
 */
export function Button({ node, onSend, onOpenRecord }: UiNodeProps) {
  const action = (node.action ?? {}) as { send?: string; openRecord?: string };
  const click = () => {
    if (typeof action.send === 'string') onSend?.(action.send);
    else if (typeof action.openRecord === 'string') onOpenRecord?.(action.openRecord);
  };
  const inert = (action.send === undefined && action.openRecord === undefined)
    || (action.send !== undefined && !onSend)
    || (action.openRecord !== undefined && !onOpenRecord);
  return <AntButton size="small" onClick={click} disabled={inert}>{String(node.label)}</AntButton>;
}
```

- [ ] **Step 5: The tree renderer**

`src/client/src/ui/blocks/UiTree.tsx`:

```tsx
import { memo } from 'react';
import { RENDERERS, type UiNode } from './registry';

interface Props {
  node: UiNode;
  onSend?: (text: string) => void;
  onOpenRecord?: (path: string) => void;
}

/**
 * Renders a tree the SERVER already validated — every node here has a schema behind it. The unknown
 * branch exists only for the case where the client is older than the server (a component shipped in
 * the schema but not yet in this bundle), which `check-ui-registry` is meant to prevent.
 */
export const UiTree = memo(function UiTree({ node, onSend, onOpenRecord }: Props) {
  const Renderer = RENDERERS[node.type];
  if (!Renderer) {
    return <div className="ui-unknown">此版本暂不支持的组件 · Unsupported component: {node.type}</div>;
  }
  const children = node.children?.length
    ? node.children.map((c, i) => <UiTree key={i} node={c} onSend={onSend} onOpenRecord={onOpenRecord} />)
    : undefined;
  return <Renderer node={node} onSend={onSend} onOpenRecord={onOpenRecord}>{children}</Renderer>;
});
```

- [ ] **Step 6: The page mount**

`src/client/src/screens/SitePage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Alert, Spin } from 'antd';
import { UiTree } from '@/ui/blocks/UiTree';
import type { UiNode } from '@/ui/blocks/registry';
import { get } from '@/lib/apiClient';   // apiClient exports get/post — verified, there is no apiGet

interface PageView {
  name: string; title: string; status: 'ready' | 'invalid'; root?: UiNode; reason?: string;
}

export function SitePage({ name, onOpenRecord }: { name: string; onOpenRecord?: (p: string) => void }) {
  const [page, setPage] = useState<PageView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setPage(null); setError(null);
    get<PageView>(`/api/ui/pages/${encodeURIComponent(name)}`)
      .then((p) => { if (live) setPage(p); })
      .catch((e) => { if (live) setError(String(e?.message ?? e)); });
    return () => { live = false; };
  }, [name]);

  if (error) return <Alert type="error" message="打不开这个页面 · Could not open this page" description={error} />;
  if (!page) return <Spin />;
  if (page.status !== 'ready' || !page.root) {
    return (
      <Alert
        type="warning"
        message="这个页面暂时无法显示 · This page cannot be displayed"
        description={page.reason ?? ''}
      />
    );
  }
  return (
    <article className="site-page">
      <h1>{page.title}</h1>
      <UiTree node={page.root} onOpenRecord={onOpenRecord} />
    </article>
  );
}
```

- [ ] **Step 7: Route to it**

In `src/client/src/screens/index.ts`, export `SitePage`.

In `src/client/src/App.tsx`, extend the URL view model (around lines 40–56):

```typescript
type PlannerView = { path: string | null; library: boolean; knowledge: boolean; page: string | null };
```

- in `readView()`: `const page = p.get('page'); if (page) return { ...none, page };`
- in `viewToUrl()`: `if (v.page) p.set('page', v.page);`
- add `const [activePage, setActivePage] = useState<string | null>(initialView.page);`
- render `<SitePage name={activePage} onOpenRecord={setActivePath} />` in the main pane when
  `activePage` is set, ahead of the markdown reader branch.
- include `page: activePage` in the `viewToUrl` call in the URL-sync effect and clear it wherever
  the other view flags are cleared, so navigating away actually leaves the page.

- [ ] **Step 8: Build the client**

```bash
cd D:/Development/Games/Gatherlight
node devtools/dev.mjs build
```
Expected: the Vite build succeeds and `tsc -b` reports no errors. A compiled server serves
`bin/wwwroot`, so a client-only build is not enough — use `dev.mjs build`.

- [ ] **Step 9: Look at it**

```bash
node devtools/dev.mjs server
```
Open `http://127.0.0.1:5317/?page=welcome`. The seeded starter page must render: a heading, muted
text, a card with a list, and one button. Confirm the button is **disabled** here (a page supplies
no `onSend`), which is the visible proof that a page cannot make the agent do anything by itself.

- [ ] **Step 10: Commit**

```bash
git add src/client/src
git commit -m "feat(ui): the component renderers, the tree renderer and the page mount

One registry, two mounts. UI_COMPONENTS is the list the drift check reads — the
schema is in C# and the renderer is here, and nothing else would notice them
diverging.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The streaming scanner and `ui-block` events

**Files:**
- Create: `src/server/Gatherlight.Platform/Agent/Ui/Models/UiBlockEvent.cs`
- Create: `src/server/Gatherlight.Platform/Agent/Ui/Services/UiBlockScanner.cs`
- Modify: `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatSessionService.cs`
- Modify: `src/server/Gatherlight.Server/GatherlightApp.cs`
- Modify: `devtools/scripts/claude-stub.mjs`
- Modify: `devtools/scripts/e2e/p41.mjs`

- [ ] **Step 1: The event payload**

`Models/UiBlockEvent.cs`:

```csharp
namespace Gatherlight.Server.Platform.Agent.Ui.Models;

/// <summary>
/// The <c>ui-block</c> SSE payload. <c>status</c> is partial | ready | invalid. A partial block
/// carries no payload at all — half a JSON tree is not something to put on the wire — and an
/// invalid one carries the raw text so the user can see what the app could not display.
/// </summary>
public sealed record UiBlockEvent(int Segment, string Status, UiNode? Node = null, string? Raw = null, string? Reason = null);
```

- [ ] **Step 2: The scanner**

`Services/UiBlockScanner.cs`:

```csharp
using System.Text;
using Gatherlight.Server.Platform.Agent.Llm.Models;
using Gatherlight.Server.Platform.Agent.Ui.Models;

namespace Gatherlight.Server.Platform.Agent.Ui.Services;

/// <summary>
/// Splits one agent turn into ordered segments: prose, and ```ui fences. Sits between the agent's
/// streaming text and the SSE emit, so the raw fence text NEVER reaches the transcript as prose —
/// the user sees a placeholder while a block streams, then the rendered tree.
///
/// One instance per run; not thread-safe (the emit path is already serialized).
/// </summary>
public sealed class UiBlockScanner
{
    private const string Open = "```ui";
    private const string Close = "```";

    private readonly IUiTreeValidator _validator;
    private readonly StringBuilder _buf = new();
    private int _segment;
    private bool _inFence;
    private bool _announced;   // partial already emitted for the current fence

    public UiBlockScanner(IUiTreeValidator validator) => _validator = validator;

    /// <summary>Pass an event through, expanding a text-delta into prose deltas + block events.</summary>
    public IEnumerable<AgentEvent> Feed(AgentEvent ev)
    {
        if (ev.Kind != "text-delta" || ev.Text is null) return [ev];
        _buf.Append(ev.Text);
        return Drain(flush: false);
    }

    /// <summary>Call once the turn's text is complete. An unterminated fence resolves to invalid —
    /// a placeholder that spins forever is a worse failure than an honest one.</summary>
    public IEnumerable<AgentEvent> Flush() => Drain(flush: true);

    private List<AgentEvent> Drain(bool flush)
    {
        var outp = new List<AgentEvent>();
        while (true)
        {
            var buf = _buf.ToString();
            if (!_inFence)
            {
                var at = FindAtLineStart(buf, Open, 0);
                if (at < 0)
                {
                    // Hold back a trailing partial fence marker so "``" never leaks as prose.
                    var safe = flush ? buf.Length : SafePrefix(buf);
                    if (safe > 0)
                    {
                        outp.Add(Prose(buf[..safe]));
                        _buf.Remove(0, safe);
                    }
                    return outp;
                }
                if (at > 0)
                {
                    outp.Add(Prose(buf[..at]));
                    _buf.Remove(0, at);
                }
                // Consume the opening fence line (```ui plus the rest of that line).
                var line = _buf.ToString();
                var nl = line.IndexOf('\n');
                if (nl < 0)
                {
                    if (!flush) return outp;      // opening line not complete yet
                    outp.Add(Block(new UiBlockEvent(NextSegment(), "invalid", Raw: line, Reason: "unterminated block")));
                    _buf.Clear();
                    return outp;
                }
                _buf.Remove(0, nl + 1);
                _inFence = true;
                _announced = false;
                _segment++;
                continue;
            }

            // Inside a fence: hold everything until the closing ``` at a line start.
            var body = _buf.ToString();
            var end = FindAtLineStart(body, Close, 0);
            if (end < 0)
            {
                if (flush)
                {
                    outp.Add(Block(new UiBlockEvent(_segment, "invalid", Raw: body, Reason: "unterminated block")));
                    _buf.Clear();
                    _inFence = false;
                    return outp;
                }
                if (!_announced)
                {
                    outp.Add(Block(new UiBlockEvent(_segment, "partial")));
                    _announced = true;
                }
                return outp;
            }

            var payload = body[..end];
            var result = _validator.ValidateJson(payload);
            outp.Add(Block(result.Ok
                ? new UiBlockEvent(_segment, "ready", Node: result.Node)
                : new UiBlockEvent(_segment, "invalid", Raw: payload, Reason: result.Reason)));

            // Consume the closing fence line.
            var afterClose = end + Close.Length;
            var nl2 = body.IndexOf('\n', afterClose);
            _buf.Remove(0, nl2 < 0 ? body.Length : nl2 + 1);
            _inFence = false;
            _segment++;
        }
    }

    private int NextSegment() => ++_segment;

    private AgentEvent Prose(string text) =>
        new() { Kind = "text-delta", Text = text, Data = new { segment = _segment } };

    private static AgentEvent Block(UiBlockEvent b) => new() { Kind = "ui-block", Data = b };

    /// <summary>Index of `marker` when it starts a line, else -1.</summary>
    private static int FindAtLineStart(string s, string marker, int from)
    {
        for (var i = from; i >= 0 && i < s.Length;)
        {
            var at = s.IndexOf(marker, i, StringComparison.Ordinal);
            if (at < 0) return -1;
            if (at == 0 || s[at - 1] == '\n') return at;
            i = at + 1;
        }
        return -1;
    }

    /// <summary>How much of `s` is safe to emit as prose — everything except a trailing fragment
    /// that could still turn into an opening fence once more text arrives.</summary>
    private static int SafePrefix(string s)
    {
        var lineStart = s.LastIndexOf('\n') + 1;
        var tail = s[lineStart..];
        return Open.StartsWith(tail, StringComparison.Ordinal) && tail.Length > 0 ? lineStart : s.Length;
    }
}
```

- [ ] **Step 3: Wire it into the chat session**

In `ChatSessionService.cs`:

1. Inject `IUiTreeValidator _uiValidator` into the constructor (add the field and the
   `using Gatherlight.Server.Platform.Agent.Ui.Services;` line).
2. Add a helper beside `Emit` (which is at line 229):

```csharp
    /// <summary>The chat emit seam: agent text passes through a per-run UiBlockScanner so a ```ui
    /// fence becomes a validated block event instead of raw JSON in the transcript. Non-text events
    /// pass through untouched.</summary>
    private void EmitScanned(ChatSession s, UiBlockScanner scanner, AgentEvent ev)
    {
        foreach (var outEv in scanner.Feed(ev)) Emit(s, outEv);
    }
```

3. At each of the four `_agent.RunAsync(...)` call sites (lines ~453, ~495, ~542, ~565), create a
   scanner for that run and flush it afterwards. For example, the plan run becomes:

```csharp
            var scanner = new UiBlockScanner(_uiValidator);
            var res = await _agent.RunAsync(
                …,
                label: $"chat:{s.Mode}:plan", onEvent: ev => EmitScanned(s, scanner, ev), ct: s.Abort.Token);
            foreach (var outEv in scanner.Flush()) Emit(s, outEv);
```

Apply the same three-line shape to the `exec`, `repair` and `revise-plan` call sites. **Every run
gets its own scanner and its own flush** — a scanner reused across runs would carry a half-open
fence into the next turn.

- [ ] **Step 4: Teach the stub to emit blocks**

In `devtools/scripts/claude-stub.mjs`, near the other trigger checks (after the `FORCE_ERROR`
branch), add these. Read the trigger from the CURRENT request only — the thread context echoes
prior turns, which is what broke p28:

```javascript
// --- S3a: UI block fixtures. Read the trigger from the CURRENT request (thread context echoes
// earlier turns' text, so scanning the whole prompt cross-fires on follow-ups).
const current = prompt.split("THE USER'S REQUEST:").pop();
const uiCase = (current.match(/UI_CASE:([A-Z_]+)/) || [])[1];
if (uiCase) {
  const fence = (body) => '```ui\n' + body + '\n```';
  const cases = {
    VALID: 'Here is the plan.\n\n' + fence(JSON.stringify({
      type: 'Card', title: 'Day 1', children: [
        { type: 'Text', text: 'Morning at the museum' },
        { type: 'Table', columns: ['Item', 'Cost'], rows: [['Entry', '1200']] },
      ],
    })) + '\n\nAnything else?',
    UNKNOWN_TYPE: fence(JSON.stringify({ type: 'Gantt', text: 'nope' })),
    BAD_JSON: '```ui\n{ "type": "Card", \n```',
    BAD_PROP: fence(JSON.stringify({ type: 'Text', text: 'hi', colour: 'red' })),
    BAD_ACTION: fence(JSON.stringify({
      type: 'Button', label: 'Open', action: { openRecord: 'state/gatherlight.db' },
    })),
    REMOTE_IMAGE: fence(JSON.stringify({ type: 'Image', src: 'https://example.com/a.png', alt: 'a' })),
    EVIL_IMAGE: fence(JSON.stringify({ type: 'Image', src: 'javascript:alert(1)', alt: 'a' })),
    TOO_BIG: fence(JSON.stringify({
      type: 'Stack',
      children: Array.from({ length: 600 }, (_, i) => ({ type: 'Text', text: `row ${i}` })),
    })),
    UNTERMINATED: 'Working on it.\n\n```ui\n{ "type": "Card"',
  };
  done(cases[uiCase] ?? `unknown UI_CASE ${uiCase}`);
  process.exit(0);
}
```

Check how the surrounding code terminates a run (the `done(text)` helper defined near the top) and
match it — do not invent a different exit path.

- [ ] **Step 5: Add the chat rows to p41 and watch them fail**

Append to `devtools/scripts/e2e/p41.mjs`, inside the `try` block before the `catch`:

```javascript
  // --- the chat mount ---------------------------------------------------------------------
  // GET /api/chat/{id} returns a SNAPSHOT (phase, plan, cards) and NOT the event log, so the block
  // events have to come off the SSE stream — which replays everything buffered on connect. Same
  // reader shape e2e-p28/p39/p40 use; reading the wire also proves the events actually ship.
  const streamEvents = async (id, ms = 4000) => {
    const res = await fetch(`${base}/api/chat/${id}/stream`);
    const reader = res.body.getReader();
    let text = '';
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const race = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(null), 400))]);
      if (!race || race.done) break;
      text += Buffer.from(race.value).toString('utf8');
    }
    reader.cancel().catch(() => {});
    const events = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      try { events.push(JSON.parse(t.slice(5).trim())); } catch { /* keep-alive / partial frame */ }
    }
    return events;
  };

  const blocksFor = async (uiCase) => {
    const started = await post('/api/chat', { message: `UI_CASE:${uiCase}`, mode: 'plan' });
    const id = started.body?.id;
    if (!id) throw new Error(`no session id for ${uiCase}: ${JSON.stringify(started.body)}`);
    // The stub answers immediately; wait for the run to leave planning before replaying the stream.
    await until(async () => (await j(`/api/chat/${id}`)).body?.phase !== 'planning', 20000);
    const events = await streamEvents(id);
    return {
      blocks: events.filter((e) => e.kind === 'ui-block').map((e) => e.data),
      prose: events.filter((e) => e.kind === 'text-delta').map((e) => e.text ?? '').join(''),
      deltas: events.filter((e) => e.kind === 'text-delta'),
    };
  };

  const valid = await blocksFor('VALID');
  ok('valid fence yields exactly one block', valid.blocks.filter((b) => b.status !== 'partial').length === 1,
    JSON.stringify(valid.blocks.map((b) => b.status)));
  const ready = valid.blocks.find((b) => b.status === 'ready');
  ok('valid fence is ready', Boolean(ready), JSON.stringify(valid.blocks));
  ok('ready block carries the tree', ready?.node?.type === 'Card');
  ok('ready block keeps its children', ready?.node?.children?.length === 2);
  ok('the fence payload never leaks into prose', !/"type"\s*:/.test(valid.prose), valid.prose.slice(0, 200));
  ok('prose around the block survives', /Here is the plan/.test(valid.prose) && /Anything else/.test(valid.prose));
  // Three segments in index order: prose · block · prose. This is what lets the client interleave
  // them without guessing where the block belonged.
  const segments = [
    ...valid.deltas.map((e) => ({ index: e.data?.segment ?? 0, kind: 'prose' })),
    ...valid.blocks.filter((b) => b.status !== 'partial').map((b) => ({ index: b.segment, kind: 'block' })),
  ];
  const distinct = [...new Set(segments.map((s) => s.index))].sort((a, b) => a - b);
  ok('the turn splits into three segments', distinct.length === 3, JSON.stringify(segments));
  ok('the block sits between the two prose segments',
    segments.find((s) => s.kind === 'block')?.index === distinct[1], JSON.stringify(segments));

  const rejects = [
    ['UNKNOWN_TYPE', /Gantt/],
    ['BAD_JSON', /JSON/i],
    ['BAD_PROP', /colour/],
    ['BAD_ACTION', /openRecord|outside the site/],
    ['EVIL_IMAGE', /record path|https/],
    ['TOO_BIG', /500|nodes/],
    ['UNTERMINATED', /unterminated/i],
  ];
  for (const [name, pattern] of rejects) {
    const r = await blocksFor(name);
    const bad = r.blocks.find((b) => b.status === 'invalid');
    ok(`${name}: block is invalid`, Boolean(bad), JSON.stringify(r.blocks.map((b) => b.status)));
    ok(`${name}: reason names the cause`, pattern.test(bad?.reason ?? ''), bad?.reason ?? '');
    ok(`${name}: no ready block slipped through`, !r.blocks.some((b) => b.status === 'ready'));
  }

  // The positive control for the image rule: https is ALLOWED, matching markdown and the CSP.
  const remote = await blocksFor('REMOTE_IMAGE');
  ok('REMOTE_IMAGE: an https image is allowed',
    remote.blocks.some((b) => b.status === 'ready'), JSON.stringify(remote.blocks));
```

Add `until` to the import list at the top of the file, and destructure `post` alongside `j` from
`makeClient(base)`.

```bash
node devtools/dev.mjs e2e p41
```
Expected: **FAIL** on every new row — no `ui-block` events exist yet.

- [ ] **Step 6: Build and make it pass**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
node devtools/dev.mjs e2e p41
```
Expected: `e2e-p41 PASS`, with both the page rows from Task 2 and the chat rows still green.

If the stream yields no `ui-block` frames, check that the scanner is wired at the call site you are
driving (the plan run) and that `Flush()` runs after it — do not weaken an assertion to make it pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/Gatherlight.Platform/Agent/Ui src/server/Gatherlight.Platform/Agent/Chat devtools/scripts/claude-stub.mjs devtools/scripts/e2e/p41.mjs
git commit -m "feat(ui): stream ```ui fences as validated block events

The scanner sits between the agent's text and the SSE emit, so a fence never
reaches the transcript as prose. One scanner per run, flushed at the end: an
unterminated fence resolves to invalid rather than a placeholder that spins
forever.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The chat transcript renders segments

**Files:**
- Create: `src/client/src/ui/blocks/BlockSegment.tsx`
- Modify: `src/client/src/lib/chatTypes.ts`
- Modify: `src/client/src/ui/organisms/ChatPanel.tsx`

- [ ] **Step 1: The segment types**

In `src/client/src/lib/chatTypes.ts`, add `'ui-block'` to `AgentEvent['kind']` and add:

```typescript
/**
 * One `ui-block` event. `partial` carries no payload — half a tree is not something to render —
 * and `invalid` carries the raw text so the user can see what could not be displayed.
 */
export interface UiBlockEvent {
  segment: number;
  status: 'partial' | 'ready' | 'invalid';
  node?: UiNode;
  raw?: string;
  reason?: string;
}
```

with `import type { UiNode } from '@/ui/blocks/registry';`.

- [ ] **Step 2: The segment renderer**

`src/client/src/ui/blocks/BlockSegment.tsx`:

```tsx
import { Spin, Collapse } from 'antd';
import { UiTree } from './UiTree';
import type { UiBlockEvent } from '@/lib/chatTypes';

/**
 * A block that failed validation is SHOWN, not dropped: a silent hole makes a schema bug invisible
 * and leaves the user reading a reply with a gap in it. It is also not a red error — a household
 * seeing an alarm for a block name we simply do not ship is a support call, not a signal.
 */
export function BlockSegment({
  block, onSend, onOpenRecord,
}: { block: UiBlockEvent; onSend?: (t: string) => void; onOpenRecord?: (p: string) => void }) {
  if (block.status === 'partial') {
    return (
      <div className="ui-block-partial">
        <Spin size="small" /> <span>正在准备视图… · Preparing view…</span>
      </div>
    );
  }
  if (block.status === 'invalid') {
    return (
      <div className="ui-block-fallback">
        <div className="ui-block-fallback-head">这段内容暂时无法显示 · This content could not be displayed</div>
        {block.reason ? <div className="ui-block-fallback-reason">{block.reason}</div> : null}
        <Collapse
          ghost
          size="small"
          items={[{ key: 'raw', label: '查看原始内容 · Show raw content', children: <pre>{block.raw ?? ''}</pre> }]}
        />
      </div>
    );
  }
  return block.node
    ? <UiTree node={block.node} onSend={onSend} onOpenRecord={onOpenRecord} />
    : null;
}
```

- [ ] **Step 3: Segment-aware transcript state**

In `ChatPanel.tsx`, the assistant transcript item currently accumulates one `text` string. Change it
to hold ordered segments:

```typescript
type Segment =
  | { kind: 'prose'; index: number; text: string }
  | { kind: 'block'; index: number; block: UiBlockEvent };
```

- The assistant `TranscriptItem` gains `segments: Segment[]` (keep `text` for the user/notice roles).
- On `text-delta`: append to the prose segment whose `index` equals `ev.data.segment` (default `0`
  when the field is absent, so a non-chat producer still renders), creating it if absent.
- On `ui-block`: upsert the block segment at `ev.data.segment` — a later `ready`/`invalid` for the
  same index REPLACES the earlier `partial`.
- Render segments sorted by `index`.

- [ ] **Step 4: Render them**

Replace the assistant branch of `TranscriptRow` (line ~1197):

```tsx
  if (item.role === 'assistant') {
    return (
      <div className="chat-msg assistant">
        {(item.segments ?? []).map((seg) =>
          seg.kind === 'prose'
            ? <MarkdownView key={seg.index} source={seg.text} />
            : <BlockSegment key={seg.index} block={seg.block} onSend={onSend} onOpenRecord={onOpenRecord} />)}
      </div>
    );
  }
```

`TranscriptRow` is memoized on `item`; pass `onSend`/`onOpenRecord` as stable `useCallback`
references from `ChatPanel` so memoization still holds. `onSend` sets the composer draft and sends
it through the SAME path a typed message takes — a button must not have a private route into the
agent.

- [ ] **Step 5: Build**

```bash
node devtools/dev.mjs build
```
Expected: clean `tsc -b` and a successful Vite build.

- [ ] **Step 6: See it end to end**

```bash
node devtools/dev.mjs server
```

In another shell, drive the stub through a real chat turn:

```bash
curl -s -X POST http://127.0.0.1:5317/api/chat -H "content-type: application/json" -d "{\"message\":\"UI_CASE:VALID\"}"
```

Open `http://127.0.0.1:5317/` and confirm in the transcript: prose, then a rendered Card with a
table inside it, then more prose — and **no JSON anywhere on screen**. Then run `UI_CASE:BAD_PROP`
and confirm the fallback card appears with "show raw content" collapsed.

- [ ] **Step 7: Commit**

```bash
git add src/client/src
git commit -m "feat(ui): the chat transcript renders ordered segments

Prose and blocks interleave by segment index; a ready/invalid block replaces the
partial placeholder at the same index. A button's send action goes through the
same path a typed message takes — no private route into the agent.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Delete the raw-HTML path

**Files:**
- Create: `src/client/src/ui/blocks/legacyMaps.ts`
- Modify: `src/client/src/ui/organisms/MarkdownView.tsx`
- Modify: `src/client/src/lib/sanitize.ts`
- Modify: `src/client/package.json`
- Modify: `devtools/scripts/e2e/p41.mjs`

- [ ] **Step 1: The legacy map plugin**

`src/client/src/ui/blocks/legacyMaps.ts`:

```typescript
/**
 * Compatibility ONLY. Plan documents written before S3a embed the maps as raw HTML
 * (`<div class="trip-map" data-cities="…">`). remark parses those into `html` nodes BEFORE rehype
 * runs, so this plugin can turn them into real map nodes without `rehype-raw` being enabled at all
 * — which is why the raw-HTML pipeline can be deleted rather than narrowed. Scoped to exactly these
 * two classes; every other raw HTML node renders as escaped text.
 */
const TRIP = /<div\s+class=["']trip-map["']([^>]*)>/i;
const CITY = /<div\s+class=["']city-map["']([^>]*)>/i;
const attr = (s: string, name: string): string | undefined =>
  new RegExp(`${name}=["']([^"']*)["']`, 'i').exec(s)?.[1];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function remarkLegacyMaps() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tree: any) => {
    const visit = (node: any) => {
      if (!node.children) return;
      node.children = node.children.map((child: any) => {
        if (child.type !== 'html' || typeof child.value !== 'string') { visit(child); return child; }
        const trip = TRIP.exec(child.value);
        if (trip) {
          return mapNode({ cities: (attr(trip[1], 'data-cities') ?? '').split(',').map((s) => s.trim()).filter(Boolean) });
        }
        const city = CITY.exec(child.value);
        if (city) {
          return mapNode({
            pointsRaw: attr(city[1], 'data-points') ?? '',
            connect: ['1', 'true'].includes((attr(city[1], 'data-connect') ?? '').toLowerCase()),
            title: attr(city[1], 'data-title'),
          });
        }
        return child;
      });
    };
    visit(tree);
  };
}

// A `legacy-map` element node carrying its config as a data attribute; MarkdownView maps it to the
// Map renderer. Using a custom element name (not `div`) keeps it out of the way of real content.
function mapNode(config: Record<string, unknown>) {
  return {
    type: 'paragraph',
    children: [],
    data: { hName: 'legacy-map', hProperties: { 'data-config': JSON.stringify(config) } },
  };
}
```

- [ ] **Step 2: Rewire `MarkdownView`**

In `src/client/src/ui/organisms/MarkdownView.tsx`:

- Delete the `rehypeRaw` and `rehypeSanitize` imports, the `markdownSchema` import, and the
  `REHYPE_PLUGINS` constant. Remove `rehypePlugins={REHYPE_PLUGINS}` from `<ReactMarkdown>`.
- Add `remarkLegacyMaps` to the remark plugin list (both branches of the `collapsible` ternary).
- Delete the `div` component override entirely (the `trip-map` / `city-map` dispatch).
- Add a `'legacy-map'` component that reads the config back and renders the same maps:

```tsx
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'legacy-map': ({ node, ...rest }: any) => {
        let cfg: { cities?: string[]; pointsRaw?: string; connect?: boolean; title?: string } = {};
        try { cfg = JSON.parse((rest as Record<string, string>)['data-config'] ?? '{}'); } catch { /* keep {} */ }
        if (cfg.cities?.length) return <TripMap cities={cfg.cities} />;
        return <CityMap pointsRaw={cfg.pointsRaw ?? ''} connect={Boolean(cfg.connect)} title={cfg.title} />;
      },
```

Update the file's header comment: the pipeline no longer parses raw HTML, and the maps in existing
documents arrive through the remark shim.

- [ ] **Step 3: Strip the dead schema**

In `src/client/src/lib/sanitize.ts`, delete `markdownSchema` and the `rehype-sanitize` import, and
rewrite the file's header comment to say what is now true: the markdown pipeline no longer renders
raw HTML at all, so there is no allow-list to keep correct. **Keep `escapeHtml`, `sanitizeHtml` and
`safeUrl`** — `sanitizeHtml` still guards the PDF-export path over `marked()` output, which is a
different pipeline.

Verify nothing else imports the removed symbol:

```bash
cd D:/Development/Games/Gatherlight
grep -rn "markdownSchema\|rehype-raw\|rehypeRaw\|rehype-sanitize\|rehypeSanitize" src/client/src src/client/package.json
```
Expected after this step: only `package.json` lines, which the next step removes.

- [ ] **Step 4: Drop the dependencies**

Remove `"rehype-raw"` and `"rehype-sanitize"` from `src/client/package.json` dependencies, then:

```bash
cd src/client && npm install && cd ../..
```

- [ ] **Step 5: Add the legacy-map row to p41**

In `devtools/scripts/e2e/p41.mjs`, after the page rows, add a document fixture and assert the
server still serves it (the rendering itself is verified by eye in Step 7 — the e2e proves the
document survives the pipeline change without becoming an error):

```javascript
  // --- legacy map compatibility -----------------------------------------------------------
  // A plan document written before S3a embeds its map as raw HTML. It must still be readable —
  // the remark shim converts it at parse time, which is why rehype-raw could be deleted.
  const legacyDoc = path.join(dataDir, 'plans', 'legacy-map-demo.md');
  fs.mkdirSync(path.dirname(legacyDoc), { recursive: true });
  fs.writeFileSync(legacyDoc,
    '# Legacy\n\n<div class="city-map" data-points="35.71,139.79|Asakusa" data-connect="1"></div>\n', 'utf8');
  // GET /api/plans/content?path=… returns { path, content } for an indexed .md file.
  const doc = (await j('/api/plans/content?path=plans/legacy-map-demo.md')).body;
  ok('legacy map document is still served intact', /city-map/.test(doc?.content ?? ''),
    (doc?.content ?? '(no content)').slice(0, 80));
```

The document has to be indexed before `/api/plans/content` will serve it — the watcher picks up new
files, so if this row is flaky, wait for it with `until(async () => (await j('/api/plans/content?path=plans/legacy-map-demo.md')).status === 200)`
rather than removing the assertion.

- [ ] **Step 6: Build and run**

```bash
node devtools/dev.mjs build
node devtools/dev.mjs e2e p41
```
Expected: the build is clean and `e2e-p41 PASS`.

- [ ] **Step 7: Confirm the maps by eye**

```bash
node devtools/dev.mjs server
```
Open a plan document that contains a `trip-map` or `city-map` div (the p41 fixture above works: open
`http://127.0.0.1:5317/?path=plans/legacy-map-demo.md`). The map must render exactly as before.
Then confirm the raw-HTML path is really gone: a document containing `<script>alert(1)</script>`
must display that text visibly, not execute it.

- [ ] **Step 8: Commit**

```bash
git add src/client
git commit -m "refactor(ui): delete the raw-HTML markdown path

rehype-raw and the sanitize allow-list are gone. Existing documents keep their
maps through a remark shim that rewrites the two legacy div classes before rehype
runs — so nothing in the data folder needed rewriting, and agent text now has no
path to markup at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The vocabulary contract

**Files:**
- Modify: `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatEnvironmentService.cs`
- Modify: `src/server/Gatherlight.Platform/Hosting/Migration/Steps/KnowledgeBaseStep.cs`
- Modify: `devtools/scripts/e2e/p41.mjs`

- [ ] **Step 1: Understand why this is not a template file**

`ZhikuSeeder` never overwrites a file the household edited (`ZhikuSeeder.cs:97-107`). That is right
for planning guidance and wrong for a protocol contract: an agent working from a stale vocabulary
emits trees that fail validation, and the user sees fallback cards instead of a plan. So the
contract is written by `ChatEnvironmentService` and version-gated, exactly as the scope guard is.

- [ ] **Step 2: Add the contract file**

In `ChatEnvironmentService.cs`, beside `ScopeGuardPath`:

```csharp
    public string UiSpecPath => Path.Combine(_site.ZhikuPath, "ui-spec.md");
```

And beside the guard's version helpers:

```csharp
    // The UI contract is app-managed, not knowledge-base content: an agent working from a stale
    // vocabulary emits trees that fail validation and the household sees fallback cards. Same
    // version-gated re-issue as the scope guard — a newer on-disk version is left alone.
    private static readonly int ShippedUiContractVersion = ReadContractVersion(UiSpecMd);

    private static bool ShouldReissueUiSpec(string path)
    {
        if (!File.Exists(path)) return true;
        try { return ReadContractVersion(File.ReadAllText(path)) < ShippedUiContractVersion; }
        catch { return true; }
    }

    private static int ReadContractVersion(string body)
    {
        var m = System.Text.RegularExpressions.Regex.Match(body, @"UI_CONTRACT_VERSION:\s*(\d+)");
        return m.Success && int.TryParse(m.Groups[1].Value, out var v) ? v : 0;
    }
```

- [ ] **Step 3: Write the contract itself**

Add the `UiSpecMd` const to `ChatEnvironmentService.cs`, next to `ScopeGuardMjs`:

````csharp
    private const string UiSpecMd = """
        <!-- UI_CONTRACT_VERSION: 1 — generated by Gatherlight. App-managed: edits are replaced. -->
        # 界面块 · UI blocks

        You can render real UI, not just text. Write normal prose, and drop ```ui fenced blocks into
        it. Each block holds ONE component tree as JSON.

        ```ui
        { "type": "Card", "title": "Day 1", "children": [
            { "type": "Text", "text": "Morning at the museum" },
            { "type": "Table", "columns": ["Item", "Cost"], "rows": [["Entry", "1200"]] } ] }
        ```

        Rules:
        - `type` and `children` are reserved. Every other key is a prop, written flat.
        - A bare string inside `children` is shorthand for a `Text` node.
        - Only the components below exist. Anything else is shown to the user as "content this app
          cannot display" — so do not invent component names.
        - There is no HTML and no script. If you cannot express it with these components, say so in
          prose.

        ## Components

        | Type | Children | Props |
        |---|---|---|
        | `Stack` | yes | `gap`: none·sm·md·lg |
        | `Row` | yes | `gap`; `align`: start·center·end·baseline; `wrap`: true/false |
        | `Card` | yes | `title`, `subtitle` |
        | `Divider` | no | — |
        | `Heading` | no | `text` (required), `level`: 2·3·4 |
        | `Text` | no | `text` (required), `weight`: normal·bold, `tone`: default·muted·positive·warning |
        | `List` | no | `items` (required, strings), `ordered`: true/false |
        | `Badge` | no | `text` (required), `tone` |
        | `Image` | no | `src` (required — a file path inside the site, or an https URL), `alt`, `caption` |
        | `Table` | no | `columns` (required), `rows` (required, array of string arrays), `caption` |
        | `Map` | no | `points`: [{name,lat,lng}], `cities`: [names], `connect`, `title` |
        | `Link` | no | `href` (required, http/https), `text` (required) |
        | `FileRef` | no | `path` (required), `label` |
        | `Button` | no | `label` (required), `action` (required) |

        ## Button actions

        A button does one of exactly two things:

        - `{ "send": "text" }` — puts that text in as the person's next message.
        - `{ "openRecord": "plans/some-file.md" }` — opens a file from the site.

        Nothing else is accepted. A button cannot approve anything, run a tool, or open a URL —
        every real decision still goes through its own confirmation.

        ## Pages

        A page is the same tree saved as a file:

        ```json
        { "title": "Trip dashboard", "root": { "type": "Stack", "children": [] } }
        ```

        Limits: at most 12 levels deep and 500 nodes per tree.
        """;
````

- [ ] **Step 4: Return every written path**

`EnsureFiles()` currently returns `string?`. Change it to `IReadOnlyList<string>` so it can report
both files:

```csharp
    /// <summary>Returns the data-root-relative paths of app-managed files newly written this run
    /// (caller commits them to the data repo). Empty when everything was already current.</summary>
    public IReadOnlyList<string> EnsureFiles()
    {
        …
        var created = new List<string>();
        if (ShouldReissueGuard(ScopeGuardPath))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ScopeGuardPath)!);
            File.WriteAllText(ScopeGuardPath, RenderScopeGuard());
            created.Add(".claude/hooks/scope-guard.mjs");
        }
        if (ShouldReissueUiSpec(UiSpecPath))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(UiSpecPath)!);
            File.WriteAllText(UiSpecPath, UiSpecMd);
            created.Add(".claude/ui-spec.md");
        }
        return created;
    }
```

Update `KnowledgeBaseStep.cs:27`:

```csharp
        if (_chatEnv.EnsureFiles() is { Count: > 0 } seeded)
        {
            var sha = await _git.CommitPathsAsync(seeded, "seed: app-managed agent files", ct);
            _commits.Record(sha, "seed: app-managed agent files", "seed");
        }
```

Then find any other caller:

```bash
grep -rn "EnsureFiles" --include=*.cs src/server/
```
Fix each to the new signature.

- [ ] **Step 5: Assert the re-issue in p41**

Add to `devtools/scripts/e2e/p41.mjs` (the file is written during startup migration, so this can
run right after `waitHealthy`):

```javascript
  // --- the UI contract is app-managed ------------------------------------------------------
  const uiSpec = path.join(dataDir, '.claude', 'ui-spec.md');
  ok('the UI contract is seeded into the data folder', fs.existsSync(uiSpec));
  const specBody = fs.existsSync(uiSpec) ? fs.readFileSync(uiSpec, 'utf8') : '';
  ok('the contract carries a version', /UI_CONTRACT_VERSION:\s*\d+/.test(specBody));
  ok('the contract documents every component',
    ['Stack', 'Row', 'Card', 'Divider', 'Heading', 'Text', 'List', 'Badge', 'Image', 'Table', 'Map', 'Link', 'FileRef', 'Button']
      .every((c) => specBody.includes(`\`${c}\``)),
    'a component is missing from the contract the agent reads');
```

And prove the version gate actually replaces a stale copy — write an older version, restart, and
check it came back:

```javascript
  // A stale contract must be REPLACED (unlike knowledge-base content, which is never overwritten).
  fs.writeFileSync(uiSpec, '<!-- UI_CONTRACT_VERSION: 0 -->\nstale\n', 'utf8');
  server.kill();
  // `server` is already `let` (see Task 2) — reassign so the suite's finally kills the live one.
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  await waitHealthy(base);
  const after = fs.readFileSync(uiSpec, 'utf8');
  ok('a stale contract is re-issued', /UI_CONTRACT_VERSION:\s*1/.test(after) && after.includes('`Button`'),
    after.slice(0, 80));
```

Put this block **last** in the `try`, after every other assertion — it restarts the server, and the
rows above expect the first one.

- [ ] **Step 6: Build and run**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
node devtools/dev.mjs e2e p41
```
Expected: `e2e-p41 PASS`, including the two contract rows and the re-issue row.

- [ ] **Step 7: Commit**

```bash
git add src/server/Gatherlight.Platform devtools/scripts/e2e/p41.mjs
git commit -m "feat(ui): ship the block vocabulary as an app-managed contract

The seeder never overwrites a file the household edited, which is right for
planning guidance and wrong for a protocol: a stale vocabulary means the agent
emits trees that fail validation. Version-gated re-issue, same as the scope guard.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The drift check and close-out

**Files:**
- Create: `devtools/scripts/check-ui-registry.mjs`
- Modify: `devtools/dev.mjs`
- Modify: `.claude/rules/dev-conventions.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: The check**

`devtools/scripts/check-ui-registry.mjs`:

```javascript
#!/usr/bin/env node
// check-ui-registry.mjs — the component vocabulary lives in TWO languages: an IUiNodeSchema per
// component in C# (the enforcement point) and a renderer per component in TypeScript. Nothing but
// this check would notice them drifting apart — the compiler cannot see across the wire, and a
// component in the schema with no renderer is a blank space in the user's page.
//
// Static, not a live request: it must run in CI and pre-merge without a server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const appCs = path.join(repo, 'src', 'server', 'Gatherlight.Server', 'GatherlightApp.cs');
const registryTs = path.join(repo, 'src', 'client', 'src', 'ui', 'blocks', 'registry.ts');

const errors = [];

// Server side: every AddSingleton<IUiNodeSchema, XSchema>() registration.
const serverTypes = (() => {
  if (!fs.existsSync(appCs)) { errors.push(`missing ${path.relative(repo, appCs)}`); return []; }
  const body = fs.readFileSync(appCs, 'utf8');
  return [...body.matchAll(/AddSingleton<IUiNodeSchema,\s*([A-Za-z0-9_]+)Schema>/g)]
    .map((m) => m[1]).sort();
})();

// Client side: the exported UI_COMPONENTS list, read from the RENDERERS map's keys.
const clientTypes = (() => {
  if (!fs.existsSync(registryTs)) { errors.push(`missing ${path.relative(repo, registryTs)}`); return []; }
  const body = fs.readFileSync(registryTs, 'utf8');
  const block = /export const RENDERERS[^{]*{([\s\S]*?)\n};/.exec(body);
  if (!block) { errors.push('could not find the RENDERERS map in registry.ts'); return []; }
  return [...block[1].matchAll(/(?:^|[\s,{])([A-Z][A-Za-z0-9_]*)\s*(?:,|$|:)/gm)]
    .map((m) => m[1])
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
})();

if (serverTypes.length === 0) errors.push('no IUiNodeSchema registrations found — did the DI block move?');

const onlyServer = serverTypes.filter((t) => !clientTypes.includes(t));
const onlyClient = clientTypes.filter((t) => !serverTypes.includes(t));
for (const t of onlyServer) errors.push(`'${t}' has a server schema but no client renderer`);
for (const t of onlyClient) errors.push(`'${t}' has a client renderer but no server schema`);

if (errors.length) {
  console.error('\x1b[31m✖ UI registry drift\x1b[0m');
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`check-ui-registry: clean — ${serverTypes.length} components, schema and renderer agree.`);
process.exit(0);
```

- [ ] **Step 2: Wire it into dev.mjs**

In `devtools/dev.mjs`, beside the `check-layering` case (line ~148):

```javascript
  case 'check-ui-registry':
    run('node', [path.join(repo, 'devtools', 'scripts', 'check-ui-registry.mjs'), ...args]);
    break;
```

And add the usage line beside the others near line 18:

```javascript
//   node devtools/dev.mjs check-ui-registry - assert the C# schemas and TS renderers agree
```

- [ ] **Step 3: Prove it passes, then prove it can fail**

```bash
cd D:/Development/Games/Gatherlight
node devtools/dev.mjs check-ui-registry
```
Expected: `check-ui-registry: clean — 14 components, schema and renderer agree.`

Now make it fail, both directions. Temporarily add a schema registration with no renderer:

```csharp
            .AddSingleton<IUiNodeSchema, GanttSchema>()
```
(You do not need the class to exist — the check is static.) Run again; expect:
```
✖ UI registry drift
  'Gantt' has a server schema but no client renderer
```
Revert that line. Then temporarily add `Gantt,` to `RENDERERS` in `registry.ts` and run again;
expect `'Gantt' has a client renderer but no server schema`. Revert.

Run once more and confirm clean. **Quote all three outputs in your report** — a checker that cannot
fail is not a checker.

- [ ] **Step 4: Document the convention**

In `.claude/rules/dev-conventions.md`, add a bullet to the Backend section, after the scorers/judge
bullets:

```markdown
- **Agent-authored UI is a validated node tree, never markup.** The vocabulary is a DI collection of
  `IUiNodeSchema` (`Platform/Agent/Ui`): one class + one registration per component, never a switch.
  The server validates before the client is told a block exists — unknown type, unknown prop, wrong
  type, children on a leaf, or past the depth/node limits all fail, and a failure is SHOWN to the
  user, never dropped. Two mounts share it: a ```ui fence inside a streamed chat turn (the scanner
  splits a turn into ordered segments so raw JSON never lands in the transcript) and a page spec in
  `{data}/ui/`. `rehype-raw` and the sanitize allow-list are gone — legacy `trip-map`/`city-map`
  divs survive through a remark shim, so agent text has no path to markup at all. A `Button`'s
  action is a container verb (`send`, `openRecord`), and `send` only composes the user's next
  message: a button cannot approve anything. The schema is C# and the renderer is TypeScript, so
  `node devtools/dev.mjs check-ui-registry` guards the two lists against drift. The vocabulary the
  agent reads (`.claude/ui-spec.md`) is app-managed and version-gated like the scope guard.
```

In `CLAUDE.md`, add to the "Current state" section:

```markdown
The agent's own UI is declarative: `Platform/Agent/Ui` validates a component tree that renders both
inline in chat and as site pages from `{data}/ui/` — no raw HTML anywhere in the agent's reach.
```

- [ ] **Step 5: Full verification**

```bash
node devtools/dev.mjs check-ui-registry
node devtools/dev.mjs check-layering
node devtools/scripts/check-sensitive.mjs --tree
dotnet build src/server/Gatherlight.Platform/Gatherlight.Platform.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Planner/Gatherlight.Planner.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
node devtools/dev.mjs build
```

All clean; the three net10.0 projects at `0 Warning(s) 0 Error(s)`; Host with only its known
MSB3277.

**Do not run the full e2e suite from a subagent** — a backgrounded suite is orphaned when the
agent's turn ends, which already cost this project a wasted run. The coordinator runs
`node devtools/dev.mjs e2e all`, expecting `41/41`.

- [ ] **Step 6: Commit**

```bash
git add devtools .claude/rules/dev-conventions.md CLAUDE.md
git commit -m "chore(ui): the registry drift check, and the documented convention

The schema is C# and the renderer is TypeScript; nothing but this check would
notice them diverging. Verified by making it fail in both directions.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Not in scope

- **Composites (`defineComponent`) and the authoring loop** — S3b. `ui/` is not in the agent's write
  scope (`ChatEnvironmentService.RenderScopeGuard` builds `WRITE_DIRS` from the manifest's records
  plus `.claude`), so the agent cannot yet write pages. That is deliberate: S3b adds the write scope
  together with the diff gate's rendered page preview, and one without the other is the bad half.
- **`plan` and `choice` blocks** — S3c. The existing approval cards keep working unchanged.
- **`Chart`, `Tabs`, data binding** — deferred in the spec.
- **Tightening `img-src`** — the remote-image channel is a named residual; the fix is a CSP change
  plus a tile proxy, not a validation rule.
