# Conversation history in the chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make past conversations reachable from the chat, surviving a server restart, using the transcript already stored in `lyntai_message`.

**Architecture:** Two read routes on `ChatRepository` (which already holds the `IConversationStore` handle) return a conversation list and a conversation's stored events. The client replays those events through the **same reducer** the live SSE stream uses, so there is one renderer rather than a history view that drifts. Turns are grouped into conversations by a new `ConversationId` in the thread's opaque metadata — no migration.

**Tech Stack:** ASP.NET Core net10.0 (`Gatherlight.Platform`), Lyntai `IConversationStore`, React 18, node e2e suites.

**Spec:** `docs/superpowers/specs/2026-08-05-conversation-history-design.md`

---

## Before you start

**Read these — the plan depends on how they already work:**

- `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatRepository.cs` — `SessionMetadata` (the app-owned JSON inside the Lyntai thread's metadata slot), `UpsertSessionAsync`, `AppendEventAsync`.
- `src/server/Gatherlight.Platform/Ops/Eval/Services/FeedbackStore.cs:146-163` — `TranscriptAsync`, which already does most of what Task 1 needs. **Do not call it from the chat module**: it is the eval console's store, and the dependency would run backwards. Read it as a reference and use `IConversationStore` directly.
- `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatSessionService.cs:364-380` — `PrepareThreadContextAsync`, whose idle / turn-cap / post-commit reset rule Task 2 reuses to decide when a new conversation begins.
- `src/client/src/ui/organisms/ChatPanel.tsx` — the reducer, `SESSION_KEY`, and the `event` action the replay reuses.

**The modelling fact that shapes this work:** `StartChatAsync` mints a fresh session id per **turn**, and each turn is its own `lyntai_thread`. The multi-turn conversation you see exists only in the browser's reducer. That is why Task 2 adds `ConversationId` — without it, history is a list of turns with no way to tell which belonged together.

**Conventions this repo enforces:**

- Everything here is **Platform**; `node devtools/dev.mjs check-layering` must stay clean.
- Repository methods are async; SQL is hand-written Dapper — but this sub-project writes **no SQL**: Lyntai owns `lyntai_thread`/`lyntai_message` and is reached only through `IConversationStore`.
- Sources are BOM-less UTF-8; Chinese string literals must not become mojibake.
- Client primitives come from `@/ui/atoms`, never `antd` directly.

Create the branch:

```bash
cd D:/Development/Games/Gatherlight
git checkout -b feat/chat-history
```

Per-task commits on that branch. Do not push.

---

## File structure

**Server**

| File | Responsibility |
|---|---|
| `Platform/Agent/Chat/Services/ChatRepository.cs` | `ConversationId` on `SessionMetadata`; `HistoryAsync`, `TranscriptAsync`, `ConversationContextAsync`, `LatestConversationIdAsync` |
| `Platform/Agent/Chat/ChatController.cs` | `GET /api/chat/history`, `GET /api/chat/history/{id}`; `ContinuesConversationId` on the start request |
| `Platform/Agent/Chat/Services/ChatSessionService.cs` | assign the conversation id when starting a turn; use the per-conversation context when continuing |

**Client**

| File | Responsibility |
|---|---|
| `src/client/src/lib/chatApi.ts` | `getChatHistory`, `getConversation` |
| `src/client/src/ui/organisms/ChatHistory.tsx` (new) | the conversation list — title, date, status chip |
| `src/client/src/ui/organisms/ChatPanel.tsx` | header actions, load-and-replay, `historical` state, open-most-recent on mount |

**Tests:** `devtools/scripts/e2e/p43.mjs` (new).

---

### Task 1: The history reads and their routes

**Files:**
- Modify: `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatRepository.cs`
- Modify: `src/server/Gatherlight.Platform/Agent/Chat/ChatController.cs`
- Create: `devtools/scripts/e2e/p43.mjs`

- [ ] **Step 1: Add the wire shapes**

At the top of `ChatRepository.cs`, beside `ChatTurnRow`:

```csharp
/// <summary>One conversation in the history list. <c>Title</c> is the first turn's user message,
/// truncated — no LLM call to name a thread, and nothing new to persist.</summary>
public sealed record ChatHistoryRow(
    string Id, string Title, string Phase, string Mode, string CreatedAt, int Turns);

/// <summary>A conversation's stored transcript. <c>Events</c> are the persisted SSE payloads,
/// verbatim and in order — the client replays them through the SAME reducer the live stream feeds,
/// so this MUST stay the wire shape rather than a projection of it.</summary>
public sealed record ChatTranscript(
    string Id, string Title, string Phase, string Mode, string CreatedAt,
    List<System.Text.Json.JsonElement> Events);
```

- [ ] **Step 2: Add `ConversationId` to the metadata**

`SessionMetadata` is the app's own JSON inside the thread's opaque metadata slot, so a new field
costs no migration and old rows simply parse it as null.

```csharp
public sealed record SessionMetadata(
    string? Phase = null, string? Mode = null, string? UserMessage = null, string? PlanText = null,
    string? ClaudeSessionId = null, string? CommitSha = null, string? Error = null, string? Attachments = null,
    string? ConversationId = null)
```

**Every existing positional construction of `SessionMetadata` must still compile** — the new
parameter is last and optional, so they do. Check with:

```bash
grep -rn "new SessionMetadata(" --include=*.cs src/server/
```

- [ ] **Step 3: Extend the repository interface**

Add to `IChatRepository`:

```csharp
    /// <summary>Conversations, newest first. A conversation is the group of turns sharing a
    /// ConversationId; a turn whose metadata predates that field is its own conversation.</summary>
    Task<List<ChatHistoryRow>> HistoryAsync(int limit);

    /// <summary>Every stored event of every turn in one conversation, in order. Null if unknown.</summary>
    Task<ChatTranscript?> TranscriptAsync(string conversationId);
```

- [ ] **Step 4: Implement them**

In `ChatRepository`, using only the `IConversationStore` API:

```csharp
    private static string TitleOf(string? userMessage)
    {
        var m = string.Join(' ', (userMessage ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (m.Length == 0) return "(无标题)";
        return m.Length <= 60 ? m : m[..60] + "…";
    }

    // A turn's conversation: the ConversationId it was written with, or — for a thread written
    // before that field existed — the turn's own id, so old data lists as one conversation each
    // instead of collapsing into a single bucket keyed by null.
    private static string ConversationOf(SessionMetadata m, string threadId) =>
        string.IsNullOrWhiteSpace(m.ConversationId) ? threadId : m.ConversationId!;

    public async Task<List<ChatHistoryRow>> HistoryAsync(int limit)
    {
        var take = Math.Clamp(limit, 1, 200);
        // Pull generously then group: `limit` counts CONVERSATIONS, and one can span several turns.
        var threads = await _convo.ListThreadsAsync(limit: Math.Clamp(take * 8, 50, 2000));
        var groups = threads
            .Select(t => (Thread: t, Meta: SessionMetadata.Parse(t.Metadata)))
            .GroupBy(x => ConversationOf(x.Meta, x.Thread.Id));

        return groups
            .Select(g =>
            {
                var ordered = g.OrderBy(x => x.Thread.CreatedAt).ToList();
                var first = ordered[0];
                var last = ordered[^1];
                return new ChatHistoryRow(
                    Id: g.Key,
                    Title: TitleOf(first.Meta.UserMessage),
                    Phase: last.Meta.Phase ?? "",
                    Mode: last.Meta.Mode ?? "plan",
                    CreatedAt: last.Thread.CreatedAt.ToString("o"),
                    Turns: ordered.Count);
            })
            .OrderByDescending(r => r.CreatedAt, StringComparer.Ordinal)
            .Take(take)
            .ToList();
    }

    public async Task<ChatTranscript?> TranscriptAsync(string conversationId)
    {
        var threads = await _convo.ListThreadsAsync(limit: 2000);
        var turns = threads
            .Select(t => (Thread: t, Meta: SessionMetadata.Parse(t.Metadata)))
            .Where(x => ConversationOf(x.Meta, x.Thread.Id) == conversationId)
            .OrderBy(x => x.Thread.CreatedAt)
            .ToList();
        if (turns.Count == 0) return null;

        var events = new List<System.Text.Json.JsonElement>();
        foreach (var (thread, _) in turns)
        {
            foreach (var msg in (await _convo.GetMessagesAsync(thread.Id)).OrderBy(m => m.Seq))
            {
                // A malformed payload is skipped, never thrown: one bad row must not make a whole
                // conversation unreadable.
                try { events.Add(System.Text.Json.JsonDocument.Parse(msg.Payload).RootElement.Clone()); }
                catch (System.Text.Json.JsonException) { }
            }
        }

        var first = turns[0];
        var last = turns[^1];
        return new ChatTranscript(
            conversationId, TitleOf(first.Meta.UserMessage), last.Meta.Phase ?? "",
            last.Meta.Mode ?? "plan", first.Thread.CreatedAt.ToString("o"), events);
    }
```

If `IConversationStore` exposes a different member name than `GetMessagesAsync` / `ListThreadsAsync`
/ `Seq` / `CreatedAt`, read `FeedbackStore.TranscriptAsync` (which uses them today) and match it —
do not invent a member.

- [ ] **Step 5: Add the routes**

In `ChatController.cs`, after the `Snapshot` route:

```csharp
    /// <summary>Past conversations, newest first. The live stream only replays a session still in
    /// memory, so this is the only thing that survives a restart.</summary>
    [HttpGet("api/chat/history")]
    public async Task<IActionResult> History([FromQuery] int? limit)
        => Ok(new { conversations = await _repo.HistoryAsync(limit ?? 30) });

    /// <summary>One conversation's stored events, in the SSE wire shape the client's reducer eats.</summary>
    [HttpGet("api/chat/history/{id}")]
    public async Task<IActionResult> Conversation(string id)
        => await _repo.TranscriptAsync(id) is { } t ? Ok(t) : NotFound(new { error = "conversation not found" });
```

Inject `IChatRepository _repo` into the controller if it is not already there (check the
constructor first).

- [ ] **Step 6: Write the failing e2e**

Create `devtools/scripts/e2e/p43.mjs`:

```javascript
#!/usr/bin/env node
// e2e P43 — conversation history. Every turn is already stored in lyntai_message; this suite proves
// the chat can read it back, and that it SURVIVES A RESTART — the whole point of the sub-project,
// since the SSE stream only replays a session still in the server's memory.
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p43');
const { ok, fail, done } = makeReporter('p43');
makeTestData(dataDir);

// Free port — checked against every startServer({ port }) in devtools/scripts/e2e/*.mjs
// (p41 is the closest neighbour at 5482).
const PORT = 5484;

let server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const base = server.base ?? `http://127.0.0.1:${PORT}`;
const { j, post } = makeClient(base);

// Drive one plan turn to a terminal phase and give back its session id.
const runTurn = async (message) => {
  const started = await post('/api/chat', { message, mode: 'plan' });
  const id = started.body?.id;
  if (!id) throw new Error(`no session id: ${JSON.stringify(started.body)}`);
  await until(async () => {
    const p = (await j(`/api/chat/${id}`)).body?.phase;
    return p && p !== 'idle' && p !== 'planning';
  }, 20000);
  return id;
};

// Release the agent lease so the next turn can start (a session parked at a gate still holds it).
const finishUp = async (id) => {
  await post(`/api/chat/${id}/cancel`);
  await until(async () => {
    const p = (await j(`/api/chat/${id}`)).body?.phase;
    return ['cancelled', 'rejected', 'committed', 'error'].includes(p);
  }, 15000);
};

try {
  await waitHealthy(base);

  const first = await runTurn('UI_CASE:VALID 请给东京行程做一个表格');
  await finishUp(first);

  const list = (await j('/api/chat/history')).body?.conversations ?? [];
  ok('history lists the conversation', list.length >= 1, JSON.stringify(list));
  const convo = list[0];
  ok('title is the user message, not the id',
    /东京行程/.test(convo?.title ?? '') && convo?.title !== convo?.id, convo?.title ?? '');
  ok('the row carries a phase', typeof convo?.phase === 'string' && convo.phase.length > 0, convo?.phase ?? '');

  const t = (await j(`/api/chat/history/${convo.id}`)).body;
  ok('transcript comes back', Array.isArray(t?.events) && t.events.length > 0, JSON.stringify(t)?.slice(0, 160));
  ok('events are in the SSE wire shape (every one has a kind)',
    (t?.events ?? []).every((e) => typeof e.kind === 'string'));
  // S3a made a turn's content richer — the block must survive the round trip, tree intact.
  const block = (t?.events ?? []).find((e) => e.kind === 'ui-block' && e.data?.status === 'ready');
  ok('a stored ui-block round-trips with its tree', block?.data?.node?.type === 'Card',
    JSON.stringify(block?.data ?? null)?.slice(0, 160));

  ok('an unknown conversation is 404', (await j('/api/chat/history/nope')).status === 404);
  const clamped = (await j('/api/chat/history?limit=99999')).body?.conversations ?? [];
  ok('an oversized limit is clamped, not an error', Array.isArray(clamped));

  // --- THE POINT: it survives a restart ---------------------------------------------------
  server.stop();
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  await waitHealthy(base);

  const after = (await j('/api/chat/history')).body?.conversations ?? [];
  ok('history survives a server restart', after.length >= 1, JSON.stringify(after));
  const afterT = (await j(`/api/chat/history/${convo.id}`)).body;
  ok('the transcript survives a server restart',
    (afterT?.events ?? []).length === (t?.events ?? []).length,
    `${(afterT?.events ?? []).length} vs ${(t?.events ?? []).length}`);
  // The live stream cannot do this — proving the two paths are genuinely different.
  ok('the live stream no longer knows the session (which is why history exists)',
    (await fetch(`${base}/api/chat/${first}/stream`)).status === 404);
} catch (e) {
  fail(e?.stack || String(e));
} finally {
  server.stop();
}

done();
```

- [ ] **Step 7: Run it and watch it fail**

```bash
node devtools/dev.mjs e2e p43
```
Expected: **FAIL** — the routes do not exist yet. Confirm the suite can fail before making it pass.

- [ ] **Step 8: Build and make it pass**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
node devtools/dev.mjs e2e p43
```
Expected: `0 Warning(s) 0 Error(s)` and `e2e-p43 PASS`.

- [ ] **Step 9: Commit**

```bash
git add src/server/Gatherlight.Platform/Agent/Chat devtools/scripts/e2e/p43.mjs
git commit -m "feat(chat): read past conversations back from the store

Every turn was already persisted; nothing could read it. Two routes over the
IConversationStore handle the chat module already holds — not the eval console's
store, which would be a backwards dependency. The suite restarts the server,
because surviving that is the entire point.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Conversations, not turns

**Files:**
- Modify: `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatRepository.cs`
- Modify: `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatSessionService.cs`
- Modify: `src/server/Gatherlight.Platform/Agent/Chat/ChatController.cs`
- Modify: `devtools/scripts/e2e/p43.mjs`

- [ ] **Step 1: Understand what is being fixed**

`StartChatAsync` mints a new session id per turn, so each turn is its own thread. Task 1 already
groups by `ConversationId`, but nothing writes one yet — so today every turn lists as its own
conversation. This task makes consecutive turns share one.

The rule is not new: `PrepareThreadContextAsync` already decides "same working context or fresh
slate" from idle time, a turn cap, and whether the last turn committed. A new conversation begins
exactly when that decides on a fresh slate.

- [ ] **Step 2: Expose the previous conversation**

Add to `IChatRepository` and implement in `ChatRepository`:

```csharp
    /// <summary>The ConversationId of the most recent turn, or null when there is none. Read from
    /// the store rather than held in memory, so a restart does not silently split a conversation.</summary>
    Task<string?> LatestConversationIdAsync();
```

```csharp
    public async Task<string?> LatestConversationIdAsync()
    {
        var threads = await _convo.ListThreadsAsync(limit: 50);
        var latest = threads.OrderByDescending(t => t.CreatedAt).FirstOrDefault();
        if (latest is null) return null;
        var meta = SessionMetadata.Parse(latest.Metadata);
        return ConversationOf(meta, latest.Id);
    }
```

- [ ] **Step 3: Have the context decision report freshness**

In `ChatSessionService`, change `PrepareThreadContextAsync` to return both the context and whether
it reset:

```csharp
    private async Task<(string Context, bool Fresh)> PrepareThreadContextAsync()
    {
        var turns = await _repo.TurnsAsync();
        var last = turns.LastOrDefault();
        var idle = last is not null
            && DateTime.TryParse(last.CreatedAt, null, System.Globalization.DateTimeStyles.RoundtripKind, out var at)
            && DateTime.UtcNow - at > ThreadIdle;
        var tooLong = turns.Count >= ThreadMaxTurns;
        // After a committed turn the work is durably in files → fresh slate.
        var lastCommitted = last?.Outcome.StartsWith("已提交") ?? false;
        if (idle || tooLong || lastCommitted)
        {
            await _repo.ClearTurnsAsync();
            return ("", true);
        }
        return (string.Join('\n', turns.Select(t => $"- \"{t.Message}\" → {t.Outcome}")), false);
    }
```

- [ ] **Step 4: Assign the conversation id**

In `StartChatAsync`, replace the `var threadContext = await PrepareThreadContextAsync();` line with:

```csharp
        var (threadContext, freshThread) = await PrepareThreadContextAsync();
        // A conversation is the run of turns sharing a working context. An explicit
        // continuesConversationId (the user typed into an opened history item) wins; otherwise the
        // same idle / turn-cap / post-commit rule that resets the context also starts a new
        // conversation, so the grouping the user sees matches the grouping the agent gets.
        var conversationId = continuesConversationId
            ?? (freshThread ? null : await _repo.LatestConversationIdAsync())
            ?? $"c{DateTime.UtcNow.Ticks:x}";
```

Add the parameter to the method:

```csharp
    public async Task<ChatSession> StartChatAsync(string userMessage, IReadOnlyList<string> attachments,
        string mode = "plan", string? continuesConversationId = null)
```

**Then make continuing actually carry the conversation's context.** Assigning the id alone is not
enough: `chat_turn` was cleared when that conversation went idle or committed, so a turn continuing a
three-day-old conversation would start with `threadContext` empty and no idea what it was about —
success criterion 4 would fail while everything else passed. Immediately after the block above:

```csharp
        // Continuing an OLD conversation: chat_turn no longer holds it (cleared on idle/commit), so
        // rebuild the context from that conversation's own stored turns. Only when the live window
        // is empty — an active thread's own context is fresher and already correct.
        if (continuesConversationId is not null && threadContext.Length == 0)
            threadContext = await _repo.ConversationContextAsync(continuesConversationId);
```

- [ ] **Step 4b: Implement the per-conversation context**

Add to `IChatRepository` and implement in `ChatRepository`:

```csharp
    /// <summary>Thread context rebuilt from one conversation's stored turns — used when continuing a
    /// conversation whose chat_turn window was already cleared. Same one-line-per-turn shape
    /// PrepareThreadContextAsync produces, so the prompt sees no difference.</summary>
    Task<string> ConversationContextAsync(string conversationId);
```

```csharp
    public async Task<string> ConversationContextAsync(string conversationId)
    {
        var threads = await _convo.ListThreadsAsync(limit: 2000);
        var turns = threads
            .Select(t => (Thread: t, Meta: SessionMetadata.Parse(t.Metadata)))
            .Where(x => ConversationOf(x.Meta, x.Thread.Id) == conversationId)
            .OrderBy(x => x.Thread.CreatedAt)
            .TakeLast(ThreadContextTurns)
            .ToList();

        return string.Join('\n', turns.Select(x =>
        {
            var msg = TitleOf(x.Meta.UserMessage);
            var outcome = x.Meta.CommitSha is { Length: > 0 } sha ? $"已提交 {sha}"
                : x.Meta.Error is { Length: > 0 } err ? $"出错:{err}"
                : x.Meta.Phase ?? "";
            return $"- \"{msg}\" → {outcome}";
        }));
    }
```

with, beside the other constants in `ChatRepository`:

```csharp
    // Bound what a resumed conversation drags into the prompt — the same spirit as
    // ChatSessionService.ThreadMaxTurns, applied to replay rather than to the live window.
    private const int ThreadContextTurns = 8;
```

Add `ConversationId` to the `ChatSession` record (a `string` property beside `Mode`), set it from
`conversationId`, and pass it through wherever `UpsertSessionAsync` is called so it lands in the
metadata. Find every call site:

```bash
grep -rn "UpsertSessionAsync" --include=*.cs src/server/
```

Each becomes `…, s.ConversationId)` with the parameter added to the interface, the implementation,
and the `SessionMetadata` construction inside it.

- [ ] **Step 5: Accept it from the client**

In `ChatController.cs`:

```csharp
public sealed record StartChatRequest(string? Message, List<string>? Attachments, string? Mode, string? ContinuesConversationId);
```

and in `Start`:

```csharp
            var s = await _chat.StartChatAsync(message, attachments, mode, req.ContinuesConversationId);
