# Drafts, approval cards + the escalation harness (S2b) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the assistant propose a tool that a **non-technical person** can safely enable from the chat, and turn a refused capability call into a resumable decision instead of a dead end.

**Architecture:** Everything reuses the gate shape that already works four times over — the agent ends a turn with a marker, the server parks the session in a phase and emits a card built from *its own* record, a POST supplies the decision, and the run resumes with a `ResumeToken`. Cards are platform chrome rendered as siblings of agent output, never anything the agent can author; an allow-list sanitiser closes the hole that currently lets it try.

**Tech Stack:** ASP.NET Core net10.0, hand-rolled SSE (`text/event-stream`), React 18 + `react-markdown`/`remark-gfm`, `useReducer` local state. No .NET or component test project — verification is `dotnet build`, node e2e suites, and the `check-*` family.

**Spec:** `docs/superpowers/specs/2026-08-05-capability-model-design.md` — read its two "corrected after reading" sections first; they exist because the original design assumed mechanisms this codebase does not have.

**Depends on S2a** (merged): `capabilities.enabled` gates `Script` capabilities, grants are enforced, and the sandbox is real. Every sentence a card prints must correspond to a grant S2a actually enforces — that is why this comes second.

---

## Mechanisms this plan builds on (verified by reading, not assumed)

| Fact | Where | Consequence |
|---|---|---|
| SSE envelope is `AgentEvent { Kind, Phase, Text, Tool, SessionId, Data }`, camelCase, nulls dropped | `Platform/Agent/Llm/Models/AgentEvent.cs` | a card rides on `Data` of a `phase` event, as all existing cards do |
| Gates park **between turns**; `RunAsync` blocks to completion, markers are regex-matched against `FinalText`, continuation is a fresh run with `ResumeToken` | `ChatSessionService.FinishExecuteAsync`, `ContinueExecuteAsync` | escalation must be a marker, not a mid-call suspend |
| Every gate = a `ChatPhase` constant + a `ChatState` field + a reducer branch + a JSX block | `ChatPanel.tsx` | five hand-wired gates already; this plan adds two more the same way rather than generalising mid-flight |
| Gate POSTs go through `FireAndAck`: validates the expected phase (else `409`), fires async, returns `200 {ok:true}` immediately | `ChatController.cs` | new endpoints follow it exactly |
| Unknown `AgentEvent.Kind` is **silently dropped** by the client reducer (`default: return state;`) | `ChatPanel.tsx` | a new event the client ignores vanishes without trace — add a dev warning |
| `rehype-raw` is enabled with a **deny-list** sanitiser; `div.trip-map`/`city-map` become React components | `MarkdownView.tsx`, `lib/sanitize.ts` | the agent can author HTML today; Task 1 closes it |
| `notify_user` writes to a `notification` table on a **separate** SSE stream and a bell icon | `Platform/Ops/Jobs/Tools/JobTools.cs`, `NotificationBell.tsx` | it cannot point at a chat card; don't try |
| Parked sessions are in-memory only; restart forces non-terminal threads to `error` | `SelfHealStateStep` | an escalation is lost on restart, exactly like today's gates. Accepted, documented |

---

## File structure

**New**

| File | Responsibility |
|---|---|
| `Platform/Capabilities/Models/CapabilityDraft.cs` | A draft on disk: id, title, description, its proposed grant, entry source. |
| `Platform/Capabilities/Services/DraftStore.cs` | Enumerate `.claude/tool-drafts/`, validate, promote one into `{data}/tools/` + `capabilities.enabled`. |
| `Platform/Capabilities/Models/PermissionSentence.cs` | Renders a grant into plain-language clauses **in code**. The card's text comes from here, never from the agent. |
| `devtools/scripts/e2e/p39.mjs` | Draft inertness, promotion, and the permission-sentence/grant correspondence. |
| `devtools/scripts/e2e/p40.mjs` | Escalation: refusal → park → decide → resume. |

**Modified**

