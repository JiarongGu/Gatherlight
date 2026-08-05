# Capability model, permissions + the escalation harness — design (S2)

> 2026-08-05 · sub-project **S2** of the platform track. Status: **implemented** — S2a see
> `docs/superpowers/plans/2026-08-05-capability-model-sandbox.md`, S2b see
> `docs/superpowers/plans/2026-08-05-drafts-approval-escalation.md`.
> Follows S1 (`2026-08-04-site-model-container-design.md`), which is implemented.

## Why

S1 gave the site a manifest and drew the platform/product seam. It declared
`capabilities.deny` and `capabilities.enabled` **without enforcing them**, deliberately, so the
manifest's shape was fixed before anything depended on it.

S2 makes them real, and closes the gap S1 named: there are still **five unrelated ways a tool can
exist** — compiled C#, Node leaf, hot-loaded script tool, outbound MCP, and the agent-drafted tool
the user asked for — each with its own discovery, packaging, trust level and failure mode. That is a
missing model, not five bugs.

The audience decides the shape of this work. **Gatherlight is used by a non-technical household.**
A gate that asks someone to read JavaScript is not a gate; they will click through it. So the
approval surface presents *reach*, not *implementation*, and the containment has to be genuinely
enforced — because the promise being made is the permission sentence on the card, and a permission
sentence that isn't enforced is a lie told in plain language.

## Threat model (carried from S1, unchanged)

Three things, all of them live:

1. **A mistaken agent** — means well, gets it wrong, blast radius must be bounded.
2. **A prompt-injected agent** — the planner scrapes web pages, searches Xiaohongshu and reads
   uploaded PDFs, all attacker-controllable text landing in its context. Once injected it *wants*
   to escape.
3. **Untrusted capability code** — an agent-drafted tool, or an external MCP server.

## Governing stance

**Walls, not a leash.** The container bounds the blast radius of a mistake; inside it the agent is
generously equipped and left alone. Tooling is the platform's job to ship and update, so the agent
should find a tool already there rather than inventing one.

**Trust follows provenance, not enumeration.** A tool the platform ships is trusted because we wrote
and shipped it; it needs no sandbox. Only capabilities that did **not** come from us are untrusted,
and that is where enablement and containment belong. This keeps the expensive machinery on the small,
rare, human-approved surface instead of on 33 tools we authored.

## Goals

1. One registry, one lifecycle, one place to ask "what can this agent do and where did it come from".
2. `deny` and `enabled` enforced, spanning both MCP tools and the CLI's own built-ins.
3. Non-platform capabilities contained by an enforced boundary, not by a comment.
4. A denial becomes a **resumable human decision**, not a dead end.
5. The agent can propose a tool; a human enables it; an unapproved draft is inert by construction.
6. Every approval surface is legible to a non-technical person and unforgeable by the agent.

## Non-goals

| Deferred | What |
|---|---|
| **S3** | The declarative UI spec for the site's own pages and its component library |
| **S4** | The `Gatherlight.Platform` / `Gatherlight.Planner` assembly split |
| Later | A low-privilege OS account + firewall rules (the containment ceiling — see "What the sandbox does not cover") |
| Later | Sandboxing external MCP servers; they are third-party processes the user explicitly added, and are their own trust conversation |

## One registry, four origins

Every capability carries its provenance, because provenance decides its treatment.

| Origin | What it is | Default | Execution |
|---|---|---|---|
| `Platform` | the 33 compiled `IGatherlightTool`s | **available** | in-process, unsandboxed |
| `Script` | `{data}/tools/<name>/tool.json`, hot-loaded | off until `enabled` | **sandboxed** |
| `Mcp` | an outbound external MCP server | off until `enabled` | separate process, third-party |
| `Draft` | `.claude/tool-drafts/<name>/` | **never loaded** | none — inert until promoted |

