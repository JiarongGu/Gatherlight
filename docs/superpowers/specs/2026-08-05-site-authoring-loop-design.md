# The site authoring loop: the agent writes the site interface — design (S3b)

> 2026-08-05 · sub-project **S3b** of the platform track. Status: **designed**, not yet planned.
> Follows S3a (`2026-08-05-ui-block-protocol-design.md`), implemented and merged: the declarative
> UI format, the component registry, and both mounts. S3c is named below and deferred.

## Why

S3a shipped the renderer for site pages and deliberately stopped there. A page spec under
`{data}/ui/` validates and mounts at `?page=<name>`, and the site template seeds one — but **the
agent cannot write one.** `RenderScopeGuard` builds `WRITE_DIRS` from the manifest's record
directories plus `.claude`, so `ui/` is not writable, and nothing lists a page anywhere in the app.

That is the half that makes the product's premise real: *the agent writes most of the site, and the
container owns the chat.* Today it owns the chat and renders a site nobody can author.

S3a's non-goals said write access and a legible review gate must ship together, because either
alone is the bad half — write access without a reviewable gate is an agent editing the interface
unsupervised, and a gate with nothing to review is ceremony. This sub-project is both.

## The governing property

From S3a: **trust follows the review path, not the surface.** A page is a file in the git-backed
data repo, so the two-gate flow already stands between the agent and anything going live. S3b makes
that gate *legible*:

**Because a page is a validated tree of known components, the approval gate renders it.** A
non-technical household cannot review a diff of JSON any more than one of HTML — but they can look
at the page. That affordance is the reason the declarative format was chosen over markup, and this
is where it pays.

One property falls out for free, and it is the strongest thing here: **an invalid page blocks the
commit**, the way a failed build already does. The agent cannot ship a page that would not render,
because the thing being approved has already been through the validator.

## Goals

1. The agent can create and edit pages, and nothing else new.
2. A page change is reviewed by looking at the page, with the raw diff still one click away.
3. A page that fails validation cannot be committed.
4. A page the agent wrote is findable tomorrow, not just via a link in an old transcript.
5. The agent knows this is possible — a capability it is not told about is unreachable.

## Non-goals

| Deferred | What |
|---|---|
| **S3c** | Composites: `defineComponent` as a named, parameterized subtree of primitives, approved through a draft-style gate. The fourteen components cover a lot before the agent needs to invent one. |
| **S3c** | Data binding — a node that queries the record index live instead of carrying literal rows. A page with literal rows is still a page; a stale one is a smaller problem than an unauthorable one. |
| Later | Page deletion by the agent. The guard denies `rm` outright and that stays true; a page is retired by a human, or by the agent emptying it, until there is a reason to do more. |
| Later | Per-page access control. One household, one site — there is nothing here for it to separate. |

## Write scope

`RenderScopeGuard` gains the manifest's `ui.spec` alongside the records and `.claude`, so a site
that relocates its UI directory is jailed correctly without editing the guard. `PROTECTED` stays
hardcoded: a site must not be able to widen its own jail by editing its own manifest.

The guard's write check today is `underAny(rel, WRITE_DIRS)` — a flat directory list with no notion
of file type. `ui/` needs one, because the site's interface directory is not a place the agent
should be able to drop a script:

```js
const WRITE_DIRS = __WRITE_DIRS__;
const WRITE_EXTS = __WRITE_EXTS__;   // { 'ui': ['.json'] } — dirs restricted by file type
```

checked immediately after the allow-list and before `PROTECTED`:

```
ui/tokyo.json       ✓        ui/notes.md    ✗
ui/sub/deep.json    ✓        ui/hack.mjs    ✗
```

Nothing runs a `.mjs` under `ui/` today. The restriction exists so that remains true by
construction rather than by nobody having thought of it.

**Both guards carry it.** The planner guard and `guard/system-scope-guard.mjs` are identical logic
with different write scopes, and `e2e-p24` runs both; `WRITE_EXTS` is empty for 系统模式. The
`GUARD_VERSION` bump is what re-issues the new logic into data folders seeded by an earlier build —
the guard is a security boundary, not editable knowledge-base content.

## Navigation

A page file gains an optional `nav`:

```json
{ "title": "Tokyo 2026", "nav": { "label": "东京", "order": 1 }, "root": { … } }
```

`GET /api/ui/pages` returns pages ordered by `nav.order` then name, carrying `label` (defaulting to
`title`) and `hidden`. The sidebar renders a Pages section from it.

Writing the file is publishing it. The alternative — a list in `site.json` — was rejected because
every new page would need two edits, and a page whose manifest entry is missing exists on disk,
renders at its URL, and appears nowhere. That failure is silent and confusing to debug; this one
cannot happen. `hidden: true` keeps a page reachable by link while out of the menu.

An invalid page still appears in the list, marked, rather than vanishing — the same reasoning as
S3a's visible fallback: a silent hole makes a defect invisible.

## The preview gate

`ReviewPayload.files` is a list of `DiffFile { path, status, isClaudeInfra, diff }`, grouped in the
client into content changes and `.claude/` infra (the latter behind a separate acknowledgement).
Page changes become a third group.

When a diffed path sits under the UI directory, the server attaches a projection to that file:

```csharp
sealed record PageDiffView(
    string Name, string Title, string Status, UiNode? Root, string? Reason, string Summary);
```

- `Status` is `ready` or `invalid`, from the same `IUiTreeValidator` the live mount uses. It reads
  the file **from the working tree**, which at review time already holds the agent's edits and not
  yet a commit — so what is validated and rendered is exactly what approval would commit. Reading
  the committed version instead would preview the wrong thing, which is the mistake to avoid here.
