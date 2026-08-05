# The site's declarative UI: format, registry and renderer — design (S3a)

> 2026-08-05 · sub-project **S3a** of the platform track. Status: **designed**, not yet planned.
> Follows S1 (`2026-08-04-site-model-container-design.md`), S2
> (`2026-08-05-capability-model-design.md`) and S4
> (`docs/superpowers/plans/2026-08-05-platform-planner-assembly-split.md`), all implemented.
> S3b and S3c are named below and get their own specs.

## Why

S1 declared the seam this sub-project fills. `site.json` already carries
`"ui": { "spec": "ui/", "specVersion": 1 }`, and S1's data-folder layout annotates that directory
"starting page specs (inert in S1; the renderer is S3)". Nothing reads it yet, and the template does
not ship one.

The product's direction is a site whose **agent writes most of the site**, using components the
platform ships and controls. Two things stand in the way:

- **There is no format.** The agent has markdown and, through `rehype-raw` plus a
  `rehype-sanitize` allow-list, a narrow slice of HTML — enough for `div.trip-map` and
  `div.city-map`, nothing more. It cannot compose a view.
- **There is no renderer.** `MarkdownView` dispatches two known `div` classes to map components.
  That is the whole mechanism.

The audience decides the shape, as it did in S2. **Gatherlight is used by a non-technical
household.** They will approve what the agent builds, so what they approve must be something they
can actually look at and judge.

## The organizing principle: trust follows the review path

The two surfaces this format serves have opposite ownership, and the reason is not aesthetic:

| Surface | Owner | Reviewed before the user sees it? | Therefore |
|---|---|---|---|
| **Chat transcript** | the container | **No.** It streams live; by the time anyone could object it is on screen | Strict. Platform vocabulary, validated per message, no persistence, no approval step because there is no moment to put one in |
| **Site pages** (`{data}/ui/`) | **the agent** | **Yes.** A page is a file in the git-backed data repo, behind the existing two-gate diff-approval flow | Broad. The agent writes and updates the site; a human approves the diff before it goes live |

Chat is where the container must be strict, precisely because nothing stands between the agent's
output and the household's eyes. Site pages can be far freer, because the two-gate flow already
stands there.

**This is what makes the declarative format better than HTML for the site, not merely safer.**
Because a page is a validated tree of known components, the approval gate can **render a preview of
the page** instead of showing a diff of markup. A non-technical household cannot review
`<div class="grid" style="…">`; they can look at the page and say yes. That affordance does not
exist if the agent writes markup, and it is the difference between a real gate and one people click
through.

## Governing stance

**A vocabulary, not a filter.** The platform states what can be expressed; anything outside it does
not parse. This is the same move S2 made from `deny` lists to positive grants — replacing "block the
dangerous constructs we thought of" with "render the constructs we defined".

**Chrome is not in the vocabulary.** Approval cards, permission clauses and gate state render from
enforced server state, and their component types are unavailable to an agent-authored tree. The
agent's own words appear in the agent's own visual register, as S2 established for
`DraftApprovalView.description` and `CapabilityApprovalView.agentReason`.

**One format, two mounts.** The same tree renders inline in a chat reply and as a full page. A page
is not a second system; it is the same data mounted somewhere durable.

## Goals

1. One declarative UI format — validated server-side, streamed incrementally in chat, mounted as a
   page from `{data}/ui/`.
2. A component registry that is a DI collection: adding a component is a class and a registration.
3. Raw HTML gone from the agent's reach entirely, with existing plan documents still rendering.
4. A structured, replayable transcript at no migration cost.
5. A drift check, because the schema lives in C# and the renderer lives in TypeScript.
6. Every rejection visible to the user, never silent.

## Non-goals

| Deferred | What |
|---|---|
| **S3b** | The authoring loop: `ui/` added to the agent's write scope, page routing and navigation, page-level components, agent-proposed composites, and the diff gate rendering a **before/after page preview** instead of JSON |
| **S3c** | The gates as blocks: a `plan` block driving the approval card, a `choice` block turning `NEEDS_INPUT` into buttons |
| Later | `Chart`. Budget breakdowns are the only real candidate and `BudgetScanTool` returns numbers a `Table` already shows |
| Later | `Tabs`, `Accordion`, and anything else carrying interaction state. The v1 tree is stateless apart from `Button` |
| Later | Data binding — a page node that queries the record index live rather than carrying literal rows. S3b's authoring loop is where this becomes worth having |
| Out | Any agent path to raw HTML or JavaScript, on either surface. If the registry cannot express it, S3b's composites are the answer |

## Sub-project decomposition

