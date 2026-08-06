# S6 — a parked decision survives a restart

> 2026-08-06 · the last named deferral of the platform track, from
> [`2026-08-05-drafts-approval-escalation.md`](../plans/2026-08-05-drafts-approval-escalation.md)
> ("persisting parked gates across restart") and
> [`2026-08-05-ui-block-protocol-design.md`](2026-08-05-ui-block-protocol-design.md) ("the gates as
> blocks"). Status: implemented — `e2e-p46`.

## Why

Leave a conversation parked at a gate — a plan waiting for approval, a diff waiting for review, a
question waiting for an answer — restart the server, and the conversation is dead. `SelfHealStateStep`
marks every non-terminal session `error: "server restarted mid-run"`, and the agent's work is gone.

That was the right default when it was written: an in-flight run genuinely cannot survive a restart,
because the child process is gone. But it does not distinguish **running** from **parked**, and those
are opposites. A parked session is not mid-run at all — it is waiting on a human, has no child
process, and its state is already durable in three places: the thread metadata, the stored event
stream, and the working tree.

This matters more than it did a month ago, because **auto-update restarts the server**. A household
that approves an update while a trip plan sits at the diff gate loses the plan.

## Goals

1. A session parked on a human decision survives a restart and can still be decided.
2. A session that was actually mid-run still fails — the honest outcome, unchanged.
3. A restored gate is a REAL gate: its buttons work, not a replayed card with nothing behind it.
4. The restored diff gate commits what is actually on disk now, never a remembered file list.
5. Nothing is resumed that would leave two agents live at once.

## The distinction

| Phase | Was | Now |
|---|---|---|
| `planning` · `executing` · `validating` · `building` | error | **error** — the child process is gone; this is unchanged and correct |
| `awaiting-plan-approval` · `awaiting-diff-approval` · `awaiting-input` · `awaiting-mcp-approval` · `awaiting-login` · `awaiting-draft-approval` · `awaiting-capability-approval` | error | **restored** |

One rule decides it: **is there a decision outstanding?** Nothing else changes.

## What has to be durable

Most of it already is. `SessionMetadata` (the app's own JSON inside Lyntai's opaque thread-metadata
slot) already carries phase, mode, the user's message, the plan text, the claude resume token and the
conversation id. Every emitted event — including each `phase` event's `Data`, which IS the card — is
already persisted verbatim by `AppendEventAsync`.

What is missing is the state a gate needs to **act**, which is deliberately not the same as the state
it needs to **display**:

| Gate | To display | To act |
|---|---|---|
| plan | plan text ✓ already | resume token ✓ already |
| input | question + options (the card ✓) | resume token ✓ |
| mcp-add | the card ✓ | the parsed `McpAddRequest` — the card is deliberately secret-free and lossy |
| login | the card ✓ | server id + challenge |
| draft | the card ✓ | the parsed `CapabilityDraft` |
| capability | the card ✓ | the `CapabilityDenial` + the grant the card was built from |
| **diff** | the card ✓ | **the tracked path list** |

So `SessionMetadata` gains one field, `Gate`, holding exactly that action state. No migration: Lyntai
owns the table, we own the blob.

### The diff gate recomputes, and that is the point

`ApproveDiff` commits `s.Review.Files`. Restoring that list from a serialized card would commit a
**remembered** set of paths — and between the crash and the restart, the working tree may have
changed. So the restore path persists only `EditTracker`'s path list and then re-runs
`PresentDiffAsync`, which rebuilds the diff **from the working tree**.

The reviewer therefore sees what is on disk now, which is what approval will actually commit. A
restored gate that showed a stale diff and committed something else would be the worst possible
failure of a review surface.

This also means a restored diff gate can legitimately conclude "nothing to commit" — if the edits are
gone, the session ends cleanly instead of committing an empty set.

## The lease

The app-wide single-agent lease is held for a parked session's whole lifetime, so a background job
cannot mutate the tree under an unreviewed diff. A restored session must therefore **re-take the
lease**, or the restore would quietly remove the protection the gate exists to provide.

Since the lease admits one holder, at most one session can be restored. If several non-terminal
sessions somehow exist, the **newest parked** one is restored and the rest fail as before — stated
explicitly because "restore them all" would deadlock on the lease and silently drop the extras.

## Failure handling

Restoration is best-effort and never blocks startup: a session whose gate state will not parse, or
whose lease cannot be taken, falls back to today's behaviour (`error`, inspectable). It runs inside
the existing `SelfHealStateStep`, which is already non-essential and behind the 503 gate.

## Not doing: the gates as blocks

The other half of this deferral — "a `plan` block driving the approval card, a `choice` block turning
`NEEDS_INPUT` into buttons" — is **declined**, and the reasoning belongs on the record:

- **`choice` already exists.** `NEEDS_INPUT` options have rendered as buttons since p28; the card
  reads `options` off the phase event and draws one button each. Rebuilding that as a block would be
  a re-implementation, not a capability.
- **`plan` as an agent-emitted block would invert S2b's central rule.** Cards are platform chrome:
  every approval surface is rendered server-side from enforced facts, never from agent text, because
  an injected agent writes a reassuring one exactly when it matters. Letting the agent emit the block
  that *is* the approval card hands it authorship of the surface that gates it.
- The version that would not violate that — the server emitting its own card *through* the block
  renderer — is a refactor with no user-visible change, and it would put the most safety-sensitive
  UI in the app through a new path to buy consistency.

The legible-approval goal it was meant to serve is real, but it is served by the card being built
from facts and stated plainly, which S2b already does.

## Testing — `e2e-p46`

| Check | Asserts |
|---|---|
| a parked plan gate survives | phase and plan text intact after a restart, with no `error` stamped on it |
| its buttons still work | approving a RESTORED plan gate actually runs the agent, through to the diff gate |
| the lease is re-taken | a new chat is refused while the restored session is parked |
| a parked diff gate survives | and its file list is rebuilt from the working tree, not remembered |
| the rebuilt diff shows what is on disk | a file edited **while the server was down** appears in the restored review |
| the restored diff commits what was shown | approval commits that edited content, not the pre-restart version |
| a committed session is not restored | it 404s in memory (the decision is made) but still reads back as committed in history |
| a cancelled session is not resurrected | or every update would hand back a decision the household walked away from |
| and the lease came back with it | a new chat starts cleanly after both terminal cases |

Two rows from the original plan are **not** in the suite, and their absence is deliberate rather than
overlooked: "a mid-run session still fails" and "only the newest of two parked sessions is restored"
both require two concurrent non-terminal sessions, which the agent lease exists to make impossible —
constructing them would mean testing a state the product cannot reach. The mid-run path is unchanged
code, and the one-holder rule is enforced by the lease itself, which the suite does exercise.

## Decisions of record

- **Parked ≠ running.** The restart failure was correct for one and wrong for the other; the fix is
  the distinction, not a new mechanism.
- **The diff gate recomputes from the working tree.** A review surface must show what approval will
  actually commit, so the tracked path list is persisted and the diff is rebuilt, never restored.
- **A restored session re-takes the agent lease.** Otherwise restoring a gate silently removes the
  single-writer guarantee that gate depends on.
- **One restore, newest wins.** The lease admits one holder; restoring more would deadlock or drop.
- **Gates as blocks: declined.** `choice` already exists; `plan` as an agent-authored block would
  contradict the rule that approval cards are platform chrome.