`ICapabilityRegistry` replaces the current ad-hoc composition of `IGatherlightTool` + the script-tool
provider + the MCP proxy. It yields `CapabilityInfo { Id, Origin, Title, Description, InputSchema,
State }` where `State` is `Available | NotEnabled | Denied`. `/mcp` tools/list and `/api/tools` both
project from it, so what the agent sees and what the console shows can never disagree.

### Enforcing the manifest

- **`deny`** removes a capability from the registry projection and refuses it on call. It spans two
  planes: platform MCP tools, and the CLI's own built-ins — which is how **`WebFetch` finally
  becomes closeable.** For built-ins, the id is omitted from the generated `settings.chat.json`
  allow-list *and* denied by the scope guard, so removing it from one place cannot silently re-open it.
  The second plane only fires on dispatch: the scope guard's PreToolUse hook is invoked per the
  `matcher` in its own registration, so a denied built-in must also be added to that `matcher` — omit
  it and the hook never runs for that tool, so the deny is enforced on paper only. Found the hard way
  with `WebFetch`, the built-in the mechanism exists to close.
- **`enabled`** gates registration: a `Script` or `Mcp` capability absent from the list is not
  registered at all, so it never reaches tools/list.
- Entries in `enabled` grow from a bare id into a grant object. S1's reader already accepts both
  shapes, so this is additive:

```json
"capabilities": {
  "deny": ["WebFetch"],
  "enabled": [
    { "id": "merge_itinerary", "fs": { "read": ["plans"], "write": ["cache"] }, "net": false }
  ]
}
```