```

A record with a new trailing parameter still deserializes from JSON that omits it, so existing
callers and every e2e suite that posts `{message, mode}` keep working.

- [ ] **Step 6: Assert the grouping**

Add to `devtools/scripts/e2e/p43.mjs`, before the restart section:

```javascript
  // --- turns group into ONE conversation ---------------------------------------------------
  // Two consecutive turns share a working context (nothing committed, no idle gap), so they must
  // list as one conversation — otherwise history is a list of turns and the user cannot tell which
  // belonged together.
  const second = await runTurn('再补充一个预算表');
  await finishUp(second);

  const grouped = (await j('/api/chat/history')).body?.conversations ?? [];
  ok('consecutive turns group into one conversation', grouped.length === 1,
    JSON.stringify(grouped.map((c) => ({ id: c.id, turns: c.turns }))));
  ok('the conversation counts both turns', grouped[0]?.turns === 2, String(grouped[0]?.turns));
  ok('the title stays the FIRST turn message', /东京行程/.test(grouped[0]?.title ?? ''), grouped[0]?.title ?? '');

  const both = (await j(`/api/chat/history/${grouped[0].id}`)).body;
  ok('the transcript spans both turns',
    (both?.events ?? []).length > (t?.events ?? []).length,
    `${(both?.events ?? []).length} vs ${(t?.events ?? []).length}`);

  // --- continuing an OLD conversation carries its context ----------------------------------
  // The live chat_turn window is cleared on idle/commit, so a resumed conversation must have its
  // context rebuilt from stored turns. Without this the id is assigned and the agent still starts
  // blank — everything else here would stay green while the feature does nothing.
  await post('/api/chat/turns/clear').catch(() => {});   // simulate the window having been cleared
  const resumed = await post('/api/chat', {
    message: 'CONTEXT_ECHO 继续刚才的事',
    mode: 'plan',
    continuesConversationId: grouped[0].id,
  });
  const resumedId = resumed.body?.id;
  ok('a resumed turn starts', Boolean(resumedId), JSON.stringify(resumed.body));
  if (resumedId) {
    await until(async () => {
      const p = (await j(`/api/chat/${resumedId}`)).body?.phase;
      return p && p !== 'idle' && p !== 'planning';
    }, 20000);
    const plan = (await j(`/api/chat/${resumedId}`)).body?.plan ?? '';
    // The stub echoes back whether the prompt carried thread context (see the stub change below).
    ok('the resumed turn was given the conversation context',
      /CONTEXT_PRESENT/.test(plan), plan.slice(0, 160));
    ok('the resumed turn joins the same conversation',
      ((await j('/api/chat/history')).body?.conversations ?? []).length === 1);
    await finishUp(resumedId);
  }