| File | Change |
|---|---|
| `src/client/src/lib/sanitize.ts` | Deny-list → allow-list schema. |
| `Platform/Agent/Chat/Services/ChatSessionService.cs` | Two new phases + marker detection + park/resume. |
| `Platform/Agent/Chat/ChatController.cs` | Four endpoints via `FireAndAck`. |
| `Platform/Agent/Chat/Services/PromptHarness` (wherever the execute prompt lives) | Teach the two markers. |
| `src/client/src/ui/organisms/ChatPanel.tsx` | Two `ChatState` fields, two reducer branches, two card blocks, one dev warning. |
| `src/client/src/lib/chatTypes.ts`, `chatApi.ts` | Types + POST helpers for the new gates. |

---

### Task 1: Close the forged-card surface

**Files:** Modify `src/client/src/lib/sanitize.ts`; verify `src/client/src/ui/organisms/MarkdownView.tsx`.

The renderer runs `rehype-raw` with `rehypeStripDangerous`, a **deny-list**. A deny-list on HTML is a losing position — it must anticipate every dangerous construct, forever. Since approval cards are about to appear in this same transcript, an agent able to author arbitrary HTML can draw a convincing fake of one.

- [ ] **Step 1: Read what exists**

```bash
cd D:/Development/Games/Gatherlight
cat src/client/src/lib/sanitize.ts
cat src/client/src/ui/organisms/MarkdownView.tsx
grep -rn "trip-map\|city-map" --include=*.tsx --include=*.ts --include=*.md src/ docs/ | grep -v node_modules
```
Report exactly which tags/attributes the current deny-list strips, and every `div` class `MarkdownView` dispatches. The allow-list must preserve all of the latter.

- [ ] **Step 2: Replace with an allow-list**

Use `rehype-sanitize` with a schema derived from its `defaultSchema`, extended with **only**: `div` permitted `className` values `trip-map` and `city-map`, plus whatever `data-*` attributes those two components actually read (confirm by reading `TripMap`/`CityMap` — do not guess).

If `rehype-sanitize` is not already a dependency, add it (`npm i rehype-sanitize` in `src/client`) and say so.

Keep `rehype-raw` — it is what lets the map divs through at all. The change is that raw HTML is now filtered by an allow-list rather than a deny-list, so anything not explicitly permitted is dropped.

- [ ] **Step 3: Prove both halves**

Build the client: `cd src/client && npm run build` — must succeed.

Then verify by rendering, not by reading. Add a temporary scratch page or use the existing dev server to render markdown containing:
1. `<div class="trip-map" data-cities="...">` → still becomes the map component (**positive control** — an allow-list that breaks the feature is not a fix)
2. `<img src=x onerror="alert(1)">` → attribute stripped
3. `<div class="approve-card"><button>Enable</button></div>` → renders as inert text/plain div, **no button**

Describe exactly how you verified each, and what you observed. Delete any scratch page.

- [ ] **Step 4: Commit**

```bash
git add src/client
git commit -m "fix(chat): allow-list the agent's markdown HTML instead of deny-listing it

Approval cards are about to appear in this transcript, and a deny-list on raw
HTML is a losing position — an agent able to author arbitrary markup can draw a
convincing fake of one. Only markdown plus the two known map divs now render.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Permission sentences, rendered in code

**Files:** Create `Platform/Capabilities/Models/PermissionSentence.cs`.

The card tells a household what a tool may touch. **Every clause is derived from the grant by code** — if the agent could write this text, an injected agent would write a reassuring version of it.

- [ ] **Step 1: Write the renderer**

```csharp
using Gatherlight.Server.Platform.Capabilities.Models;

namespace Gatherlight.Server.Platform.Capabilities.Models;

/// <summary>
/// Turns a grant into the plain-language clauses shown on an approval card. Rendered from the
/// GRANT, never from anything the agent wrote: the household is trusting these sentences rather
/// than the code, so they must describe what is actually enforced. A clause that cannot be
/// enforced must not be printed.
/// </summary>
public static class PermissionSentence
{
    /// <summary>What the capability may do, in the site's own vocabulary.</summary>
    public static IReadOnlyList<string> Can(CapabilityGrant grant)
    {
        var can = new List<string>();
        foreach (var dir in grant.Fs.Read) can.Add($"读取 {dir}/ · read {dir}/");
        foreach (var dir in grant.Fs.Write) can.Add($"写入 {dir}/ · write to {dir}/");
        if (grant.Net) can.Add("访问网络 · reach the internet");
        return can;
    }