**Grant vocabulary and defaults.** `fs.read`/`fs.write` name **manifest-declared record directories,
or the literal `cache`** (the site's scratch area) — never absolute paths, never `state`, never a
path outside the site. A grant therefore cannot name something the site does not own, and the set of
legal values is derived from the manifest rather than free text.

Every field is **deny-by-default**, so an omitted field is the safe answer rather than an open one:

| Field | Absent means |
|---|---|
| `fs.read` | nothing readable beyond the capability's own entry script |
| `fs.write` | `cache` only |
| `net` | no network |

A bare-id entry (`"merge_itinerary"`) is therefore the most restricted form, not the least — which
matters because that is the shape S1 already shipped and the shape a hand-edit is likeliest to take.

## The sandbox

A `Script` capability is spawned as:

```
node --permission --allow-fs-read=<site>/<granted read dirs> --allow-fs-write=<site>/<granted write dirs>
     --import=<platform>/cap-guard.mjs  <entry>
```

Two implementation traps, both real: on Windows `--import` must be given a `file://` URL — a bare
drive-letter path throws `ERR_UNSUPPORTED_ESM_URL_SCHEME`. And the sandboxed process must itself be
granted `--allow-fs-read` on `cap-guard.mjs`'s own directory: without it, importing the preload
throws `ERR_ACCESS_DENIED` before the capability's own code ever runs, which means every
network-denied capability would die on launch — that read grant is the launcher's job, not something
the capability's own grant object provides.

Node's permission model enforces the filesystem scope and denies **`child_process` spawn/exec,
worker threads and native addons** outright — importing `node:child_process` still succeeds; what
throws `ERR_ACCESS_DENIED` is the operation itself (`spawnSync`, `execSync`, …). Those three denials
are what make the rest hold: a capability cannot spawn its way out, thread its way out, or load
native code.

**Network.** Node's permission model has no network dimension, so the platform supplies one.
`cap-guard.mjs` (an `--import` preload the platform owns, not the capability) refuses
`node:net`, `node:http`, `node:https`, `node:tls`, `node:dgram` and removes `fetch` / `WebSocket`
from the global scope. This is airtight *only because* the three denials above already exist —
there is no remaining route to reach the network without one of them. A capability granted
`"net": true` simply does not get the preload, and its card says so.

`ICapabilityLauncher` is the seam. A low-privilege-account implementation can replace the Node one
later without touching capability code, which is how the ceiling arrives if it is ever needed.

### What the sandbox does not cover — state this, do not discover it

- **Non-Node capabilities.** The boundary is Node's. A future capability in another runtime gets no
  containment from it, and must not be enabled until `ICapabilityLauncher` has an implementation
  that covers it.
- **External MCP servers.** Third-party processes, out of scope here (see Non-goals). Their card
  must say plainly that they run outside the sandbox.
- **Resource exhaustion.** CPU and memory are not bounded. A capability can spin. Mitigated only by
  the existing per-call timeout.

## Approval, in language a person can act on

The card is rendered **from the manifest grant by code** — never from text the agent wrote:

> **The assistant made a tool: 合并行程 PDF · Merge itinerary PDFs**
> It can **read your plans** and **save files to the scratch area**.
> It **cannot** reach the internet, change your settings, or touch anything else.
> `[ 启用 Enable ]  [ 不用 No thanks ]`  · *查看代码 show code*

Four properties, each load-bearing:

1. **Every sentence is derived from the grant object**, so it cannot overstate what was requested,
   and cannot be authored by an injected agent.
2. **The tool's description is the agent's claim** and is visually marked as such.
3. **"No thanks" is the default.** Dismissing, navigating away or ignoring the card enables nothing.
4. **The code is behind "show details"**, present for the rare technical moment, never the gate.
   A household cannot audit JavaScript; pretending otherwise manufactures false confidence.

Because the person is trusting the permission list rather than the code, **a permission that is
displayed must be enforced.** "Cannot reach the internet" is only printable because `cap-guard.mjs`
makes it true.

## Escalation: a denial is an answer, not a dead end

When a call is refused mid-run, the runtime records what it **observed** — the capability id, its
origin, and why it was refused (`Denied` or `NotEnabled`) — and raises a card built from those
facts. (The built version does not also capture the refused call's arguments — nothing downstream
turned out to need them: the card's `can`/`cannot` clauses describe the grant an "allow" would
create, not the one specific call that tripped it.) Then:

- The agent's own explanation may appear, **labelled as the assistant's account**, not the system's.
- Any optional LLM analysis runs as a **one-shot fed only the runtime facts**, never the agent's
  transcript. This is the rule S1 fixed and it is absolute: a prompt-injected agent writes a
  reassuring explanation exactly when it matters most, so the thing explaining the incident must
  never have read the attacker's text.
- The user chooses **allow once**, **allow and remember** (writes the grant into `site.json`), or
  **deny** (default).
- The run then **resumes and retries**, so a denial is a decision point rather than a dead end.

### How it resumes — corrected after reading the run loop

An earlier draft of this section said the blocked call "returns accordingly and the run continues",
which assumed the server could suspend a tool call in flight. **It cannot, and nothing in the
codebase does.** Every existing gate — `NEEDS_INPUT`, `MCP_ADD`, `LOGIN_REQUIRED` — happens
*between* agent turns: `IAgentRunner.RunAsync` blocks until the CLI reaches a terminal result, the
server inspects the final text for a marker, parks the session in a phase, and later starts a
**fresh** run carrying `ResumeToken = ClaudeSessionId`. There is no mid-call suspension to reuse.

Escalation therefore follows that same proven shape rather than inventing new run-loop machinery:

1. The refused call returns a refusal that names what was denied and instructs the agent to stop and
   surface it rather than working around it.
2. The agent ends its turn with an escalation marker; the server parks in a new phase and emits the
   card, built from the **runtime's** record of the denial, not from the agent's text.
3. The decision POSTs to a gate endpoint, and the run resumes via `ResumeToken` and retries.

**The security property is unchanged**, which is why this substitution is safe: consent still
arrives only through a platform POST. An injected agent that suppresses the marker denies *itself*
the escalation — it cannot use the omission to obtain the permission.

One consequence to accept: because parked sessions live only in memory, a server restart mid-gate
fails the session (`SelfHealStateStep` already forces non-terminal threads to `error`). An escalation
is lost on restart exactly as today's gates are. Persisting parked gates is not in scope here.

## Drafts

The agent writes `.claude/tool-drafts/<name>/` — already inside its write scope, so **no scope-guard
change is required**. Drafts are never loaded by the registry, so an unapproved draft is inert *by
construction* rather than by policy.

Enabling copies the folder to `{data}/tools/<name>/`, appends the grant to `capabilities.enabled`,
and the existing hot-reload picks it up within a second.

### Correction: the card needs no separate "pointing" step

An earlier draft of this section said `notify_user` lets the agent point at the card in the same
breath it drafts the tool. As the chat-ownership section below already found, `notify_user` writes
to a decoupled notification table with its own SSE stream and a bell icon — it cannot reach chat,
so it was never wired to this flow and the built version doesn't try to. It also turned out to be
unnecessary: the `TOOL_DRAFT: <id>` marker itself is what parks the session and emits the card, so
the card already appears in the same turn the agent drafted the tool in — there is no separate
"pointing" step for anything to perform.

## The chat surface belongs to the container

**Named invariant, and the reason the forgery attack fails:**

> **Granting happens only through a platform affordance.** No conversational path — no "yes", no
> "I approve", nothing the agent can elicit and interpret — can enable a capability or widen a
> permission. The agent has no channel through which consent reaches the runtime.

An injected agent can draw something that *looks* like an approval card. It cannot make one work,
because a forged card's buttons are not wired to anything and the runtime is not listening to the
conversation for consent.

### Agent output: fenced typed blocks

Adopted from a sibling project in this family that already solves it (a React chat client over an
LLM agent; `react-markdown` + `remark-gfm`, no `rehype-raw`):

- The agent emits markdown. A fenced block whose "language" is a **content type** carries structure:
  ` ```table `, ` ```chart `. The body is a self-contained JSON payload.
- A parser turns the stream into a typed `MessageContent[]`; a `switch` dispatches each entry to a
  platform React component. **Fixed allow-list; an unknown type degrades silently to text.**
- **One schema is the source of truth** for the runtime validator, the dispatch registry *and* the
  generated prompt documentation — so the model's instructions cannot drift from what the renderer
  accepts.
- **Streaming**: a block whose fence has not closed is marked `partial` and renders a
  "preparing…" placeholder rather than parsing a half-finished payload.

Starting set: `text` (default), `table`, `chart`. Adding one later is a schema entry plus a component.

**No `html` block** — a deliberate deviation from the reference. Its DOMPurify + sandboxed-iframe +
CSP-nonce defence is sound against code execution, but against *visual forgery* an iframe is still a
rectangle the agent controls, and for a non-technical household the failure mode is someone
believing a picture, not a script running. A planner gains little from arbitrary HTML.

**Platform chrome is structurally out of reach.** Approval cards, escalation cards, gate controls,
avatars and progress are composed as **siblings of** the agent's rendered blocks, driven by server
SSE event types the agent cannot emit — not entries within them. There is no fence syntax that
reaches them.

### What was actually true when this was written

The claim above described the intent, not the code. Reading `MarkdownView.tsx` found the chat
renders agent text through `react-markdown` **with `rehype-raw` enabled** and a **deny-list**
sanitiser (`rehypeStripDangerous`), then dispatches `<div class="trip-map">` / `city-map` to real
React components. So the agent already authors HTML that becomes components, and **a forged
approval card is renderable today.**

The invariant that matters survives — a forged card's buttons are wired to nothing, and consent
cannot arrive through the conversation — but "the agent cannot draw a convincing fake" was false,
and for a household that cannot read code, a convincing fake is the failure mode that counts.

**The fix is an allow-list sanitiser**, replacing the deny-list: standard markdown elements plus
only `div.trip-map` / `div.city-map` and their data attributes. Arbitrary agent HTML stops
rendering; the existing map feature is unaffected. Chosen over migrating the maps to typed blocks
first, which would be a cleaner end state but puts a migration in front of the cards.

Two smaller realities the same reading turned up, both of which the plan must handle:

- **Unknown SSE event kinds are silently dropped** — the client reducer's `default: return state;`
  logs nothing. A new card event the client does not yet handle would vanish without trace. (Fixed
  in the implementation: the reducer now `console.warn`s the unhandled `kind` before falling through,
  so this describes the state the plan found, not the state it left.)
- **`notify_user` never reaches the chat.** It writes to a `notification` table with its own SSE
  stream and surfaces on a bell icon in the top bar, decoupled from any chat session. "The agent
  points at the card in the same breath" therefore needs the chat channel, not `notify_user`.

## Scope: this is two plans, not one

Written out, S2 is larger than one implementation plan should be, and it splits cleanly at a point
where each half is independently useful:

**S2a — the model and the boundary.** The capability registry with provenance, `deny`/`enabled`
enforcement across both planes, and the sandbox including the network denial. Ships working software
on its own: enablement is done by hand-editing `site.json`, which is exactly what a developer wants
while the boundary is being proven, and it means the containment is tested before any UI depends on
its promises.

**S2b — the human flow.** Drafts, the approval and escalation cards, the SSE event channel, and the
chat-ownership boundary with its typed blocks. Depends on S2a because every sentence a card prints
must correspond to a grant S2a actually enforces — building the card first would mean designing
against promises that do not yet hold.

The chat's fenced typed blocks (`table`, `chart`) are the most separable piece of all and could
become S2c if S2b runs long; the chat-ownership *invariant* is required for the cards, but richer
agent output is an enrichment, not a dependency.

## Testing

| Check | Asserts |
|---|---|
| draft is inert | a `.claude/tool-drafts/` entry never appears in `/api/tools` or `/mcp` tools/list |
| enablement is the only path | copying a tool into `{data}/tools/` without a manifest `enabled` entry leaves it unregistered |
| deny spans both planes | a denied MCP tool is absent and refused; a denied `WebFetch` is absent from the generated settings **and** refused by the guard |
| sandbox: filesystem | a script capability cannot read `state/`, nor any record dir outside its grant |
| sandbox: subprocess | `child_process` operations (`spawnSync`/`execSync`/…) are denied — the import itself succeeds |
| **sandbox: network** | `fetch`, `node:http` and `node:net` all fail inside a capability granted `"net": false` |
| card truthfulness | every permission sentence rendered corresponds to a grant actually enforced |
| escalation is resumable | a denied call yields an escalation, and allowing it lets the same run continue |
| escalation provenance | the escalation payload contains runtime-observed fields only; agent text is separately attributed |
| chat ownership | *(as built)* the allow-list sanitiser drops agent-authored HTML down to markdown plus the two known map divs — verified by hand (build + render a forged card, Task 1 Step 3), not an automated suite. The typed-fenced-block mechanism this row originally described (`table`/`chart`, "an unknown fence degrades to text") was deferred, not built — see "Scope" above |

## Decisions of record

- **Trust by provenance, not enumeration.** Shipped tools are available by default and unsandboxed;
  only non-platform capabilities need enablement and containment. An allow-list over shipped tools
  would tax every release with a manifest edit and buy no safety.
- **Node's permission model first; a low-privilege OS account is the ceiling.** Chosen for zero
  install cost, no elevation and no account lifecycle, behind an `ICapabilityLauncher` seam so the
  stronger implementation can arrive without touching capability code.
- **The platform supplies the network denial** Node's model lacks, and it holds only because
  `child_process`, workers and addons are already denied. Recorded because the reasoning is the
  guarantee.
- **Permissions, not code, are the decision surface.** The audience cannot audit JavaScript, so a
  code-review gate would be decorative. This makes enforcement load-bearing: a displayed permission
  must be a true one.
- **No `html` block in chat.** Deviates from the reference implementation deliberately: the risk
  here is visual forgery, not script execution.
- **Granting happens only through a platform affordance.** The single invariant that makes a forged
  approval card harmless.