```

The `CONTEXT_ECHO` case needs a line in `devtools/scripts/claude-stub.mjs`, beside the other
trigger checks and **after** the `SCORING TASK` branch (a judge prompt has no
`THE USER'S REQUEST:` marker, so an earlier placement would make a scorer return this instead of its
verdict):

```javascript
// Reports whether the SERVER put thread context in the prompt — assigning a conversation id without
// rebuilding its context is a silent no-op the other rows would not catch.
if (prompt.includes('CONTEXT_ECHO')) {
  const marker = /最近的对话|RECENT TURNS|thread context/i.test(prompt) || /^- "/m.test(prompt)
    ? 'CONTEXT_PRESENT' : 'CONTEXT_MISSING';
  done(`计划:${marker}`);
  process.exit(0);
}
```

Read how `PromptHarness` labels the context block (`{context}` in `PlanTemplate`) and match the
real marker text rather than trusting the regex above — if the label differs, this row passes or
fails for the wrong reason. If `POST /api/chat/turns/clear` does not exist, drop that line: the
assertion still holds because the second turn committed nothing and the window may legitimately
carry over — in that case assert against a **restarted** server instead, where the window is empty.

**Update the restart rows** that follow to use `grouped[0].id` rather than `convo.id`, and compare
against `both.events.length` rather than `t.events.length`.