    /// <summary>What it cannot do. Only ever states things the sandbox genuinely enforces —
    /// network denial, platform state, and anything outside the granted directories.</summary>
    public static IReadOnlyList<string> Cannot(CapabilityGrant grant)
    {
        var cannot = new List<string>();
        if (!grant.Net) cannot.Add("访问网络 · reach the internet");
        cannot.Add("读取应用设置或数据库 · read your settings or database");
        cannot.Add("运行其它程序 · run other programs");
        return cannot;
    }
}
```

Confirm each `Cannot` clause against S2a's enforcement before shipping it: network denial is `cap-guard.mjs`; settings/database is `ResolveSitePath` refusing `state/` plus the fs grant; running other programs is `--permission` denying `child_process`. **If a clause cannot be traced to an enforcement, delete it** — an unenforced promise in plain language is the one thing this design must not produce.

- [ ] **Step 2: Build + commit**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
node devtools/dev.mjs check-layering
git add src/server/Gatherlight.Server/Platform/Capabilities/Models/PermissionSentence.cs
git commit -m "feat(capabilities): render permission sentences from the grant, in code

The household trusts these sentences rather than the code, so they are derived
from the enforced grant and never from anything the agent wrote. Every 'cannot'
clause traces to a specific S2a enforcement.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The draft store

**Files:** Create `Platform/Capabilities/Models/CapabilityDraft.cs` and `Platform/Capabilities/Services/DraftStore.cs`.

The agent writes `.claude/tool-drafts/<name>/` — already inside its write scope, so **no scope-guard change is needed**. Drafts are never loaded by the registry, so an unapproved draft is inert *by construction*.

- [ ] **Step 1: The model + store**

`CapabilityDraft { Id, Title, Description, CapabilityGrant Grant, string EntrySource, string DirPath }`.

`IDraftStore`:
- `IReadOnlyList<CapabilityDraft> All()` — enumerate `{site}/.claude/tool-drafts/*/tool.json`, parse, skip-and-log anything invalid (follow `ScriptToolProvider.Reload`'s skip-don't-crash pattern).
- `CapabilityDraft? Get(string id)`
- `void Promote(string id)` — copy the folder to `{data}/tools/<id>/`, append the draft's grant to `site.json`'s `capabilities.enabled`, and delete the draft folder.
- `void Discard(string id)` — delete the draft folder.

Three rules to enforce in `Promote`, each a real hole if missed:
1. **The id must be a safe path segment** — reject anything containing a separator, `..`, or a drive letter. A draft id becomes a directory name under `{data}/tools/`.
2. **Refuse to overwrite an existing capability** of the same id; a promotion must never silently replace a tool already enabled.
3. **The promoted grant is the draft's grant, unchanged.** The card showed the human those exact permissions — promoting something wider would make the card a lie.

- [ ] **Step 2: Build, register, commit**

Register `IDraftStore` in `GatherlightApp.cs`. Build both projects; `check-layering` green.

```bash
git add src/server/Gatherlight.Server
git commit -m "feat(capabilities): draft store — inert until a human promotes one

Drafts live in the agent's own write scope but are never loaded by the
registry, so an unapproved draft is inert by construction rather than by
policy. Promotion carries the draft's grant unchanged: the card showed those
exact permissions, so widening them would make it a lie.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The draft-approval gate

**Files:** Modify `ChatSessionService.cs`, `ChatController.cs`, the execute-prompt harness.

- [ ] **Step 1: The marker and the phase**

Follow `MCP_ADD` exactly — read `FinishExecuteAsync`'s existing marker handling first and mirror it.

- Marker: `TOOL_DRAFT: <id>` in the agent's final text.
- New phase constant: `awaiting-draft-approval`.
- On detection: load the draft via `IDraftStore`, and emit a `phase` event whose `Data` carries `{ id, title, description, can: [...], cannot: [...] }` — `can`/`cannot` from `PermissionSentence`, **never from the draft's own text**. The draft's `description` rides along separately and the client labels it as the assistant's claim.
- If the marker names a draft that does not exist or fails validation, do **not** park: emit a `notice` and finish normally. A marker pointing at nothing must not wedge the session at a gate.

- [ ] **Step 2: The endpoints**

Via `FireAndAck`, expecting phase `awaiting-draft-approval`:
- `POST api/chat/{id}/draft/approve` → `DraftStore.Promote`, then resume the run with `ResumeToken` so the agent can use the tool it just gained.
- `POST api/chat/{id}/draft/reject` → `DraftStore.Discard`, then resume so the agent learns it was declined and can carry on without it.

- [ ] **Step 3: Teach the marker**

Add `TOOL_DRAFT:` to the execute-phase prompt where `NEEDS_INPUT`/`MCP_ADD` are already documented. State that the agent writes the draft folder, emits the marker, and stops — it must not attempt to use the tool before approval, because it will not exist.

- [ ] **Step 4: Build + commit**

```bash
git add src/server/Gatherlight.Server
git commit -m "feat(chat): draft-approval gate

Follows the existing between-turns gate shape: the agent writes a draft, ends
its turn with a marker, the server parks and emits a card built from the
runtime's own reading of the draft's grant. Approving promotes and resumes;
rejecting discards and resumes, so a decline is not a dead end either.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The escalation gate

**Files:** Modify `ChatSessionService.cs`, `ChatController.cs`, `ToolRegistry` (refusal text), the execute prompt.

- [ ] **Step 1: Make a refusal actionable**

When `ToolRegistry` refuses a call because a capability is `NotEnabled` or `Denied`, the message the agent receives should name the capability and instruct it to stop and emit `CAPABILITY_BLOCKED: <id>` rather than working around the refusal. Keep the HTTP status as it is; only the message changes.

**Record the denial server-side as a fact** — capability id, its state, and the requested tool arguments' shape — so the card is built from what the runtime observed rather than from the agent's account of it.

- [ ] **Step 2: The phase, card and endpoints**

- Phase: `awaiting-capability-approval`. Marker `CAPABILITY_BLOCKED: <id>` detected as in Task 4.
- Card `Data`: `{ id, origin, state, can: [...], cannot: [...], agentReason }` — where `agentReason` is whatever the agent said and **the client must label it as the assistant's claim, not the system's**.
- `POST api/chat/{id}/capability/allow` — body `{ remember: bool }`. When `remember` is true, write the grant into `site.json`'s `capabilities.enabled`; when false, allow for this session only. Then resume via `ResumeToken`.
- `POST api/chat/{id}/capability/deny` — resume so the agent proceeds without it.

**Session-only allow** needs somewhere to live: hold it on the in-memory `ChatSession` and have the registry consult it for that session. If that turns out to require threading session identity into the registry in a way that does not fit, **report it and implement `remember: true` only** — a smaller correct feature beats a wide invasive one. Say which you did.

- [ ] **Step 3: Build + commit**

```bash
git add src/server/Gatherlight.Server
git commit -m "feat(chat): capability escalation gate — a denial becomes a decision

A refused call now tells the agent to stop and surface it; the server parks
with a card built from its own record of the denial, and the decision resumes
the run. The agent's explanation is carried separately and labelled as its
claim, because an injected agent writes a reassuring one exactly when it
matters.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The cards in the client

**Files:** Modify `ChatPanel.tsx`, `chatTypes.ts`, `chatApi.ts`, `ChatReview.tsx` (or a new sibling component file).

- [ ] **Step 1: Warn on unknown events first**

The reducer's `case 'event':` ends in `default: return state;`, silently. Before adding anything, add a dev-only `console.warn` naming the unhandled kind. Everything after this depends on new events actually arriving; a silent drop would cost hours.

- [ ] **Step 2: The two cards**

Follow `McpApprovalCard` as the model — read it first; it is the closest existing analogue.

**Draft card:** title, the assistant's description **visually marked as its claim**, then two lists rendered from `can`/`cannot` — green/neutral for can, muted for cannot. Buttons: `启用 Enable` (primary) and `不用 No thanks`. A collapsed `查看代码 show code` reveals the entry source, present for the rare technical moment and never the gate.

**Escalation card:** what was blocked, the same `can`/`cannot` treatment, `agentReason` labelled as the assistant's account. Buttons: `仅此一次 Allow once`, `一直允许 Always allow`, `不允许 Deny` (default emphasis).

Three properties to get right, each load-bearing:
1. **No destructive default.** Closing, ignoring or navigating away enables nothing.
2. **Rendered from `ev.data`**, never from message text.
3. **Cards clear on phase change**, like every existing gate card.

- [ ] **Step 3: Build + verify by looking**

```bash
cd src/client && npm run build
```
Then run the app (`node devtools/dev.mjs build && node devtools/dev.mjs server`) and **look at both cards**. The audience for this feature cannot read code; a card that renders wrong is the whole failure. Describe what you saw, or say plainly that you could not drive the UI to that state.

- [ ] **Step 4: Commit**

```bash
git add src/client
git commit -m "feat(chat): draft + escalation cards as platform chrome

Rendered from the event payload, never from message text, and composed as
siblings of agent output. Permission clauses come from the server's reading of
the grant; the assistant's own words are labelled as its claim. No path
through the card enables anything by default.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: e2e p39 — drafts

**Files:** Create `devtools/scripts/e2e/p39.mjs`.

Read `p32.mjs` first — the MCP approval gate suite is the closest analogue, including how it drives the claude stub to emit a marker.

Assert:
1. A draft in `.claude/tool-drafts/` is **absent** from `/api/tools` and `/mcp` — inert before approval.
2. The stub emits `TOOL_DRAFT:`; the session parks at `awaiting-draft-approval` and the SSE `phase` event's `data` carries `can`/`cannot` arrays.
3. **The card's clauses match the enforced grant** — a draft granting `fs.read: ["plans"]` and `net: false` produces a `can` mentioning `plans` and a `cannot` mentioning the internet. This is the assertion that keeps the card honest.
4. Approve → the tool appears in `/api/tools`, its id is in `site.json`'s `capabilities.enabled` with the **draft's own grant**, and the draft folder is gone.
5. Reject → the draft folder is gone and nothing was added to `enabled`.
6. A `TOOL_DRAFT:` naming a nonexistent draft does **not** park the session.
7. Promotion refuses to overwrite an existing enabled capability of the same id.

- [ ] Run `node devtools/dev.mjs e2e p39` → PASS. Commit.

---

### Task 8: e2e p40 — escalation

**Files:** Create `devtools/scripts/e2e/p40.mjs`.

Assert:
1. Calling a not-enabled capability yields a refusal naming it.
2. The stub emits `CAPABILITY_BLOCKED:`; the session parks at `awaiting-capability-approval` with `can`/`cannot` on the event data.
3. `allow` with `remember: true` writes the grant into `site.json` **and** the run resumes (phase leaves the gate).
4. `deny` resumes without granting anything — `capabilities.enabled` is unchanged.
5. The agent's `agentReason` is carried in a **separate field** from the runtime-derived clauses. This is the structural check behind "an injected agent cannot author the system's account of an incident".
6. A `CAPABILITY_BLOCKED:` for an unknown id does not park the session.

- [ ] Run `node devtools/dev.mjs e2e p40` → PASS, then `p2`, `p28`, `p32` → PASS (the gate suites this touches). Commit.

---

### Task 9: Close out

- [ ] Update the spec's status line to `S2b implemented`.
- [ ] Add to `.claude/rules/dev-conventions.md`: gates are between-turns markers, cards are platform chrome built from runtime facts, agent markdown is allow-listed.
- [ ] `check-layering`, `check-sensitive --tree`, both builds, client build.
- [ ] **Do not run the full e2e suite from a subagent** — a backgrounded suite is orphaned when the agent's turn ends. The coordinator runs `node devtools/dev.mjs e2e all`, expecting `40/40`.
- [ ] Commit.

---

## Deferred

- **Typed fenced blocks** (`table`, `chart`) and migrating the maps onto them, after which `rehype-raw` can be dropped entirely. The allow-list makes this an improvement rather than a prerequisite.
- **Persisting parked gates across restart.** An escalation is lost on restart exactly as today's four gates are; fixing it is a change to the whole gate model, not to this feature.
- **Sandboxing `Mcp`-origin capabilities.** Still S2a's stated non-goal.