- `Root` is the validated tree; the client renders it with the same `UiTree` the live page uses.
- `Summary` is a deterministic, plain-language account of what changed, computed by walking the
  before and after trees and counting components by type: *"新增 1 个 Table、1 个 Card"*. No LLM —
  a summary the agent authored is the agent describing its own change, which is exactly the thing
  S2 established must not be trusted at an approval surface.

The raw JSON diff stays available behind a disclosure. The render is the review; the diff is the
appeal.

**An invalid page blocks approval.** `DiffReview` already computes `canApprove` with a
`buildFailed` term; it gains a `hasInvalidPage` term and an alert naming the file and the reason.
A page that would not render cannot be committed — enforcement, not advice.

**A deleted page** renders as a plain statement that the page will be removed, with its name. There
is nothing to preview and pretending otherwise would be worse than saying so. The agent cannot
produce this case — the guard denies `rm` outright — but a human editing the data repo directly
can, and the review renders whatever diff it is given rather than assuming who made it.

## Telling the agent

S3a's sharpest lesson: the vocabulary contract was seeded, versioned and correct, and completely
unreachable, because nothing told the agent to read it — every check stayed green with the feature
switched off. So this ships with its own pointer:

- `.claude/ui-spec.md` gains a **Pages** section: the file shape including `nav`, where pages live,
  that a page is the same tree, and that an invalid page cannot be committed.
- `UI_CONTRACT_VERSION` → **2**, which re-issues the contract into existing data folders.
- The execute prompt states the agent may create and edit pages under the site's UI directory.
- An e2e row asserts the prompt carries it, the way `p41` now asserts the contract pointer — with
  the check proven by deleting the line and watching that single row fail.

## Threat model delta

S2's actors are unchanged. What this changes:

| Vector | Before | After |
|---|---|---|
| Agent writes the app's interface | Impossible — `ui/` unwritable | Possible, and every change passes the diff gate as a rendered page |
| Agent drops executable content into `ui/` | n/a | Blocked by `WRITE_EXTS`: `.json` only |
| Agent ships a page that breaks the app | n/a | Blocked: an invalid tree cannot be approved |
| Agent widens its own write scope via the manifest | Blocked (`PROTECTED` hardcoded) | Unchanged — `ui.spec` is read from the manifest, but `PROTECTED` and the extension rule are not |
| A page's text misleads the reader | n/a | **Open, and inherent.** Agent words remain agent words; platform chrome renders from enforced state and gate components are not in the registry, so a page cannot impersonate an approval surface — but it can say something untrue, exactly as a plan document can. |

## Testing

A new `p42` suite, in the discipline `p38`/`p39`/`p41` established — every rejection beside a
positive control:

| Case | Expected |
|---|---|
| Guard: write `ui/x.json` | allowed |
| Guard: write `ui/x.md` and `ui/x.mjs` | denied, message names the extension rule |
| Guard: write `ui/sub/deep.json` | allowed — the rule is by extension, not depth |
| Guard: 系统模式 unchanged | `p24` stays green with `WRITE_EXTS` empty |
| A run that edits a page | `ReviewPayload` carries `PageDiffView` with `status: "ready"` and the tree |
| A run that writes an invalid page | `status: "invalid"`, reason names the cause, and the approve call is **refused** |
| Summary of an edit adding a table | mentions the added component type and count |
| A new page with `nav` | appears in `GET /api/ui/pages` at the right order with its label |
| `hidden: true` | absent from the nav list, still fetchable by name |
| A page with no `nav` | listed, label falls back to the title |
| The prompt names the pages capability | present — proven by deleting the line and watching this row alone fail |

`check-ui-registry`, `check-layering` and the full suite are the merge gate.

## File structure

**Server**

| File | Change |
|---|---|
| `Platform/Agent/Chat/Services/ChatEnvironmentService.cs` | `WRITE_DIRS` gains `ui.spec`; new `WRITE_EXTS`; `GUARD_VERSION` + `UI_CONTRACT_VERSION` bumps; the contract's Pages section |
| `guard/system-scope-guard.mjs` | the same `WRITE_EXTS` rule, empty |
| `Platform/Agent/Ui/Models/SitePage.cs` | `nav` on the page file and the summary; `PageDiffView` |
| `Platform/Agent/Ui/Services/SitePageStore.cs` | ordering, `hidden`, label fallback |
| `Platform/Agent/Ui/Services/PageDiffSummary.cs` | the deterministic before/after tree comparison |
| `Platform/Agent/Chat/Services/ChatSessionService.cs` | attach `PageDiffView` when a diffed path is a page; refuse approval when one is invalid |
| `Platform/Agent/Llm/Services/PromptHarness.cs` | the execute prompt names the pages capability |

**Client**

| File | Change |
|---|---|
| `ui/organisms/ChatReview.tsx` | the page group: rendered preview, summary, collapsed diff, invalid-page block |
| `ui/organisms/Sidebar.tsx` | the Pages section |
| `lib/chatTypes.ts` | `PageDiffView` on `DiffFile` |

## Success criteria

1. The agent creates a page in a normal chat turn, and it is reviewed by looking at it.
2. A page written with an unknown component cannot be approved, and the gate says why.
3. `ui/x.mjs` is denied by the guard; `ui/x.json` is allowed.
4. A page with `nav` appears in the sidebar in its declared order and opens.
5. The prompt names the capability, proven by making that assertion fail.
6. `p24`, `p41`, `p42` and the full suite are green.