- [ ] **Step 7: Build and run**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
node devtools/dev.mjs e2e p43
node devtools/dev.mjs e2e p28
```

`p43` must pass including the grouping rows. **`p28` exercises thread context** and
`PrepareThreadContextAsync` just changed shape — run it.

- [ ] **Step 8: Commit**

```bash
git add src/server/Gatherlight.Platform/Agent/Chat devtools/scripts/e2e/p43.mjs
git commit -m "feat(chat): group turns into conversations

A thread is one turn; the conversation the user sees existed only in the browser.
ConversationId rides in the thread metadata we already own — no migration — and a
new conversation begins exactly when the thread-context rule decides on a fresh
slate, so what the user sees grouped matches what the agent gets as context.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The client API and the conversation list

**Files:**
- Modify: `src/client/src/lib/chatApi.ts`
- Create: `src/client/src/ui/organisms/ChatHistory.tsx`
- Modify: `src/client/src/ui/organisms/index.ts`

- [ ] **Step 1: The API calls**

Add to `src/client/src/lib/chatApi.ts` (match the existing `get`/`post` import style at the top of
that file):

```typescript
export interface ConversationRow {
  id: string;
  title: string;
  phase: string;
  mode: string;
  createdAt: string;
  turns: number;
}

export interface ConversationTranscript {
  id: string;
  title: string;
  phase: string;
  mode: string;
  createdAt: string;
  /** Stored SSE payloads, verbatim — fed straight into the chat reducer. */
  events: AgentEvent[];
}

export const getChatHistory = (limit = 30) =>
  get<{ conversations: ConversationRow[] }>(`/api/chat/history?limit=${limit}`);

export const getConversation = (id: string) =>
  get<ConversationTranscript>(`/api/chat/history/${encodeURIComponent(id)}`);
```