| | Ships | Depends on |
|---|---|---|
| **S3a** (this spec) | The format, the registry, both mounts; raw HTML is gone; the template seeds a starter page | S1, S2, S4 |
| **S3b** | The agent authors and updates the site interface, approved through a rendered preview | S3a |
| **S3c** | The approval flow reads as a checklist and buttons for a non-technical user | S3a |

S3b comes before S3c: the site is the point, and the chat gates work adequately today.

## The format

One node tree, used verbatim on both surfaces.

```json
{ "type": "Card", "title": "Day 1", "children": [
    { "type": "Map", "points": [{"name":"Asakusa","lat":35.71,"lng":139.79}], "connect": true },
    { "type": "Table", "columns": ["Item","Cost"], "rows": [["Flights","¥82,000"]] } ] }
```

`type` and `children` are reserved; every other key is a prop, flat. Flat props mean fewer nesting
levels for a model to get wrong, and the two reserved words are unambiguous. A bare string in
`children` is shorthand for a `Text` node.

**In chat**, the agent writes ordinary prose and drops fenced `ui` blocks into it. There is exactly
one fence type — `Table` and `Map` are node *types* inside the tree, not sibling fences. One parser,
one validator, one fallback path.

````
Here is your Tokyo itinerary.

```ui
{ "type": "Card", "title": "Day 1", "children": [ … ] }
```

Shall I book the hotel?
````

An assistant turn becomes an ordered list of **segments** — prose segments and block segments. The
scanner assigns the index; the client renders in index order.

**As a page**, the same tree is a file: `{data}/ui/<name>.json`, holding
`{ "title": "…", "root": { … } }`. No streaming, no segments, same validator, same renderer. S3a
ships the mount and one seeded starter page in the site template; S3b opens authoring.

## The component set (v1)

| Component | Children | Key props | Notes |
|---|---|---|---|
| `Stack` | yes | `gap` | vertical layout |
| `Row` | yes | `gap`, `align`, `wrap` | horizontal layout |
| `Card` | yes | `title`, `subtitle` | platform card chrome, visually distinct from gate cards |
| `Divider` | no | — | |
| `Heading` | no | `text`, `level` (2–4) | level 1 belongs to the page |
| `Text` | no | `text`, `weight`, `tone` | `tone` ∈ `default`·`muted`·`positive`·`warning` |
| `List` | no | `items[]`, `ordered` | items are strings |
| `Badge` | no | `text`, `tone` | |
| `Image` | no | `src`, `alt`, `caption` | `src` is a record path or an https URL — see below |
| `Table` | no | `columns[]`, `rows[][]`, `caption` | |
| `Map` | no | `points[]`, `cities[]`, `connect`, `title` | replaces both legacy map divs |
| `Link` | no | `href`, `text` | http/https only, host shown |
| `FileRef` | no | `path`, `label` | a record file; opens in the reader |
| `Button` | no | `label`, `action` | see the action allow-list |

## Enforcement

**Schemas are a DI collection.** Each node type is an `IUiNodeSchema` registered
`AddSingleton<IUiNodeSchema, …>`, following `IGatherlightTool` and `IScorer`. A schema declares its
allowed props with types, its required set, and whether it accepts children. Adding a component is a
class plus one registration — never a switch. An unregistered `type` has no schema and fails
validation in one place.

**Validation is total and positive.** Unknown prop → reject. Wrong type → reject. Children on a leaf
→ reject. Depth beyond 12 or more than 500 nodes → reject: a runaway tree is a denial of service
against the renderer, and an agent that needs 500 nodes wants a composite, which is S3b.

**Button actions are container verbs**, not URLs and not scripts:

| Action | Meaning |
|---|---|
| `{"send": "text"}` | send this text back to the agent as the user's next message |
| `{"openRecord": "plans/tokyo-2026/itinerary.md"}` | open a record file in the reader |

`openRecord` resolves through `ISiteContext.ResolveSitePath`, which already refuses `state/`. The
verb is named for the platform's own concept — records, per S1's manifest — because Platform must
not know the planner keeps plans. Anything else in `action` fails validation.

A `send` action is deliberately unprivileged: clicking it composes the user's next message and
nothing more. An agent that labels a button "Approve" gets a message, not an approval — every
consequential step still passes its own gate, rendered from enforced state. A button is a shortcut
for typing, never a shortcut past a decision.

**`Image.src` accepts a record path or an https URL**, and `Link.href` accepts http/https. The
renderer shows a link's host beside its label so the destination is not hidden behind friendly text.

A remote image is a genuine zero-click exfiltration channel — the browser fires the GET the moment
the element renders, and the data rides in the URL, so same-origin policy is irrelevant. It is not
restricted here because **restricting it at this node would not close the channel.** Plan markdown
renders `![](https://…)` through react-markdown along a path this sub-project does not touch, and
the app's own CSP is `img-src 'self' data: blob: https:` because Leaflet loads map tiles from a
CDN. A rule that stops the agent from putting a hotel photo on a page it built, while the adjacent
door stays open, buys nothing and costs a real capability.

