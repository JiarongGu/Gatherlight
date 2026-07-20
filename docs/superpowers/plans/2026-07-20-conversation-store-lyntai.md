# Conversations on Lyntai `IConversationStore` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Move Gatherlight's two-gate conversation persistence off its own `chat_session`/`chat_event` tables onto Lyntai 0.29.0's generic typed-event `IConversationStore` (`lyntai_thread`/`lyntai_message`) — single source of truth, Lyntai owns the schema. Approach A (user-chosen): session state lives in `lyntai_thread.Metadata` (JSON), the eval console queries it via SQL `json_extract` (consistent with how Gatherlight already reads `lyntai_score_result` directly). No app conversation tables.

**Architecture:** `ChatRepository` (the persistence seam) writes via the `IConversationStore` API (thread = session, message = event). **Reads go through the store APIs too** — `FeedbackStore`/`ScoringService`/`TraceService` compose over `IConversationStore` (+ `IScoreStore`) and parse the thread's JSON metadata; **no raw SQL against `lyntai_*` tables** (revised mid-flight from the SQL-`json_extract` approach, per the user, to decouple Gatherlight from Lyntai's internal schema — same principle applied to the scoring store). The app's own `chat_feedback` (human ratings) + `chat_turn` (thread-context memory) stay app-owned SQL. A FluentMigrator migration (a one-time, schema-coupled data move — distinct from runtime access) copies existing rows forward + drops the two tables, preserving original timestamps.

> **Consumers migrated:** `ChatRepository` (writes + `FailInterruptedSessions`), `FeedbackStore` (4 reads), `ScoringService` (`BuildContextAsync` + `ScoreAllAsync`), and **`TraceService`** (`BuildAsync` — the run-trace timeline; initially missed, caught by e2e p21). Shared `SessionMetadata` (camelCase) is written once + parsed everywhere.

## Key facts (verified)
- `lyntai_thread(id TEXT PK, title TEXT NULL, created_at TEXT, metadata TEXT NULL)`.
- `lyntai_message(id TEXT PK, thread_id TEXT FK→thread ON DELETE CASCADE, seq INTEGER, kind TEXT, payload TEXT, metadata TEXT NULL, created_at TEXT)` + `UNIQUE(thread_id, seq)`.
- `IConversationStore`: `CreateThreadAsync(id, title?, metadata?, ct)`, `SetThreadMetadataAsync(id, metadata?, ct)`, `GetThreadAsync(id)`, `ListThreadsAsync(limit)`, `AppendMessageAsync(threadId, kind, payload, metadata?, ct)` (store assigns GUID `Id` + 1-based per-thread `Seq`), `GetMessagesAsync(threadId)` (seq order), `DeleteThreadAsync(id)`.
- Registered by `AddClaudeCli...`/`UseSqliteStorage` → `IConversationStore` = `SqliteConversationStore` (`TryAdd` since R1). `lyntai_thread`/`lyntai_message` created eagerly by `UseSqliteStorage` during DI, BEFORE Gatherlight's `MigrateToLatest` — so the data migration can safely reference them.
- **Metadata JSON shape** (Gatherlight owns it): `{phase, mode, userMessage, planText, claudeSessionId, commitSha, error, attachments}`. Read via `json_extract(metadata,'$.phase')` etc.
- **SSE seq**: the live SSE frame id is the in-memory `s.Log` index (unchanged); the *persisted* seq is only for DB transcript/scoring order → Lyntai's store-assigned `Seq` (monotonic append order) is fine. Drop the app-passed seq.

---

## Phase 1 — `ChatRepository` writes via `IConversationStore`

**File:** `src/server/Gatherlight.Server/Modules/Chat/Services/ChatRepository.cs`

