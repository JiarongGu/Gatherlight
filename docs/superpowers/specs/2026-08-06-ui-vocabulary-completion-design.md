# S3c — pages that stay true: data binding, charts, composites

> 2026-08-06 · sub-project **S3c** of the platform track, the last one named by
> [`2026-08-05-ui-block-protocol-design.md`](2026-08-05-ui-block-protocol-design.md) and
> [`2026-08-05-site-authoring-loop-design.md`](2026-08-05-site-authoring-loop-design.md).
> Status: implemented — `e2e-p45`.

## Why

S3b made pages **authorable**. It did not make them **true**.

Every page the agent writes today carries literal rows. `ui/trip.json` holds a `Table` whose cells
were copied out of `plans/trips/2026-08-kyoto.md` at the moment the agent wrote it. Edit the trip
tomorrow and the page keeps showing yesterday's numbers, confidently, with no signal that it is
lying. The household's own dashboard becomes the least trustworthy surface in the product — worse
than the markdown, because a table *looks* like a readout of live state.

S3b's spec said the quiet part: "a stale one is a smaller problem than an unauthorable one." That
was the right call at the time and it has been paid off — pages are authorable now, and staleness is
what is left.

Three things finish the vocabulary. They are one sub-project because they share a validator, a
contract file and a drift check, and shipping them separately would revise the same four files three
times:

1. **Data binding** — a node reads live state instead of carrying a copy of it.
2. **`Chart`** — the one genuinely missing primitive. A household reading a budget on a phone gets a
   table of eleven numbers where a bar would do.
3. **Composites** — a named, parameterized subtree, so the agent stops re-emitting the same
   forty-node card six times per page.

## Goals

1. A page can show current data without being rewritten.
2. The agent names a query; it never writes one. Nothing the agent authors is ever *executed*.
3. A binding that cannot be satisfied says so, visibly, where the data would have been — the page
   still renders.
4. The renderer learns nothing new about binding: resolution happens server-side, and the wire shape
   stays exactly what S3a already renders.
5. A composite cannot expand into a bomb — recursion is impossible by construction, and the limits
   apply to the expanded tree.

## Non-goals

| Deferred | What |
|---|---|
| Later | User-defined queries. The query set is code we ship, for the same reason `runCapability` names an id: an agent-authored filter expression is an agent-authored program. |
| Later | Write bindings. A page reads state; it never mutates it. Every mutation stays behind a gate. |
| Later | Client-side refresh / polling. A binding resolves when the page is served. "Fresh at open" is the whole claim, and it is the one worth making. |
| Dropped | Deleting `remarkLegacyMaps` — see "The shim stays" below. |

## The governing idea

> **The agent names data; it never describes how to get it.**

This is `runCapability`'s rule applied to reading. A page supplies an **id and parameters**, and the
server owns what that id means — the same shape as a capability, a scorer, a UI schema, and every
other variation point in this codebase. The alternative (a filter string, a WHERE clause, a JSON
query DSL) hands the agent an expression language evaluated against the household's database, which
is a program by any other name, authored by the one participant the threat model says can be
injected.

## 1. Data binding

### Shape

A component that renders data gains an optional `bind` prop, mutually exclusive with the literal one:

```json
{ "type": "Table",
  "columns": ["计划 · Plan", "更新 · Updated"],
  "bind": { "query": "records", "params": { "kind": "trips", "limit": 10 } } }
```

`bind` is a new `UiPropKind.Binding`. It validates by **shape**: `query` must name a registered
source, and every key in `params` must be declared by that source with a matching scalar type. An
unknown query, an unknown param, a wrong-typed param, or supplying both `rows` and `bind` all fail
validation — which means, per S3b, **a page with a broken binding cannot be committed**.

### The sources are a DI collection

```csharp
public interface IUiDataSource
{
    string Id { get; }
    string Description { get; }                                  // rendered into ui-spec.md
    IReadOnlyDictionary<string, UiParamSpec> Params { get; }      // declared, validated, closed
    Task<UiData> FetchAsync(UiBindArgs args, CancellationToken ct);
}
```