The channel is recorded as a residual below. The fix, when it is worth doing, is one move at the
CSP layer rather than a rule per node: proxy map tiles through the server, then tighten `img-src`
to `'self' data: blob:` — which closes it for markdown, trees and anything added later at once.

## Streaming and failure (chat mount)

The scanner runs over the accumulated assistant text as it arrives and emits one `block` event per
fence, on the existing SSE stream as a new `AgentEvent.kind`:

```
{ segment: 3, status: "partial" }                        // fence open, payload incomplete
{ segment: 3, status: "ready",   node: { … } }           // closed and validated
{ segment: 3, status: "invalid", raw: "…", reason: "…" } // closed, failed validation
```

A `partial` block renders as a compact "preparing view…" placeholder rather than leaking half a JSON
payload. The trailing-unclosed-fence rule is borrowed from `langchain-ui`'s
`parseRichTextToMessageContent`, relocated to C# where the existing e2e harness can test it — the
client has no test framework, and adding one is not the price of this feature.

A fence still open when the turn's text ends resolves to `invalid` with reason "unterminated block",
never staying `partial`. A placeholder that spins forever is a worse failure than an honest one, and
a truncated run is exactly when it would happen.

An `invalid` block renders as a plainly-marked card naming what the app could not display, with the
raw content behind a disclosure. Not dropped: a silent hole makes a schema bug invisible in
production and leaves the user reading a reply with a gap in it. Not a red error either: a household
seeing an alarming failure for a block name we simply do not ship is a support call, not a signal.

**Persistence costs no migration.** Blocks are appended through
`AppendEventAsync(sessionId, "ui-block", payloadJson)`. Lyntai owns `lyntai_thread`/`lyntai_message`
and the payload is already an opaque JSON string, so a structured transcript falls out of the shape
that exists. The DB redesign offered for this sub-project is not needed and is not taken.

## What is removed

`rehype-raw` and `markdownSchema` both go, along with the `div` dispatch in `MarkdownView`. After
this, agent text has no path to markup at all — a stronger statement than any allow-list, and one
that needs no maintenance as components are added.

**Existing documents keep their maps.** remark parses `<div class="trip-map" …>` into an `html` node
in the mdast tree *before* rehype runs. A remark plugin rewrites those nodes — both `trip-map` and
`city-map` — into `Map` nodes. Old trip documents render exactly as they do now, and nothing in the
data folder is rewritten. The plugin is compatibility, scoped to those two classes; every other raw
HTML node renders as escaped text.

## The drift check

Schemas live in C#; renderers live in TypeScript. Two lists that must agree, and nothing would
notice if they stopped. `node devtools/dev.mjs check-ui-registry` compares the client's exported
component keys against the server's registered schemas and fails when either side is ahead, naming
the offending component. Same shape and rationale as `check-layering`: a one-second structural check
over something no compiler can see. Its plan step proves it can fail by adding a component on one
side only, quoting the failure, then reverting.

## The vocabulary contract

The agent learns the format from `Assets/SiteTemplate/.claude/ui-spec.md` — every component, its
props, the action verbs, the page file shape, with worked examples.

This file is **app-managed, not knowledge-base content.** `ZhikuSeeder`'s hash guard never
overwrites a file the household has edited, which is right for planning guidance and wrong for a
protocol contract: an agent working from a stale vocabulary emits trees that fail validation, and
the user sees fallback cards instead of a plan. It therefore carries a `UI_CONTRACT_VERSION` and is
re-issued into existing data folders on bump, exactly as the scope guard's `GUARD_VERSION` is.

## Threat model delta

S2's three actors are unchanged: a mistaken agent, a prompt-injected agent, untrusted capability
code. What this sub-project changes:

| Vector | Before | After |
|---|---|---|
| Forged approval card | Possible in principle — the agent authors HTML and the allow-list permits the `div` classes maps need | Impossible by construction: gate components are not in the registry |
| Script injection | Blocked by the allow-list, correctly | No parse path exists |
| Zero-click exfiltration via image URL | Possible — `defaultSchema` permits `img[src]` with an https URL, and the CSP allows `img-src … https:` | **Unchanged — a named residual.** See below |
| Click-through exfiltration via link | Possible | Still possible, deliberately: `Link` allows http/https and the host is shown |
| Renderer denial of service | Unbounded | Bounded by depth and node-count limits |

**What this does not cover.**