- [ ] **Inject `IConversationStore`** (add `using Lyntai.Storage;`), keep `IDbConnectionFactory` (for `chat_turn` + the bulk fail-interrupted update). Ctor: `ChatRepository(IDbConnectionFactory db, IConversationStore convo)`.
- [ ] **`AppendEventAsync`** — drop the `seq` param from the interface + impl; body: `await _convo.AppendMessageAsync(sessionId, kind, payloadJson);`
- [ ] **`UpsertSessionAsync`** — build the metadata JSON in C# and create-or-update the thread:
```csharp
var metadata = JsonSerializer.Serialize(new
{
    phase, mode, userMessage, planText, claudeSessionId, commitSha, error, attachments = attachmentsJson,
});
var existing = await _convo.GetThreadAsync(id);
if (existing is null) await _convo.CreateThreadAsync(id, title: null, metadata: metadata);
else await _convo.SetThreadMetadataAsync(id, metadata);
```
(add `using System.Text.Json;`)
- [ ] **`EventPayloadsAsync`** — `return (await _convo.GetMessagesAsync(sessionId)).Select(m => m.Payload).ToList();`
- [ ] **`FailInterruptedSessionsAsync`** — bulk conditional metadata update via SQL (startup-only; Gatherlight owns the metadata shape, same coupling as its `lyntai_score_result` reads):
```csharp
using var conn = _db.Open();
return await conn.ExecuteAsync(
    """
    UPDATE lyntai_thread
    SET metadata = json_set(json_set(metadata, '$.phase', 'error'), '$.error', 'server restarted mid-run')
    WHERE json_extract(metadata, '$.phase') NOT IN @terminal
    """,
    new { terminal = TerminalPhases });
```
- [ ] **`chat_turn` methods** (`TurnsAsync`/`AddTurnAsync`/`ClearTurnsAsync`) — unchanged (app-owned memory).

**File:** `src/server/Gatherlight.Server/Modules/Chat/Services/ChatSessionService.cs`
- [ ] **`Emit`** — remove the `int seq;` + `seq = idx + 1;`; the persist call becomes `_repo.AppendEventAsync(s.Id, ev.Kind, payload)`. Keep `idx` (SSE frame id) unchanged.

- [ ] **Build.** `node devtools/dev.mjs build` → 0 errors.

---

## Phase 2 — `FeedbackStore` + `ScoringService` read via SQL `json_extract`

**File:** `src/server/Gatherlight.Server/Modules/Eval/Services/FeedbackStore.cs` — rewrite the 4 read queries (`RateAsync` on `chat_feedback` is unchanged):

- [ ] **`ConversationsAsync`**:
```sql
SELECT t.id AS Id,
       json_extract(t.metadata,'$.phase')       AS Phase,
       json_extract(t.metadata,'$.mode')        AS Mode,
       json_extract(t.metadata,'$.userMessage') AS UserMessage,
       json_extract(t.metadata,'$.commitSha')   AS CommitSha,
       json_extract(t.metadata,'$.error')       AS Error,
       t.created_at AS CreatedAt, f.rating, f.note,
       (SELECT CAST(AVG(score) AS REAL) FROM lyntai_score_result c WHERE c.session_id = t.id) AS AvgScore,
       (SELECT COUNT(*) FROM lyntai_score_result c WHERE c.session_id = t.id) AS ScoreCount
FROM lyntai_thread t LEFT JOIN chat_feedback f ON f.session_id = t.id
ORDER BY t.created_at DESC LIMIT @limit
```
- [ ] **`StatsAsync`** — `SELECT COUNT(*) FROM lyntai_thread` (rating/dist from `chat_feedback` unchanged).
- [ ] **`TranscriptAsync`** — session:
```sql
SELECT t.id AS Id, json_extract(t.metadata,'$.phase') AS Phase, json_extract(t.metadata,'$.mode') AS Mode,
       json_extract(t.metadata,'$.userMessage') AS UserMessage, json_extract(t.metadata,'$.planText') AS PlanText,
       json_extract(t.metadata,'$.commitSha') AS CommitSha, json_extract(t.metadata,'$.error') AS Error,
       t.created_at AS CreatedAt, f.rating, f.note
FROM lyntai_thread t LEFT JOIN chat_feedback f ON f.session_id = t.id WHERE t.id = @id
```
events: `SELECT seq AS Seq, kind AS Kind, payload AS PayloadJson, created_at AS CreatedAt FROM lyntai_message WHERE thread_id = @id ORDER BY seq`
- [ ] **`EvalExportAsync`**:
```sql
SELECT t.id AS Id, json_extract(t.metadata,'$.mode') AS Mode,
       json_extract(t.metadata,'$.userMessage') AS Input, json_extract(t.metadata,'$.planText') AS Plan,
       json_extract(t.metadata,'$.commitSha') AS CommitSha, f.rating, f.note, t.created_at AS CreatedAt
FROM lyntai_thread t JOIN chat_feedback f ON f.session_id = t.id ORDER BY t.created_at
```
(scores subquery on `lyntai_score_result` unchanged.)