One class + one `AddSingleton<IUiDataSource, …>` per query, never a switch — the same pattern as
`IUiNodeSchema`, `IScorer` and `IGatherlightTool`.

**A source returns exactly one data shape: rows of strings.** Not a union of rows/points/series —
one shape, so a source can be written without knowing which component will bind to it, and a
component reads the columns it needs (`Table` renders all of them; `Chart` reads column 0 as the
label and column 1 as the value, and a non-numeric cell there is a runtime failure like any other).
Binding `Map` is therefore **not** in this cut: points need typed lat/lng, and inventing a second
data shape to carry them would buy one component at the cost of the property that makes sources
cheap. It stays a literal-points component until a source exists that is worth the second shape.

The interface lives in **Platform**; a source that knows what a "trip" is lives in **Planner**. That
is the seam working as designed — the compiler already forbids the other direction.

Shipping three, because each answers a question a household actually asks:

| Id | Owner | Params | Returns |
|---|---|---|---|
| `records` | Planner | `kind` (a record subdirectory), `limit` | recent records: title · updated · path |
| `library` | Platform | `kind`, `query`, `limit` | library entities: name · region · summary |
| `budget` | Planner | `slug` | the zero-LLM budget scan for one plan: line · amount |

### Resolution is server-side, and that is the load-bearing choice

Bindings resolve **where the tree is already being validated** — `GET /api/ui/page/{name}`,
`POST /api/ui/validate`, and the chat block path — and the resolved node goes over the wire with
`rows` filled in and `bind` gone. Consequences, all of them good:

- **The client changes not at all.** `RENDERERS` and `UI_COMPONENTS` are untouched, so
  `check-ui-registry` keeps meaning what it means.
- **The database is never reachable from the browser.** A binding is not an API the client can call
  with arbitrary parameters; it is a server-side fill of a tree the server already validated.
- **The diff gate renders real data.** S3b reviews a page change by rendering it; a bound page
  renders against live state at review time, which is exactly what the reviewer needs to see.

### When the data isn't there

Two failure classes, deliberately handled differently:

| Failure | When | Result |
|---|---|---|
| **Shape** — unknown query, unknown param, both `rows` and `bind` | validation | the tree fails; the page cannot be committed |
| **Runtime** — the source throws, the record is gone, the query times out | resolution | that node renders as a visible "数据暂时不可用 · data unavailable" with the query id; **the rest of the page renders** |

A runtime failure must never blank the page and must never silently render an empty table — an empty
table is indistinguishable from "you have no trips", which is a lie the page tells on our behalf.

Rows are capped (200) and the cap is **reported in the node**, never silently applied: a truncated
table that does not say so is the same lie in a smaller font.

## 2. `Chart`

One new component, deliberately minimal:

```json
{ "type": "Chart", "kind": "bar", "labels": ["机票","住宿","餐饮"], "values": [82000, 64000, 21000],
  "unit": "JPY", "caption": "预算构成" }
```

- `kind`: `bar` · `line` — no pie (a family budget with eleven categories is unreadable as a pie, and
  the honest chart for part-of-whole here is a stacked bar).
- `labels` and `values` are equal-length and required; `values` are numbers, which is why this cannot
  just be a `Table`.
- Binds like everything else: `bind` in place of `labels`/`values`.

Rendered with inline SVG in the client — no chart library, no new dependency, and nothing that could
need a CDN the CSP would refuse anyway.

## 3. Composites

A composite is a **named parameterized subtree of primitives**. It adds no privilege: it expands,
server-side, into components that already exist and are already validated.

```json
{ "define": "DayCard",
  "params": { "day": "string", "note": "string" },
  "body": { "type": "Card", "title": "{{day}}", "children": [ { "type": "Text", "text": "{{note}}" } ] } }
```

Used as any other node: `{ "type": "DayCard", "day": "Day 1", "note": "Museum" }`.