A tree can still *say* something untrue in a `Text` node — agent words remain agent words. The
mitigation is unchanged from S2: platform chrome renders from enforced state, and the agent's prose
is styled as the agent's. Nothing here makes the agent honest; it makes the agent unable to
impersonate the platform.

**Remote-image exfiltration stays open**, deliberately, and predates this work. Any https URL in an
`Image` node or in plan markdown fires a GET the moment it renders, with attacker-chosen data in the
path. Restricting the node alone would be theatre while `![](https://…)` renders next to it. The
real mitigation is a CSP change, not a validation rule: proxy Leaflet's tiles through the server so
`img-src` can drop to `'self' data: blob:`. Worth doing on its own merits some day; out of scope
here, and listed so nobody reads this spec as having handled it.

## Testing

A new `p41` e2e suite. The claude stub emits each case and the suite asserts the wire result:

| Case | Expected |
|---|---|
| Valid tree, several components nested | `status: "ready"`, node matches what was sent |
| Unknown component type | `status: "invalid"`, reason names the type |
| Malformed JSON inside the fence | `status: "invalid"`, reason names the parse failure |
| Unknown prop on a known component | `status: "invalid"`, reason names the prop |
| `Button` action `{"openRecord": "state/gatherlight.db"}` | `status: "invalid"` — the path is refused |
| `Image` with an `https://` src | `status: "ready"` — allowed, matching markdown and the CSP |
| `Image` with a `javascript:` or `file:` src | `status: "invalid"` — only record paths and https |
| Tree exceeding the node limit | `status: "invalid"`, reason names the limit |
| Fence open mid-stream | `status: "partial"`, no raw payload on the wire |
| Fence still open when the turn's text ends | `status: "invalid"`, reason "unterminated block" — never left `partial` |
| Legacy `<div class="trip-map">` in a plan document | Renders as a `Map` node |
| Prose before and after a block | Three segments in index order |
| A seeded `ui/` page fetched through the page mount | Validated tree returned; a hand-corrupted page returns the same `invalid` shape, not a 500 |

Every rejection sits beside a positive control — the valid tree in row one is asserted in the same
run — so a blanket-reject bug cannot pass. This is the discipline `e2e-p38` and `e2e-p39` already
use.

`check-ui-registry` and `check-layering` both run in the close-out gate, and the full suite must be
green before merge.

## File structure

**Server** (`src/server/Gatherlight.Platform/Agent/Ui/`) — Platform, because none of it knows what a
plan is:

| File | Responsibility |
|---|---|
| `Services/UiBlockScanner.cs` | accumulated text → ordered segments; the partial-fence rule |
| `Services/UiTreeValidator.cs` | walks a parsed tree against the schema collection; enforces limits |
| `Services/UiActionValidator.cs` | the action allow-list and `openRecord` path resolution |
| `Services/SitePageStore.cs` | reads `{data}/ui/<name>.json` through `ISiteContext`, validates, projects |
| `UiController.cs` | `GET /api/ui/pages`, `GET /api/ui/pages/{name}`, `GET /api/ui/registry` |
| `Models/UiNode.cs` · `UiBlockEvent.cs` · `SitePage.cs` | the wire shapes |
| `Schemas/IUiNodeSchema.cs` | the DI seam |
| `Schemas/LayoutSchemas.cs` · `ContentSchemas.cs` · `InteractiveSchemas.cs` | the fourteen, grouped by kind |

**Client** (`src/client/src/ui/blocks/`):

| File | Responsibility |
|---|---|
| `registry.ts` | `UI_COMPONENTS` — the exported key list `check-ui-registry` reads — and the type→component map |
| `layout.tsx` · `content.tsx` · `interactive.tsx` | the renderers, grouped to match the schemas |
| `UiTree.tsx` | renders a validated tree; used by both mounts |
| `BlockSegment.tsx` | one chat segment: ready tree, partial placeholder, or fallback card |
| `legacyMaps.ts` | the remark plugin rewriting the two legacy map divs |
| `../screens/SitePage.tsx` | the page mount |

`MarkdownView.tsx` loses its `div` dispatch and both rehype plugins. `ChatPanel.tsx`'s reducer moves
from one growing text buffer to indexed segments; at 1215 lines it is the largest file in the client,
and the transcript rendering comes out of it as part of this work rather than as a later cleanup.

## Success criteria

1. The agent composes a nested tree in chat and it renders as platform components.
2. A page spec in `{data}/ui/` renders as a real screen through the same renderer.
3. `rehype-raw` is absent from `package.json`, and an existing trip document still shows its map.
4. Every row of the `p41` matrix passes, positive controls included.
5. `check-ui-registry` is green, and was demonstrated failing.
6. A tree that fails validation is visible to the user and names what could not be displayed.
7. The full e2e suite is green.