Import `AgentEvent` from `@/lib/chatTypes` if it is not already imported there.

- [ ] **Step 2: The list component**

Create `src/client/src/ui/organisms/ChatHistory.tsx`:

```tsx
import { Tag, Spin } from '@/ui/atoms';
import type { ConversationRow } from '@/lib/chatApi';

const PHASE_CHIP: Record<string, { label: string; color: string }> = {
  committed: { label: '已提交', color: 'green' },
  rejected: { label: '已撤销', color: 'default' },
  cancelled: { label: '已停止', color: 'default' },
  error: { label: '出错', color: 'red' },
};

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
};

/** The conversation list. Titles come from the first user message, so there is nothing to name and
 *  nothing to keep in sync — a conversation is findable by what it was about. */
export function ChatHistory({
  rows, loading, activeId, onOpen,
}: {
  rows: ConversationRow[];
  loading: boolean;
  activeId: string | null;
  onOpen: (id: string) => void;
}) {
  if (loading) return <div className="chat-history-empty"><Spin size="small" /></div>;
  if (rows.length === 0) return <div className="chat-history-empty">还没有对话记录。</div>;

  return (
    <div className="chat-history">
      {rows.map((r) => {
        const chip = PHASE_CHIP[r.phase];
        return (
          <button
            key={r.id}
            type="button"
            className={`chat-history-row${r.id === activeId ? ' is-active' : ''}`}
            onClick={() => onOpen(r.id)}
          >
            <span className="chat-history-title">{r.title}</span>
            <span className="chat-history-meta">
              {when(r.createdAt)}
              {r.turns > 1 ? ` · ${r.turns} 轮` : ''}
              {chip ? <Tag color={chip.color}>{chip.label}</Tag> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
```