Five rules make this safe rather than a template language:

1. **Definitions live in `ui/` like everything else** — same flat directory, same `.json`, same scope
   guard, same diff gate. A file with `define` is a composite; a file with `root` is a page. One
   store, one review path.
2. **Substitution is whole-value only.** `{{day}}` replaces an entire string prop. There is no
   expression, no concatenation, no nesting — `"{{a}}{{b}}"` is not a thing. A parameter can never
   inject structure, only a value into a slot the definition already chose.
3. **No composite may reference another.** One level, enforced at expansion. This makes recursion
   impossible rather than detected, which is a much shorter proof.
4. **Expansion happens before validation**, so the depth and node limits apply to the expanded tree.
   500 nodes stays 500 nodes.
5. **A composite may not be named after a primitive.** `define: "Table"` fails — otherwise a
   definition could quietly redefine what `Table` means on every page.

Composite *edits* go through the diff gate like any page. That matters more here than for a page,
because editing one changes every page that uses it — so the gate renders the affected pages, not
just the definition.

## The shim stays

`remarkLegacyMaps` was slated for deletion once typed blocks existed. It should not be deleted, and
the reason is worth recording so it is not re-proposed:

- The benefit it was tied to has **already been banked by other means**. `rehype-raw` and the
  sanitize allow-list are gone (S3a); the shim never enables raw-HTML parsing — it pattern-matches
  two class names in `html` nodes remark already produced, and every other raw HTML renders as
  escaped text.
- Nothing creates that shape any more. The agent cannot author markup at all, and the shipped
  knowledge base no longer mentions `trip-map` / `city-map`.
- What is left is **documents already in the household's data folder**. Deleting 53 lines of inert
  compatibility code would cost a migration that rewrites the family's own plan files.

That is a bad trade. The shim is compatibility for real user data, it is inert, and it stays.

## Testing — `e2e-p45`

| Check | Asserts |
|---|---|
| bound table renders live | a page bound to `records` shows a record created AFTER the page was written |
| binding survives the round trip | the served tree has `rows` and no `bind` — the client is never handed a query |
| unknown query fails validation | and therefore **cannot be committed** (the S3b property, re-proved) |
| unknown / mistyped param fails | closed param contract, per source |
| `rows` + `bind` together fails | the two are mutually exclusive |
| runtime failure is visible | a source that throws renders the unavailable node, and the REST of the page still renders |
| the cap is announced | a source over the row cap renders truncated **and says so** |
| chart validates its pairing | `labels`/`values` length mismatch fails |
| composite expands | a page using `DayCard` renders the primitives, with params substituted |
| composite recursion is impossible | a definition referencing another definition fails |
| composite cannot shadow a primitive | `define: "Table"` fails |
| expanded tree obeys the limits | a composite used enough times to pass 500 nodes fails |
| the agent is told | `ui-spec.md` names bindings, the query ids, `Chart` and composites — `UI_CONTRACT_VERSION` bumps to 3 |

The contract assertion is not ceremony: S3a's lesson, re-learned in S3b, is that a capability the
agent is never told about is unreachable while every check stays green.

## Decisions of record

- **The agent names a query; it never writes one.** An agent-authored filter is an agent-authored
  program evaluated against the household's database. Ids and declared params, exactly like
  `runCapability`.
- **Bindings resolve server-side.** The renderer never learns what a binding is, the client can never
  call one with parameters of its own, and `check-ui-registry` keeps its meaning.
- **Shape errors fail the commit; runtime errors render.** A page that cannot be right is refused; a
  page whose data is temporarily missing says so where the data would have been. Neither silently
  shows an empty table.
- **Truncation is announced.** A capped result that does not say it was capped is a false readout.
- **Composites are one level, whole-value substitution only.** Recursion becomes impossible instead
  of detected, and a parameter can never inject structure.
- **`remarkLegacyMaps` stays.** Its deletion was tied to a benefit already obtained; the remaining
  cost is a migration over the household's own documents.
