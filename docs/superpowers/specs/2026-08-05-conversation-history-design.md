# Conversation history in the chat — design (S5)

> 2026-08-05 · a correctness sub-project, sequenced **ahead of S3b** (the site authoring loop,
> `2026-08-05-site-authoring-loop-design.md`, specced and waiting). Follows S3a, merged.

## Why

Every chat turn is already stored durably. `ChatRepository.AppendEventAsync` writes each agent event
into Lyntai's `lyntai_message`, and since S3a that includes `ui-block` events carrying validated
component trees. `FeedbackStore.TranscriptAsync(id)` reads it back today.

**None of it is reachable from the chat.** `ChatController` exposes exactly three reads:

| Route | Returns |
|---|---|
| `GET /api/chat/active` | the live session, if any |
| `GET /api/chat/{id}` | a snapshot — phase, plan, gate cards. **No event log.** |
| `GET /api/chat/{id}/stream` | SSE, and only while `_chat.Get(id)` finds the session in memory |

So a page reload works while the server is up (the stream replays its in-memory log), and everything
is gone after a restart. There is no way to open yesterday's conversation at all. The transcript
that exists in the database is exposed only under `/api/manage/conversations`, which was built for
scoring and evals — not for the household.

The content is not lost. It is unreachable. That distinction is why this is small.

It is also newly expensive: S3a made a turn's content richer — rendered tables, maps, validated
trees — so losing the transcript costs more than it did a week ago, and S3b will add page previews
to the same transcript.

## Goals

1. Conversations survive a restart and are reachable from the chat, the way any chat app works.
2. Reopening the app looks like you left it.
3. Continuing a past conversation carries that conversation's context.
4. One renderer for live and historical turns — not two.
5. Nothing historical is presented as actionable when it is not.

## Non-goals

| Deferred | What |
|---|---|
| Later | Search across conversations. The eval console already has a conversation list for ops; full-text over transcripts is a bigger feature than this defect warrants. |
| Later | Renaming or deleting conversations. Auto-titles from the first message are enough to find one; deletion is a data question that deserves its own thought. |
| Later | Resuming a parked gate after a restart. The in-memory session that could act on it is gone; see "What replays and what doesn't". |
| Out | A second transcript layout. Explicitly rejected below. |

## The list

The chat panel header gains `＋ 新对话` and a list toggle. Conversations are shown newest first:

- **Title** — the first user message, truncated. Already stored as `SessionMetadata.UserMessage`;
  nothing new to persist and no LLM call to name a thread.
- **Date** and a **status chip** from the thread's phase: 已提交 · 已撤销 · 出错 · 进行中.
- The open conversation is highlighted.

On load the most recent conversation opens. That is what makes the app look like you left it, and
it is the behaviour the user asked for by naming the convention rather than a bespoke drawer.

## One renderer, not two

The history endpoint returns the conversation's stored events, and the client feeds them through the
**same reducer** the live SSE stream uses:

```ts
for (const ev of history.events) dispatch({ type: 'event', ev });
```

Blocks, tool rows, notices, thinking, usage and gate cards all replay through the code that already
renders them. A history view that re-implements rendering drifts from the live one within a release
— S3a's *one format, two mounts* applied to time instead of surface.

This constrains the wire shape: the endpoint must return events in the **same shape the SSE stream
emits**, because that is what the reducer consumes. `AppendEventAsync` persists
`JsonSerializer.Serialize(ev, AgentEvent.WireJson)` — the SSE payload verbatim — so the stored rows
already are that shape. The endpoint returns them parsed, in `seq` order.

## Server

Two reads, on `ChatRepository`, which already holds the `IConversationStore` handle. The chat module
does **not** reach into `Ops/Eval`'s `IFeedbackStore`: that store is the eval console's concern, and
the coupling would be backwards.

```
GET /api/chat/history?limit=50   →  [{ id, title, phase, createdAt, updatedAt }]
GET /api/chat/history/{id}       →  { id, title, phase, mode, createdAt, events: [...] }
```

`limit` is clamped. A missing id is 404. No storage work, no migration.

## Continuing a past conversation

The composer stays live. Sending from an opened conversation starts a **new turn** — the server
already runs every turn as a fresh CLI session — whose prompt carries **that thread's** context
rather than the global recent-turns summary.

Today `ChatSession.ThreadContext` is built from the `chat_turn` table: one-line summaries of recent
turns, globally. That is right for "carry on from what we were just doing" and wrong for "continue
this specific conversation from three days ago". So `ChatRepository` gains a per-thread context
builder over that thread's own stored messages, and the client passes the conversation id when
starting a turn from an opened history item.

The old turn's gates are not reopened. They are finished.

## What replays and what doesn't

Events replay as **content**. A conversation that was parked at a gate does not get a live gate: the
in-memory session that could approve or reject it no longer exists, and after a restart
`FailInterruptedSessionsAsync` has already marked it errored.

So a historical gate card renders as the card it was, visibly historical, **with no buttons**.
Handing someone an Approve button that silently does nothing is worse than showing them a finished
decision — this is the same rule S3a applied to invalid blocks: show it, mark it, never pretend.

Concretely: the client tracks whether the transcript it is showing is the live session or a
historical one, and gate actions render only for the live one.

## Testing

A new `p43` suite:

| Case | Expected |
|---|---|
| Run a turn to completion, then list history | the conversation appears with its title and phase |
| Title of a conversation | the first user message, truncated — not the id |
| Fetch its transcript | events come back in `seq` order, in the SSE wire shape |
| A `ui-block` event in a stored turn | survives the round trip with its tree intact |
| Restart the server, then list + fetch | both still work — the point of the whole sub-project |
| `limit` above the clamp | clamped, not an error |
| Unknown id | 404 |
| Start a turn continuing a past conversation | the prompt carries that thread's context (asserted through the claude stub, the way p41 asserts the contract pointer) |
| A conversation parked at a gate, replayed | the gate's card data is present in the events; the client renders it without actions |

The last row is asserted server-side (the events are there); the no-buttons rule is a client
behaviour verified by looking at it, since the client has no test framework and this sub-project is
not the place to add one.

## File structure

**Server**

| File | Change |
|---|---|
| `Platform/Agent/Chat/Services/ChatRepository.cs` | `HistoryAsync(limit)`, `TranscriptAsync(id)`, `ThreadContextAsync(id)` over `IConversationStore` |
| `Platform/Agent/Chat/ChatController.cs` | the two `history` routes |
| `Platform/Agent/Chat/Services/ChatSessionService.cs` | accept a `continuesSessionId` when starting a turn; use the per-thread context when present |

**Client**

| File | Change |
|---|---|
| `ui/organisms/ChatHistory.tsx` (new) | the conversation list — title, date, status chip |
| `ui/organisms/ChatPanel.tsx` | header actions, load-and-replay, `isHistorical` state gating gate actions, open-most-recent on mount |
| `lib/chatApi.ts` | the two history calls |

## Success criteria

1. Restart the server; yesterday's conversation is still there and opens.
2. Reopening the app shows the most recent conversation, not an empty panel.
3. A turn with a `ui-block` replays with its table rendered, through the live renderer.
4. Typing into an opened past conversation starts a turn that knows what it was about.
5. A historical gate card shows no Approve button.
6. `p43` and the full suite are green.