Export it from `src/client/src/ui/organisms/index.ts` alongside the other organisms.

- [ ] **Step 3: Style it**

Add to `src/client/src/styles.css`. These use the variables that file already defines — `--surface-2`,
`--border-soft`, `--text`, `--text-2`, `--muted`, `--accent`, `--accent-soft`, `--radius-sm`,
`--font-body`:

```css
/* --- conversation history (chat panel) --- */
.chat-history { display: flex; flex-direction: column; gap: 2px; padding: 6px 4px; }
.chat-history-row {
  display: flex; flex-direction: column; gap: 3px;
  width: 100%; text-align: left;
  background: none; border: 0; border-radius: var(--radius-sm);
  padding: 8px 10px; cursor: pointer;
  font-family: var(--font-body); color: var(--text);
}
.chat-history-row:hover { background: var(--surface-2); }
.chat-history-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.chat-history-row.is-active { background: var(--accent-soft); }
.chat-history-title {
  font-size: 13.5px; line-height: 1.35;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.chat-history-meta {
  display: flex; align-items: center; gap: 8px;
  font-size: 11.5px; color: var(--muted);
}
.chat-history-empty { padding: 24px 12px; text-align: center; color: var(--muted); font-size: 13px; }
.chat-historical-note {
  padding: 7px 12px; margin-bottom: 8px;
  border: 1px solid var(--border-soft); border-radius: var(--radius-sm);
  background: var(--surface-2); color: var(--text-2); font-size: 12.5px;
}
```