**File:** `src/server/Gatherlight.Server/Modules/Scoring/Services/ScoringService.cs`
- [ ] **`BuildContextAsync`** — session row: `SELECT json_extract(metadata,'$.phase') AS phase, json_extract(metadata,'$.mode') AS mode, json_extract(metadata,'$.userMessage') AS user_message, json_extract(metadata,'$.planText') AS plan_text, json_extract(metadata,'$.commitSha') AS commit_sha FROM lyntai_thread WHERE id = @id`; committed-event lookup: `SELECT payload FROM lyntai_message WHERE thread_id = @id AND payload LIKE '%"files"%' AND payload LIKE '%"sha"%' ORDER BY seq DESC LIMIT 1`.
- [ ] **`ScoreAllAsync`** backlog: `SELECT t.id FROM lyntai_thread t WHERE json_extract(t.metadata,'$.phase') IN @terminal AND NOT EXISTS (SELECT 1 FROM lyntai_score_result r WHERE r.session_id = t.id) ORDER BY t.created_at DESC LIMIT 500`.

- [ ] **Build.** → 0 errors.

---

## Phase 3 — Data migration + drop the app tables

**File:** `src/server/Gatherlight.Server/Modules/Fluent/Migrations/202607200001_MigrateChatToLyntaiConversation.cs`
- [ ] Create the migration (safe: `lyntai_thread`/`lyntai_message` exist from Lyntai's eager migration):
```sql
INSERT OR IGNORE INTO lyntai_thread (id, title, created_at, metadata)
SELECT id, NULL, created_at,
  json_object('phase',phase,'mode',mode,'userMessage',user_message,'planText',plan_text,
    'claudeSessionId',claude_session_id,'commitSha',commit_sha,'error',error,
    'attachments', json(attachments_json))
FROM chat_session;

INSERT OR IGNORE INTO lyntai_message (id, thread_id, seq, kind, payload, metadata, created_at)
SELECT lower(hex(randomblob(16))), session_id, seq, kind, payload_json, NULL, created_at
FROM chat_event;
```
then `Delete.Table("chat_event"); Delete.Table("chat_session");`. `Down()` recreates the two shells (one-way; rows stay in Lyntai).

- [ ] **Build** → 0 errors.

---

## Phase 4 — Verify + commit

- [ ] **Full e2e.** `node devtools/dev.mjs e2e all` → `N/N passed` (esp. p2 chat, p22 eval/feedback, p21/p23 scoring, p25 error-continuity, p26 jobs).
- [ ] **Scratch-test the migration SQL** against a temp db (seed chat_session/chat_event + a lyntai_thread conflict → assert copy + json_object + drop) via `node:sqlite`, like the chat_score migration.
- [ ] **check-sensitive** + commit (2 commits: the conversation-store rewire; the data migration).

## Notes
- Deliberate: persisted seq is now Lyntai-assigned (monotonic append order), not app-derived; live SSE unchanged (in-memory index). `chat_feedback`/`chat_turn` stay app-owned. `attachments` kept in metadata for completeness (not queried).
- Follow-up (optional): Part 9 storage-feature toggles let Gatherlight enable only Scoring+Conversation+KV stores (skip the ~10 unused `lyntai_*` tables). Separate change.