If any variable name has changed, read `src/client/src/styles.css` and match what is there rather
than inventing one — a missing custom property fails silently and renders unstyled.

- [ ] **Step 4: Build**

```bash
node devtools/dev.mjs build
```
Expected: clean `tsc -b` and a successful Vite build. (The component is not mounted yet — this step
only proves it compiles.)

- [ ] **Step 5: Commit**

```bash
git add src/client/src
git commit -m "feat(chat): the conversation list component and its API calls

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Replay in the panel

**Files:**
- Modify: `src/client/src/ui/organisms/ChatPanel.tsx`

- [ ] **Step 1: Add the state**

`ChatPanel` gains, alongside its existing `useState` calls:

```tsx
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<ConversationRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  // The conversation being SHOWN. Null while on a live session that has no id yet.
  const [conversationId, setConversationId] = useState<string | null>(null);
  // True when the transcript is a replay of a finished conversation rather than a live session.
  // Gate actions render only when false — see Step 4.
  const [historical, setHistorical] = useState(false);
```

- [ ] **Step 2: Load and replay**

```tsx
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try { setHistory((await getChatHistory()).conversations ?? []); }
    catch { setHistory([]); }
    finally { setHistoryLoading(false); }
  }, []);

  // Replay a stored conversation through the SAME reducer the live stream feeds. One renderer:
  // blocks, tool rows, notices and gate cards all come back through the code that already draws
  // them, so a history view cannot drift from the live one.
  const openConversation = useCallback(async (id: string) => {
    setShowHistory(false);
    closeRef.current?.();            // detach any live stream first
    dispatch({ type: 'rehydrate', sessionId: '' });
    setConversationId(id);
    setHistorical(true);
    try {
      const convo = await getConversation(id);
      for (const ev of convo.events) dispatch({ type: 'event', ev });
    } catch {
      dispatch({ type: 'event', ev: { kind: 'error', text: '打不开这段对话。' } });
    }
  }, []);
```

`rehydrate` already resets to `initialState`, which is exactly the blank slate a replay needs.

- [ ] **Step 3: Open the most recent on mount**

Extend the existing mount effect (the one that calls `getActiveSession`): when there is **no** live
session to re-attach to, load history and open the newest conversation, so reopening the app looks
like you left it.

```tsx
      const active = await getActiveSession();
      if (active?.id) { /* existing re-attach path, unchanged */ return; }
      const rows = (await getChatHistory()).conversations ?? [];
      setHistory(rows);
      if (rows.length > 0) await openConversation(rows[0].id);
```

Keep the existing re-attach branch exactly as it is — a live session must still win over history.

- [ ] **Step 4: Gate actions only when live**

A replayed gate card must not offer buttons: the session that could act on it is gone. Wherever
`PlanActions`, `DiffReview`, the MCP/draft/capability cards and the input-reply composer are
rendered, guard them with `!historical`. The card content still renders — only the actions
disappear.

Add a visible banner while historical, above the transcript:

```tsx
  {historical && (
    <div className="chat-historical-note">
      正在查看历史对话 · 继续输入会开始新的一轮
    </div>
  )}
```

- [ ] **Step 5: Continue from a historical conversation**

When sending while `historical` is true, pass the conversation id so the new turn carries that
conversation's context, and drop back to live. In the send handler, where `startChat` is called:

```tsx
      const started = await startChat(text, attachments, mode, conversationId ?? undefined);
      setHistorical(false);
```

Add the parameter to `startChat` in `src/client/src/lib/chatApi.ts`, passing it as
`continuesConversationId` in the POST body. Check the existing signature and keep the new parameter
last and optional.

- [ ] **Step 6: The header actions**

Add to the chat panel header, beside the existing controls: a `＋ 新对话` button that clears the
transcript to a live blank slate (`dispatch({type:'rehydrate', sessionId:''}); setHistorical(false); setConversationId(null);`)
and a history toggle that calls `loadHistory()` and flips `showHistory`. When `showHistory` is true,
render `<ChatHistory rows={history} loading={historyLoading} activeId={conversationId} onOpen={openConversation} />`
in place of the transcript.

- [ ] **Step 7: Build**

```bash
node devtools/dev.mjs build
```
Expected: clean.

- [ ] **Step 8: See it work**

Start the server against a scratch data folder under `devtools/_*` (**never** `local/`, which holds
real family data), run a turn through the stub, then:

1. Reload the page → the conversation is still shown.
2. **Stop and restart the server**, reload → the conversation is still shown. This is the bug being
   fixed; verify it directly.
3. Open the history list → the conversation is listed with its title and date.
4. Type into an opened past conversation → a new turn starts and the transcript continues.
5. Open a conversation that ended at a gate → the card renders **with no Approve button**.

Report each. If you cannot drive a browser, say so plainly rather than claiming the check.

- [ ] **Step 9: Commit**

```bash
git add src/client/src
git commit -m "feat(chat): replay past conversations through the live reducer

The stored events are the SSE payloads verbatim, so history needs no second
transcript layout — it feeds the same reducer. A replayed gate renders without
buttons: the session that could act on it no longer exists.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Close out

**Files:**
- Modify: `.claude/rules/dev-conventions.md`

- [ ] **Step 1: Document the convention**

Add a bullet to the Backend section of `.claude/rules/dev-conventions.md`, after the chat-gates
bullet:

```markdown
- **Chat history is the stored event stream, replayed.** Every agent event is persisted as its SSE
  payload verbatim (`AppendEventAsync` → `lyntai_message`), so `GET /api/chat/history{,/id}` returns
  the wire shape and the client feeds it to the SAME reducer the live stream feeds — one renderer,
  no history view to drift. A **thread is one turn**; the conversation the user sees is the run of
  turns sharing a `ConversationId` in the thread's app-owned metadata, and a new one begins exactly
  when `PrepareThreadContextAsync` decides on a fresh slate (idle · turn cap · post-commit). A
  replayed gate renders **without actions** — the in-memory session that could act on it is gone,
  and an Approve button that silently does nothing is worse than a finished decision.
```

- [ ] **Step 2: Full verification**

```bash
node devtools/dev.mjs check-layering
node devtools/dev.mjs check-ui-registry
node devtools/scripts/check-sensitive.mjs --tree
dotnet build src/server/Gatherlight.Platform/Gatherlight.Platform.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Planner/Gatherlight.Planner.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
node devtools/dev.mjs build
node devtools/dev.mjs e2e p43
node devtools/dev.mjs e2e p28
```

All clean; the three net10.0 projects at `0 Warning(s) 0 Error(s)`; Host with only its known
MSB3277.

**Do not run the full e2e suite from a subagent** — a backgrounded suite is orphaned when the
agent's turn ends. The coordinator runs `node devtools/dev.mjs e2e all`, expecting `42/42`.

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/dev-conventions.md
git commit -m "docs: chat history is the stored event stream, replayed

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Not in scope

- **Search across conversations** — the eval console has a list for ops; full-text over transcripts
  is a feature, not this defect.
- **Rename / delete** — auto-titles are enough to find a conversation, and deletion is a data
  question that deserves its own thought.
- **Resuming a parked gate after a restart** — the in-memory session is gone and
  `FailInterruptedSessionsAsync` has already marked it errored.
