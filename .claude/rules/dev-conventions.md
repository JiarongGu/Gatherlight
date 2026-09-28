# Dev conventions — server, data, tooling

The load-bearing patterns for working on Gatherlight's code. These mirror the sibling projects
(same family patterns); deviations need a reason.

## Backend (src/server)

- **Three projects, compiler-enforced**: `Gatherlight.Platform` (classlib, references none of
  ours) → `Gatherlight.Planner` (classlib, references Platform) → `Gatherlight.Server` (web app,
  references both — the composition root, exempt by definition) → `Gatherlight.Host` (WinForms,
  references Server). Namespaces are unchanged from the old single-project layout —
  `Gatherlight.Server.Platform.<Group>.<Name>` / `Gatherlight.Server.Product.Planner.<Name>` — this
  was a compilation boundary, not a rename. Each module: `{Name}Controller.cs` (thin) →
  `Services/` (business logic + repository). **A module is Platform if it survives the planner
  being replaced by a different site** — i.e. it knows nothing about plans, trips, budgets,
  household or travel. Groups: `Kernel` (contexts, paths, config), `Site` (template seeding, and
  the site manifest), `Hosting` (security, update, resources, migration, settings, migrations
  runner), `Agent` (LLM + chat sessions/gates/SSE), `Capabilities` (tool registry, MCP endpoint +
  client, document/media tooling), `Storage` (library, knowledge, memory, uploads, data repo,
  backup), `Ops` (jobs, traces, scoring, eval, playground, cortex). **Platform must never
  reference Planner** — the compiler enforces it (`Gatherlight.Platform.csproj` carries no
  `ProjectReference` to Planner); `node devtools/dev.mjs check-layering` is a fast redundancy that
  also asserts that `ProjectReference` never reappears. Where Platform needs something the Product
  owns, invert it behind a Platform-owned port resolved as a DI collection — see
  `Platform/Kernel/Services/IRecordIndex.cs`, which lets startup migration and backup restore
  trigger a rebuild without knowing the planner keeps an index. Variation points are interfaces
  resolved via DI collections (e.g. `IGatherlightTool`), never if/else chains.
- **Type naming — never `Dto`/`DTO` in a name.** "DTO" is a pattern label, not a domain word; it
  says nothing about what the type carries. Name the *role*, using the suffixes already in the
  codebase: `…View` for a client-safe projection of an entity (`McpServerView`, `PromptView`,
  `MigrationStepView`), `…Request`/`…Response` for a controller's wire shape, `…Summary` for a
  reduced/aggregate shape (`BudgetSummary`), `…Info` for a descriptor (`McpToolInfo`), `…Config`
  /`…Options` for settings, `…Snapshot` for a point-in-time state. Same for members, locals and
  prose — say "the view projection", not "the DTO". (Also avoid the other empty suffixes: `Data`,
  `Object`, `Manager` where a verb-noun service name fits.)
- **SQLite via Dapper**: hand-written SQL, `snake_case` columns ↔ PascalCase properties
  (`MatchNamesWithUnderscores`). **Repository methods are async** (`QueryAsync`/`ExecuteAsync`).
  Trap: SQLite integer affinity — wrap double columns in `CAST(x AS REAL)` in SELECTs.
  **Table ownership** (one database, deliberately not split): product tables are `plan_index`
  `plan_asset` `library_item` `knowledge` `entity` `job` `job_run` `data_commit` `chat_*` `upload`
  `tool_cache` `zhiku_state` `lyntai_*`; platform tables are `app_config` (security/update/resources
  keys), `notification`, `process_log`. A note for a future split, not an enforced boundary — at one
  site there is nothing for enforcement to catch.
- **Migrations**: FluentMigrator in `Platform/Hosting/Fluent/Migrations/`, numbered `YYYYMMDDNNNN` —
  never reuse a number (unapplied duplicates are skipped silently). Composite PKs must be
  inline at CreateTable (SQLite has no ALTER ADD CONSTRAINT). The 0.x ledger was squashed into a
  single `202607280001_Baseline` (one-time, at the Lyntai-1.0 fresh-start reset — durable data
  travels via the whole-install backup); the ledger is append-only again from there. Lyntai owns its
  own `lyntai_*` tables + `lyntai_version_info` (migrated eagerly by `UseSqliteStorage`) — so a Lyntai
  bump can change this database's schema at its first start: 3.5.0 added the nullable
  `lyntai_job.stage_detail`, which nothing of ours reads (we run no Lyntai job store, write no `lyntai_*`
  SQL, and the backup carries no database). What a build downgraded past such a migration does with the
  version it does not know is unverified.
- **Full-text search = FTS5 `trigram`**: search indexes are external-content FTS5 virtual tables
  with the **`trigram`** tokenizer (indexed CJK *substring* recall — `unicode61` treats a whole
  Chinese phrase as one token), kept in sync by AFTER INSERT/DELETE/UPDATE triggers and backfilled
  in the same migration. Build the MATCH string via `Platform/Kernel/Services/FtsQuery` (drops
  `<3`-char tokens, quotes the rest), fall back to LIKE when it returns null, rank with `bm25()`.
  Reference: the FTS virtual tables + sync triggers in `202607280001_Baseline` +
  `LibraryStore`/`Knowledge/Stores`.
- **Sources are BOM-less UTF-8 + `<CodePage>65001</CodePage>`** — without it, csc on a
  CJK-locale machine reads Chinese string literals as ANSI mojibake (bit us once).
- **Scorers / evals** are the DI-collection pattern in practice: each eval dimension is an `IScorer`
  registered `AddSingleton<IScorer, …>` (`Platform/Ops/Scoring`) — deterministic ones compute in
  code, LLM-judge ones extend `LlmScorerBase` (one-shot claude from a neutral cwd, `{score,reason}`
  verdict). Add a dimension = add a class + one registration, never a switch. The eval playground
  (`Platform/Ops/Playground`, `dev.mjs eval`) reuses them against dry plans (no persistence).
- **Judge tools** (`Platform/Ops/Scoring/Services/JudgeTools.cs`): the LLM judges can open the
  REAL artifact instead of grading the truncated excerpt in the `ScoreContext`. They reach it
  through Lyntai's `AddMcpToolHost(new ClaudeCliMcpConnector(), …)`, which registers an
  `ICliToolProvisioner` — read ONLY by `ClaudeCliProvider`, i.e. the one-shot `ITextClient` path
  (the agent path, `ClaudeAgentSession`, takes no provisioner — it reaches the app's tools through
  the loopback channel in the next bullet, a different endpoint with a different lifetime). **Which
  one-shot calls get it is per CONSUMER** (Lyntai 3.4, D190, `McpToolHostOptions.ToolsByConsumer`):
  `scorer` gets exactly the two judge tools, named by their `ToolName` constants, and `default` is
  EMPTY, so every other tag — the CLI 判断's annotation and verification (`memory`), 语义's rephrasing
  (untagged, `default`) — starts no host and is handed no `--mcp-config`. So the scorers' `Consumer`
  override is what hands them the tools: Lyntai's own `scoring` tag would fall through to `default`.
  **Through 3.2 this bullet said "the judges and nothing else" and it was false**: the provisioner ran
  on EVERY `ClaudeCliProvider` call, so each memory write and recall on the CLI judge stood up the host
  and was handed file-read tools it never used. Per hosted call Lyntai starts a bearer-gated loopback
  `HttpListener` and tears it down after. **It executes app code, so the jail is the load-bearing part**:
  read-only, text extensions only, size-capped, and a POSITIVE allow-list of `plans/ household/
  .claude/` — never `state/` (access token, TLS pfx, DB), with symlink targets re-checked and every
  listing hit re-resolved. That's the same set the planner agent may already read, so the judges gain
  no reach the scope guard doesn't already grant. Registering zero `ITool`s makes the host a no-op, and
  a `ToolsByConsumer` name no registered tool has is refused when the provisioner is built. Proof lives
  in `e2e-p36`: the claude stub drives the MCP server for real and asserts the denials, and the stub's
  args log shows every scorer spawn handed an `--mcp-config` while no annotation, verification or
  rephrase spawn is — confirmed to FAIL with the option removed (all three) and with only `scorer`'s
  entry removed (the scorer rows).
- **The agent's own tools come from a loopback-only channel**, not the public listener: a second
  Kestrel endpoint on `127.0.0.1:0`, plain HTTP, serving `/mcp` only, behind a per-start bearer token
  held in memory. `AgentSessionOptions.McpServers` (Lyntai) points each run at it. This exists because
  the public listener carries TLS and authentication meant for REMOTE HUMANS — with TLS on the agent's
  `http://` connection failed, and with `trustLoopback:false` it got a 401, and in both cases the CLI
  surfaced nothing: the server contributed no tools and the agent reported them **missing**. Exposure
  settings describe how remote humans reach the app; they have nothing to say about a child process on
  the same machine. Shape: `Platform/Hosting/Security/Services/InternalMcpEndpoint` (port + token,
  never persisted), `AccessGateMiddleware` telling the two ports apart by `Connection.LocalPort`
  **ahead of** its own `Enabled` check (a token-less install turns that gate off entirely, and an
  unrestricted internal port would then serve `/api`), and `Agent/Llm/Services/AgentMcpWiring` building
  the per-run server list for all three run sites (chat, jobs, the eval playground). The server NAME
  comes from `IToolRegistry.McpServerName`, not a literal: `AllowedTools` are `mcp__<name>__*`, so a
  drifted name would leave every tool un-approved — silently, which is the failure this channel exists
  to end. Naming a server does **not** pre-approve its tools; `AllowedTools` still does that. There is
  no generated `state/mcp.chat.json` any more, and startup deletes one an older build left behind — a
  file that configures nothing is worse than no file, because the next person debugging this reads it
  and believes it. Proof lives in `e2e-p44`, which asserts the TOOL LIST (never merely a 200) in each
  configuration, and the server name the spawned CLI was actually handed.
- **Agent-authored UI is a validated node tree, never markup.** The vocabulary is a DI collection of
  `IUiNodeSchema` (`Platform/Agent/Ui`): one class + one registration per component, never a switch.
  The server validates before the client is told a block exists — unknown type, unknown prop, wrong
  type, children on a leaf, or past the depth/node limits all fail, and a failure is SHOWN to the
  user, never dropped. Two mounts share it: a ```ui fence inside a streamed chat turn (the scanner
  splits a turn into ordered segments so raw JSON never lands in the transcript) and a page spec in
  `{data}/ui/`. `rehype-raw` and the sanitize allow-list are gone — legacy `trip-map`/`city-map`
  divs survive through a remark shim, so agent text has no path to markup at all. A `Button`'s
  action is a container verb (`send`, `openRecord`, `runCapability`), and `send` only composes the
  user's next message: a button cannot approve anything. `runCapability` names code a human ALREADY
  approved — the page supplies an id, never code — and the click confirms first, from
  `PermissionSentence` over the enforced grant (`GET /api/ui/capability/{id}`), never from the page,
  whose label the agent wrote. The verb validates by SHAPE, not by state: enablement is enforced at
  invocation by `ToolRegistry`, so a page naming a capability enabled later is still committable. A
  capability's OUTPUT is data, not a view — it reaches the renderer only via `POST /api/ui/validate`.
  The schema is C# and the renderer is TypeScript, so
  `node devtools/dev.mjs check-ui-registry` guards the two lists against drift. The vocabulary the
  agent reads (`.claude/ui-spec.md`) is app-managed and version-gated like the scope guard — it is a
  protocol contract, not knowledge-base content the seeder must preserve, and it has to keep saying
  exactly what `UiTreeValidator` enforces. Proof lives in `e2e-p41`.
  The agent authors pages too: `ui/` is in the scope guard's write set, restricted to flat `.json`
  by `WRITE_EXTS` so a path it may write there is exactly a page (the store lists the top level only
  — without the flat rule it could write a permanently invisible file). A page change is reviewed by
  RENDERING it at the diff gate from the working tree, with a change summary computed from the two
  trees rather than written by the agent, and an invalid page **cannot be committed**. Both the
  contract (`UI_CONTRACT_VERSION`) and the shared prompt preamble name pages — S3a's lesson is that
  a capability the agent is never told about is unreachable while every check stays green, so
  `e2e-p42` asserts the prompt pointer itself, not just the file. Proof lives in `e2e-p42`.
- **A page reads live data by NAMING a query, and the resolution happens server-side.** `bind` on a
  `Table`/`Chart` replaces the literal prop (`BindFills`; carrying both fails, because two sources of
  truth for the same cells is a page that can disagree with itself). The query is an `IUiDataSource`
  id with a CLOSED parameter set — one class + one registration per query, `Platform/Agent/Ui/Data`,
  implementations free to live in Planner. This is `runCapability`'s rule applied to reading: an
  agent-authored filter expression is an agent-authored program evaluated against the household's
  database, so the agent picks a name and fills declared slots and never writes the query.
  `UiBindingResolver` fills the tree wherever it is already being validated, and the node that goes
  over the wire has `bind` GONE — so the renderer never learns what a binding is (`check-ui-registry`
  keeps its meaning), the browser can never call a query with parameters of its own, and the S3b diff
  gate reviews a bound page against live data, which is what the reviewer actually needs to see.
  Two failure classes, deliberately different: a **shape** error (unknown query/param, both props)
  fails validation and therefore blocks the commit; a **runtime** error renders a visible warning
  where the data would have been and leaves the rest of the page standing. Neither ever yields an
  empty table — an empty table is indistinguishable from "you have nothing", which is a lie told on
  the household's own data. Same reason `Truncated` exists: a capped result SAYS there was more.
  Bindings are refused in a ```ui chat block (`allowBindings:false`) because that seam is synchronous
  and streaming — and in chat the agent already holds the data.
- **A composite is one level of whole-value substitution, and nothing more.** A file in `ui/` with
  `define` is a component definition; one with `root` is a page — same directory, same guard, same
  gate. Expansion happens BEFORE validation so the depth/node limits apply to what actually renders.
  Three constructions rather than three checks: a definition may not use another definition (so
  recursion cannot exist), a placeholder must be the whole value (so a parameter injects a value into
  a slot the definition chose, never structure), and a definition may not take a primitive's name
  (whose violation is *carried* as `UiComposite.Problem` and shown at the gate — a definition that
  silently never renders is the worst outcome). Editing a definition changes pages whose own files
  did not change, so `PagesToReview` expands a changed definition into those pages and the gate
  renders them. Proof lives in `e2e-p45`.
- **`remarkLegacyMaps` stays.** Its deletion was tied to dropping `rehype-raw`, which S3a already did
  by another route; the shim never enables raw-HTML parsing, nothing creates that shape any more, and
  the only thing left to migrate is the household's own existing documents. Recorded so it is not
  re-proposed as leftover cruft.
- **Capabilities carry provenance.** `Platform` (compiled, shipped by us) is available by default and
  runs in-process; `Script` and `Mcp` are off until `site.json` lists them in `capabilities.enabled`;
  `Draft` is never loaded. Non-platform capabilities run under `node --permission` with filesystem
  scope from their grant plus `cap-guard.mjs`, the platform preload that removes the network. That
  network denial holds ONLY because `--permission` already denies `child_process` spawn,
  `worker_threads` and `process.binding` — relaxing any of those silently breaks it. Two traps found
  the hard way: the sandbox must be granted read on the preload's own directory or it cannot import
  it, and a denied CLI built-in must appear in the PreToolUse `matcher` or the guard is never invoked
  for it. The launcher **fails closed**: no runtime supporting `--permission` + `module.registerHooks`,
  or a missing preload, means a Script capability refuses to run rather than running unsandboxed.
  Proof lives in `e2e-p38`, whose denials are real attempts paired with positive controls.
  **The ENVIRONMENT is part of the sandbox, so it is an allow-list** (`ChildEnvironment.ForSandbox`, applied by
  `NodeCapabilityLauncher.Build` and by `CapabilityRuntime`'s probe, so the probe tests what will run). Measured on Node
  24.15 under the exact launch, with `NODE_OPTIONS` inherited from the server: `--require <file>` ran that file — outside
  every read grant — BEFORE `cap-guard.mjs`, and it handed the capability `require('net')`/`require('http')` through a
  global, so the network denial the card promises was gone; `--allow-child-process` and `--allow-worker` reopened the
  two denials that denial rests on; `--allow-fs-read=*`/`--allow-fs-write=*` widened the jail to the disk; and
  `--allow-addons` re-enabled native addons (only `--import` from `NODE_OPTIONS` was refused, an ESM load being checked
  against the read grant). And `process.env` showed agent-written code every variable the app was started with,
  `GATHERLIGHT_ACCESS_TOKEN` too when the token is given that way. A deny-list would have to track every variable a future node reads (`NODE_*`,
  `OPENSSL_*`, `UV_*`) and drift; the allow-list is what node needs on this OS (`SystemRoot`, `windir`, `SystemDrive`,
  `TEMP`/`TMP`/`TMPDIR`, `USERPROFILE`/`HOME`, `PATH`) plus `TZ`/`LANG`/`LC_ALL`, and under `net: true` the proxy
  variables, `NODE_USE_ENV_PROXY` and `NODE_EXTRA_CA_CERTS`. `.claude/tool-spec.md` renders that list from the same
  constants (`TOOL_CONTRACT_VERSION` 2), so the contract cannot drift from it. Nothing about it can fail open: removing a
  variable cannot widen the sandbox, and the fail-closed launcher is unchanged. Proof: `e2e-p38` case 2b — a server
  started with `NODE_OPTIONS=--require _node-inject.cjs`: the capability runs and reads its grant (positive control), the
  preload never ran in it and left no `net`, no `NODE_OPTIONS` and none of the server's variables reach it, and the
  claude stub, which KEEPS `NODE_OPTIONS`, logs that it ran the preload — proving the injection real. Confirmed to FAIL
  with `ForSandbox` removed from the launcher (2026-09-28): the capability reported the preload ran, a working `net`
  (`typeof connect` = `function`), `NODE_OPTIONS` and every server variable — 4 checks — while its positive controls
  (it runs, reads its grant, cap-guard still blocks `node:net`) stayed green.
- **Split a growing class into SERVICES, not `partial`s.** `ChatSessionService` reached 1615 lines;
  a `partial` split made the files smaller and changed nothing that mattered, because the class could
  still absorb anything and nobody ever felt the cost. It is now four types — `ChatSessionService`
  (sessions + the two-gate pipeline), `ChatGateService` (the five between-turns gates), `GateMarkers`
  (final text → marker, pure) and `GateCards` (runtime facts → card, pure). The boundary is
  structural: `ChatGateService`'s constructor takes the provision/login/draft/capability/manifest
  services the session pipeline does not need, so a sixth gate lands where those dependencies already
  are. The cycle you would expect is avoided by passing the host per CALL rather than injecting it —
  `ChatSessionService` implements `IChatGateHost` explicitly (eight members — `ParkAsync` beside
  `SetPhase`, because entering a gate is the one phase move that must be durable before it is visible;
  see the restart bullet below), so the seam does not widen its public API and anything a gate wants
  beyond those eight is a design question. `GateCards`
  gains a real guarantee from the move: unable to reach session state or a service, a card cannot
  describe anything other than what is enforced.
- **Chat gates are between-turns markers, not suspensions.** There is no mid-run suspend: the agent
  ends a turn with a marker in its final text (`NEEDS_INPUT` · `MCP_ADD` · `LOGIN_REQUIRED` ·
  `TOOL_DRAFT` · `CAPABILITY_BLOCKED`), the server parks in a `ChatPhase` and emits the card on a
  `phase` event's `Data`, a POST through `FireAndAck` supplies the decision, and a FRESH run carries
  `ResumeToken`. A marker naming something that does not exist must NOT park — a gate with nothing to
  decide wedges the session and holds the app-wide agent lease.
- **A gate parked on a human decision survives a restart; a mid-run session still fails.** Those are
  opposite cases and `SelfHealStateStep` used to treat them alike. A running session's child process
  is gone — `error` is honest. A parked one has nothing in flight and its state is durable — **because
  it is stored BEFORE it is shown**, which it was not until 2026-09-27: `SetPhase` flipped the in-memory
  phase, emitted the card, and only then queued the metadata write behind the event append, so for tens
  of milliseconds `GET /api/chat/{id}` said "parked" while the stored phase still said `planning`. A hard
  kill in that window — a crash, an update restart — had the restart fail the session as mid-run and
  throw away the plan the household had just been shown. It surfaced only when `p46`'s 250 ms poll
  happened to land in the window on one machine's timing, "consistently" there and 1 in 3 on another
  tree, same commit. Now a gate is entered ONLY through `ParkAsync`, which commits the thread metadata
  naming the phase and its card and then flips and emits; `SetPhase` refuses a gate phase; and
  `ChatPhase.Parked` is ONE list shared with `ReconcileInterruptedAsync`, so a gate that can be shown is a
  gate a restart looks for. A graceful stop also flushes every session's queued writes
  (`FlushPersistenceAsync` on `ApplicationStopping`, bounded at 5 s) — the second line; a hard kill gets
  no such chance, and no suite asserts the flush, because every suite stops its server by TerminateProcess. `p46` waits for a parked phase at a 10 ms poll and kills at once, and never waits for
  the durable row, which would test the fixture's patience rather than the product: against the old
  ordering it lost the plan gate 4 runs of 4, and against the fix with only the flip moved back ahead of
  the write, 2 of 2. So
  `ReconcileInterruptedAsync` returns the newest parked thread (ONE — the agent lease admits one
  holder) and `RestoreParkedAsync` rebuilds it, **re-taking the lease**: restoring the gate without it
  would silently remove the single-writer guarantee the gate exists to provide. What gets persisted is
  the state a gate needs to ACT (`GateState` in the session's own metadata — the parsed MCP request,
  the draft, the denial + its grant, the tracked paths), which is deliberately not what it needs to
  DISPLAY (already durable: every phase event's `Data` is the card, stored verbatim). The diff gate is
  **rebuilt, never remembered** — `PresentDiffAsync` re-reads the working tree, because approving a
  remembered file list could commit something other than what the reviewer was shown. This matters
  more since auto-update restarts the server. Proof lives in `e2e-p46`.
- **Chat history is the stored event stream, replayed.** Every agent event is persisted as its SSE
  payload verbatim (`AppendEventAsync` → `lyntai_message`), so `GET /api/chat/history{,/id}` returns
  the wire shape and the client feeds it to the SAME reducer the live stream feeds — one renderer, no
  history view to drift. Two traps found by building it: the **user's** message is not an agent event
  (it lives in the turn metadata), so `TranscriptAsync` synthesizes a `kind:"user"` event per turn or
  a replay shows only the agent's half; and a **thread is one turn** — the conversation the user sees
  is the run of turns sharing a `ConversationId` in the thread's app-owned metadata, a new one
  beginning exactly when `PrepareThreadContextAsync` decides on a fresh slate (idle · turn cap ·
  post-commit). Assigning that id is not enough to resume one: `chat_turn` was cleared, so the
  context is rebuilt from the conversation's stored turns (`ConversationContextAsync`) or the agent
  starts blank while every other check stays green. A replayed gate renders its card **without
  actions** — the in-memory session that could act on it is gone, and an Approve button that silently
  does nothing is worse than a finished decision.
- **Cards are platform chrome; the agent's words are labelled as its claim.** Permission clauses are
  rendered server-side from the enforced grant (`PermissionSentence`), never from agent text, and a
  clause with no enforcement behind it is a defect — the household is trusting the sentence, not the
  code. The agent's own description rides in a separate field and is styled unmistakably differently,
  because an injected agent writes a reassuring one exactly when it matters. Agent markdown is
  allow-listed so it cannot forge a card.

## LLM / process spawning

- **claude CLI only, never API keys** — enforced at spawn since round 6: the process forgets every variable that would
  put the CLI on an API key, another provider or another endpoint (`ChildEnvironment.OffSubscriptionVariables`, under
  *Data folder discipline*). Resolve the executable via `where.exe` once, preferring
  `.cmd`/`.exe` (the first `where` hit can be an extensionless bash shim Windows can't run).
  `ArgumentList` only — never a shell (newlines + metacharacters in prompts). Prompts over
  stdin. BOM-less UTF-8 both directions. `Kill(entireProcessTree: true)` on abort.
- Cheap utility calls (extract, validation) run with a **neutral cwd** so the data folder's
  CLAUDE.md/knowledge base isn't loaded per call; the interactive chat runs cwd = data root
  **by design** (the planner gate is the product).
- **The CLI is a PROVISIONED resource, not an assumption** (`Agent/Llm/Services/ClaudeCliRuntime`).
  `Locate()` resolves an explicit override → the copy provisioned into `{data}/state/resources/claude`
  → a bundled `libs/claude` → PATH, and **re-resolves per call** until it finds a real file: DI builds
  the singleton long before the panel install that changes the answer, and resolving once in a
  constructor is the exact trap that left a freshly downloaded git invisible to a retry. The seam into
  Lyntai is the **`CLAUDE_CMD` env var**, deliberately not `AddClaudeCliAgentSession(command)` — that
  argument is captured once at DI registration, while `ClaudeAgentSession` calls
  `CliCommand.Resolve` *inside the run* (`ClaudeCommand.Resolve` through 3.2, with the same precedence), so
  only the env var can carry a CLI installed after startup.
  `Apply()` therefore runs on every probe, not just at boot, and never overrules an existing override.
- **Installed is not usable: probe, don't pattern-match.** A downloaded CLI is not a signed-in one, so
  `claude auth status --json` is the probe (`{loggedIn,email,subscriptionType}`, exit 1 when signed
  out) and it distinguishes *missing* from *signed out* from *a real failure* — three problems with
  three different fixes. `DiagnoseFailedRun` calls it instead of matching the spawn error, because that
  Win32 text is **localized** ("系统找不到指定的文件" here, English elsewhere): matching it would work on
  the developer's machine and silently stop working on the household's. `claude auth login` is
  browser-interactive with no headless flag — the app detects the state exactly and cannot complete it,
  so the message names the command rather than pretending to fix it.
- Tests stub the CLI via `GATHERLIGHT_CLAUDE_CMD` (see devtools/scripts/claude-stub.mjs). **The stub must
  answer `auth status --json`** — it short-circuits before the stdin drain. Without that the probe reads
  its stream-json as garbage, every suite boots with a spurious "not logged in" warning, and the
  diagnosis rewrites the failed-turn messages other suites assert on. **It also emits what claude 2.1.28x
  really sends** — `system/thinking_tokens` progress events carrying the session id — because Lyntai 3.2's
  reader turned each into a `SessionStarted`, and every tick became a stored `system` row (`e2e-p43` counts
  them). `AgentRunner` collapsed them with a once-per-run guard until Lyntai 3.3.0 fixed the reader (its
  `docs/task-archive.md` Part 275 — one SessionStarted per session id); the 3.4 bump deleted the guard, so these
  events are now the regression test for the upstream fix, not for code of ours. A stub that only speaks the
  stream shape of a year ago keeps every suite green against a CLI nobody runs any more.

## Security / remote access (`Platform/Hosting/Security`)

- **Loopback is trusted; remote needs a token.** `AccessGateMiddleware` gates `/api` + `/mcp` (token
  via `Authorization: Bearer` / `X-Gatherlight-Token` / httpOnly `gl_auth` cookie; loopback bypasses
  it unless `security.trustLoopback:false`, e.g. behind a same-host proxy). `SecurityHeadersMiddleware`
  puts CSP + nosniff/frame/referrer/permissions on every response — the CSP is calibrated to the
  built client, verify with a real render before tightening. `ILoginThrottle` = per-IP brute-force
  lockout. Binding beyond loopback **without** a token **fails closed** (refuses to start) — unless
  the explicit **`security.allowLanWithoutToken`** opt-in (`GATHERLIGHT_ALLOW_LAN=1`) is set, for a
  trusted private LAN (logs a loud startup warning; the gate is then a no-op). The `/manage` Settings
  tab surfaces this as a 3-way **Local / LAN / WAN** access mode (WAN = `0.0.0.0` + token required).
- **Every remote image goes through `/api/img`, so `img-src` is `'self' data: blob:`.** Map tiles,
  library covers, an `Image` node's https src and a picture in plan markdown all route through the
  one same-origin door (`ImageProxyController` over `ImageCache` — SSRF guard, image content-type,
  size cap, disk cache). With `img-src https:` any URL that reached a rendered page made the
  household's BROWSER call that host, leaking their IP and that they were reading it, on render,
  unrecorded — and an image URL can come from agent text. Proxying does not make an arbitrary URL
  safe to FETCH; it moves the fetch to the server, where it is guarded and visible. The tile route
  takes three bounded integers and pins the upstream host, so nothing agent-written reaches an
  outbound URL. **Adding `https:` back re-opens the residual** — `e2e-p17` asserts its absence, not
  the directive's presence, and the CSP stays calibrated against a real render.
- **Every fail-closed rule needs its opt-in asserted too.** `p17` case C proved an unauthenticated
  LAN bind is refused — which passes whether the refusal is conditional or unconditional. It was
  unconditional in the headless entry point for months: `Gatherlight.Server/Program.cs` built its
  options from config for port/bind/token/trustLoopback/TLS and never read `AllowLanWithoutToken`,
  so a household that chose LAN mode and took the documented opt-in got a refusal quoting the setting
  they had already set — while `Gatherlight.Host` honoured it. A denial without its positive control
  is half a test.
- **WAN WITHOUT TLS IS A TOKEN IN PLAINTEXT, and it used to look as calm as a safe setup.** The token
  requirement is genuinely enforced — an unauthenticated non-loopback bind refuses to start — but HTTPS is
  only ever a 建议, and the console's danger styling keyed SOLELY on a missing token. So the configuration
  that ships a bearer credential across the internet in clear text rendered in the same grey as a correct
  one. Both halves were true and one was invisible, which is the same defect shape as an unenforced claim
  arriving from the other direction. The settings panel now flags WAN-with-TLS-off separately — a
  different hole from having no token, fixed by a different switch, so not folded into the same sentence.
  Deliberately NOT made fail-closed: refusing to start would be ours to impose on a household who may be
  behind their own terminating proxy, and this file's own rule is that "costlier" describes an option
  rather than removing it. Asserted in `desktop-e2e`, which can drive the segmented control safely
  because it sets React state only — nothing is written until 保存, which the harness never presses.
- **TLS is Kestrel-native** (`TlsCertificate.Resolve`): a self-signed cert generated + reused from
  `state/gatherlight-tls.pfx`, or a configured PFX. Config lives in `security.*` (settings.json) +
  `GATHERLIGHT_BIND`·`_ACCESS_TOKEN`·`_TRUST_LOOPBACK`·`_TLS[_CERT]` env overrides.

## Capabilities, the sandbox & app-managed files

- **The agent authors capabilities as SANDBOXED SCRIPT TOOLS, never as MCP servers.** It drafts
  `.claude/tool-drafts/<id>/` (tool.json + entry script), raises `TOOL_DRAFT`, a human promotes it,
  and it runs under `node --permission` + `cap-guard.mjs` with a grant. Authoring an *MCP server*
  instead would take the same agent-written code and run it via plain `Process.Start` with the
  household's full privileges and no jail — strictly worse, for an identical capability. The contract
  it writes against is `.claude/tool-spec.md`: app-managed and version-gated like `ui-spec.md`, with
  the grant vocabulary rendered from THIS site's record dirs and — the load-bearing part — **the
  blocked-module list parsed out of the shipped `cap-guard.mjs` at render time**, not restated. A
  contract that merely describes the sandbox drifts the first time the sandbox changes, and the agent
  only finds out when an approved capability throws at run time, after a human said yes to a card
  promising it could not reach the internet. Proof lives in `e2e-p39`, which asserts the contract's
  contents, that the prompt points at it, and — the row that was missing for months — that a promoted
  draft **actually runs**, not merely that it appears in `/api/tools`. "Listed" is not "usable"; the
  same gap existed for platform tools and for proxied MCP tools (`e2e-p47`).
- **An external MCP server is the one capability we do NOT contain, and its card says so.**
  `StdioMcpConnection.Start` is a plain `Process.Start` — no `--permission`, no `cap-guard.mjs`, no
  path jail — so the process runs with the host account's full privileges. The add-gate therefore
  carries `sandboxed:false` plus `PermissionSentence.ExternalMcp()`, and deliberately has **no
  `cannot` list**: every clause in `Cannot` is a promise the sandbox keeps, there is no sandbox here,
  and inventing a reassuring one is precisely the unenforced-plain-language failure the card model
  exists to prevent. The client renders it through `UnsandboxedNotice`, never `GrantClauses`, whose
  empty 系统禁止 column would read as a missing value rather than a warning. Proof lives in `e2e-p32`.
- **Anything that replaces a record subtree must RE-ISSUE the app-managed files** — one seam,
  `IAppManagedFiles.ReissueAsync` (template seed + `ChatEnvironmentService.EnsureFiles`), called by
  startup AND by backup import. `.claude/` holds files the APP owns, not the household: the scope
  guard, the UI contract, the shipped form maps. They are derived from the app version — the same
  class as the plan index, which import already rebuilt — so restoring an older archive rolled them
  BACK. Measured on a real 2026-07-28 backup: the guard went from v7 to **v4** (losing S2's `DENIED`
  plane and S3b's `WRITE_EXTS`), the UI contract and form maps vanished, and because `EnsureFiles`
  only ran at startup the downgrade lasted the whole session. It surfaced as a visa PDF failing to
  generate — the loud symptom of a silent security regression. Two traps in the fix itself:
  `DataWriteLock` is a **non-reentrant** `SemaphoreSlim(1,1)` and the seeder takes it, so the re-issue
  must sit OUTSIDE import's lock scope (holding it deadlocks the import outright); and the re-issue
  must run BEFORE the restore commit so its files land in the same commit. Proof lives in `e2e-p47`.
  **Since the 2026-09-28 security review the scope guard is no longer one of these files**: it lives under
  `state/agent/` (regenerated every boot, not in the archive), so no restore can roll it back at all — and the re-issue
  DELETES a guard an older archive restores into `.claude/hooks/`, so a backup cannot leave a stale one in the jail
  either (`p47` asserts both). The UI contract and the form maps still ride this seam.
- **A zip cannot carry an empty directory, and a PACKED git repo has them.** `git gc` moves every ref
  into `packed-refs` and deletes the loose `refs/heads/<branch>`, leaving `refs/` empty. The export
  enumerates FILES, so `refs/` simply is not in the archive, and git then refuses to recognise the
  restored folder at all — `fatal: not in a git directory`. It surfaces as the FIRST thing startup does
  to a data folder (`初始化数据仓库: git config … failed (128)`) with no hint that the history is intact
  in `packed-refs` three inches away. Worse, the diagnosis is easy to get wrong: run `git` anywhere
  inside another repo and it walks UP, finds that parent, and reports success — which is why the first
  repro looked fine and the first e2e assertion passed while proving nothing. **Adding auto-packing is
  what made this reachable**, so the two changes belong together: `RepairGitSkeleton()` re-creates
  `refs/heads`, `refs/tags`, `objects/info`, `objects/pack` on IMPORT (which also rescues archives
  already in circulation, as fixing only the exporter cannot), and the exporter additionally writes
  directory ENTRIES so a hand-unzipped archive is valid too. `e2e-p47` packs the source repo before
  exporting — without that the fixture's refs stay loose and the whole case evaporates.
- **The backup MUST carry every directory the household writes to.** `Folders` was a hard-coded list
  that had drifted from the site: `ui/` (agent-authored pages, approved at the diff gate, tracked in
  the data repo) and `site.json` (the manifest holding `capabilities.enabled` — every capability a
  human promoted — and `records`, which the scope guard renders its write-scope FROM) were both absent.
  Neither loss was visible: the seeder immediately re-creates the template's `welcome.json`, so `ui/`
  came back looking intact with the household's own pages gone, and `SiteManifestStep` writes a fresh
  default, so the app came up working and merely forgot what it was allowed to do. When a new record
  directory is added to the site, add it here — and assert it in `p47` by NAME, never by the
  template-seeded file that would come back anyway. **`uploads/` was in the list and asserted by nothing**
  until 2026-08-23: dropping it from `Folders` left every check green while every file the household had
  attached stopped travelling. The rule already existed and `ui/` and `site.json` were added under it after
  they were lost — the directory ALREADY in the list was never retro-fitted, which is how a rule written
  after an incident covers the next case and not the previous one. Confirmed by dropping it: `p47` fails.
- **The backup carries `.git`, so LOOSE OBJECTS are a backup-size problem.** Git writes every new
  object loose — one zlib file each — and only packs when told; a loose object is already-compressed
  data a zip cannot squeeze. A restore writes a whole tree that way, so the objects ride into the NEXT
  export. Measured on a real data folder: 223 loose at 1.93 MiB against 158 packed at 790 KiB, and the
  export had grown 3.42 MB → 4.86 MB with **nothing of the household's added** (`plans/`, `household/`
  and `memory.json` were byte-identical; the knowledge base had actually shrunk). `git gc` took `.git`
  from 3.1 MB to 1.1 MB and the export to 2.79 MB — smaller than the archive taken before any of it.
  So `IDataRepoMaintenance` packs: threshold-gated at startup, and **forced after an import**, because
  import is a known bulk-object event and a small household would otherwise sit under any threshold
  forever while every export carried the pile. It expires reflogs first (per-clone breadcrumbs that pin
  unreachable objects and travel in the backup for nobody), takes `DataWriteLock` (gc rewrites the
  object store; a commit landing mid-pack is corruption found much later, in a backup nobody can
  restore) and is therefore called OUTSIDE any lock scope, the lock being non-reentrant. It is
  **lossless on purpose** — it never drops a commit. Bounding how far back history goes is a separate,
  destructive decision: the data repo is the audit trail the diff gate rests on, and "what did the
  agent change last Tuesday" is answerable only while that history exists. Proof lives in `e2e-p47`,
  which asserts `packs >= 1` and not merely a low loose count — the fixture's ~119 objects already sit
  under any sane threshold, so a count-only check passed while maintenance had never run.
- **The fact index is DERIVED, and rebuilding it is destructive.** `knowledge` is the record of truth —
  it is what the backup carries and what the index rebuilds FROM; Lyntai's graph memory engine
  (`Storage/Knowledge/FactIndex`, engine `facts`, **one scope for every fact** — see the next bullet) only ranks it, adding
  decay-by-what-has-happened, reinforcement on recall, and model-free linking of facts recalled
  together. Deliberately the **associative** tier: Lyntai can hold authoritative material that never
  decays, and that is the curated markdown the CLI loads directly, so grading facts authoritative here
  would exempt them from the only thing indexing them buys. Three traps: it is **not** an
  `IRecordIndex`, because that collection is rebuilt at every startup and the discard would erase the
  decay positions and links the index spends weeks accumulating — startup gets `SyncAsync` (back-fill
  only, via `FactIndexStep`) and a backup import gets the destructive `RebuildAsync`, because there the
  facts themselves were replaced. **Where only the VECTORS need redoing, nothing is rebuilt** (Lyntai D194, adopted at
  the 3.5 bump, owner decision 2026-09-26): an embedding model turned on or changed (paid by the RESTART that wires it —
  the bind records the vectors as owed and `FactIndexStep` re-embeds at that marker; the console's semantic reindex is
  refused until then, and afterwards re-embeds with the model already running), a
  vector address moved (layout "2" at startup) and the one-off for facts an old embedder batch refused each re-embed
  every entry IN PLACE — `FactIndex.ReembedInPlaceAsync` over Lyntai's `IReindexableMemory.ReindexAsync`, which writes
  vectors and nothing else, so node ids, links, decay positions, reinforcement and subject handles all stay and no fact
  is annotated. The destructive rebuild is left for the two cases where the ENTRIES are wrong: a backup import and a
  pre-marker layout. Before D194 re-remembering was the only way to give an entry a new vector, so every one of those
  vector passes paid a rebuild — and an annotation per fact. **The rebuild forgets THROUGH THE ENGINE**
  (`IForgettableMemory`, since the 3.5.1 bump), not its store: the engine's removal lock is what D194's pass takes for
  each write-back, and since Lyntai 3.5.1 what every write's vector index takes too, each re-reading that its entry
  survived — so no vector outlives the forget. The store's own `ForgetAsync` took no part in that lock, and a
  `remember_fact` beside a backup import could re-read its node just before the forget deleted it and index a vector
  for a node that no longer existed. Not driven by a suite: the window lies inside Lyntai, between a re-read and an
  upsert. **The bulk passes are serialised besides** (`FactIndex._bulk`): the rebuild, the re-embed and the BACK-FILL.
  The rebuild clears every `graph_ref` before it re-indexes, so a back-fill beside it — a detached one after a memory
  import during a backup import — read every fact as pending and annotated each a second time; it now waits and finds
  only what is still unindexed. `e2e-p48` case 10 stages it (the stub keeps two facts' annotation 6 s long) and was
  confirmed to FAIL with the wait removed: the back-fill indexed 7/7 instead of 1/1, and each slow fact was annotated 3
  times instead of 2. **The rebuild's wait takes NO token, nor does its discard** (2026-09-27): it waited with the
  caller's, outside its try, so a backup import whose client gave up while it queued behind a long console pass threw
  out of a method whose contract is to degrade rather than throw, and the rebuild the import asked for never ran. The
  facts underneath have already changed when it is called, so the forget, the vector sweep and the ref clear run to the
  end whatever the caller does; only the re-indexing after them honours the token, since an empty ref is what the next
  back-fill finishes. Clearing the refs BEFORE the wait was the other option and is wrong: a back-fill that got the
  semaphore first would read every fact as pending and annotate each, and the rebuild would annotate each again — case
  10's failure. Not driven by a suite (a client abort timed to land while the import queues). **Single writes racing a rebuild: CONDITIONAL REF WRITES** (owner decision 2026-09-27, no lock).
  `remember_fact` (and the memory import's rows) take no lock, and two races on `graph_ref` left a NON-empty ref no
  back-fill returns to. (1) A write that read the row's ref before indexing, and wrote or restored it after the rebuild
  had cleared and re-indexed that row, left a ref to a node the rebuild forgot — `RememberFactTool`'s fall-back to the
  ref it read, above all, when its index failed. (2) An EDIT landing after the rebuild's snapshot was overwritten when
  the rebuild, re-remembering the OLD content, wrote that node's ref — the widest window, the whole rebuild. Now the
  tool writes only while the row's ref is still the one it read (`IKnowledgeStore.SetGraphRefIfAsync`, `NULLIF(graph_ref,
  '') IS @read`), and the rebuild and the back-fill write only while the row still holds the content they indexed
  (`SetGraphRefIfContentAsync`); a lost race leaves the ref current, or empty for the back-fill. `e2e-p48` case 11 drives
  both: a remember_fact held open in its annotation (the stub's `GATHERLIGHT_STUB_HANG_ONCE_FILE` hangs ONE annotation
  and lets the rebuild's own of the same fact answer) is abandoned after a backup import re-indexed its row, and an edit
  lands inside the rebuild's 6-s re-remember of the old content — each confirmed to FAIL with its condition removed (the
  row naming a forgotten node; the edited row naming its OLD content's node). (The vector left by (1) in 3.5.0 was
  harmless in kind: ids are never reissued — 3.5.1 pins it on every store — so an orphan vector never answers for
  another entry.) **Nor does a scheduled job run beside the startup's own bulk passes**: `JobSchedulerService` waited a
  fixed 5 s, so a startup rebuild or re-embed longer than that had a due `remember_fact` tool job writing beside it; it
  now waits for the migration gate (`MigrationState.IsMigrating`, the one the access middleware uses) and asks again at
  every tick, so a Retry holds jobs back too. `e2e-p26` case 10 (a due job, a migration held open 20 s by the runner's
  test seam: no run while it is open, one at the first tick after), confirmed to FAIL with the wait removed.
  One embed per entry (`FactIndex.ReindexBatchSize` = 1):
  D194 counts a whole BATCH failed when its one embed call fails, and llama.cpp refuses a request whole when one input
  is past the window, so at Lyntai's default of 32 one long fact cost every other entry its new vector (confirmed:
  「0 条向量已原地重新计算;5 条没能计算」). What that costs is a request per entry — POST to summary, 100 short facts:
  2.6–2.7 s on one discrete GPU and 5.4–5.8 s on the CPU (llama.cpp b10549, EmbeddingGemma-300M Q8_0), 4.5–4.8 s for the
  built-in ONNX embedder (CPU, in process) — about 26, 56 and 46 ms per entry, so ~26 s, ~56 s and ~46 s for a thousand
  short facts, if it scales linearly (only 100 were measured; long facts cost more). **A pass with failures runs ONCE
  MORE** (Lyntai's own recipe, its `docs/memory.md`) and only what fails twice is classified: a blip is healed by the
  rerun, where it used to read as a refused input. An entry refused on both passes keeps the vector it had, or none, and
  is not retried — nothing loops; a pass whose failures come with the embedder DOWN (the probe after them unanswered)
  does not complete, and leaves the layout marker owed for the next start. A pass that completed also sweeps the vector
  collections a pre-3.2 build left at the OLD address (`{member}|{task}|{scope}`, listed by that prefix — a format that is
  history, and one the pass never writes to): no recall read them, and each held a stale copy of every fact's content
  as its payload. Measured on the real binary (`docs/self-managed-llm-runtime.md`, 2026-09-27): 100 facts, 100 embeds
  and one probe, no stub spawn, every graph table byte-identical. Proof: `e2e-p52` case 11, confirmed to FAIL with the
  old rebuild restored (links 32 → 0, an annotation per fact), with the owed marker removed, at batch size 32, with the
  failures never classified, without the rerun (11a2: the once-refused entry keeps its old width) and without the sweep
  (11b). **A MODEL CHANGE owes the vectors, and the restart pays them** (11d): binding an embedder newly, or to another
  model, records the layout marker as owed, so the start that wires it re-embeds in place on its own — the bind's note
  says so, and asks for no reindex. A reindex BEFORE that restart is refused (409), because it would re-embed with the
  model still running and record the vectors as current: after the restart they were the wrong width, semantic recall
  silently empty. The panel's running model is the WIRED one (`MemorySemanticWiring`), so a model change shows the
  restart owed where it used to read as applied. A console pass writes a token of its own (`FactIndexLayout.PassPrefix`)
  and hands the marker back by COMPARE-AND-SET (`IAppConfigService.CompareAndSet`), so a bind landing mid-pass — which
  writes a plain "2" — survives the pass's end. Each confirmed to FAIL with its own half removed: the refusal (the
  reindex 202s), the bind's owed marker, and the compare-and-set (both leave the marker "3" and the restart re-embeds
  nothing). **Stated residuals:** the write-time `similar` links stay as the model that wrote them scored them, or
  absent when none did — D194 recomputes no edge, and recall reads the new vectors through the semantic seed channel,
  which is what the paraphrase check measured; an entry the NEW model refuses twice keeps the old model's vector, which
  scores 0 at another width but is in the wrong space at the SAME one — which takes a household-dropped GGUF embedder of
  the same width as the one it replaces AND a fact past the new one's window (the catalogued embedders are one model,
  EmbeddingGemma, at one width, and its window is 2,048 tokens); refs are not cleared for it, since the fact's words and
  graph still find it; an input refused on both passes while the probe is answered is read as refused for good, and an
  outage that lifts between the rerun and the probe reads that way too; and the re-embed's serialisation with a rebuild
  is not driven by any suite (a race on demand; the back-fill's is, above). An EMPTY `graph_ref` is the index's retry queue: a write that failed — or kept no
  vector while its embedder was DOWN — is left that way on purpose, and the back-fill returns to it. The graph
  dedups on **content hash**, so editing a fact orphans its
  previous node; recall over-asks and filters to resolvable refs so an orphan never shrinks the page.
  And every operation degrades to FTS rather than throwing — an index that fails closed is worse than
  one that ranks by relevance alone, and an empty result reads to the agent as "the household knows
  nothing", which is a lie told on their own data. `recall_facts` therefore reports `ranked:
  graph|fts`, because a graph answer and a fallback answer are otherwise indistinguishable. Proof lives
  in `e2e-p48`, whose restore assertion was confirmed to FAIL with the rebuild removed.
- **WHAT THE RECALL LAYERS DO, and what is actually evidenced.**

  | | does | evidence |
  |---|---|---|
  | **公式** | graph decay + rank fusion + FTS trigram | the floor; always on, no cost. On the 240-question bilingual fixture (`docs/judge-bench.md`): top-1 80/240, found@8 127/240, ~0.25 s per recall on Lyntai 3.5.1 (Runs 10–11); 79/240, 125/240, ~0.23 s on 3.2 (Runs 1–7) — the base the Claude row pairs with, since the Claude judge was not re-run |
  | **判断 · Claude CLI** | subject handles on every write; judges which candidates answered, and promotes those to the front | **top-1 79 → 130/240 (+21.3pp, p < 0.001, 95% [+15.9, +26.3]pp), each of the four sets significant on its own; found@8 125 → 131, not a finding (p = 0.210)** — `docs/judge-bench.md` Run 1, 2026-09-23, its `contentonly` arm: the judge reading each fact's CONTENT alone, the input that ships since 2026-09-24 (through Lyntai's `ContentChars` since 2026-09-27, workaround (1) — the arm names here are Run 1's: the bench's `content` arm has shown content alone since then, and `contentonly` is gone). Its `content` arm — topic — content, the 1.3.0 input — read top-1 132 (+22.1pp, [+16.6, +27.2]pp) and found@8 133 (p = 0.096), and the two were measured equivalent. Costs **~8.7 s per recall** there (serial median; ~9.5 s for topic — content; 8.7–11.7 s across Run 1's judge arms; **9–17 s** measured earlier on the household's own facts) — a CLI spawn per call. Before the content fix, on the household's own facts: +2 facts in each multilingual probe, 0 same-language |
  | **判断 · reranker** | VERIFICATION only, by a llama.cpp cross-encoder; tagging still on the Claude CLI | **found@8 127 → 207 (LAMAR) / 208 (BGE) of 240 (+33.3 / +33.8pp, both p < 0.001) — cross-language 6 → 49 / 49 of 60; top-1 80 → 89 / 91 (+3.8pp p = 0.012 / +4.6pp p = 0.013)** — `docs/judge-bench.md` Run 11, 2026-09-27, Lyntai 3.5.1, all three rerankers in one run (Run 2 on 3.2, 2026-09-23: found@8 208 / 203, cross-language 49 / 48, top-1 86 / 90, from 79 / 125). ~0.45–0.46 s per recall, warm, on one GPU, ≤60 candidates, on facts of at most 101 characters — on 60 long notes of 883–1,241 characters (Run 6c, each read in windows) a recall took 3.2 s on BGE and LAMAR and 1.2 s on mMiniLMv2. **mMiniLMv2** (133 MB, same run, same fixture, 语义 off, page of 8, launched at its declared 512): found@8 127 → 203 (+31.7pp) and top-1 80 → 100 (+8.3pp), both p < 0.001; against the SAME run's BGE (208) no significant difference and not equivalent (8/3, p = 0.227, [−4.9, +0.7]pp), against LAMAR (207) no significant difference either (8/4, p = 0.388) — Run 4's measured loss to LAMAR (9/0, p = 0.004, on 3.2) did not replicate; top-1 above both (4/13, p = 0.049 against BGE; 3/14, p = 0.013 against LAMAR; uncorrected, the first marginal); ~0.34 s per recall against the run's formula 0.25 s (facts of at most 101 characters). Run 4 (3.2, under a 4096 launch) read 199 / 99. LAMAR vs BGE: no finding either way, and EQUIVALENT on found@8 on 3.5.1 (4/3, p = 1.000, [−2.7, +1.9]pp); Run 2's 5–0 lean toward LAMAR (p = 0.063, interval excluding zero) did not replicate; top-1 7/5, p = 0.774. BGE is `RecommendedReranker` by the smaller-file tie-break registered before Run 2, and by nothing else. Lyntai, on ITS English LoCoMo corpus (`docs/memory-measurements.md` there, evidence-hit, n = 200), in ONE run — 2026-09-10, `embeddinggemma-300M` embedder, base 85.5%, a perfect judge +7.0: BGE Q8 +5.5, LAMAR Q8 +5.5, LAMAR Q5 (our file) +6.0. Its 2026-09-15 run read LAMAR Q5 at +9.0 of 9.5 over `nomic-embed-text` (base 83.0%); Lyntai's own rule is that a reranker's delta belongs to the configuration, so quote the base and embedder with it or not at all — the household notes quote neither |
  | **判断 · 内置 reranker** | VERIFICATION only, by mMiniLMv2 as ONNX IN PROCESS on the CPU (`BuiltInJudgeSource`, round 6); tagging on the Claude CLI | **as good as llama.cpp's mMiniLMv2, and faster than llama.cpp on a CPU** — `docs/judge-bench.md` Run 13, 2026-09-28, Lyntai 3.5.1, one laptop's CPU (Core Ultra 9 185H, ~17–22% busy with other work), each arm's pass alone, the qint8 ONNX export against llama.cpp's Q8_0 GGUF, 语义 off, a page of 8. Short (240 questions): top-1 99 / found@8 203, against llama.cpp on the GPU's 100 / 203 — both EQUIVALENT (found@8 1/1, [−1.4, +1.4]pp). Long (60 notes of ~900–1,200 characters, 240 questions): 81 / 180 against 79 / 182 — no significant difference (found@8 9/7, p = 0.804, [−4.2, +2.5]pp, not equivalent), and equivalent to llama.cpp on the CPU (6/6). Median per recall 467 ms short and 8.1 s long, against llama.cpp on the CPU's 817.5 ms and 20.0 s (faster on 223 and 225 of 240) and on the GPU's 300 ms and 1.2 s. Per set, descriptive only (1 of 16 uncorrected tests): long cross-language 41 against the GPU arm's 47, same-language 50 against 46. Memory ~0.76 GB private after short facts, ~1.04 GB after long notes; load ~1.3 s at the first judged recall; the pace sized 2 of its long recalls, skipped none. So it is OFFERED, and RECOMMENDED where there is no usable GPU (`GgufCatalog.RerankerWithoutGpu`) |
  | **判断 · llama.cpp chat model** | BOTH halves locally — subject handles on every write, and judges which candidates answered (partition, like the Claude judge); no account quota | Same 240-question fixture, 语义 off, content-only judge input, one chat model per run beside 公式 and BGE — `docs/judge-bench.md` Run 11, 2026-09-27, Lyntai 3.5.1, thinking off by the request field, the 512-token cap, the 16,384 context, as the product runs it. **Gemma 3 1B is WORSE than no judge at ranking first**: top-1 80 → 36 (−18.3pp, p < 0.001); found@8 127 → 123 (−1.7pp, p = 0.424), no significant difference — Run 11b (Run 3 on 3.2, 2026-09-24: 79 → 33 and 125 → 111, both worse; that found@8 loss did not replicate, and one run per version cannot say why it moved); coverage 203/234. **Qwen3 0.6B is BETTER on both**: top-1 80 → 107 (+11.3pp), found@8 127 → 152 (+10.4pp), both p < 0.001 — Run 11a (Run 5b on 3.2: 110 / 148); coverage 218/234. Adds ~0.08 s (Gemma: 338 ms against its run's formula 257) and ~0.14 s (Qwen3: 382 against 245) per recall, serial medians, warm, one GPU. Those figures are over tags the Claude CLI wrote. **Qwen3's OWN tags were measured in Run 7** (2026-09-24, on Lyntai 3.2 and not re-run since, the same fixture and settings as Run 5b, a seed tagged by Qwen3 paired within the run against Claude's tags replayed through the same path): no significant difference — top-1 104 vs 114 (−4.2pp, p = 0.143, 95% [−9.2, +0.9]), found@8 155 vs 152 (+1.3pp, p = 0.736, [−3.6, +6.1]) — and NOT equivalent (neither interval inside ±3pp); still significantly better than no judge over the same tags (+10.8 / +14.6pp, p < 0.001). Its tags COLLAPSE unrelated facts (`parent` on 12; 29 of 78 handle assignments reused only across groups, against Claude's 7 of 65), which a fixture of one-fact questions barely exercises — the model note says so. Gemma's own tags are unmeasured. Qwen3's child and the router took +2,472 MiB of GPU memory at the chat context cap, +5,175 MiB uncapped (launch item (5)) |
  | **语义 · Claude CLI** | stores other wordings of a fact, **≥1 in another language** | capability proven directly: an English question retrieves a Chinese-only fact. Aggregate effect NOT measured — see the rule below on why this tool cannot |

  **The two judges are complements, not rungs of one ladder.** The reranker changes WHAT REACHES THE PAGE; the
  Claude judge changes WHAT COMES FIRST. A reranker endorses a full page of its eight best every time, so the
  answer lands on the page far more often, in whatever position the engine gives it; the Claude judge endorses
  only what it judges to answer, so when it finds the answer that fact goes first (its top-1 and found@8 nearly
  coincide, 130 and 131 content-only, 132 and 133 on topic — content), and when it does not the page stays the
  engine's. Against Run 1's `content` arm — topic — content, the 1.3.0 input; Run 2 was paired with that arm,
  not with the content-only one that ships since, which Run 1 found equivalent to it — on the same seed and
  questions, both rerankers are significantly worse on top-1 (−19.2 / −17.5pp) and significantly better on
  found@8 (+31.3 / +29.2pp) — at about 1/20 of the latency and no account quota per recall. **A local chat judge
  complements the reranker the SAME way** (`docs/judge-bench.md` Run 11, one run, same fixture, Lyntai 3.5.1): Qwen3
  0.6B ranks the answer first more often than BGE (107 against 91, +6.7pp, p = 0.011; Run 5b on 3.2: 110 against 90,
  p = 0.002) and gets it onto the page far less often (152 against 208, −23.3pp; Run 5b: 148 against 203) — it
  endorses what it judges to answer, as the Claude judge does, while the reranker endorses a full page. Which is why the owner kept BGE as 判断's local default (2026-09-24): Qwen3 is offered, not recommended.

  With `VerificationFilters` off (how we register it) a verdict REMOVES nothing — but it is not inert: under
  Lyntai's default `VerdictCombination`, Partition, every endorsed candidate is PROMOTED ahead of the rest, in
  the engine's own order, before the caller's limit is applied, and is reinforced. That one mechanism is behind
  both judges' numbers. Until 2026-09-23 this paragraph said a verdict reached the ordering only THROUGH
  reinforcement — "real but indirect", 0.000 on same-language probes — which described the topic-only judge on
  the household's 16 facts; the judge that reads content moved same-language top-1 by +25.0pp on the fixture.
  `Fuse` lost to partition for both judges (Claude top-1 −28.8pp; reranker found@8 −29.6 / −26.7pp), so
  partition stays and Fuse remains a measurement knob.

- **THREE RULES FOR MEASURING ANY OF THIS.** They are here because ignoring them produced three sessions
  of wrong conclusions, and each is cheap to apply.
  **(1) When a measurement says "no effect", check the instrument can EXPRESS the effect.** `recall-bench`
  generated questions *in the fact's own language* — the one case the lexical floor already handles — so
  it could never see an enrichment layer working. It now generates FOUR sets (`QUESTION_SETS`): same,
  cross, a third language, and CODE-SWITCHED, which is how people actually type in chat. A zh↔en flip
  alone is too narrow; a household with Japanese or Korean material is not served by it. (The Japanese
  floor beats the English one because the index is TRIGRAM and Japanese shares kanji with Chinese.)
  **(2) Only the WITHIN-RUN paired comparison is trustworthy.** Recall REINFORCES, so a run mutates what
  it measures. Anything compared across runs is unattributable — and two adjacent runs agreeing shows
  convergence, not stability. The bench is paired and counterbalanced for this reason. A layer whose state
  is durable rows (语义's phrasings) therefore cannot be A/B'd by this tool at all; that needs a fixture
  whose graph resets between arms, which `recall-bench` deliberately is not.
  **(3) A capability question needs ONE FACT, not a corpus.** "Does a stored phrasing retrieve its fact?"
  is settled by writing one fact and querying a wording that appears only in its phrasings. Reaching for a
  16-fact benchmark to answer it is what made this look unanswerable for three sessions.

- **REQUIRE IT, DON'T OFFER IT — the rephrase prompt.** It listed 另一种语言的常见叫法 as one option among
  three, and a model asked for "a different wording" takes the synonym every time: measured on a real
  fact, four phrasings and not one latin character. The layer therefore added only same-language surface
  the lexical floor already reached. The prompt now REQUIRES a line in another language, and `e2e-p48`
  asserts the retrieval half (an English query reaching a Chinese-only fact), failing when the stub's
  cross-language phrasing is removed. Generalises: when a prompt lists alternatives, the model picks the
  cheapest, so anything load-bearing has to be mandatory rather than mentioned.

- **A LAYER'S COST LINE DESCRIBES THE BOUND ARM.** 判断 has always derived its cost from `boundJudge`;
  语义 carried a fixed string from when its only arm was an embedder — 「不消耗 token;资料不离开这台电脑」
  — so a household who chose the Claude arm was told their facts stay on their machine while every fact
  was being sent to Claude and billed. Adding an arm to a layer means re-reading everything the layer
  SAYS: a fixed string cannot be wrong about a backend that did not exist when it was written, which is
  exactly why nobody re-reads it. `p51` binds each arm and asserts the claim tracks it, including that a
  LOCAL arm still says the data stays put.

- **Switching 语义 off does NOT clear what it wrote.** Phrasings live in `knowledge.aka`, which the FTS
  table indexes unconditionally — so 15 facts were still matching on their stored phrasings after the layer
  was turned off, and nothing in the product said so. Turning a layer off stops it producing; it does not
  retract what it produced. **The `/off` response now says so**, and deliberately does not delete them —
  the persistence has a real upside (re-enabling costs no re-derivation, which is ~46 s per fact), so the
  defect was the silence, not the effect. A CLEAR action stays a separate decision, because it turns on
  whether phrasings are the layer's output or part of the fact, and putting one inside an "off" button
  would answer that question by accident.
- **FTS TOPS THE PAGE UP; it is not only a fallback for an empty one** — and until 2026-08-22 it was, which
  quietly cost the 语义 CLI arm most of its value. Phrasings live in `knowledge.aka`, which is in the FTS
  table and in NO graph node (the graph indexes a fact's CONTENT, which never contained them), while
  `MemoryTools` ran the FTS recall only when the graph resolved nothing. So a household paying a model call
  per fact got phrasings reachable only by a query that matched nothing else at all — a far narrower promise
  than the layer makes. Demonstrated in `e2e-p48`: `zzfishpref harbour` resolved the three lexically-matching
  facts and silently dropped the one whose stored phrasing was the query's only real match. Now FTS fills
  slots the caller asked for and the graph did not use — **topping up, never merging**, so the graph's rows
  keep their place and their order and nothing can displace a ranked hit (the property that makes the
  subject append safe). Rows added this way carry `matched:"text"`, but only when the graph also answered:
  on an empty page `ranked` already says `fts` for the whole result and marking each row states it twice.
  **The first version of that test was VACUOUS and passed** — it used a term matching the target fact's own
  topic, so the graph found it lexically and the phrasing was never needed. To ask the question at all, the
  lexical term has to match an UNRELATED fact. Topping up also made the two paths OVERLAP, so
  `RecallAsync` takes an `exclude` set: "give me more, but not these" is the top-up's real contract, and it
  stops a fact found both ways counting twice in `knowledge.hits`. **That counter turned out to have no
  reader at all** — incremented on every recall, mapped onto `KnowledgeRow`, and used by neither the ranking
  (confidence then bm25), nor `MemoryTools.Row`, nor the client, which is why the double-count was a latent
  wrong number rather than a visible one. **Resolved by giving it a reader** (`used` on each recalled row)
  rather than by dropping a column the backup carries: it earns its place on rows matched by TEXT, which
  carry no retrievability and so had no usage signal at all. "Read it or stop writing it" —
  and reading it was the smaller change.
- **A WORKAROUND FOR A LYNTAI GAP IS RECORDED ON BOTH SIDES, or it becomes a duplicate feature.** We are
  review-only on Lyntai, so our fixes for its gaps live here and the request lives in its `TASKS.md`. Each
  half has to name the other: the code says *this exists because the library does not do it, and here is
  what happens when it does*; the task says *an adopter already shipped a workaround, so landing this means
  telling them to remove it*. Without both, a future release closes the gap silently and the app keeps
  running its own copy — two implementations in one call path, each looking necessary to whoever reads only
  one repository. The app-side subject lookup ↔ Lyntai Part 94 is the worked example, and it also shows
  the note must state the CONSEQUENCE precisely rather than warn vaguely: there, an engine-side seed would
  not double any row (we dedup by graph ref) and would report better numbers than we can, so the honest
  instruction was "delete this", not "beware of conflicts". **And the rule paid out**: Lyntai 3.1 closed both
  Part 94 and Part 93 (the candidate-list widening, below), and the 3.2 upgrade deleted both copies without
  an investigation, because each note already said what to do.
  **The failure runs the other way too, and is this rule's negative example**: `AgentRunner`'s tool-call bridge
  carried a note claiming `ClaudeToolCalls.FilePathOf` read only `file_path`, filed as a Lyntai gap — but the
  shipped 3.2.0 class already read `file_path` → `notebook_path` → `path` in that order, shipped as G1 in
  `0.29.3`. `docs/task-archive.md` Part 11 only FILES the request and carries no outcome text of its own; the
  "stale on both halves" quote belongs to a DIFFERENT item, Part 25's "agent-event contract" (2026-08-05). The
  note kept a duplicate of shipped library code in the TRACKER's call path until it was checked against
  Lyntai's source on 2026-09-24 and switched to `FilePathOf` there — `ToolDetail`'s OWN copy of the same
  fallback chain stays, because it takes a parsed `JsonElement` for a UI label, not the `ToolCall` `FilePathOf`
  takes, so only one of the two copies is gone.
  **Six were open at Lyntai 3.2.0; on 3.5.1 four are CLOSED and two STAY, each by a decision of ours rather than a
  gap left open.** CLOSED, each fix shipped in 3.3.0: (1) the judge-content decorator, for `ContentChars`, adopted on
  2026-09-27 once 3.5.0 (its Part 302) had fixed the cut that gutted a long CJK note; (2) the scoped routing store, for
  D176's routes, and (4) the `SessionStarted` guard, for the reader's one-per-id — both with the 3.4 bump; (5) the
  chat preset's `reasoning = off`, for `SuppressReasoningFields`, with the 3.4 bump after a real-binary check of every
  catalogued chat model. STAY: (3) — the workaround itself closed, since the 3.4 bump reads D175's per-write `Ran`,
  but its embed probe stays as OUR quota gate (a retried write during an outage would still pay its annotation), and
  the entry says what would end the gate; and (6) — our windows, pace and admission stay because Run 10 found D177, as
  close to ours as 3.5.1 allows, not better for BGE, which is the owner's rule for keeping ours; the entry says what
  would reopen it.
  **(1) CLOSED — the app-side judge-content decorator ↔ Lyntai `docs/task-archive.md` Part 276 / D170, shipped in 3.3.0,
  adopted on 2026-09-27 once Lyntai 3.5.0 had fixed its cut (Part 302).** Lyntai's LLM judge rendered each candidate as
  its headline alone, and our headline is the fact's TOPIC, so the judge decided "did this answer?" from topics;
  `JudgeSeesContentPolicy` showed it the content. Upstream closed the gap with `LlmVerificationOptions.ContentChars` —
  content ALONE, not "topic — content" — and Part 276's own outcome named our decorator as the thing to remove. Whether
  the topic was worth keeping was MEASURED rather than argued: `docs/judge-bench.md` Run 1 found content alone
  EQUIVALENT to topic — content on top-1 and found@8 (2/0 pairs, p = 0.500, 95% [−2.2, +0.6]pp, inside ±3pp) with ~24%
  less candidate text, so content alone became the default on 2026-09-24, and it is what `ContentChars` renders. The
  3.4 bump still kept the decorator, for its CUT: through 3.4.0 Lyntai cut content past the cap at the LAST space
  however early, so a long Chinese note whose one space follows a leading date reached the judge as the date. 3.5.0
  takes a space only in the cap's latter half, else cuts at the last text-element boundary, never inside a surrogate
  pair, and flattens with `MemoryLine.Flatten` first (which also folds U+000B and U+001C–U+001E, a strict improvement).
  **What was done:** `JudgeWiring.Llm` sets `ContentChars` to `JudgeWiring.ContentChars` — 400, the decorator's cap,
  re-homed beside the verifier it sizes; `LlamaServerRuntime.ChatContextTokens` and `RerankInputCap` name it — for BOTH
  LLM judges, the Claude CLI and a llama.cpp chat GGUF. The class, its `GATHERLIGHT_JUDGE_INPUT` knob and both of the
  knob's announcements are deleted. In `judge-bench.mjs`, `topic`, `contentonly` and the `lcb:<model>` chat arms are
  REFUSED by name with the reason, `content`/`content2`/`fuse` show content alone and set no judge-input knob (`fuse`
  keeps the verdict-combination one), the default `--chat-arms` is `lc`, and a saved run keeps what its arm names meant
  on its own date — so a `--baseline=…:content` against a run from before the change is LABELLED with the input it
  measured ("topic — content") in the header and a note, rather than paired as if both sides ran one configuration.
  `e2e-p52` case 7b asserts the verdict-combination knob in state/logs instead. **The residual, accepted by the owner
  on 2026-09-26:** a note with a space in its characters 200–400 is cut there, at a word — at worst half the cap —
  where the decorator hard-cut at 400. On the committed fixtures every fact of at most 400 characters renders
  identically, and 20 of the 90 long notes (the long and mixed fixtures) are cut 1–12 characters shorter. No LLM judge
  has been measured on notes over 400 characters at all — the long fixtures run the claude stub. The chat context
  cap's worst prompt still bounds the judge's, because no line is longer than the decorator's was
  (`LlamaServerRuntime.ChatContextTokens` says why). **What can no longer be reproduced:** "topic — content" and
  topics alone. Run 1's `content`, `content2`, `fuse` and `topic` rows and the `lcb` rows of Runs 3, 5 and 5b are
  their only record (`docs/judge-bench.md`, "The judge's input since 2026-09-27"). **Proof:** `e2e-p48` asserts that
  the judge is shown a fact's content and not its topic — a topic word no fact's content holds is absent, a content
  phrase present — confirmed to FAIL with `ContentChars` left at 0; and that a 508-character Chinese note whose three
  spaces sit in its first 30 characters reaches the judge with at least 200 characters of its content — confirmed to
  FAIL on a real build against Lyntai 3.4.0, where the note arrived as its first 27 characters and "…".
  **The flip also moved the llama.cpp CHAT judge, and `docs/judge-bench.md` Run 3 measured that.** `JudgeWiring.Llm`
  builds the verifier for both LLM judges (`ClaudeCliJudgeSource`, and `LlamaCppSource` bound to a chat GGUF). Run 3
  benched `gemma-3-1b-it-Q4_K_M` on both inputs, under a rule written before the run: stop and ask the owner only
  if content alone is significantly worse. It is not significantly worse, but it is not equivalent either. Content
  alone trails `topic — content` by 4.6pp top-1 (23/12, p = 0.090, 95% [−9.4, +0.3]pp) and by 4.2pp found@8 (18/8,
  p = 0.076, [−8.3, +0.04]pp). Part of that gap is `both` failing to give a verdict more often (75% coverage
  against 86%), since a recall with no verdict keeps the engine's page. So the flip stayed unscoped, and adopting
  `ContentChars` gave every LLM verifier the same content-only rendering. Quote the lean with the
  figures, never as "equivalent". The same run found the bigger thing: in EITHER mode this 1B judge is
  significantly WORSE than no judge (top-1 79 → 33 / 44 of 240, −19.2 / −14.6pp, p < 0.001), because partition
  promotes whatever it endorses.
  **(2) CLOSED — the app-side routing store ↔ `docs/task-archive.md` Part 284 / D176, shipped in 3.3.0, adopted with
  the 3.4 bump (2026-09-26).** Lyntai's live override was a bare MODEL keyed by CONSUMER alone, so a key written for
  one 判断 binding was read by another — after a fallback, or between a rebind and its restart (previous bullet) — and
  `JudgeScopedModelRoutingStore` withheld it while the saved binding annotated through a different client. D176 made
  the override a ROUTE, provider AND model (`provider:model[, …]`), and a router ignores, with a warning, a route
  naming a provider IT does not hold — Lyntai builds one router per named client, over that client's providers only.
  That covers both situations the store existed for, so the bump DELETED it: after a fallback the route still names
  `llamacpp`, which the CLI's router does not hold; between a rebind and its restart the newly bound provider is
  unheld the same way. The reverse holds too: a chat GGUF annotates on its own client, `memory-llamacpp`, whose router
  holds only `llamacpp`, so a `claude-cli:…` route written by a rebind is ignored there and the running GGUF keeps
  annotating. Two caveats stand: the argument needs the chat provider id distinct from the embedder's and the
  reranker's (`LlamaCppSource.Register` gives each its own, Lyntai D133, and D176 skips a provider serving no text
  anyway); and an ignored route LOGS a Warning on every call it is ignored for, where the store was silent. **That
  warning is not accepted as the trade for a FALLBACK.** There it would fire on every annotation and every recall's
  verification for as long as the fallback lasts — forever for a household that removed llama.cpp on purpose — plus
  one per fact on the startup back-fill: a log that cries wolf about a state the startup warning already announced.
  So `LiveRouteMigrationStep`, which runs at every start, DELETES a `memory` route naming no provider the RUNNING judge
  annotates through (`MemoryJudgeWiring`, the resolved judge, asked for its `AnnotationProvider`). At a start the
  restart has already applied any rebind, so such a route can only be a fallback's leftover, and deleting it loses
  nothing: once the saved binding resolves again, `DefaultModelByConsumer["memory"]` carries the model the bind wrote
  into it. What remains is the warning between a rebind and its restart — transient, and true: that choice waits for
  the restart. **What the bump did, as ONE unit** — renaming the prefix without writing routes would have silently
  dropped every live model change:
  - `RouteKeyPrefix` is `llm.route.`, its own namespace — NEVER `llm.model.`, where a bare `haiku` is read as a
    provider id and live routing stops for that consumer. `LiveRoutes` reads and writes every route: each write is
    `provider:model`, and a blank model DELETES the key, because a bare provider means the backend's own default,
    never `DefaultModelByConsumer`.
  - Only `scorer` and `memory` are routes — the two consumers Lyntai's router resolves. `chat`/`extract`/`validate`
    stay `llm.model.<consumer>` (`LiveRoutes.ModelKey` — CURRENT keys, not legacy ones): the app reads each itself
    and hands it to the agent CLI's `--model` (`ChatSessionService`, `UnattendedRunService`, `PlaygroundService`,
    `ZhikuMigrator`, `ExtractTool`, `ClaudeValidateService`), where a route would arrive as `claude-cli:opus`.
  - A routed model may not contain a COMMA (`LiveRoutes.WhyNotAModel`): a route is a comma-separated fallback list,
    so `haiku, llamacpp:x` would store a second backend nobody chose. Cortex answers 400 and a bundle's import skips
    the key; a colon is allowed, because Lyntai splits every entry at its FIRST colon and real ids carry one.
  - The provider is STATED beside the model, on the source: `IMemoryJudgeSource.AnnotationProvider` — the CLI's id
    for the CLI arm and for a reranker's tagging, `llamacpp` for a chat GGUF. The binding endpoint writes
    `AnnotationProvider:AnnotationModel`.
  - Cortex's scorer row (`CortexConfigService`, marked `Routed` in its catalog) stores `llm.route.scorer =
    claude-cli:<model>`, shows the model half, and deletes the route on a clear or a reset.
  - The memory bundle carries each model as cortex STORES it (`ModelKeys`), so the scorer travels as its route, and
    imports through cortex's writer (`SetModelFromKey`): an older bundle's `llm.model.scorer` lands as the route; a
    route cortex could not have written (a bare provider, another backend) is refused; the judge's route never
    travels. An install from before the routes skips `llm.route.scorer`, so its scorer stays on the default.
  - The backup reconcile deletes `llm.route.memory`, and any leftover `llm.model.memory`.
  - `LiveRouteMigrationStep`, right after `db-migrate`, moves what an install stored and LOGS each key, because our
    namespace gets no warn-once from Lyntai (its check covers only `lyntai.model.`; the option that widens it,
    `LyntaiOptions.ModelOnlyKeyPrefixes` — Part 310's item, closed as Part 308, released in 3.5.0 — warns on ANY key
    left under a listed namespace, and `llm.model.` keeps the current `chat`/`extract`/`validate` keys, so it does not
    fit us and stays at its default): `llm.model.scorer = X` becomes
    `claude-cli:X`; `llm.model.memory` takes the SAVED binding's `AnnotationProvider` — the provider the key was
    written for, which reproduces exactly what the deleted store did with it — becomes `claude-cli:X` when nothing
    is bound, and is DROPPED, at Warning, where there is no provider to derive (a retired backend, a source saved
    with no model: both keys the store never read). A route already present is kept over the old key beside it —
    the route is what this build reads, which is not the same as newer (a downgrade and an upgrade can leave either
    one older). It then drops a fallback's stale `memory` route (above).
  Proof: `e2e-p52` case 4 passes on routes alone, and fails when a chat GGUF's route names the CLI (read straight
  through after the fallback); 4b is its positive control, a route for the running provider read live; case 5 reads
  `claude-cli:haiku` from the database; and after the fallback the restart has dropped the GGUF's route and the log
  holds no per-call router warning. `e2e-p16` S1–S4 drive a real scoring pass (the route reaches the judge spawn's
  `--model`; a clear gives the consumer default, haiku, never no `--model`; a comma is a 400) and M1–M6 the migration
  (nothing bound, a fallen-back chat GGUF, a retired backend, the CLI saved with a model, a reranker, and a second
  boot changing nothing); `e2e-p14` the bundle; `e2e-p47` the reconcile. Each is confirmed to fail with its own half
  removed (the suites' headers name which).
  **(3) CLOSED as a workaround — `IFactIndex.EmbedderReadyAsync` ↔ `docs/task-archive.md` Part 285 / D175, shipped
  in 3.3.0, adopted with the 3.4 bump (2026-09-26); the probe STAYS, as our cost policy and as a classifier.** A failed
  write-time embed is not an error to Lyntai's graph engine: it stores the fact WITHOUT its vector and hands back a
  reference, and a row holding one is never revisited — `SyncAsync` back-fills only EMPTY refs (measured: a real
  install came up 6/6 "indexed" with 0 vectors, coverage reading 100%). Until the bump only an all-or-nothing
  pre-flight probe kept that from happening. D175 made a write REPORT what it did — `MemoryWriteResult.Ran`, where
  `Lyntai.Memory.MemorySources.Similarity` (Lyntai's flags enum, not this app's `MemorySources` catalog in
  `Agent/Llm/Sources/MemorySources.cs`) means THIS write's vector was indexed — and the bump reads it on every write.
  **A vector-less write is CLASSIFIED, never assumed to be an outage — and never assumed permanent.** When an embedder
  is wired (`Embeds`) and a write's `Ran` lacks `Similarity`, `FactIndex.IndexAsync` makes at most two calls, and never
  for a write that kept its vector. FIRST it re-embeds the fact's OWN content (the Document role, the Memory consumer,
  the route the write took): taken now, whatever cost the write its vector has passed — a blip that cleared, a child
  crash the re-check's own request reloaded, the tail of a router restart, a vector store that refused after a good
  embed (Lyntai sets no `Similarity` for any of them, and its routing policy retries nothing by default) — so the row is
  left UNINDEXED and the gated back-fill remembers it again. Refused again, THEN the tiny probe: unanswered, the embedder
  is down — unindexed as well; answered, the embedder refused THIS input twice while it takes others — past its window,
  above all — so the fact KEEPS its reference, graph-indexed without a vector as every vector-less write was before the
  bump, is never retried, and the log names it (「the embedder refused the content of fact N (kind/topic) twice…」). The
  first version sent the probe alone, and read ANY loss the probe outlived as a refused input — so one blip became one
  permanent loss, recoverable only by a destructive reindex and told to nobody. The version before it left every
  vector-less write unindexed, and on the real binary that was a regression: llama.cpp refused every fact past its
  512-token physical batch (launch item (7) under «The runtime the app PROVISIONS»), so a long fact was never indexed at
  all and every start re-remembered it at an annotation apiece. **The residual, stated:** an input refused only
  INTERMITTENTLY — refused at the write and again at the re-check while the probe is answered — is read as refused for
  good, and stays without a vector until a semantic reindex; and a vector store that refuses after a good embed EVERY
  time reads as passing, so its fact is retried by every back-fill, an annotation each (Lyntai itself calls a store
  refusal after a good embed "not foreseen", its `docs/task-archive.md` Part 304). **An UNCHANGED re-remember keeps its
  ref** (`RememberFactTool`): identical content dedups onto the node the row already names, with whatever vector it had,
  so an index attempt that failed during an outage no longer clears that ref and hands the fact to the back-fill for
  nothing — an edit still clears it (`KnowledgeStore.LearnAsync`).
  **A partial rebuild writes the layout marker.** `RebuildAsync` forgets the old graph and clears every ref BEFORE it
  re-indexes, so every entry it writes is at the current address and every fact it did not index is an empty ref the
  next start's back-fill finishes there: "the entries are at the current address" is true after the pass. For a round
  the step held the marker back until the count reached the fact TOTAL, which made every retry a whole DESTRUCTIVE
  rebuild — an annotation re-spent on every fact, and the decay and links accumulated since discarded again — for the few
  facts a back-fill would have finished. A partial pass warns 「事实索引的重建没有全部完成(建立了 N/M 条) ——
  其余的事实仍能按关键词找到,下次启动会补上。」 and writes the marker. ZERO writes none, because a zero is ambiguous:
  `RebuildAsync` degrades rather than throwing, so it returns 0 when every write stayed unindexed, when it failed before
  clearing the old refs (which would still address the old layout), AND when it threw after indexing some facts; the
  first costs nothing to hold (its empty refs send the next start down the back-fill path), the other two need a retry.
  Its sentence therefore names no count and promises no fill-in: 「事实索引的重建没有完成 —— 已有的事实仍能按关键词找到,
  下次启动会再试。」 — the next start rebuilds again where it finds refs, back-fills where it finds none, and does either
  only if the embedder answers its gate.
  **The probe stays, as a gate, by owner decision** — our quota, not a library gap. Without it nothing would be lost,
  but every bulk pass during an embedder outage would re-remember each pending fact, and each write still pays its
  annotation: Lyntai 3.5.0 made a graph write EMBED BEFORE IT ANNOTATES (3.4 annotated first), yet a write whose embed
  failed goes on to annotate unless `SkipAnnotationWithoutVector` is set, which stays off (below) — so with 判断 on the
  Claude CLI, each is an annotation call against the household's quota, for a fact that loses its vector again and is
  walked again by the next pass. It gates EVERY bulk path that re-remembers or re-embeds facts but
  one: `FactIndexStep`'s back-fill, re-embed and layout rebuild at startup, which keeps its household warning
  (「「语义」的嵌入模型这次启动没有响应…」); `DetachedFactBackfill`'s after a memory import or the startup seed, which skips
  with a log line; and the console's semantic REINDEX (`MemoryRecallController`), which answers 409 before touching
  anything, the layout marker included — 「「语义」的嵌入模型现在没有响应 —— 现在重建算不出任何向量,所以没有开始(已有的向量和
  索引都没有动)。等它恢复后再重建。」. Until the 3.5 bump that reindex was a destructive rebuild, so run during an outage it
  discarded the index, paid an annotation per fact and left every row for the next start to pay again; since it
  re-embeds in place a failed pass loses nothing, and what the gate spares is a pass that computes no vector and the
  back-fill after it, whose writes would lose their vector again, an annotation each. The CLI rephrasing arm's reindex embeds
  nothing and answers the probe as ready, so it runs as before. The ONE exception is a backup import's rebuild: its facts
  were replaced, so the old refs must go whatever the embedder says, and with it down each write stays unindexed for the
  startup back-fill — its annotation paid then and again later. It is a gate, not the detection: a probe can pass a
  moment before a write fails (D175 says so of the probe it deferred), which is what the per-write classifier is for.
  **It still restates the engine's embedding route** (Lyntai's filter — a backend producing vectors from text — is
  internal), so a filter change upstream could make the probe answer differently from a write: wrongly passing costs
  one pass's annotations, wrongly failing defers the indexing with the warning — and, in the classifier, reads an input
  refusal as an outage, so that fact is retried. **What ends the gate:** Lyntai `docs/task-archive.md` Part 310's item
  "Let a graph write skip its annotation when its vector fails" — closed there as Part 304,
  `GraphMemoryOptions.SkipAnnotationWithoutVector` (with the write embedding before it annotates), RELEASED in 3.5.0
  and left OFF by the 3.5 bump (2026-09-26). Set, it would make a retried write during an outage cost no annotation, so
  the quota reason would go. **But it cannot simply be switched on:** it skips the annotation of EVERY write owed a
  vector that got none — including one the classifier then KEEPS as a refused input and never retries, which would stay
  without subjects for good (it is an engine option, with no per-write override). So the option stays off and the gate
  stays, until the option can come with a pass that re-annotates the kept vector-less facts (not built). **The other
  way out was MEASURED and does not qualify** (`docs/judge-bench.md` Run 14, 2026-09-28, `GATHERLIGHT_EMBED_SEGMENTATION=d177`,
  off by default): Lyntai's input segmentation on `llamacpp-embed` does give an over-window fact a vector, but a pooled
  mean of ~6 mostly-filler pieces dilutes the one piece that carries the meaning (the capability check's paraphrase did
  not find its fact: cosine 0.237, rank 22 of 61, against 0.624 for that sentence alone), and the pooled notes crowd the
  page (short targets 15/0 and the cross-language set 12/0 against segmentation, both p < 0.001), so its rule failed on
  two of three clauses. Run 14 also measured what the gate protects today: **with 语义 on, a fact that has NO vector is
  pushed off the page** — 22 of 60 over-window targets on the page against 59 with 语义 off (37/0, p < 0.001) — which is
  the cost of every fact the embedder refuses, larger than this design assumed. The
  classifier keeps its probe either way — it answers a different question. The startup warning would then need another
  source — a start with nothing pending makes no write, so there is nothing to observe; `LlamaWarmStep` warns for a
  llama.cpp model that fails to warm, and nothing warns for the built-in embedder. **A write kept WITHOUT ITS SUBJECTS
  is logged, since the 3.5 bump.** Through 3.4 the shipped LLM annotator caught its own failures and returned
  `MemoryAnnotation.None`, which the engine counts as an answer, so `Lyntai.Memory.MemorySources.Annotation` was set for
  a signed-out CLI too and the app did not read it. 3.5.0 returns `MemoryAnnotation.Unanswered` for a refused or non-Ok
  call, an empty or unparseable reply and its own timeout (Lyntai `docs/task-archive.md` Part 303), logging the likeliest
  at Debug, below our file log. So `FactIndex.IndexAsync` now warns — 「fact index: kind/topic was stored without its
  subject handles…」 — when a write that KEEPS its reference lacks the flag: a real call that went unanswered, or a
  subject store that failed (Lyntai warns of that too). **Its volume:** one line per SINGLE write (`remember_fact`); a
  BULK pass (a back-fill, a rebuild) counts them and writes ONE line at its end with the count and three examples,
  because while the annotator fails every write of the pass loses its subjects the same way — a back-fill of N facts
  on a signed-out CLI used to be N Warnings of one cause. The text names the annotator neutrally ("the Claude CLI or a
  local chat model"), since a llama.cpp chat GGUF annotates too. Warning, because the same outcome from a THROWING annotator is a
  Warning in Lyntai's own engine and because nothing retries it (a write left unindexed is re-annotated by the back-fill
  and is not logged). With 判断 OFF, `SwitchableAnnotationPolicy` returns `None` without asking — answered, about
  nothing — so an "off" write sets the flag and logs nothing, which is right: nothing was asked. Proof, `e2e-p52`: the
  chat fake's unparseable annotation (case 1's write) is named in the log, and a write the stub CLI tags (case 4's, after
  the fallback) is not; the first confirmed to FAIL on a 3.4.0 build, where the flag was set for it.
  **Where a fact past the embedder's window stands:** indexed without a vector — graph-ranked, linked and reachable by
  its subjects, found by meaning only through its words. Lyntai 3.3's input segmentation on the embedding registration
  (D177: `MaxInputChars` on `llamacpp-embed`, the pieces embedded and pooled into one length-weighted mean vector) would
  give it one; that is an UNMEASURED option, not built. Proof, `e2e-p52` case 9, each confirmed to FAIL with its own half
  broken: a write that kept its vector is embedded once and never probed; a write whose CONTENT the fake refuses every
  time while it answers the probe keeps its ref, is named in the log and is not re-embedded at the next start (every
  vector-less write left unindexed); a content the fake refuses ONCE leaves an empty ref the next start back-fills (the
  single-probe rule, which kept it without a vector); a write while the fake refuses everything leaves an empty ref the
  next start re-indexes (the probe's answer ignored); an unchanged re-remember while it is down keeps its ref and is not
  re-embedded next start (the ref cleared as before); a memory import while it is down skips its back-fill and the next
  start indexes it (that gate removed); the embedder-down start re-remembers nothing (the startup gate removed); a
  semantic reindex then is refused and every ref kept (its probe removed); a rebuild the fake goes down during writes the
  marker, and the next start back-fills with every other node id kept (the total rule restored); and a rebuild that
  indexes nothing writes no marker, says so without a count, and the next start back-fills onto the zero pass's own
  nodes (the zero rule removed).
  **(4) CLOSED — `AgentRunner`'s once-per-run `SessionStarted` guard ↔ `docs/task-archive.md` Part 275, shipped
  in 3.3.0, adopted with the 3.4 bump (2026-09-26).** Lyntai 3.2's stream reader yielded a `SessionStarted` for
  EVERY `system` event carrying a session id, and claude 2.1.28x's `system/thinking_tokens` progress events carry
  one, so without the guard every tick of a thinking turn was a stored, invisible `system` row. 3.3.0's reader
  keeps the last id it announced (per reader, and the session builds a reader per turn) and yields one per id, so
  the bump DELETED the `sessionAnnounced` flag and its check; nothing else in the bridge depended on it. One
  difference, equivalent in practice: Lyntai still announces a genuinely DIFFERENT id, where the guard dropped any
  second `SessionStarted` — a claude run has one id. Proof: `e2e-p43` stays green against a stub that still emits
  those progress events (the stub bullet under *LLM / process spawning*), so it now fails if the upstream fix
  regresses rather than if our guard does.
  **(5) CLOSED — `reasoning = off` on every CHAT preset section ↔ Lyntai `docs/task-archive.md` Part 288 / D179,
  shipped in 3.3.0, adopted with the 3.4 bump (2026-09-26), verified on the real binary before the key went.** Both memory
  seams ask for no reasoning (`TextReasoning.Suppress`), and Lyntai 3.2.0's OpenAI-shaped payload never read the field —
  so against llama-server's default `--reasoning auto` a thinking-capable template thought on every verification and
  annotation (Qwen3-0.6B 1.3–7.5 s per verdict, Qwen3.5-0.8B past a 300 s timeout; `docs/judge-bench.md`, Run 5's screen),
  and the chat preset's `reasoning = off` (the router passes it to the child as `--reasoning off`) was what stopped it.
  NOT `reasoning-budget = 0`, which leaves the template thinking and puts the reasoning in the content. **D179 is
  CONFIGURED fields**: `HttpModelOptions.SuppressReasoningFields`, a JSON object Lyntai merges into a `chat/completions`
  body only when the call asks `Suppress` — the library ships NO default, so the bump turned nothing on by itself.
  **What the bump did, in the order this entry required**: (1) `LlamaCppSource.Register`'s chat registration moved to
  the options-action overload `AddLlamaProvider(id, o => …)` (it seeds `http://localhost:8080`, overridden, and leaves
  `Produces` at Text) and sets `SuppressReasoningFields = {"chat_template_kwargs":{"enable_thinking":false}}`
  (`LlamaCppSource.SuppressReasoningFields`); (2) each catalogued chat model — Qwen3-0.6B, Gemma 3 1B, Gemma 3 4B — was
  driven through the app's own write and recall on b10549 with the key REMOVED, behind a recording proxy
  (`docs/self-managed-llm-runtime.md`, 2026-09-26): every call carried the field and answered 200, with no
  `reasoning_content` and no `<think>`, 6–23 completion tokens (6–30 with the key kept), every write tagged and every
  verdict parsed but two of Gemma 3 1B's 28 (a stray quote the model wrote, with and without the field alike) — ARRIVALS
  asserted, because a refused field is a silent NoOpinion (below); and the rendered prompt is byte for byte the one the
  key rendered, for all three (Qwen3's pre-closed think block; Gemma's template ignores both). The same run's controls:
  with the key gone and the field stripped by the proxy, Qwen3 reasoned on every call (119–512 tokens, one reply cut at
  the cap), so the instrument could see thinking; with the key kept, today's behaviour, no reasoning either.
  (3) Only then was the key deleted from `LlamaServerRuntime.LaunchKeys` — p51 now asserts it ABSENT from every section,
  p52 that both seams' requests carry the field (and no embedding request does), and judge-bench's own preset copy lost
  it too, its `mirrorGuard` holding both halves to the product and its tag-seed build guarding the field on every
  annotation request instead of `--reasoning off` in the child's argv. Each confirmed to FAIL with its half reverted.
  **What the key covered and the field does not, both accepted**: a request that does not come through the memory seams
  — the app's own warm (`max_tokens: 1`) now opens a think block on Qwen3, one discarded token; and a template that
  decides thinking by some other variable than `enable_thinking` (a dropped-in model) is not reached by the field —
  the 512-token cap then makes it silent rather than slow (launch item (4)). **A server that REFUSES the field fails the
  call**: the router logs `Failed` at Information and the judge reads it as transient, so a refusal looks like no
  judge at all. llama-server b10549 accepts it. Since Lyntai 3.5.0 (its `docs/task-archive.md` Part 309) it is no longer
  QUIET: the first call carrying these fields that is answered with a 4xx the classifier leaves `Failed` logs ONE
  Warning per registration, naming the option and quoting the server. It needed nothing from us and stays at its
  default. It keys on the status, not the field, so ANY such 4xx fires it — an unrestarted or adopted router's
  `400 model not found` too — and the Warning then only suggests the field was refused; the quoted words say which.
  Proof, `e2e-p52` case 3c: the fake answers every chat call carrying the field with a 400 naming it, several calls are
  refused, and `state/logs` holds that Warning exactly once, quoting the fake — confirmed to FAIL on a 3.4.0 build (no
  Warning for 3 refused calls). The `n-predict` and `ctx-size` caps
  were never part of this workaround and stay: they are our own launch contract (`LlamaServerRuntime.ChatMaxTokens` —
  the memory seams send no `max_tokens`, and the router does not stop a child's generation when the app abandons a
  request; `LlamaServerRuntime.ChatContextTokens` — launch item (5)).
  **(6) KEPT — ours, by Run 10 under the owner's rule (2026-09-27) — `ChunkedScoreProvider` (with `RerankPace`) ↔ Lyntai
  `docs/task-archive.md` Part 287 / D177, with Part 289 closed into it, RELEASED in 3.3.0 (first read at Lyntai commit
  `e6fa579b`; nothing through 3.5.1 changed the segmentation described here) and adopted by neither the 3.4 nor the 3.5
  bump.** Lyntai
  3.2.0 had no way to score a document longer than a reranker's window except to send it whole (one over-window pair
  fails the WHOLE call) or cut it, and Run 6 measured the cut pushing a long note off the page; so the app scores each
  long candidate in windows and keeps its best (the reranker bullet below). D177 as released: a
  provider given `HttpModelOptions.MaxInputChars` SEGMENTS an over-long input (`InputSegmentation`) and scores a
  document as its best piece (MaxP), every piece in one request; on a Score registration that bound is the PAIR
  window, the query keeping at most (1 − `MinDocumentShare`, default 0.5) of it, cut ONCE per call at a word boundary;
  characters are counted after NFKC, per text element, while the ORIGINAL text is sent; `MaxPiecesPerInput` on
  `InputSegmentation` caps an input's pieces — the first, the last anchored at the tail, the rest spread evenly
  between; `Overlap` defaults to 0.15 and is configurable. It explicitly REJECTS a per-call cap and a latency budget as
  library policy — "fitting a call to a latency budget is a policy for the deployment that measured it". So D177 now
  does what our budget does under a declared window — and ours is query-aware ONLY there: for BGE and LAMAR, which
  declare none, `RerankInputCap.PerCandidate` is 1,000 characters whatever the query (the query itself is capped at
  2,045 characters counted after NFKC since 2026-09-25, half the 4,096-token batch). **What remains ours**: consecutive windows overlap by
  AT LEAST a quarter (settable in D177 as an `Overlap` of 0.25, where it is an upper bound — the next piece restarts at
  the earliest sentence end or space inside it, else where the last one ended); under a declared window we SEND the
  NFKC text, where D177 counts NFKC and sends the original (the tokenizer normalises either way — identical token ids
  but for 95 scalars newer than the model's table); and the call sized by TIME (`RerankPace`). **D177 through 3.4.0
  could not carry `RerankPace`**: its piece cap was fixed at registration, so no decorator could vary a call's pieces per
  request, and deleting `ChunkedScoreProvider` deleted the pace — and the skip with it, since `RerankAdmission` reads
  the provider's one-window shape and sends its probe. (The skip itself needs nothing on any Lyntai bump: it is decided above the scoring
  policy and hands Lyntai no verdict — see the pace paragraph under the reranker bullet.) Two items of Lyntai
  `docs/task-archive.md` Part 310 — our upgrade's findings — bear on this, both RELEASED in 3.5.0: Part 305's
  `ScoreRequest.MaxPiecesPerInput` narrows the registration's cap for one call, so a decorator can now size a D177 call
  by the pace without segmenting it itself; Part 306's `InputSegmentation.MaxDocumentPiece` bounds a document's pieces
  apart from the query, which can express our rule for a model declaring no window (read only where a window is set,
  so it needs `MaxInputChars` set generously beside it). What such a decorator still cannot see is what was SENT — D177
  counts no pieces for its caller and the HTTP reranker returns no usage — so its pace would learn from a bound, not a
  count. **Run 10 settled it: KEEP OURS** (`docs/judge-bench.md` Run 10, 2026-09-27, Lyntai 3.5.1, one GPU). The
  owner's rule, fixed before the runs: switch only if, for the recommended BGE, D177 is significantly BETTER on the long
  fixture's found@8, AND no reranker is significantly worse under D177 at any position or on the mixed fixture's
  short-target questions, AND short facts are byte-identical; otherwise keep ours — switching also costs the pace its
  precision. D177 ran configured as close to ours as 3.5.1 allows (the `d177` knob mode, under the reranker bullet), each
  reranker paired with ours within its own run on the long, mixed and short fixtures. **For BGE on long notes D177 was
  significantly WORSE**, not better — found@8 201 → 171 (31/1, p < 0.001), and worse at every one of the four positions —
  so the rule's first clause failed and its second blocked; LAMAR could not tell the two apart on either fixture; short
  facts were byte-identical for all three rerankers, bodies included. **What drove BGE's loss is a co-recall link
  dynamic, not the segmenter** (post hoc, descriptive): 26 of its 31 losses are Japanese-worded questions whose pages held
  only the fixture's four Japanese notes, because D177's arm never built the links that open those questions up and ours
  did by mid-run — a recall-reinforcement effect (measuring rule 2), which on the mixed fixture ran the other way.
  Outside that set the two differ 5/1. So the rule's result stands, and what it says is narrower than its size: D177 is
  not better for BGE. **mMiniLMv2 did significantly BETTER under D177** — outside the rule, which reads BGE and only
  blocks: long 182 → 196 (10/24, p = 0.024), mixed 184 → 198 (1/15, p < 0.001), concentrated where the answer is past the
  first window, and not the Japanese-set dynamic. The likely reason, stated and untested, is D177's SENTENCE-BOUNDARY
  piece placement, which splits an answer sentence less often than our fixed-position windows in mMiniLMv2's
  250–500-character budget. That is a finding about placement, separable from the pace, so **the follow-up worth
  measuring is boundary-cut windows INSIDE ours**, not a switch. Nothing in the product changed: `ChunkedScoreProvider`,
  `RerankPace` and `RerankAdmission` stay, and `d177` stays a measurement mode, never a default. **What would reopen
  it**: a within-run measurement under the same rule in which D177 is significantly better for BGE — worth running only
  once D177 can also carry a pace that learns from what was SENT (it reports no piece count, and the HTTP reranker no
  usage, so a pace over 3.5.0's per-request `MaxPiecesPerInput` would learn from bounds up to ~2× apart), since a D177
  with no pace has no skip, and Run 8 measured what BGE does on a CPU without one — or the owner changing the rule.
  **Both halves are recorded, and Lyntai's is now stale**: Part 289's outcome names "an app-side segmenting
  score-provider decorator" as the adopter's copy to remove when D177 releases — by its role, not its class name, as a
  library that names no adopter must. It has released and we kept the copy, so the answer — kept, why, and Run 10 — is
  owed to Lyntai's `TASKS.md` (we are review-only there), or the next reader of that outcome deletes a decorator a
  measurement kept. Lyntai's `docs/memory-measurements.md` records our Run 6c as `rerank-segmented-adopter-long-notes`.
- **SUBJECT HANDLES ARE SEARCHABLE, and they were bought long before they were.** With 判断 on, every write
  is annotated and its subjects — stable handles naming what the fact is ABOUT, "配偶", "deploy-key" — are
  recorded. Two things read them, both at WRITE time: linking two facts, and prompting the annotator to
  reuse a handle. **No recall path touched them**, so a household asking "配偶" got nothing from a fact whose
  text says 太太, while a handle saying exactly that sat in the store, paid for by a model call they had
  already made. Same shape as an embedding bought on every write and read by no recall — a cost with no
  matching benefit, invisible from every API response. **Since Lyntai 3.1 the ENGINE closes it**: the
  subject channel (`SubjectSeedSource`, registered by `AddMemoryEngine`) seeds a recall from handles the
  query names — substring for a spaceless script, word boundary for a spaced one — and ranks those candidates
  with every other, so a subject hit carries a REAL retrievability and degree. It was first closed APP-side,
  by an append after the graph's answer that could measure neither number and therefore reported
  `matched:"subject"` with retrievability omitted rather than a false `0.0`; that append was deleted in the
  3.2 upgrade, as its own note instructed. The handles are still NOT put into the FTS text, where a generic
  handle would compete for bm25 against the fact's own words. Proof lives in `e2e-p48`, whose handles appear
  in no fact's text (so only the subject channel can find the fact) and which asserts the hit is an ordinary
  RANKED one — a returning `matched:"subject"` would mean the app-side copy came back. **The stub taught the
  same lesson twice**: its annotation branch must read only the text after
  the last `Fact:`, because Lyntai composes the prompt as [known subjects] + [earlier facts] + the write, so
  a whole-prompt scan hands every handle to every write. That is the p28 cross-fire exactly, one call site
  over, and it was caught by the selectivity assertion rather than in production.
- **Recall quality is THREE INDEPENDENT SWITCHES, and where each one's config lives is decided by WHEN it
  is read.** *Formula* (graph decay + rank fusion + FTS trigram) is the floor: always on, no setup, no
  cost. *Claude CLI* adds annotation per write and verification per recall — and costs a model call for
  each, measured at 4 for 3 writes + 1 recall. *Local model* adds real semantic vectors from a runtime this app
  PROVISIONS — llama.cpp's `llama-server`, or the in-process ONNX embedder (`builtin`). It said
  "a LOCAL Ollama" until 2026-08-23, months after Ollama stopped being a backend at all: disk and
  local compute, no tokens, and nothing leaves the machine. They are independent rather
  than tiered because they are complements — verification acts on what was retrieved (Lyntai's `ApplyVerdict`
  promotes the endorsed candidates ahead of the rest before the cut, keeping the engine's order within each
  group, and reinforcement then follows the endorsed set — see the recall-layers table), while the semantic layer
  changes what is RETRIEVABLE AT ALL — so a household must be able to drop the token cost without losing local semantics.
  The enrichment was adopted wholesale with Lyntai 3.0 and spent that per-operation cost for months with
  no way to decline it; the default stays ON (turning it off by default would silently degrade recall on
  upgrade) but declining is now a setting. **It is an `app_config` value read per call, not a
  registration** — `ServerConfig` reserves `settings.json` for "what must exist before the DB opens", its
  model already lived in `app_config` (then cortex's `llm.model.memory`; since the 3.4 bump the live route
  `llm.route.memory`, written by 记忆检索's bind — cortex no longer has the row), and splitting one feature's
  controls across two stores also made it need a restart. The decorators that make it live are registered BEFORE
  `AddMemoryAnnotation`/`AddMemoryVerification`, whose `TryAddSingleton` then stands down — the BYO seam
  those registrations document — and "off" returns the library's own `MemoryAnnotation.None` /
  `MemoryVerification.NoOpinion`, which the engine STORES exactly as it would with no policy registered — what makes
  runtime flipping safe. It does not REPORT them the same way since Lyntai 3.5: an "off" write sets `Annotation` in its
  `Ran` — `None` is an answer, about nothing — where no policy would not, which is right (nothing was asked, and it
  keeps `FactIndex`'s unanswered-annotation warning for a real call), so "off" and "no policy" are equal in the store,
  not in `Ran`. **NoOpinion, never `NothingRelevant`**: the latter asserts every recall
  found nothing useful and teaches the engine exactly the wrong thing. The LOCAL MODEL is the honest
  exception and stays in `settings.json`: the embedder, vector store and engine member are consumed at DI
  REGISTRATION time, before the container — and therefore the DB — exists, the same reason `security.*`
  lives there. **A consumer routed in `DefaultModelByConsumer` must be settable SOMEWHERE the household can
  reach** — otherwise its model is routable in principle and unreachable in practice, which `memory` was for
  a while, with a comment promising a live override the product gave no way to set. Cortex's `ModelCatalog`
  is the default home and the right one for `chat`/`extract`/`scorer`/`validate`. **`memory` is the exception and is
  deliberately absent from it**: 记忆检索 binds the judge's model together with its BACKEND, and a cortex row
  beside that was a SECOND writer of one value — the one that won. A household who set 记忆判断 to `haiku`
  there and later moved the judge to a local model had the router asking the Ollama provider for a model
  called `haiku`; both memory policies are fail-open, so the symptom was zero model calls and no error at
  all. Two controls for one value is worse than one control in an unexpected place. Proof lives in
  `e2e-p51`, which asserts the cortex row is GONE as well as that the binding writes the key.
  **`validate` was the inverse defect — read but settable NOWHERE, not routed twice.**
  `ClaudeValidateService` fed `llm.model.validate` to `ClaudeAgentOptions.Model` beside a comment claiming "a
  cheaper model suffices", but the key was in no settable place (not `ModelCatalog`, not
  `DefaultModelByConsumer`), so the comment's cheaper model was unreachable and the pass always ran on the
  CLI default. It is a cortex row now, default `null` (today's behaviour, unchanged — a cheaper default is
  an unmeasured cost/quality call nobody has made), and the comment in `ClaudeValidateService.cs` stopped
  claiming a model it did not use. `validate` needs no `memory`-style exclusion: nothing else writes
  `llm.model.validate`, so a cortex row is not a second writer of anything. Proof lives in `e2e-p16`
  (listed + settable + round-trips) and `e2e-p14` (a bundle carrying `llm.model.validate` imports it, now
  that `validate` is tunable and travels in the bundle — it stays a plain `llm.model.` key under the live routes,
  like `chat`/`extract`: workaround (2) under the Lyntai list). **The key-to-ARGV step is asserted too**, by a
  real validate pass in `e2e-p16` (cases V1/V2). It was a stated gap for a round: the pass runs only when the
  diff at the gate touches `.claude/`, and every suite with files there PLANTED them on disk rather than
  writing them through a turn, so no suite ever reached one. `KBEDITTEST` makes the stub's execute turn
  write a skill file, the stub answers the validation prompt with `VALIDATION_OK` and echoes the model it
  was handed, and its args log (`GATHERLIGHT_STUB_ARGS_LOG`) classifies each spawn by PromptHarness's phase
  header — the assertion has to name WHICH spawn, because with `validate=haiku` the scorers and the memory
  judge also run on haiku. V1 sets `validate=haiku` with `chat=opus`: the validation spawn gets `--model
  haiku` while plan and execute get `--model opus` (the positive control). V2 clears the row: no `--model`
  at all, not the chat row's value. Confirmed non-vacuous by expecting a wrong value in each case (the model
  not passed in V1, chat's in V2): both fail.
- **Meaning-based fact recall is a GRAPH OPTION and ONE SCOPE — not a second engine member.** Both halves
  were got wrong first, both failed silently, and neither was visible from any API response, so the
  reasoning is on the record. (1) With an embedder + vector store registered, `UseGraph()` already embeds
  every write — for novelty judgement and for linking entries whose text never overlaps — but a recall
  consults those vectors only through a semantic seed channel, which ships OFF. So the embedding was bought
  on every write and consulted on no recall. Through 3.0.2 that channel was `GraphMemoryOptions.SemanticSeedK`;
  **Lyntai 3.2 made it a registered seed SOURCE** (`AddMemorySemanticSeeds`), whose constructor needs a
  vector backend and a vector store — so the embedder arms add it themselves, beside what it reads
  (`VectorRecallWiring`), and the Claude CLI arm, which registers neither, never does. `e2e-p52` proves it
  by ROUTING — a recall sends its query to the embedder — and was confirmed to FAIL with the registration
  removed (the only request that recall made was the judge's). Adding a
  `UseSemantic()` member instead looks equivalent and is not: a composite ROUTES a write to the first
  member supporting the grade, so that member's store stays empty unless something fills it — and once
  filled, its hits carry `facts/semantic#<contentHash>` while every `knowledge` row stores the graph's
  `facts/graph#<id>`, and resolution is an exact ref match in `ByGraphRefsAsync`. A second embedding per
  fact, bought and then discarded on the way out. (2) Scope is keyed into the vector collection name
  (`{member}|{task}|{scope}`), so putting the fact's `kind` there — which reads like its natural home —
  splits the vectors per kind, and a recall naming NO kind searches `facts/graph|facts|`, which is empty.
  That is the default `recall_facts` call. Kind never did the filtering anyway: `ByGraphRefsAsync` applies
  it in SQL when resolving refs to rows, which is why `RankAsync` over-asks harder when a kind is given
  (the narrowing now happens after the ranking, not before it). Measured 2026-08-21 on a fixture of 8
  facts: before, 12 vectors for 6 facts and paraphrase queries answering **nothing**; after (1), scoped
  3/3 improved and unscoped 0/3; after (2), unscoped 3/3 and one embedding per fact. **Do not adopt 3.0.1's
  `FanOutWrites()` here** — fan-out propagates a member's write failure, so a stopped Ollama would fail
  `RememberAsync`, `IndexAsync` would null the row's `graph_ref`, and every new fact would silently lose
  GRAPH recall too. (Since the Lyntai 3.4 bump `IndexAsync` chooses that outcome on purpose for ONE case, and says
  so in a log line: a write that kept no vector is left unindexed when its content embeds on a second try or the
  embedder does not answer at all — keyword-only until the next back-fill gives it its vector — and keeps its ref when
  its content is refused again while the embedder answers. Workaround (3) in the Lyntai list.) **3.0.2 fixes
  (2) upstream — the graph's semantic half now spans scopes on a null-scope recall — and one scope stays anyway**: spanning rests on the OPTIONAL `IListableVectorStore`, so a store
  without it yields nothing on the DEFAULT recall, silently, which is the failure class this bullet exists
  to record; and it searches one collection per kind for the same vectors. Note also what one scope did NOT
  buy: cross-kind LINKING already worked, because the graph's lexical recall spans scopes when the query
  names none. Because scope addresses the graph, moving it strands existing entries at the old
  address — reachable only by a rebuild — so `FactIndexStep` carries a **layout marker** (`facts.index.layout`)
  and pays a one-off `RebuildAsync` on upgrade, writing the marker LAST so a crash mid-rebuild retries
  instead of settling into the silent FTS fallback. **Layout 3 is a move WE did not make**: Lyntai 3.2 changed
  the vector collection address (U+001F separator) and orphans vectors under the old one — its changelog says
  "a deployment re-indexes", and `IVectorStore` has no way to read a vector back out to move it. Only the
  VECTORS moved, so 2 → 3 touches the graph only where an embedder is wired (`IFactIndex.Embeds`) — and since the
  Lyntai 3.5 bump it re-embeds the entries IN PLACE there rather than rebuilding them (D194; the old-address
  collection is left unread, swept only by a rebuild); an install without one keeps its graph, decay and links. `e2e-p48` case 8 asserts the kept node ids and was confirmed to FAIL
  with the rebuild forced; the embedder branch is not drivable there (no local model) — a stated gap. Proof lives in `e2e-p48`, which asserts the ONE SCOPE
  against the store (no API response shows it, and the suite runs without an embedder so it cannot see
  vectors at all) and was confirmed to FAIL against kind-as-scope. **Lyntai 3.0.2 added a wiring finding for
  (1)** — an embedder + vector store with no semantic seed channel is logged at Warning when the engine
  factory is built (in 3.2: "no IMemorySeedSource declaring MemorySeedKind.Semantic") — so a regression that
  re-buys the embedding and reads none of it announces itself instead of showing up as "recall feels no
  different". Verified both ways again on 2026-09-23 under 3.2: silent on the current wiring, firing in
  `p52`'s negative control.
- **"Worse" and "costly" are reasons to DESCRIBE an option, not to remove it — and "cannot" has to mean
  cannot.** This was violated twice in one session, both times by reasoning that sounded like engineering
  judgement and was actually a decision taken away from the household.
  **(1) 语义 had no Claude arm** and the panel explained why: "Claude ships no embeddings endpoint, so this
  layer cannot have it." The first clause is true; the conclusion was not. The layer was defined as
  embeddings BY US, so the missing class was a consequence of our definition, not a limit of Claude's — and
  the effect was that a machine which cannot run a local model (no GPU to spare, a GPU wanted for something
  else, a household declining a 222 MB download) was offered NOTHING for that layer, with a paragraph where
  a choice belonged. "No class implements the interface" is circular whenever we wrote the interface.
  `ClaudeCliSemanticSource` now serves the layer's actual job — a paraphrase finds the fact — by storing
  rephrasings instead of vectors. It is genuinely worse than an embedder for wording nobody anticipated, and
  that sentence is in its description rather than in a refusal.
  **(2) A capability was deleted for tidiness.** 资源 was scoped to "only what Gatherlight provisions" —
  a decision about what a PANEL SHOWS — and that got carried through into removing the model pull/delete
  verbs and their endpoints, justified as "an unused management verb is an invitation to the next caller".
  Code hygiene does not outrank what the household can do. It cost the free-form field whose own docstring
  recorded why it existed: *a catalogue baked into a release cannot contain a model published after it.*
  The same code was later removed AGAIN, correctly, when that runtime stopped being a backend at all and
  the app no longer depended on it. **Two removals of the same code, one wrong and one right; the
  difference is whether the DEPENDENCY went with it, not how tidy the interface looked.**
  **The test:** if the honest sentence is "it does this less well" or "this costs more", ship the option with
  that sentence attached and let the household weigh it. A DECLINED entry saying "cannot" is only for a real
  impossibility — never for an option nobody built. **The example this sentence used to give went false on
  2026-09-23**: "内置 on 判断 needs an in-process chat model, which does not exist". A reranker verifies without
  chatting, and Lyntai 3.2.0 shipped an in-process ONNX cross-encoder (`AddOnnxProvider` producing scores, its
  D157), so 内置 on 判断 is now exactly an option nobody built — with tagging on the CLI, like the llama.cpp
  reranker. It was not built for a measured reason: that path read WordPiece tokenizers only, so the one model
  proven through it, ms-marco-MiniLM-L6-v2, is English-only (+3.0 of 9.5 on Lyntai's English LoCoMo, 2026-09-15,
  base 83.0%, and −5.4 on multi-hop), while the multilingual rerankers need SentencePiece and run on llama.cpp
  (`docs/superpowers/specs/2026-09-23-reranker-judge-and-verdict-bench-design.md` §Constraints). **That reason went
  false too, three days later**: Lyntai 3.5.0's ONNX provider reads SentencePiece from a model's `tokenizer.json`, and
  Lyntai's own model notes record the multilingual `mmarco-mMiniLMv2` reranker — the one we catalogue for llama.cpp —
  running end to end through it (its D191, 2026-09-26). So the gap is now wholly ours: the option is not BUILT (it needs
  `Lyntai.Providers.Onnx`, an ONNX export, a catalogue row) and not MEASURED against llama.cpp's mMiniLMv2, and the
  owner decided on 2026-09-26 to build it in a later round. Until then it stayed unbindable, its declined reason saying
  "not built yet, not yet measured against llama.cpp's mMiniLMv2, use llama.cpp meanwhile" rather than "cannot" — the
  honest sentence for a gap that was ours. Twice a stated reason for an unbuilt option was overtaken by the library
  while the option stayed unbuilt; a reason names what it rests on so the next release can be checked against it.
  **Round 6 built it** (`BuiltInJudgeSource`, 2026-09-28): the model repository's own qint8 ONNX export — the one D191
  was verified with — scored in process by `InProcessReranker` over `Lyntai.Providers.Onnx`, behind the SAME chain as
  llama.cpp's reranker (`RerankVerification`, see the reranker bullets). That emptied `MemorySources.JudgeDeclined`; the
  declined shape stays for the next real impossibility. And it shows the rule's second half: **built is not measured**.
  It is the same checkpoint as llama.cpp's mMiniLMv2 in another quantisation, tokenizer and runtime, so its quality was a
  claim until `docs/judge-bench.md` Run 13 paired the two — and until then it was BINDABLE (after the screen), DESCRIBED
  as unmeasured in its row, cost line, toast and group sentence, and RECOMMENDED nowhere (an installed copy did not even
  end the suggestion of a measured reranker). **Run 13 measured it** (2026-09-28; the recall-layers table has the
  figures): as good as llama.cpp's mMiniLMv2, and on a CPU much faster than llama.cpp there — so by the owner's
  registered rule it is offered and RECOMMENDED where there is no usable GPU, every "unmeasured" sentence went, and the
  exclusion went with them: an installed 内置 is a measured reranker like any other (`ModelsController.Recommend`).
  Proof: `e2e-p56` (the binding, the texts), `e2e-p51` (the no-GPU recommendation), `e2e-p52` case 6h (skips) and
  `e2e-p53` (BGE measured too slow).
  A model row saying "you do not need this" is the same error in miniature: state the trade-off, and say
  when it is unmeasured. And a removed capability needs a test asserting the household can still do it —
  both removals above passed every check, because nothing asserted the ability existed (`p51` now does).
  **Measured WORSE is still described — and never recommended** (2026-09-24). `docs/judge-bench.md` Run 3
  measured Gemma 3 1B as a local chat 判断 significantly worse than no judge (top-1 79 → 33 of 240, found@8
  125 → 111; 语义 off, content-only input). Run 11 (Lyntai 3.5.1, 2026-09-27): still worse on top-1 (80 → 36), no
  longer on found@8 (127 → 123, p = 0.424) — so every sentence about it now says worse at ranking FIRST (the note,
  and the 判断 group sentence's 「在排第一这一项上比不开判断更差」), and none says both metrics; still never recommended,
  because 18.3 points fewer answers first is not a model to point a household at. It was `GgufCatalog.RecommendedJudge`: 推荐 in its name,
  「判断质量没有单独实测过」 in its note, the model 资源's 推荐 badge moved to and the download the 判断 row
  suggested — four claims, all false once it was measured. It stays selectable with the result and its
  configuration in its note; the constant is retired, and 判断's local default (badge and suggestion) is
  `GgufCatalog.RecommendedReranker`, the local judge that measured better. The badge's fallbacks ("any
  embedder", then "whatever is smallest") went too: past the three recommended ids the smallest row left is a
  model nobody chose to recommend, so nothing is. The 判断 group sentence says what the measured chat models
  did and that the others were not measured, rather than "not measured per model". `p51` asserts the name, the
  note, the badge and the suggestion; `p52` case 5 the group sentence — each confirmed to FAIL on the code
  before. **Measured BETTER is offered — and still not recommended when the owner says so** (2026-09-24, Run 5b):
  Qwen3 0.6B is the first chat judge significantly better than no judge on both metrics (top-1 79 → 110, found@8
  125 → 148; Run 11 on Lyntai 3.5.1: 80 → 107, 127 → 152), and it is catalogued with those figures, its
  configuration and what its OWN tagging measured in its note (Run 7: not significantly different from Claude's
  tags, not equivalent either, and collapsing unrelated facts — it said "unmeasured" until then).
  `RecommendedReranker` stays the default, because the reranker puts the answer on the page far more often
  (208 against 152 in the same run, Run 11; 203 against 148 in Run 5b); the badge never names a chat judge, and one on
  disk does not stop the reranker suggestion (`p51`).

- **VOCABULARY, because this area had none and the gap cost a whole design conversation.** FOUR words, and
  they are not interchangeable. A **LAYER** is a job (公式 · 判断 · 语义). A **BACKEND** is *where the model
  comes from* — `claude-cli` · `llama-cpp` · `builtin` (`MemoryBackends`). `ollama` and `openai-compat`
  were backends until 2026-08-22 and are now RETIRED ids: `IsRetired` refuses a binding to either and the
  layer says what to pick instead, because the two silent alternatives were moving 判断 onto account
  quota and switching 语义 off. A **GROUP** is one of the three answers the picker offers — `cli` ·
  `managed` · `none` — keyed on what it COSTS, and `none` deliberately holds no backends: choosing it
  turns the layer off, which is a real answer to "where does the model come from" and used to be a
  separate button. **Their display names are 本机模型 and 不用模型, and both were wrong before 2026-08-22
  in ways that cost a household a real option.** `managed` was called **llama.cpp** — after ONE of its two
  runtimes; the other is an ONNX session in our own process using no part of llama.cpp. `none` was called
  **内置**, which is simultaneously the id and 资源 label of that in-process embedder. So the picker told a
  Claude-CLI household that real vectors meant downloading and running another program (wrong: 内置 is
  222 MB of weights in this process), while the word for that very thing meant "switch the layer off" one
  panel over. A group is named for what it COSTS, never after a member; and one word gets one meaning.
  `p51` pins both. A **MODEL** is
  what a backend serves. An **ORIGIN** is *whose runtime it is* — `bundled` (in our process) · `app` (we
  downloaded and start it) · `household` (they run it, we only connect) — `RuntimeOrigin`, resolved PER
  INSTALL because for `claude-cli` the app provisions a copy AND a household may have their own, so only
  `Locate()` knows which won — it is the last backend where that question is live, which is why `p51` cannot
  drive the `app` branch (its stub override outranks a planted file) and `p50` case F asserts it instead,
  claudeless and against a real download. It was briefly recorded as an uncovered gap, which was one
  assumption too many: the override does not make the branch unreachable, it just means the fixture has to
  be one that never stubs the CLI. **That fourth word was missing and its absence cost the second
  design conversation**: the picker said only 本机 · Ollama, "your Ollama", while 资源 had been downloading
  and starting it since 2026-08-21 — so a provisioned runtime read as a manual prerequisite, to a household
  and then to us, and a false claim ("语义 is the only layer you cannot switch on without installing a
  separate program") shipped in the panel, the resource row and the release notes on the strength of it. **Every layer lists every backend**, and one it cannot use carries its reason
  instead of being omitted — omitting it answers "why isn't this an option?" only in the source tree.
  **`ollama` and `openai-compat` are RETIRED ids — past tense throughout.** This passage used to argue in
  the present tense that "Ollama keeps its own backend because the app can enumerate it", then that it does
  not manage it, then that it is not a backend at all — three positions in four lines, written as the
  decision moved and never reconciled. What holds now: `MemoryBackends.IsRetired` covers both, binding
  either returns 400, and the layer names what to pick instead.
  Why each went. **Ollama** was retired in steps, and the middle step is the instructive one: we stopped
  installing it, then stopped managing its models, and finally stopped connecting to it — leaving, in
  between, a 记忆检索 that offered a daemon's models while nothing anywhere could add or remove one. Half
  -managing someone else's runtime has no consistent version. **`openai-compat`** was the one path never
  tested end to end: every case in `p51` was a denial or an address round-trip against a port with nothing
  listening, and nothing ever listed models from a live endpoint, embedded through it, or answered a
  judgement through it.
  Worth keeping from the old text, because it is a design rule rather than a status: `openai-compat` was
  ONE class for the whole OpenAI-compatible family (llama-server · LM Studio · vLLM · Jan · LocalAI), not
  one per product, for the same reason `EmbeddingCatalog` is not a gate — a list of products goes stale the
  moment somebody ships a new runtime.
  `p49` asserts the absent spec against the present `llama-cpp` one, and `p51` asserts that binding a
  retired id is REFUSED (400) rather than silently redirected — the fallback would have moved 判断 onto
  account quota nobody chose and switched 语义 off, both invisibly.
  The docs previously described this one axis three ways — "the local model", "the judge's *transport*", "the
  embedder" — and named it never, so every discussion of it had to invent a term. **The trap in that
  invention:** 嵌入 already means *embedding* here (`EmbeddingCatalog`, 嵌入模型, the 嵌入 badge), so
  "embedded"/"嵌入式" for a bundled runtime collides with it head-on and a sentence like "cli/local for the
  judge and embedded for 语义" parses correctly under BOTH readings. Hence **`builtin` · 内置**, which cannot
  be confused with 嵌入. Say backend, not transport; say built-in, not embedded.
- **The runtime the app PROVISIONS is llama.cpp's `llama-server`, not Ollama** (decided, measured and
  accepted 2026-08-22 — `docs/self-managed-llm-runtime.md` carries the numbers, the eliminated alternatives
  and what only running it revealed). Ollama is not gone: it stays a **household** origin, detected and
  connected to but never installed by us, because plenty of households run their own. `llama-cpp` is 35 MB
  against Ollama's 1460, matches its retrieval (9/10 top-1 on the `EmbeddingCatalog` fixture) and beats its
  latency (25 ms/query through the app against 69). Seven things about it are load-bearing and all seven
  fail SILENTLY, which is why they are here and not only in the doc:
  **(1) `--n-gpu-layers` is launch CONTRACT.** Absent it, llama-server runs on the CPU and logs nothing —
  222 ms/query against 7 ms, on the path of every recall. It goes into a generated per-model preset, which
  is the form whose effect was verified in the child's own argv. **`p51` now asserts the generated preset
  rather than trusting the comment** — the only mention of it in the suite used to be a comment citing a
  manual measurement, which is a contract enforced by remembering. It is drivable with llama.cpp absent
  because `WritePresets` runs BEFORE the spawn: a stub binary that merely exists clears the executable
  check, the spawn then fails, and the preset is on disk regardless (the trick `p50` case F uses). Both
  halves were confirmed to FAIL when broken — the missing flag, and `embeddings = true` written onto every
  model instead of only embedders.
  **(2) Models load LAZILY**, so starting means start-and-WARM. `--models-max` is a cap, not a preload; the
  first request for a model spawns a child and waits (17.3 s for a 1B q4). Returning when the router answers
  hands back a runtime that stalls on the first real recall — the very cost this runtime was chosen to remove.
  **`p51` pins it, and needed no spawn either**: the start endpoint warms the BOUND models the router reports,
  so a fake router, with 语义 and 判断 bound through the real bind endpoint, receives one warm call per bound
  model. It asserts they are DIFFERENT requests — `/v1/embeddings` for an embedder, `/v1/chat/completions` for a
  chat model, and `/v1/rerank` for a reranker, which takes a second binding because 判断 holds one or the other —
  because `embeddings = true` restricts that child to one API and the wrong warm call fails against a real
  llama-server.
  **The first version of that test was vacuous and this is the useful part**: it asserted the endpoint's own
  `warmed` list, which still came back complete with the warm call deleted, because the endpoint builds it
  from the models it probed. A field reporting that work happened is not evidence the work happened. It now
  counts the requests that arrived at the fake server, and fails with `requests:[] reported:[both]` — which
  is the shape of every self-reported metric in this codebase, one level down.
  **It warms what is BOUND, never more than the router holds.** Two fixes, one inside the other. The real router
  also lists the machine's llama.cpp/HF cache, and warming everything it listed loaded unrelated models and
  evicted ours — so the button was narrowed to OUR models (`InstalledGgufIds`). That still warmed every GGUF of
  ours, and with three on disk and `--models-max` 2 it loaded them in turn and could evict the bound judge or
  embedder with an unbound one of our own. It now warms `MemorySources.BoundToLlamaCpp`: the set `LlamaWarmStep`
  reads, through the resolvers the DI wiring uses, one model per layer at most — so never more than the router
  holds, and ours by construction, since a llama.cpp binding resolves only while its file is in the app's folder.
  Nothing bound means the router starts and loads nothing. A bound model the router does NOT list is reported
  (`notWarmed`, and a `note` the console toasts as a warning), never restarted in: that restart is a bind's
  decision, and the start button is not a bind (the startup step still goes through `EnsureServesAsync`, as a bind
  does). **Its cure depends on WHOSE router it is** (`LlamaServerState.Ours`): a service restart ends only ours, and
  an adopted one — an orphan of a crash, or the household's own on our port — is adopted again, so 「重启服务」 there
  was a restart for nothing; that case says the runtime's own not-ours clause (`LlamaServerRuntime.NotOursRemedy`,
  one writer with `EnsureServesAsync`'s refusal). `p51` asserts an unbound GGUF of ours the router lists is not
  warmed (confirmed to FAIL against the old button, which sent it `/v1/rerank`), that the unplanted cache model is
  not either, that an unlisted bound model on its ADOPTED fake is reported with the not-ours cure and never
  「重启服务」 (which the first version said, and asserted), and that a router going silent right after the start is
  a 409 in the probe's words rather than a 200 reading 「已在运行」.
  **(3) `embeddings = true` RESTRICTS a child to embeddings** — and `reranking = true` restricts one to
  `/v1/rerank` — so each goes only on its own kind, and what a GGUF IS has exactly ONE writer,
  `ResourceProvisioner.GgufKind`: chat, embedding or reranking (`GgufCapability`). Exact for what we provision
  (the catalogue row's `Capability`), a *stated* name heuristic for a GGUF the household dropped in — and the
  heuristic checks "rerank" BEFORE "embed", because a reranker's name is the more specific of the two. It
  replaced a yes/no embedder test the day a third kind arrived: a boolean has no answer for "reranker", so every
  caller would have grown its own. It briefly had two copies of a substring test in two files, which is the
  drift this file keeps paying for.
  **(4) A CHAT section launches with `n-predict = 512`** (2026-09-24), and nothing else does — and with NO `reasoning`
  key since 2026-09-26: `reasoning = off` sat beside it as workaround (5) in the Lyntai list above, and thinking is now
  turned off by the REQUEST (`chat_template_kwargs.enable_thinking = false`, Lyntai D179). Without the cap a small
  model's runaway fills its whole context, silently — Run 5's screen saw gemma-3-270m reach 31,073 tokens in 154 s. 512 holds every legitimate reply measured on the small models' own tokenizers (a
  whole page's verdict 19 tokens, four subject handles ≤ 26, a verdict naming all 96 candidates a recall at the
  DEFAULT limit of 8 shows the judge 282) and cuts only a verdict endorsing ~170+ candidates, which Lyntai calls the
  judge's failure signal and which then parses as NoOpinion. How many the judge is shown depends on the LIMIT as well
  as the kind: 4× what `FactIndex.RankAsync` asks for, min(3 × limit, 100) with no kind and 100 with one — so 400 on
  a recall naming a kind or asking for 34 or more, and past ~170 from a kind-less limit of 15. On the real binary the
  capped runaway stopped at 512 tokens in 2.4 s. `p51` pins the cap on chat sections and its absence on embedder and
  reranker sections, and a `reasoning` key on none; confirmed to FAIL when broken. **The cap makes an ALWAYS-THINKING
  model silent, not slow**: a dropped-in model whose template thinks regardless of `enable_thinking` spends the 512 tokens inside its
  thinking and is cut before any verdict or subject list, so it verifies nothing and tags nothing on every call —
  fail-open, no error — where uncapped it would at least have been visibly slow. None in the catalogue does; the cure
  for one is a row measured on the bench, not a bigger cap.
  **(5) A CHAT section's context is capped at 16,384 tokens** (`ctx-size`, `LlamaServerRuntime.ChatContextTokens`,
  2026-09-24, owner-approved), and nothing else's changes. Unset, a chat child takes its model's TRAINING context and
  llama.cpp reserves the KV cache for all of it up front: Qwen3-0.6B's 40,960 tokens, full attention on all 28 layers,
  are 4,480 MiB of KV for a 604 MiB model, and the router plus that child took **+5,175 MiB** of GPU memory by
  nvidia-smi — **+2,472 MiB** at the cap (KV 1,792 MiB; b10549, Vulkan, one RTX 4080 Laptop GPU;
  `docs/self-managed-llm-runtime.md`). Silent either way: nothing fails, the GPU just holds gigabytes. **16,384 is the
  measured worst prompt with a third to spare**, counted by the server on each model's own tokenizer and template with
  prompts built as Lyntai 3.2.0 builds them: 400 candidates (the deepest verification) of the fixture's facts is
  ≤ 10,395 tokens, + the 512-token reply; the deepest annotation 604–3,132. What does NOT fit — 400 candidates averaging
  more than ~45–50 Chinese characters, or 400 at the 400-character cap (114k–124k, past the models' own training windows
  too) — is refused whole (HTTP 400 `exceed_context_size_error`) and fails open: NoOpinion for a verdict, no subjects for
  an annotation. **Two things it changes beyond memory, both measured and accepted**: llama.cpp's default `--fit on`
  shrinks only an UNSET context (uncapped, on a simulated short GPU it cut Qwen3 to 12,032 to leave 1 GiB free, logged at
  verbosity 4 only) — with the cap it leaves it alone, so the footprint is the same on every machine and a GPU without
  room for it is unmeasured, as for every model here since `n-gpu-layers` was set; and the 16,384 cells are SHARED by
  the child's 4 slots, so two DEEP verifications in flight at once (~10.5k each) both fail (HTTP 500, ~1.6 s, the child
  fine afterwards) where a deep one beside an annotation or a 96-candidate page is answered. Gemma 3 1B, whose
  sliding-window layers kept its cache small anyway, went 183 → 119 MiB of KV and answered as before. `p51` pins the
  line on chat sections and its absence from embedder and reranker sections (a reranker keeps exactly ONE `ctx-size`,
  its own); confirmed to FAIL with the line removed and with it written on every section.
  **(6) A RERANKER runs on the device it was MEASURED fastest on — never one guessed from the device list** (2026-09-26,
  owner decision after `docs/judge-bench.md` Run 8b — a run recorded UNREAD, its rule not read, so its figures are
  descriptive only and none is quoted here). On this laptop the integrated Arc is SLOWER than the CPU for both rerankers
  WITHIN each run of the device measurement — BGE 2.9× and 2.7×, mMiniLMv2 6.0× and 6.7× per pair token (both GPUs
  visible, then the Arc alone; Run 8b's own ratios set its iGPU arms against another run's CPU) — and `--list-devices` prints an integrated GPU exactly like a discrete one ("Vulkan1: Intel(R) Arc(TM) Graphics"), so no
  reading of the list can answer "run this where?" — while llama.cpp's own default put the child on the Arc when it was
  the only GPU visible (Run 8b) and on the RTX alone when both were. So at every router start the app performs
  (`SpawnAsync`: a start or a restart, under the one lifecycle lock — never an ADOPTED router, whose presets are not
  ours), each installed reranker without a current measurement is timed first by `RerankDeviceMeter`: on the CPU
  (`device = none`) and on every listed device, ONE AT A TIME (two children share one package's power budget — Run 9's
  void), each a standalone `llama-server` with the section's own `LaunchKeys` plus `--device`, on a loopback port the OS
  picks — never one in the router's band, which this machine's dynamic range (1024–15000) covers, so a port the router
  would take next is refused and another asked for, up to 128 times with the refused ones held open: the OS hands out
  bind-to-zero ports in SEQUENCE, and with 20 tries a start whose sequence had reached the 64-port band excluded two
  devices with 「没能找到一个可用的端口」 (`e2e-p53`, final review) — `/health`, a warm call, one timed call of DIFFERENT documents of the
  same size (sent byte for byte twice, a future rerank prompt cache could answer the timed one), the tree killed. Every
  wait is capped (load 45 s, each call 30 s); a device that fails, exits, times out or does not score every document
  (`RerankReply`) is excluded with a household reason (the exception to the log, never into a row). A call that TIMES
  OUT — warm or timed; on the slowest machines the warm call is the one that does, so the timed call is never reached —
  also leaves a LOWER BOUND on the device's rate (`LowerBoundMsPerToken`, the cap over the batch's pair tokens in the
  pace's unit), never a result. With no valid device and EVERY device timed out, the measurement complete, the smallest
  bound is what the verdict judges AND where the pace starts (`RerankDeviceMeasurement.LowerBoundOnly`, one condition for
  both in `RerankDeviceVerdict.Seed`), and one that fails the default page's admission counts as too slow — said as
  「至少要」, never 「约要」 (final review: a machine too slow to answer anywhere within the cap read as "nothing known" and
  was never offered mMiniLMv2; re-review: the verdict read the bound while the pace started from the GPU figure, so the
  row said 「会跳过判断」 while the first long recalls were sent and cut at the deadline twice). A device excluded for any
  other reason leaves its speed unknown, and llama.cpp may put BGE there, so then nothing is claimed. The preset names the
  fastest device THAT GAVE A RESULT (`device = Vulkan0`, or `none`) — unless an excluded device whose speed is UNKNOWN (it
  exited, failed to load, answered an error, scored part of the batch) still has a retry left (`RerankDeviceMeasurement.Pinned`)
  — and nothing else gets a device key; with no valid result, or while such a device is still to be measured, no key:
  llama.cpp chooses, as before. Pinning the fastest device that DID answer while a retry was pending (final review) moved a
  reranker off the RTX a busy moment had excluded — onto the CPU — seeded the pace from the CPU, skipped long recalls, and
  let those skips flip the badge, all before the retry that would have found the RTX; the row says it while it lasts
  (「…但还有设备没测完,所以测完之前仍由 llama.cpp 自己选设备:没测完的设备重测时可能比 CPU 更快(一次没测出结果常常只是暂时的,
  比如当时正被别的程序占着),所以应用等它测完再定用哪个。」). **A device that TIMED OUT does not hold the pin back**
  (re-review): its lower bound is at least the fastest valid rate — under one cap it always is, since a valid call finished
  inside that cap on a batch of the same size — so it cannot win its retry by being faster than that bound says, and
  waiting three starts for it left llama.cpp's own choice in place, which on an iGPU-only laptop is the iGPU (Run 8b). It
  is pinned away at once, measured again at each start, and takes over if the retry finds it faster; the row says so
  (「{GPU} 在限定时间内没有打完,已经比 CPU 慢,所以不等重测就先定下来;重测时要是更快,就改用它。」). The cost is now
  narrower than before: only a GPU that TIMES OUT on the four-document batch — at least ~19 ms per pair token at the
  30 s cap, ~380× the GPU figure the pace starts from without a measurement — is pinned away before its retry; a busy GPU that fails to
  load or exits still leaves llama.cpp's own choice until it has been measured again. The measurement is CONTAINED: anything it throws is logged and the router
  starts anyway — a reranker whose retry threw keeps the device its stored result names, and one with nothing stored gets
  no key: it is an optimisation, and must never be why llama.cpp did not start, nor why a known device is forgotten.
  **An exclusion is RETRIED, a bounded number of times** (review, 2026-09-26). Most are transient — a cold shader cache or
  a virus scan of a fresh `llama-server` at the first start of a new build (exactly when the key changes), a game or
  another llama-server holding VRAM, contention, a lost port race — and saved as final, one busy moment would have put a
  reranker on the CPU for good while the badge said 「它最快的设备是 CPU」. So at each start the app performs, a current
  measurement's excluded devices — and only those — are measured again and merged, up to `RerankDeviceMeter.MaxAttempts`
  (3) each; valid results stand, and meanwhile the preset names no device (above). After that the exclusion stands
  until the key changes, and the row says which of the two applies to EACH device — so does the badge's lead, per device
  (one clause for all of them was false for any whose attempts were spent). Beside a router the app did not start, a
  retry is promised only for the app's own start, since nothing is measured for an adopted router. Each result carries the
  date it was taken, and the row gives the first and last when a retry measured some devices on a later start.
  **The key** (`RerankDeviceKey`) is the model file (id, size, time), the build tag and the device list's ids AND names —
  its free-memory figures stripped, or every boot re-measures; the names because `GGML_VK_VISIBLE_DEVICES` can hand the id
  `Vulkan0` to a different GPU — and the SHAPE the figures were taken under (final review): `MeasurementVersion`, a hash of
  the section's `LaunchKeys`, and the batch's document count and pair tokens. A changed window, batch or token weighting
  therefore re-measures by itself, and the version constant covers what the values cannot show (how a call is timed,
  what counts as valid); a store written before the shape existed re-measures once. A device that comes and goes changes
  the list, so docking and undocking an external GPU re-measures at EACH change — one entry per model, the latest.
  **A GPU DRIVER update is not in it**, so it re-measures nothing — the row's "won't be measured again" sentence says so
  (「除非模型文件、llama.cpp 版本、设备列表或应用的测法变了(更新显卡驱动不算)」); what a driver changes is unmeasured. It lives in
  `rerank-devices.json` beside the GGUFs, under `state/`, which the backup does not carry: a device choice belongs to one
  machine. A measurement that cannot be SAVED is still what this start's preset names, and the runtime keeps it in memory
  and reads it FIRST — it is newer than anything stored under the same key by construction (a merged retry sits beside the
  older measurement it was merged from; read store-first, the row showed the older one while the router ran the merged,
  and the attempts stopped advancing). The row, the next retry and the pace seed read it; each start tries the save again;
  and after an app restart it is gone and the model is measured again — which is what the row says
  (「这次的结果没能保存:…会再试着保存;要是应用重启时还没保存上,重启后会重新测」). The batch is
  four documents of invented bilingual prose, each a full window of the model's own budget (`RerankInputCap.Fit`), counted
  by `RerankPace.PairTokens` and read through `RerankPace.RateOf` — the pace's unit, one counting.
  **Nothing outlives it** — a measurement child on a random port is adopted by nothing, and holds RAM or VRAM until a
  reboot. Each child goes into a Windows JOB OBJECT with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` whose only handle the process
  holds and never closes (`MeasurementJob`), so the OS kills the child when the app ends however it ends — the likely case
  being a household force-quitting a first-boot overlay a minute into a measurement. Verified on the real binary: the app
  TerminateProcess'd mid-measurement, the child gone in 111 ms; the same with the job disabled, the child still running
  10 s later. The ROUTER is not in the job — its orphan is adopted by the next start, by design. `Dispose` also kills a
  running child before it waits for the lifecycle lock. The window between a spawn and its assignment is not covered.
  **`n-gpu-layers = 99` stays beside `device = none`**, harmless: the child logs "offloaded 25/25 layers to GPU" yet holds
  only CPU buffers and scores at the CPU's rate, the same as with 0; `device = none` is what keeps a batch off a visible
  GPU. **Three readers, none with a threshold of its own.** The PACE starts from the PINNED device's rate — not while a
  device of unknown speed is still to be measured, when it starts from the GPU seed as without a measurement; from the
  lower bound when every device timed out — never faster
  than the GPU seed, because a four-document batch on a discrete GPU is mostly call overhead and, seeded at the floor, the
  pace would stop learning (`MinSignalFactor`) — read at its FIRST USE, since the verifier is built before the startup step
  that measures. The 推荐 BADGE recommends the small reranker (内置 since Run 13, llama.cpp's mMiniLMv2 before), even
  beside an installed BGE, when a fresh pace seeded exactly as the
  runtime seeds one (`RerankDeviceVerdict.PaceSeed`) from BGE's measurement would not SEND the default page's one-window
  call — 96 candidates (`recall_facts`' 8 → `FactIndex.RankLimit`'s 24 → Lyntai's 4× verification depth; the bench's
  "≤ 60" is its fixture's size), each a long fact read in one full window of the batch's prose — the runtime's own
  admission (`RerankDeviceVerdict.ReferenceAdmission`); the lead says it is long facts, and that short ones take far less.
  **Not while a retry is pending**: a BGE measurement that still has an excluded device with attempts left moves nothing —
  one RTX busy at the first start would otherwise recommend a 133 MB download the next start's retry may reverse; it flips
  once every device has a result or has spent its attempts.
  **Only BGE's measurement moves it**: a LAMAR or mMiniLMv2 measured too slow changes nothing, because the question is
  whether this machine is too slow for BGE, the default. Precedence: recent skips → BGE measured too slow → no GPU → BGE —
  and the first two are REPAIRS that outrank the EMBEDDER suggestion (final review): with no embedder installed the badge
  offered the embedder while the judge skipped or BGE measured too slow, so mMiniLMv2's row (「「资源」也会改为推荐它」,
  「应用测完就改为推荐 mMiniLMv2」) and the 判断 row promised a recommendation 资源 did not make. Only the runtime-missing
  suggestion comes before them — a reranker needs that runtime too.
  And the reranker's ROW says where it runs and what was measured (`RerankDeviceNotes`), including that embedders and
  chat models are not measured — and, beside a router the app did not start, that it is not measured while that router is
  not ours (its "next start" promise would never be kept). **The limitation, said in the reason and the notes rather than
  hidden**: a measurement exists only for a model on disk, taken at the next router start the app performs, so on an
  iGPU-only machine the badge offers BGE first and moves to mMiniLMv2 once BGE is measured. **Who waits**: the migration
  overlay — whose step line shows 「正在测重排模型 … 第 i/n 个」 while it runs (`ILlamaServerRuntime.MeasuringNow`, polled) —
  or a bind's restart and 资源's start button, which no server or client timeout bounds, the start button's answer then
  saying what THAT start measured and how long it took (`ILlamaServerRuntime.StartAsync` returns it: a measurement another
  caller ran while this one waited for the lock is never claimed, and a start that then FAILS still says it, since the time
  went there) — and a BIND's toast likewise (final review): a bind reaches the runtime inside a source's own check, so
  `EnsureServesAsync` reports what its start or restart measured to an ambient `RerankMeasurementCapture` the bind opens,
  and the note — or the refusal — ends with 「启动 llama.cpp 前先测了 X 在哪个设备上最快(用了 N 秒),结果写在「资源」里各自那一行。」
  (`RerankDeviceNotes.MeasuredBeforeStart`, one writer with the start button's) — worst case 105 s per device per
  unmeasured reranker, and per retried
  device. Inside a restart the router stays down for the measurement too; `ILlamaRestartPolicy` already refuses a restart
  while anything WRITES through the router, so what that longer window can cost is a reranker's verification, which fails
  open. Measured: 77 s for both rerankers on this laptop's three devices, and nothing on the next start
  (`docs/self-managed-llm-runtime.md`, 2026-09-26, with the per-device figures: on the RTX the choice changes nothing, the
  default already put both there; with only the Arc visible, both go to the CPU). **Measuring it found a parser bug**:
  `--list-devices` is read as stdout and stderr together, and with `LLAMA_ARG_LOG_VERBOSITY=4` in the environment three
  `load_backend` log lines became "devices" and a re-measure on devices that do not exist — only the indented lines
  under the header are devices now. Proof: `e2e-p53`, through the measurement-only seam `GATHERLIGHT_LLAMA_MEASURE_CMD`
  (a fake `llama-server`, `devtools/scripts/fake-llama-measure.mjs`, answering in time proportional to the pair tokens
  it is sent, per model and device; the precedent is `GATHERLIGHT_CLAUDE_CMD`) and the cap knob
  `GATHERLIGHT_RERANK_MEASURE_CAP_SECONDS`, which only shortens: the choice, one device at a time, the launch keys,
  different warm and timed documents, validity, the cap and the kill, retries and their bound, the key's five parts, the
  flip and no flip while a retry is pending, a CPU section, an unsaved measurement read first and saved again, the start's
  own measurement sentence on a failed start, the overlay's progress line, and — counted at a fake ROUTER, not read from
  a log — the pace seed against a control whose retry is pending, and the kill-on-close job (the app TerminateProcess'd
  under a running child); and with the final review the device pinned only once the measurement is complete, the repair
  ahead of the embedder with none installed (and `e2e-p52` case 6h for the skips), the lower bounds (every device timed
  out → 「至少要」; one exited → nothing claimed), the shape in the key, and a refused bind's measured clause; and with its
  re-review the pace starting from the lower bound when every device timed out (counted at the router: nothing sent), and a
  device that timed out not holding the pin back — the CPU named at once, the device taking over when its retry is faster
  (while one of unknown speed still does, in A2, B, C, D and E's control). 资源's start button opens the same capture as a
  bind, for a restart one of its warms could trigger — not drivable (a listed model is warmed without a restart), a stated
  gap. **Confirmed to FAIL** (each on a build of its own, 2026-09-26): no device key in `LaunchKeys`, the
  preset not given the devices, validity off, the free-memory figures kept in the key, the flip off, the seed not wired,
  devices measured in parallel, no kill, the store ignored, the key without devices / the file / the build, the badge's
  limitation sentence removed, a device key on every section, the old seed sentence restored (`p51`), and with the review
  round retries off, retries unbounded, the timed call identical to the warm one, the save failure hidden, the adopted
  router ignored, no progress line and the job off; and with the re-review the store read before the unsaved measurement
  (in the lookup, and in the retry), the flip allowed while a retry is pending, the adopted clause ignored, the failed
  start's sentence dropped, one clause for all excluded devices in the lead, and the save not retried; and with the final
  review the device pinned while a retry is pending (five assertions), the pace seeded then (the control's count), the
  embedder ahead of the repair (`p53`'s two no-embedder badges and `p52` 6h's), no lower bound, a lower-bound verdict while
  retries are pending, the bounds judged beside a device that exited, no shape in the key, and the bind's clause dropped
  or its sink not threaded; and with its re-review the runtime's seed without the lower-bound fallback (the recall sent),
  a timed-out device holding the pin back (`p53` H), and no excluded device holding it back at all (ten assertions).
  **Gaps**: `Dispose`
  killing a child is asserted by nothing (the
  harness stops a server with TerminateProcess, which skips Dispose — the job covers that kill too); the router's band
  refused when the OS offers it is not drivable; so are a throw inside a retry (nothing in the measurement can be made to
  throw there) and a start that waited behind another caller's measurement; a bind that SUCCEEDS after measuring is not
  driven either — the fake router can only be adopted, so no bind reaches a start of ours that then answers — and its note
  carries the clause by the same code path as the refusal that is asserted; the port search crossing the band is not driven
  on demand (the OS's sequence cannot be positioned; a green `p53` run crossed it, the sequence at 10,996 before and
  13,395 after, with no exclusion); a driver update re-measures nothing; whether an embedder or a chat model would be
  faster on another device is unmeasured; and one laptop is the only hardware measured.
  **(7) An EMBEDDER section launches with its WINDOW as its physical batch** (`batch-size`/`ubatch-size`, 2026-09-26).
  llama.cpp embeds an input in ONE physical batch and refuses a longer one whole, and until then the embedder section
  set none, so llama.cpp's 512 applied while EmbeddingGemma reads 2,048: on the real binary (b10549, router mode, the
  product's preset) 750 Chinese characters embedded (511 tokens) and 840 (572) came back 500 「input (572 tokens) is
  too large to process」; English up to 2,500 characters. Silent twice over: nothing said a long fact had no vector, and
  once the 3.4 bump read `Ran`, every start re-remembered it. With the row's window, 3,000 Chinese characters (2,037
  tokens) and 10,000 English (1,878) embed; the compute buffer went 10.76 → 55.05 MiB, the GPU +44 MiB loaded and +79
  after long inputs, and a short query stayed at ~30 ms median (30.9 → 31.0 and 30.2 → 29.5) —
  `docs/self-managed-llm-runtime.md`. **The row declares the window** (`GgufModel.ContextTokens`, EmbeddingGemma's
  2,048 from its GGUF's `context_length`, read through `GgufCatalog.DeclaredWindow` as a reranker's is); **a row without
  one gets `LlamaServerRuntime.EmbedBatch`, 8,192**, because a batch PAST the model's context costs nothing more —
  measured: the same 55.05 MiB at 8,192 on the 2,048 model, and 10.76 at 2,048 over a 512 context, the same as 512 — so
  the model's own context is then the limit, and an input past it is refused as 「larger than the max context size」.
  What 8,192 costs a model whose own context is that large is unmeasured. No `ctx-size` on an embedder: the child takes
  its model's own. Past the window a fact is kept without a vector (workaround (3)). `p51` pins both keys on both kinds
  of embedder section; confirmed to FAIL with the keys removed, and with the row's window removed (8,192, not 2,048).
  **The facts the OLD batch refused get their vector once.** On 1.3.x a fact past ~510 tokens kept its graph ref WITHOUT
  a vector, and the back-fill revisits only empty refs — so the wider window would never have reached them short of a
  reindex. So `FactIndexStep` runs a one-off step (`facts.index.embed-window`, only with a llama.cpp embedder wired,
  after the gate): when any indexed fact is long enough to have been refused at 512 — estimated by `RerankPace.Tokens`,
  whose rates OVERESTIMATE EmbeddingGemma's (0.83 against 0.68 per CJK character, 0.25 against 0.19 per other), above
  400 — it records the vectors as owed (layout "2"), and the same start re-embeds every entry IN PLACE (Lyntai D194):
  one embed each, no fact re-remembered or annotated, decay, links and subjects untouched. At the 3.4 bump it cleared
  those facts' refs instead, so the gated back-fill re-remembered each onto the node it already had (Lyntai 3.4's graph
  store upserts on engine, task, scope and content hash) — which kept the node but advanced its position and paid one
  annotation per fact revisited. Length decides only WHETHER the pass is owed; the pass re-embeds every entry, because no
  API narrows it. `e2e-p52` case 9e (the graph rows byte-identical across the start, each entry embedded once),
  confirmed to FAIL with the step removed.
  Also: models are NOT portable — Ollama's own `embeddinggemma:300m` blob is a GGUF and llama.cpp refuses it
  (`expected 316 tensors, got 314`), so every model is a fresh sha256-pinned download and "reuse what is
  already there" is not on the table. And `LlamaServerRuntime` deliberately does **not** search PATH: a
  household's own llama-server is already reachable as `openai-compat` with an address they typed, and
  collapsing the two is precisely the ambiguity that hid the Ollama provisioning for months. `Dispose` kills
  the tree on graceful shutdown; a forced kill orphans a router, which the next start ADOPTS rather than
  duplicates (measured — two processes across a restart, not four). **The adoption is `EnsureServingAsync`
  probing `Serving` BEFORE it checks the executable exists**, and `p51` pins that ordering: with nothing
  installed at all, a start against a port that already answers succeeds. Swap those two lines and every
  start on a machine with an orphan spawns a duplicate — confirmed, the test fails with the
  not-downloaded refusal. It needs no real binary, which is why the gap was worth re-examining rather
  than recording.
- **A FAILED EMBED IS NOT AN ERROR TO THE ENGINE — so nothing may write through a router that is down.**
  Lyntai's graph engine catches a failed write-time embed and stores the fact anyway, without its vector
  ("storing without signals or links"), and hands back its graph reference. Until the Lyntai 3.4 bump the fact
  kept it, so no back-fill ever returned: semantic recall never found it again, and coverage read 100%. Since the
  bump `FactIndex.IndexAsync` reads the write's `Ran` and classifies the loss — the fact's content re-embedded, then a
  probe: a loss that PASSED or an embedder that is DOWN leaves the fact UNINDEXED and the next back-fill gives it its
  vector — keyword-only until then, and the retry pays its annotation again, which is why the rest of this bullet still
  keeps writes off a down router; content refused again while the embedder ANSWERS means the input itself was refused,
  and the fact keeps its ref without a vector (workaround (3) in the Lyntai list above; the embedder's window is launch
  item (7) of the previous bullet). Four things follow,
  all found by review, the first three confirmed on the real binary (`docs/self-managed-llm-runtime.md`):
  **(1) `LlamaWarmStep` runs BEFORE `FactIndexStep`.** The other way round, the 3.2 layout rebuild re-remembered
  every fact before anything had started llama-server (a graceful shutdown kills it): a real install came up
  with 6 of 6 facts indexed and **0 vectors**, marker written. Fixed, the same repro keeps 6.
  **(2) `FactIndexStep` probes one embed first** (`IFactIndex.EmbedderReadyAsync`, the engine's own routing)
  and, when an embedder is wired but does not answer, indexes nothing, writes no marker and warns. Since the 3.4
  bump that is a COST gate (workaround (3)), shared with the import's and the seed's detached back-fill and the
  console's semantic reindex: the per-write classifier already keeps a vector lost to an outage retryable, and what the
  gate spares is an annotation per pending fact on every pass of an outage. A marker is written only after work that actually happened — and a rebuild that
  indexed PART of the facts did happen: its entries are at the current address and the rest are empty refs, so it
  writes the marker, warns, and the next back-fill finishes the rest without a second destructive rebuild. Only a
  rebuild that indexed nothing holds the marker back, with a sentence of its own (a zero cannot tell "nothing indexed"
  from "failed before clearing the old refs" or "threw after indexing some"). `e2e-p52` case 9 boots one folder up (9a: a refused input keeps its ref; a write during an outage
  stays unindexed; 9c: an import's back-fill skips), up again (the back-fill re-indexes the outage's rows, not the
  refused one), down (no fact's content reaches the fake — which fails with the gate removed — no marker, the
  warning), partly down (9b: one fact's content and every later probe refused — the marker written, the other warning)
  and up (that fact back-filled, every other node id kept).
  **(3) A router restart is refused while anything writes through it** — see the next bullet.
  **(4) An embedder that is BOUND but not WIRED leaves the vector rebuild owed.** When the saved 语义 arm is one
  that registers an embedder (`TakesEffectOnRestart` — for this layer that IS "embeds") but none is wired this
  start — its model file gone, its runtime gone, the built-in files missing — `FactIndexStep` records layout "2"
  (entries at the current address, vectors not) where it used to record "3". "3" told the start that had the
  embedder back that nothing was owed: it only synced, the vectors Lyntai 3.2's address change orphaned were
  never re-embedded, and semantic recall stayed empty without a word. Same rule as (2), a marker says only what
  happened. An install with NO marker yet and an owed embedder therefore pays a rebuild now, for the scope move, and a
  re-embed IN PLACE when the embedder returns (one embed per entry, nothing learned lost — Lyntai D194; before the 3.5
  bump that second pass was a rebuild too, because Lyntai could re-embed only by re-remembering). `e2e-p52` case 10,
  confirmed to FAIL with the rule removed; the in-place pass at "2" is case 11.
  **It covers only a start that REACHES the marker write** — one with no marker yet, or with "2" or older stored.
  With "3" already stored, `FactIndexStep` syncs and returns before it ever asks whether an embedder is owed, so
  a model that vanishes AFTER an install reached "3" leaves the marker at "3": the facts written while it was
  gone keep no vector, and the start that has it back only syncs. The per-write check does not reach them either:
  with no embedder WIRED no vector is owed, so each of those writes kept its ref. Those facts are recovered only by
  the manual reindex that the gone-model startup warning (`LlamaWarmStep`) asks for — 「再在「记忆检索」重新建立一次语义
  索引」, which re-embeds every entry in place, so a vector-less one gains its vector — which is why that warning carries
  the reindex and not only the restart.
- **A model downloaded while OUR router runs is restarted in — within limits, each for a failure found in
  review.** The router reads its models directory and preset file ONCE (measured: `400 model not found`
  before and after the presets are rewritten, until a restart), so `LlamaServerRuntime.EnsureServesAsync`
  restarts a router we started when a bind names a model it does not list. Not otherwise:
  **only when the probe ANSWERED without the model** — a failed probe says nothing, and reading it as "not
  listed" restarted a healthy router on two slow probes; **never an ADOPTED router** (an orphan of an earlier
  run, or the household's own) — not ours to kill, and an app restart would only adopt it again, so the bind
  and the startup warning name the process to end (`e2e-p52` case 8, on both layers, and case 7's warning);
  **never while 语义 embeds through it or 判断 annotates through it (a chat model)** (`ILlamaRestartPolicy`) —
  the restart window is exactly the failed-embed case above, so the bind says to restart the service instead.
  A reindex needs no check of its own: it reaches llama.cpp only through those two (the CLI arm's rephrasing is
  on the default client, the CLI), and the separate reindex check it had refused, with a sentence about lost
  vectors, reindexes that touch no llama.cpp at all. A chat judge's annotation is lost the way a vector used to
  be: fail-open, at write time, for good. A vector lost in that window is, since the Lyntai 3.4 bump, retried by
  the next start's back-fill — keyword-only until then, and paying its annotation again. Verified on the real
  binary (the runtime doc), because no fake can be a router we started.
  "Annotates" means RUNNING with 判断 switched on: switched off, the chat judge makes no call and the restart
  goes ahead. A binding that is only SAVED loses nothing either, and is refused anyway because the service
  restart it is owed loads the new model too — in its own sentence (「设置的是这个 llama.cpp 的…模型,但还没有
  生效」), never the running one's loss clause, which would be false. It said 「已改用」 ("has switched to") until
  2026-09-24, which was false whenever nothing had switched — a bound model missing when the container was built
  and back on disk since resolves as saved-not-running too. And every refusal, loss or owed, ends by saying the
  choice was NOT saved and must be made again after the restart (`LlamaRestartPolicy.ReselectAfterRestart`, also on
  the port-release refusal): the bind answers 409 and writes nothing, so "restart the service" alone promised a
  model the restart would load into the router and not into the layer. Start, restart and stop hold ONE lock: probe-then-spawn is a
  check-then-act on a port, and a concurrent spawn during a restart once made the live router look adopted,
  because `_started` was set before the process answered — it is set only after, now, and `Dispose` marks the
  runtime disposed before taking the lock so nothing spawns after it. After a restart the requested model is
  warmed before returning and the rest re-warmed one at a time (llama.cpp loads concurrently badly), only if
  ours — the real router also lists the machine's llama.cpp cache.
  **The probe has THREE answers — refused, answering, HELD — and a held port is never spawned beside.** A
  probe timeout is never an escaping cancellation: HttpClient's timeout arrives as a `TaskCanceledException`, so a
  catch filtered on the TYPE let it out of `IsServingAsync` and `RunAsync`, and on the real binary that was a bind
  answering 500 with llama.cpp left stopped. Only the caller's TOKEN says the caller gave up (`WarmCoreAsync` had
  already learned this). But the first fix read the timeout as "not serving", and "not serving" means "start
  one": a port that ACCEPTS and gives no model list (a timeout, a non-2xx, a body without a `data` array) is
  HELD — by a hung llama-server, another program, or our own router too busy to reply — and a router spawned
  beside it cannot bind, while every sentence named the wrong cause (「没能启动」, even 「还没有下载」). Held is its
  own state: `EnsureServingCoreAsync` never spawns, and its sentence (`HeldProblem`) takes precedence in
  `Problem` and is what the bind and the start button say. And **the restart waits for the old router to let
  go of its port** before probing, at most 15 s, because `Kill`'s 5 s wait carries on either way and a dying
  router's socket most likely still accepted that re-probe — so a router we just killed is reported as not yet
  gone, never as a stranger holding the port; and a panel probe DURING our restart, which runs outside the lock,
  reads `_restarting` and says the app is restarting llama.cpp rather than blaming another process. **Our own
  START has the same window** — `_started` is set only once the router answers — so `SpawnAsync` (every start, a
  fresh one included) sets `_starting` and `HeldProblem` says 「应用正在启动 llama.cpp,稍等几秒」; before that
  it blamed "another process" for our own starting router. **Both 「稍等几秒」 sentences are true only while their
  flag is set**, so each flag is cleared in a `finally`, under `_gate`, TOGETHER with the cached probe
  (`InvalidateLocked`) — a cached 「稍等」 used to outlive the transition by the cache's 20 s — and a probe that was
  already out when the cache was dropped does not write back (`_probeEpoch`). And **a restart that finds the port
  HELD after it was released never passes the re-probe's sentence on**: that sentence was computed with
  `_restarting` set, so the bind's FINAL answer was 「应用正在重启,稍等几秒」 from a restart that had given up with
  nothing running. It is `RestartBlocked` instead — the app stopped llama.cpp to load the model and could not start
  a new one because the port is held by something that does not answer as llama.cpp, llama.cpp is NOT running;
  wait and retry, then end it in 任务管理器, then reboot — never 「重启服务」, which ends neither a stranger nor a router
  stuck in teardown — and choose the model again, since the bind saved nothing. What holds the port is ONE
  writer shared with the stranger sentence (`HeldBy`), naming both candidates, because the app cannot tell a
  stranger that took the freed port from our OLD router still dying with an accept too slow for the release check
  to see. That is also why `NotOursRemedy` is not reused there: "not started by the app this time" is false of the
  second. Proof:
  `e2e-p51` and `e2e-p52` case 8a (a fake that accepts and never answers `/v1/models`): the held sentence, and NO
  spawn attempted in the fixture's log — the no-spawn check fails when a held port falls through to the spawn —
  plus ten real-binary restarts in the runtime doc, where the wait never had to wait. **Asserted by nothing,
  stated as gaps:** `HeldProblem`'s other three sentences — 「应用正在重启 llama.cpp」 (our own restart window),
  「应用正在启动 llama.cpp」 (our own start window) and 「应用启动的 llama.cpp 还在运行,但端口…没有回应」 (a router
  we started, too busy to answer) — because a fake is always ADOPTED, so case 8a reaches only the stranger's
  sentence; the port-release timeout's sentence (「…秒内没有让出端口…」), which no suite can reach and none of the
  ten real restarts produced; and `RestartBlocked`, verified by READING only, because a stranger grabbing the port
  inside the restart window cannot be staged on demand. A real-binary start + restart (the runtime doc,
  §2026-09-24) shows the flags regressed nothing, and a panel polling through that restart did show
  「应用正在重启」 while the old router was dying — the first time that sentence was seen outside the code — and
  nothing stale after the bind; 「应用正在启动」 was not seen, since the new router went from refused straight to
  answering. **The restart branch has NO
  e2e coverage**: the fake router can only ever be adopted, and no stub can be a real router. It was verified by hand on the real binary — a bind racing 资源's start button
  left one router and a second restart still worked; with 语义 on llama.cpp the same bind was refused with 0
  restarts.
- **A reranker judge: input bounded per PAIR, a long candidate read in WINDOWS, and its tagging state said out
  loud.** One (query, document) pair past the router's 4096-token batch fails the WHOLE `/v1/rerank` call
  (measured: ~6,000 Chinese characters ≈ 4,960 tokens → 500, the short document beside it unscored too; the limit is
  per pair — 96 long documents in one call scored, and 2,000 windows in one call were served), and the scoring
  verifier is fail-open, so one long fact made every recall that surfaced it unverified. `RerankInputCap` bounds every
  pair: at most 1,000 characters of document, ~830 tokens at the worst rate measured (0.83 per UTF-16 unit, common
  CJK); `p51` pins `ctx-size = 4096` on the preset. Beside a reranker that declares no window (BGE, LAMAR, anything
  dropped in) the QUESTION is capped too, at 2,045 characters — half the pair budget of that 4,096-token batch, the
  declared-window rule applied to it (`RerankInputCap.UndeclaredQueryMaxChars`, reading `LlamaServerRuntime.RerankBatch`).
  It went uncut until 2026-09-25, argued from recall queries being short; the agent writes them, and one long enough
  would have refused every call it was in, silently. The question is COUNTED after NFKC (`RerankInputCap.CapCountedNfkc`,
  per text element as D177 counts) and SENT as written, because the tokenizer normalises before it counts — so it costs
  at most 2,046 tokens whatever it contains. A CANDIDATE on that path stays counted raw: ~210 ㌚ in one window overflow
  the pair beside a question at the cap, ~610 beside a short one — the stated limit. `e2e-p52` case 6c sends 2,812
  characters and asserts 2,045, the question's head, and a question of 1,000 ㌚ (5,020 after NFKC) cut by its NFKC
  length; each confirmed to FAIL without its half.
  **A CUT IS WORSE THAN NO JUDGE for the note it cuts, so a long candidate is scored in windows** (2026-09-24,
  `docs/judge-bench.md` Runs 6 and 6c). The bound used to be a cut, argued as "better than a refused call" — true for
  the recall's OTHER candidates, false for the cut one: under partition the reranker endorses its eight best and
  promotes them, so a note whose answer lies past the cut scores like filler and is pushed OFF a page the engine would
  have given it. Measured on 60 notes of 883–1,241 characters (240 questions, no tags, no embedder, a page of 8): an
  answer at a note's END reached the page 4 times in 60 on mMiniLMv2, against 29 with no judge; past 1,000
  characters, 3 of 60 on BGE and LAMAR against 30. `ChunkedScoreProvider` decorates the reranker's own score provider
  (applied where `RerankVerification.Build` builds the verifier — for both reranker judges, llama.cpp's and 内置's —
  registered nowhere): each document is split by
  `RerankInputCap.Windows` into windows of the SAME budget the bound uses (`RerankInputCap.PerCandidate`, NFKC under a
  declared window) — at most 5, overlapping by a quarter, the last at the tail; unread stretches appear only past FIVE
  window-lengths, 1 − 5 × window ÷ length of the text — all windows go in ONE call, and each document keeps its MAX window score, so
  `ScoringVerificationPolicy` still sees one score per candidate and `EndorseCount` still counts candidates. A request
  whose documents all fit one window passes through untouched. Run 6c's pre-registered rule held and it is the default:
  end-position answers 4 → 44 of 60 on mMiniLMv2 (0/40, p < 0.001), beyond-1,000 answers 3 → 51 / 52 on BGE / LAMAR,
  no reranker significantly worse at the start, and every row byte-identical on the ≤ 101-character fixture — though
  where the cut already read the answer every difference leans against chunking (found@8 8 losses to 1 gain, post hoc;
  mMiniLMv2's top-1 at the start 24 → 19), so quote "not significantly worse", never "nothing lost". It costs
  time where notes are long: 2.0 → 3.2 s per recall on BGE, 0.5 → 1.2 s on mMiniLMv2, on those notes, one GPU.
  **A call is sized by TIME, not only by count.** 480 windows per call was measured on one GPU (~20 s on BGE/LAMAR);
  on a CPU-only machine the same call can outlast the 60 s verification deadline — NoOpinion after a minute, logged at
  Warning only. So 480 is a CEILING, and below it `RerankPace` — one per verifier, learned from the rerank calls the
  provider makes — predicts a call's time in ms per PAIR TOKEN (query plus document; per window would learn a
  60-character fact's cost and apply it to a 1,000-character window), each character counted at its script's measured
  rate — 0.83 from U+2E80 up, 0.25 below, one writer (`RerankPace.Tokens`) shared by the timing and the sizing — and
  gives each long candidate only the windows that fit half the deadline, down to one, the cut. It counted CHARACTERS
  until review (2026-09-25), which let a pace learned on English under-predict Chinese by ~3.3×, past the margin.
  **Its rules, each a judgement stated as one** (reviewed twice on 2026-09-25; `RerankPace`'s comment has the reasons):
  a call too SMALL to measure — its scoring, at the current estimate, under 4 × the 50 ms overhead allowance, ~4,000
  tokens at the seed — teaches nothing, because a 33-token call taking 150 ms read 60× the seed and a 17 s model reload
  on a 30-token call 565 ms per token; a slower ANSWERED call is believed at once on a repeat (the last call that taught
  anything slow too — answered slower, or cut having proved it slow — and the flag stays set, so a third in a row is
  believed too), and alone moves the estimate halfway in log space and at most ×4; a faster call lowers it halfway,
  arithmetically — a single fast call can at most halve it, so a misleading one under-predicts the next by at most the
  2× the margin covers — and only a CHUNKED one: a pass-through call may raise it, never lower it; a failed answer
  teaches nothing. **A CUT PROVES ONLY A LOWER BOUND**, and sizing by it was the second review's finding: the next call
  was sized to half the cut one, and was cut again whenever the first's true time was over twice the deadline — a
  machine 30× slower waited the minute four times running (612 → 306 → 153 → 76 s). So a cancellation teaches only if
  the call had already run longer than predicted (a user's stop proves nothing), and one past the budget puts the pace
  AFTER CUT: every chunked call sends ONE window per candidate until one answers, and that answer is believed whole —
  one minute-wait wherever one window each can finish in time. Seeded with the GPU figure, so on that GPU nothing
  changes — or, since 2026-09-26, with this machine's measurement of the bound reranker where there is one, never faster
  than that figure (launch item (6)).
  **WHERE EVEN ONE WINDOW PER CANDIDATE CANNOT FIT, NOTHING IS SENT** (2026-09-25, `docs/judge-bench.md` Run 8). On that
  run's CPU (Core Ultra 9 185H, `device = none`) BGE scored ~3.1 s per 1,000 pair tokens, so a recall of ~59 long notes
  cost ~118 s at one window each: 230 of 240 chunked recalls waited the full minute for no verdict and ended where no
  judge is (found@8 104, no judge's 104), and the pace sat in after-cut mode for 212 of them. No sizing can fix that, so
  `RerankPace.Admit` predicts the one-window call and SKIPS the recall — NoOpinion at once, the engine's page, as a cut
  leaves it, without the minute. **The skip is decided ABOVE Lyntai** (`RerankAdmission`, between `RerankInputCap` and
  `ScoringVerificationPolicy`, reading `ChunkedScoreProvider.Shape` — the documents the scoring policy will send): a
  skipped recall makes no provider call and hands Lyntai no verdict. It was first a blameless `Unsupported` returned by
  the provider, and Lyntai 3.3.0 (its `6c45d051`, unreleased when this was decided) logs a verdict that is not transient
  at Warning in that policy — one Warning per skipped recall — while the in-code plan to "filter it" would also have hidden
  `ContextWindowExceeded`, `AuthFailed` and `Refused`, and `Unsupported` means a capability gap in Lyntai's vocabulary, not
  "this machine is slow". So there is NO Lyntai-bump step for the skip; the probe and the sizing stay in the provider,
  the one place a call to the router can be timed. One Information line per skipped recall, in the pace family ("0
  window(s) per long candidate instead of N — the judge is skipped for this recall", or "0 window(s) per candidate
  instead of 1 (none is long)" on short facts), so judge-bench's I6 VOIDS a GPU run in which it fires and its CPU arms read
  it as an explained abstention (`PACE_SKIP`, strip `S`). **Send only when nothing is presumed queued AND the one-window
  call fits `RerankPace.OneWindowLimit`** (review, 2026-09-25, both halves). A send behind a presumed queue used to go
  whenever queue plus prediction fitted the budget; being queued, its cut taught nothing and extended the presumption, so a
  slow machine could wait the minute again and again without learning and never reach a probe. And the limit was half the
  deadline, which threw away verdicts arriving in 30–60 s although a one-window call is already the smallest call there is
  (mMiniLMv2 on Run 8's CPU, a kind-filtered recall of 400 long candidates: ~47 s). It is now 0.8 of the deadline
  (`RerankPace.OneWindowShareOfDeadline`, 48 s) while the estimate comes from an ANSWER — an answered rate is steady on one
  machine (Run 8's mMiniLMv2: p10–p90 0.257–0.327 ms per token across calls of 133 to 65,463 tokens, a p90 9% over the
  median), so a call predicted at 0.8 overruns only at 25% over its prediction, ~3× that spread — and half the deadline
  while the estimate is only a lower bound after a cut. A one-window call past the SIZED budget but inside that limit is
  sent as it is, and says so ("…, the fewest that scores every candidate: predicted at ~X s …", `PACE_FEWEST`). **A LONE
  CUT IS DAMPED like a lone slow answer** (halfway in log space, at most ×4; a second in a row believed): believed in full,
  ONE GPU stall — a 70 s reload on a 5,800-token pass-through call, cut at 60 s — set the estimate to 206× the seed and
  skipped every recall above ~2,900 pair tokens for ten minutes, silently. The accepted price: a machine that truly is that
  slow waits the minute TWICE. **Re-probe**: once ten verification deadlines (10 min; the interval scales with the test
  knob) pass with no call able to LOWER the estimate — a chunked call or a probe; a pass-through call only raises it, so
  short-fact recalls must not hold the re-check off — and nothing presumed queued, a skipped recall sends a PROBE — the
  first windows of its longest candidates, a sixth of the budget at the estimate (~5 s), sent by `RerankAdmission` through
  `ChunkedScoreProvider.ProbeAsync` directly, not through Lyntai's router — believed whole; when it says the whole call now
  fits, the SAME recall sends it ("re-measured this machine", also a pace line). A probe that would carry every candidate
  IS the one-window call, so that recall goes through Lyntai as usual with its call timed as the probe, and its answer is
  the verdict; it logs the re-measure line too. A truly slow machine pays ~5 s per interval, never the minute per recall.
  **…except for the in-process 内置 scorer**, which STOPS an abandoned call at its next pass (`InProcessReranker`), so its
  pace presumes nothing busy after a cut (`RerankPace`'s `abandonedCallsRunOn: false`); the call queued behind that last
  pass waits a pass for it, stated rather than modelled. Everything else below holds for it, the in-flight rule included.
  **An abandoned call is not free, and what queues behind it is not believed.** llama-server scores a cancelled batch to
  the end (a 1-document call after a 15 s abort took 181.9 s), so after a cut the next recall was cut 218 of 222 times,
  and the QUEUE drove the estimate: a 1-note, 801-token call cut behind two abandoned batches set it through `AtLeast` to
  24× the machine's rate, an ANSWERED call that had queued was believed whole at 4.4×, and the run ended at 5.7×, set by a
  cut 3,398-token call. So a call abandoned PAST its prediction leaves the router presumed BUSY for twice the time it ran
  (`QueueFactor`; Run 8's cut calls needed at most ~125 s in all at the answered rate, ≤ 65 s past the minute); one
  abandoned BEFORE it — a user's stop — only for the rest of what was predicted, since it proves nothing; and no
  presumption lasts past two deadlines, because a call timed past 1.5 deadlines (`RerankPace.ClockJumpDeadlines`) means the
  clock jumped — a laptop asleep mid-recall, IF `Stopwatch` counts sleep, which is believed and NOT verified on Windows — and
  teaches no rate. A call SENT while the router is presumed busy OR while another call is IN FLIGHT is possibly queued:
  cut, it teaches nothing; answered, it never raises the estimate, lowers it only as an unqueued answer of its kind would
  (a probe to it, a chunked call halfway, a pass-through not at all — it used to lower all the way, pass-through
  included), and does not end after-cut; and an answer ends the presumption only when its call was sent AFTER the
  abandoned one (`RerankPace.Ticket` carries the send time). A first call sized at the GPU seed on a far slower machine can
  outrun the presumption — a stated limit. **Skips are COUNTED and SAID** (`RerankPace.RecentSkips`, the last 20 recalls):
  the 判断 row reads the count — a lock and an array, nothing awaited — and says 「最近 N 次检索里有 M 次因为这台机器太慢跳过了判断」
  (`GgufCatalog.SkipNotice`), offering 内置 — to download, or to switch to when it is already on disk; when 内置 IS what
  skips, nothing to fetch and the truth said instead (`GgufCatalog.SkipAdvice`) — and 资源's badge recommends it
  too, BESIDE an installed reranker — the one exception to the one-reranker rule, whose premise ("any installed reranker
  measured better than none") the skips refute on this machine — and AHEAD of the embedder suggestion, which used to hide it
  on an install with no embedder (final review; `e2e-p52` case 6h asserts it with the embedder removed). Before, a skip
  reached only `state/logs` at Information:
  fail-open and unreported. **No GPU → the small reranker** (owner decision, same day; llama.cpp's mMiniLMv2 GGUF until
  `docs/judge-bench.md` Run 13 moved the role to 内置, the same model in process — `GgufCatalog.RerankerWithoutGpu` is
  `BuiltInJudgeSource.ModelId` since, the GGUF row `GgufCatalog.SmallReranker`, and the llama.cpp row's own suggestion,
  the skip notice and 资源's badge all name it through `GgufCatalog.ResourceIdForReranker`): `GgufCatalog.RecommendedRerankerFor` — the
  one writer 资源's badge and the 判断 row's suggestions read — picks `RerankerWithoutGpu` when `LlamaServerState.Gpu` is
  FALSE, i.e. `--list-devices` answered with its header and listed no device at all, OR when the pace skipped recent
  recalls, OR (since 2026-09-26, launch item (6)) when BGE was MEASURED too slow on this machine; otherwise BGE. **The
  device probe alone almost never fires**: the provisioned Vulkan build lists an integrated
  GPU as a device (this machine: `Vulkan1: Intel Arc`), so nearly every x64 laptop reads "GPU". On this laptop's Arc both
  rerankers were then measured SLOWER than its CPU — by the device measurement on the real binary (launch item (6),
  `docs/self-managed-llm-runtime.md` 2026-09-26, the Arc against the CPU WITHIN each run: mMiniLMv2 6.0× and 6.7×, BGE
  2.9× and 2.7×; with only the Arc visible the app chose the CPU for both and, BGE being too slow for the default page
  there, moved the badge to mMiniLMv2), and descriptively by `docs/judge-bench.md` Run 8b, a run recorded UNREAD (its
  rule was not read), whose ratios set its iGPU arms against another run's CPU and are not quoted. The household notes
  say 「mMiniLMv2 约 6–7 倍,BGE 约 3 倍」 — the within-run figures. So the app MEASURES a
  reranker's devices rather than reading the list, and the skip signal still catches a machine too slow on any device. The
  notes say so in one place — mMiniLMv2's row, with the configuration, labelled as one laptop's figures, BGE's row and the
  badge reasons pointing there; they said 「只有集成显卡的机器两者都还没有量过」 until 2026-09-26. Run 8b's accuracy figures
  are not quoted in household text. A list naming only NON-Vulkan devices (CUDA0, Metal, SYCL0…) is a build we did not provision and
  reads NOT KNOWN (`LlamaServerState.GpuFrom`), never "no GPU" — it read "no GPU" at first. The badge and the row read the
  runtime's MEMO of the binary's device list (`ILlamaServerRuntime.Gpu`), which `Invalidate` leaves alone by design: read
  from the cached state, every start, restart and model removal flipped the badge to BGE until a background probe
  finished. Not "n-gpu-layers = 0": Run 8 found llama.cpp offloads a big batch to any GPU it sees even then (~5 s against
  143–197 s with `device = none`). On that CPU mMiniLMv2 judged every recall (17.5 s median, found@8 180/240). **The
  household note, restructured** (review: the shared clause had grown to 978 characters inside one parenthesis, on three
  rows): ONE short shared clause (`RerankerLatencyCaveat`) says what a slow machine does — fewer windows, down to the first;
  the first recall after a launch can still wait the minute; one wait is damped, so a truly slow machine waits twice; one
  window each after a wait; skipped past ~48 s (half a minute right after a wait — the figure computed from the constants,
  so it cannot drift from the code); re-measured every ten minutes; skipped for a minute or two after a wait; the skips shown
  in the 判断 row — and carries `docs/judge-bench.md` Run 9's mixed-recall result (VALID, 1a22630: 30 short facts beside 30
  long notes, on the GPU; reading the long notes in windows did not significantly lower short-target found@8 — 94→91,
  101→99, 98→97 of 120 — with a loss of up to ~4–6 points not ruled out, so "no cost" is not claimed; long targets +30 to
  +69), in one sentence no stronger than those intervals, where it said 「长短事实混在一起的检索还没有量过」; Run 8's CPU figures, with
  their configuration, are mMiniLMv2's row's alone; BGE's row says what that run found for BGE and LAMAR's that it was not
  run there, each pointing at the row with the measurement. Unmeasured: the per-script rates beyond English and CJK; the
  skip, queue, probe, damping and 0.8 rules on a real CPU router (derived from Run 8 and reviewed against it); an
  integrated GPU other than this laptop's Arc (launch item (6) measured that one; Run 8b, unread, described it). Proof, `e2e-p52`: 6e (the
  deadline knob 12 s, a fake at 1.6 ms per pair token: all 5
  windows, all 5 again — the lone slow call not believed — then 4; still 4 after a fast pass-through big enough to teach,
  and still 4 after a 3.3 s call of 33 tokens, which the floor ignores; then a recall STOPPED by its client at ~55% of its
  call's cost, and the next recall at ~80% of it is sent and judged), 6f (6 s, 4 ms, a fake that scores one request at a
  time and finishes abandoned ones: the first recall ~17 s true, cut and unjudged; a recall at once after it sends NOTHING,
  its skip line naming the ~12 s presumed queue; once that passes, ONE window and a verdict, one "no verdict" line in the
  log), 6g (16 s, 2.2 ms: a pace learned on four English notes sizes two Chinese ones by their tokens — fewer windows and a
  verdict, where per-character counting sends all 10 and is cut), 6h (3 s, ~0.93 ms, eight ~950-character notes, one
  pass-through call ~2× the deadline: cut; skipped at once behind the queue, and the 判断 row and 资源's badge now saying so
  where neither did before; a SHORT-fact recall with ~1 s of the presumption left skipped too, its line "per candidate …
  (none is long)"; the big recall sent again and cut again — two waits; skipped behind that queue, then for the pace alone,
  fast, nothing sent; a short-fact recall that fits is sent and judged, and does NOT restart the interval; 30 s after the
  first skip a one-note probe, still slow, still skipped; skipped again at once; three ~840-character notes predicted at
  ~1.9 s — past the 1.5 s budget, inside the 2.4 s limit — sent and judged; after another 30 s, the fake fast, the probe
  re-measures and the same recall sends all eight and gets its verdict; TWO "no verdict" lines in all), 6i (6 s, a fake that
  answers at once but for one request stalled 9 s: a six-note pass-through recall judged; the same recall stalled and cut;
  once the presumption passes, sent and JUDGED — the lone cut damped; then two recalls at once, one stalled and the other
  queued behind it in the fake, both cut; once that passes, sent and JUDGED again — the second, sent while the first was in
  flight, taught nothing). Each rule of this round was confirmed to FAIL with its own change reverted, on a build of its
  own (2026-09-25): a send allowed whenever queue plus prediction fit — 6h's short-fact recall behind the queue sent and
  judged; the counter unread and the badge's exception off — 6h's 判断-row and badge assertions; the in-flight mark
  removed — 6i's last recall skipped; a user's stop presumed at twice its run — 6e's last recall skipped; a lone cut
  believed in full — 6i's third recall skipped, and 6h's second cut never sent; the one-window limit held at half the
  deadline — 6h's three-note recall skipped; every sent call restarting the interval — 6h's probe never sent; the skip
  removed — 6f's and 6h's skips each sent and waited out. Each earlier case was confirmed to FAIL with its own rule removed — the floor,
  the after-cut rule, the lone-raise damping, the pass-through no-lower, the script weights — and only its own assertion.
  Not driven, each for a stated reason: the cap on the presumption and the clock-jump rule bind only when a call is timed
  past its deadline, which the deadline itself prevents unless the clock jumps — the suite cannot put the machine to sleep;
  a queued ANSWER lowering the estimate only as its kind allows needs a second call answered while another is in flight
  and then a recall whose admission differs between the two estimates, and the rule can only keep the estimate higher —
  its sibling, a queued CUT teaching nothing, is 6i's; and the re-measure line of a probe that IS the whole one-window
  call needs a single-candidate recall whose one window is predicted past the limit (≥ ~35 ms per pair token for a
  ~850-token pair after a wait, ~11× Run 8's BGE on its CPU) and a probe that then answers in time — a fake can stage it,
  at the cost of another re-probe interval of suite time; its format is `PACE_REMEASURED`'s, shared with the partial
  probe's line that 6h asserts. The no-GPU
  recommendation: `e2e-p51`, whose stand-in `llama-server.exe` is a copy of Windows' `more.com` printing a planted
  `--list-devices` file from its working directory — no device, then a CUDA device only, then a Vulkan GPU, then
  unreadable — asserting mMiniLMv2 with its reason on the badge and the 判断 row, still mMiniLMv2 after a model removal
  invalidates the runtime's state, BGE and no machine claim for the CUDA list, BGE for a GPU and for unknown, and nothing
  beside an installed BGE; confirmed to FAIL with `RecommendedRerankerFor` returning BGE, with a CUDA-only list read as "no
  GPU", and with the badge reading the cached state. The bench cannot see the pace in its tables, so judge-bench counts the
  pace's Information lines in every arm's log and VOIDS a run in which they fired, and refuses a VOID run as a `--baseline`
  (`docs/judge-bench.md`, "The bench and the pace").
  `GATHERLIGHT_RERANK_CHUNKING=off` (`RerankChunking`) is KEPT as a measurement knob so the bench can reproduce the cut
  Runs 2–6 measured; judge-bench's `rr`/`rrf` arms pin it off and `rrk` on. **Its third value, `d177`, is a
  measurement mode too** (`085398c`, for `docs/judge-bench.md` Run 10), never a default: `RerankInputCap` prepares the
  candidates exactly as `on` does — the query fitted, NFKC under a declared window, NOTHING cut — but no
  `ChunkedScoreProvider` wraps the reranker, so there is no pace and no `RerankAdmission` (no skip), and Lyntai's own
  D177 segmentation does the reading instead, configured on the `llamacpp-rerank` registration in that mode only
  (`RerankChunking.LyntaiSegmentation`): under a declared window (mMiniLMv2) a 506-character pair bound, the query at most
  half; without one (BGE, LAMAR) a 4,090-character bound, the query at most 2,045 and each document piece at most 1,000;
  overlap 0.25, at most 5 pieces. Set only in `d177`, so `off` still reproduces the cut and `on` is never segmented
  twice. It is announced at startup like the other two values (`rerank chunking = d177`), and judge-bench's `rrd` arm
  pins it. Run 10 kept ours over it — workaround (6) has the result. **Two traps met measuring it**: llama.cpp's
  scores drift in the third decimal between identical calls, so an A/B that must be byte-identical needs identical
  requests to get identical replies (the bench's `--rerank-memo`); and that memo's proxy, on Node's default keep-alive
  agent, lost one request in each run (of ~780 and ~1,500) before the router saw it — each an abstention that voided
  Run 6b — found only by
  reconciling the proxy's forwards with the router log's `proxying request to model` lines, which the bench now does
  itself. The memo shares only a 2xx: it once shared refusals too, handing one arm's failure to every later arm sending
  the same bytes. Proof: `e2e-p52` cases 6b/6c (a long fact reaches `/v1/rerank` as windows, tail included; a short one
  exactly as written), confirmed to FAIL with the knob off. **What reaches `/v1/rerank` is half a test**: a fault in the
  provider (a window count the scores do not match, an exception) is fail-open, so the engine's page stands and every
  window assertion stays green — confirmed by making the provider throw. So 6b/6c also assert the recall came back
  judged (`answered`, which Lyntai sets only when a verdict was judged — true from 3.2.0 through 3.5.1), and case 6d asserts the MAPPING: a long
  note whose only rewarded text is in its TAIL window, among 11 candidates for a page of 8, is on the page only when
  that window's score is credited to it — confirmed to fail under the cut, a first-window mapping and a mapping off by
  one window. The fake scores it 9.0 against the fillers' 3.2 so no tie is relied on (Lyntai's score ranking is a
  stable sort, so a tie would test the engine's order instead). When chunking is ON and `RerankVerification.Providers`
  finds nothing to wrap, building the verifier THROWS — the cap no longer cuts, so a silent miss would send long
  candidates whole; not drivable in e2e (it needs the registration and the wrapper to disagree), a stated gap.
  **The limit is PER MODEL, and it comes from the model's catalogue row** (2026-09-24). mMiniLMv2
  (`docs/judge-bench.md` Run 4) serves 512-token slots, and at the 1,000-character cap dense Chinese is 781 tokens:
  the whole call is refused — 400 under the 4096 preset, 500 「too large to process … batch size 512」 under its
  own — fail-open, so every recall surfacing a long fact would go unverified in silence. (Lyntai 3.2.0 read that 400's
  「larger than the max context size」 as a HOST fault, `Failed`, counted toward benching the reranker for every caller,
  logged at Debug; 3.3.0 reads it as `ContextWindowExceeded`, which advances without blame, and logs a failure that
  will repeat at Warning — Lyntai `docs/FIXES.md` 2026-09-24. The 500's 「physical batch size」 read `Failed` through
  3.4.0 and reads `ContextWindowExceeded` since 3.5.0 — Lyntai `docs/task-archive.md` Part 310's item, closed there as
  Part 307 — so it no longer benches `llamacpp-rerank` or `llamacpp-embed`, and the scoring verifier logs it at
  Warning. The call is refused either way.)
  `GgufModel.ContextTokens`
  declares the window, and `GgufCatalog.DeclaredWindow` is the ONE read behind both halves of the contract: the
  preset launches the model with that `ctx-size`/`batch-size`/`ubatch-size`, and `RerankInputCap` fits every pair
  to it. Never a branch on the id. On this tokenizer family (XLM-R SentencePiece, no byte fallback) an
  NFKC-normalised text costs at most its UTF-16 length + 1 in tokens, and a pair adds 4 special tokens, so query +
  document ≤ window − 6 CHARACTERS OF THE NORMALISED TEXT is a hard bound with no `/tokenize` round trip: the query
  gets at most half (253 at 512), each candidate the rest (≤ 506 − the query's length, never over 1,000). Verified on
  the real binary under the new preset: a 512-token pair is served and 513 refused (`n_ctx_slot = 512`), and the app
  bound to the catalogued id recalled a 1,236-character Chinese fact with a 347-character query and got a verdict.
  **The count is taken AFTER NFKC, and the normalised text is what is sent** (2026-09-24). The tokenizer normalises
  with `nmt_nfkc`, so a compatibility character EXPANDS — ℃ → °C, ㎡ → m2, ㍿ → 株式会社 — and a raw count
  undercounts: on the real mMiniLMv2 `/tokenize`, a lone ℃ or ㎡ is 2 tokens, ﷺ 4, ㌚ 6 per UTF-16 unit, and a pair
  of 506 raw characters dense in ℃ came to 1,006 tokens and was refused (`500 … too large to process`), while the
  same pair fitted on its normalised text came to 510 and was served. Normalised, the bound held with NO exception
  over every assigned BMP scalar and every astral one FormKC changes (64,012; .NET 10's FormKC equal to Node's NFKC
  on all of them), so no slack margin is kept. Sending the normalised text loses nothing the model reads — the token
  ids are identical for all but 95 of the 4,928 changed scalars, characters newer than the model's normalisation
  table (㋿) plus fullwidth ～. The sweep, that pair, and the 4096-vs-512 launch latency re-run with
  `dev.mjs rerank-window` on the pinned GGUF (`docs/self-managed-llm-runtime.md` records the method and the run).
  `e2e-p52` case 6c writes a fact dense in ℃/㎡/㎏/㍿ and fails with the raw count. A
  declared window ≤ 6 (no room for a pair's overhead) reads as NO window (`RerankInputCap.UsableWindow`, also
  applied by `DeclaredWindow`), rather than cutting every query and candidate to nothing; no row declares one, and
  no suite can drive it. **Stated limits**: a row WITHOUT a window keeps the 1,000-character cap, an untouched query
  and un-normalised text, exactly as before — at the costliest rate measured (㌚, 6 tokens) ~680 such characters in
  one candidate could still overflow 4096, not guarded; a GGUF the household dropped in has no row, so it gets no
  window: named with "rerank" it is served at 4096 with the 1,000-character cap and refused on long input, as
  before; named without it — this model's other quants included — `GgufKind` types it CHAT, so it is never used as
  a reranker; either way the fix is a measured row, not a guess from its file name; the character bound does NOT
  transfer to a byte-level tokenizer; and the windows (above) are measured on notes of one length band only — long
  and short notes mixed in one recall (measured since, in Run 9: no significant loss on the short targets, a loss of up to
  ~4–6 points not ruled out — every reranker's note says so) and notes past five window-lengths are not. A CPU-only
  machine was measured in Run 8 (one laptop's CPU, 60 long notes): mMiniLMv2 judged every recall in windows, found@8
  180/240 against no judge's 104; BGE waited out the minute on 230 of 240 and ended at 104 — which is why the pace now
  skips; how soon the pace settles where calls are SIZED is unmeasured there (mMiniLMv2 never needed sizing). The row's id is the UPSTREAM file stem, with no "rerank" in it, on purpose: a catalogued
  id is typed by its row, and the upstream stem also catches a household who drops the file in under its own name
  — an id of ours containing "rerank" would leave that file uncatalogued and typed CHAT, the hazard that made Run 4
  rename it. Proof: `e2e-p52` case 6c (every pair at the fake router fits, query included, windows too; BGE,
  declaring no window, gets 1,000-character windows and an uncut query) and `p51`'s preset block (the row's 512, not
  4096) — both confirmed to FAIL with the row kept and the window unwired.
  And because a reranker hands TAGGING to the CLI, a signed-out or missing CLI means no tagging at all —
  fail-open, unreported — so the 判断 row, the bind toast and the startup warning read the CLI's CACHED probe
  (`MemorySources.CliTaggingNow`; a panel must not await a process) and say whether tagging is happening, and
  nothing when nobody has probed yet (`e2e-p52` case 7, signed out against signed in; the unknown state is not
  drivable — the startup CLI step always probes).
- **A model call INSIDE a tool call needs a clock that ends first — two equal clocks lose the page.** Lyntai's seams
  fail open on their OWN timeout and propagate only the caller's cancellation (`catch (OperationCanceledException)
  when (ct.IsCancellationRequested) { throw; }` at every layer), which is right. But `ToolRegistry` links every tool
  call to 120 s and Lyntai's provider timeout is also 120 s, started LATER (at the HTTP send), so a hung judge was
  always ended by the TOOL's deadline: a caller cancellation to the engine, propagated, and `FactIndex.RankAsync`
  caught it and served the page from FTS (docs/judge-bench.md Run 5's arm logs: "recall failed; falling back to
  FTS", the token's "The operation was canceled." rather than `HttpClient.Timeout`'s message, 120 s after the last
  answer). `VerificationDeadlinePolicy` gives every verifier half the tool's deadline and turns its own expiry —
  the caller's token still live — into NoOpinion, so the engine's page stands; a real caller cancellation still
  propagates. Its 60 s rests on recalls of at most 60 candidates (the bench fixture's, the household's 16 facts): a CLI
  verification shown up to 400 — a recall naming a kind, or asking for 34 or more — is unmeasured, and a verdict that
  would have arrived between 60 and 120 s is now dropped as NoOpinion where it used to be delivered.
  Annotation deliberately has none: there the tool's deadline fails the index, `graph_ref` is left empty
  and the startup back-fill re-indexes the fact WITH subjects, where a deadline would index it permanently without
  them. **That was true of a NEW fact only until 2026-09-24**: an EDIT (same kind+topic) kept the ref to its previous
  content's node — `RememberFactTool` wrote the ref only when it was non-null, and `LearnAsync` updated the content
  without touching it — and the back-fill revisits only EMPTY refs, so the new content and its subjects stayed out of
  the graph until a rebuild. The memory import had the same hole without any failure, since it never indexes. Now the
  tool writes the null and `LearnAsync` clears the ref of a row whose content CHANGED; `e2e-p48` case 9 hangs the
  annotation of an edit, edits a second fact by import, and asserts neither ref still names its previous content's
  node and both facts are re-indexed with their new content at the next start (the edited one with its subject).
  **The import no longer waits for that start** (2026-09-24): `POST /api/memory/import` starts a DETACHED, serialised
  back-fill (`DetachedFactBackfill` → `SyncAsync`, never a rebuild — decay and links survive), and so does the startup
  seed, which runs after `FactIndexStep` and used to leave its facts keyword-only for a whole life. Not bound to the
  request, not persisted: the rows are the state, and a run cut short leaves empty refs the next start finishes. Not
  added to `MemoryService.ImportAsync` itself, because the backup import rebuilds inline and a back-fill racing that
  rebuild would remember facts twice. `e2e-p14` imports an edit and a new fact and sees both indexed with their new
  content in the same life, and a seeded install's fact likewise; both confirmed to FAIL with the call removed. The test
  knob `GATHERLIGHT_JUDGE_DEADLINE_SECONDS` can only shorten it. `e2e-p52` case 3b hangs the chat judge and asserts
  a graph-ranked page in seconds; with the policy removed it gets `ranked: fts` after 120 s.
- **A recall layer's BACKEND is a SOURCE, and a source serves a layer by existing.** One interface per layer
  (`Agent/Llm/Sources`: `IMemoryJudgeSource`, `IMemorySemanticSource`, sharing `IMemorySource`), one class per
  backend, a **static catalog** (`MemorySources`) — never a predicate over capability strings. That earlier
  predicate was wrong in both directions at once: a machine whose models were all catalogued embedders got a
  dead switch with no explanation, and the first UNCATALOGUED embedder passed straight through the check
  written to stop it, into a fail-open policy. 语义 DOES have a Claude arm now (`ClaudeCliSemanticSource`, rephrasing
  rather than embedding) — for a while it had none, and the panel explained the absence instead, which was
  the wrong shape: an absent class is a fact about what we wrote, never a reason to withhold a choice. What
  the catalog still guarantees is that nothing FILTERS — a layer's arms are the classes implementing its
  interface, never a predicate over capability strings. **Static rather than a DI
  collection** because `GatherlightApp` wires from it *inside* `AddLyntai(b => …)`, while the container is
  being built: a DI collection would need a second registration-time list, and two lists for one set is the
  drift `check-ui-registry` exists to catch. Sources take runtime deps as a per-call `MemorySourceContext`.
  **A source also declares whether binding it needs a RESTART** (`TakesEffectOnRestart`): true for an arm
  whose `Register` wires something into the container, which is built once; false for one whose effect is at
  WRITE time and reads the saved binding per call. The panel infers "running" for 语义 from whether the
  container holds an `ISemanticMemory`, so the CLI arm — which registers nothing — read as permanently
  un-applied and the banner asked forever for a restart that would change nothing. That is exactly the
  failure `MemoryRecallPanel`'s own comment records about a remembered model compared against a null running
  one, recurring one case over. The answer lives on the SOURCE, not in an `if (id == "claude-cli")`, because
  a per-id branch is the if/else chain this catalog exists to replace.
  Bindings live in `settings.json` (`memory.judgeSource`/`judgeModel`/`semanticSource`/`embeddingModel`) —
  consumed at DI registration, before the DB opens — while 判断's on/off stays live in `app_config`, and the
  console reports the two as different kinds of change. **`memory.judgeTransport` is legacy**, resolved on
  read (`cli`→`claude-cli`, `local`→`ollama`) and never written again; its `judgeModel` belonged to the LOCAL
  arm alone and was deliberately REMEMBERED across a switch back to the CLI, so reading it unconditionally
  hands an Ollama model id to Claude — a badge reading `Claude CLI · gemma3:4b`, caught only against a real
  data folder and now pinned by `p51`'s case I on a pre-seeded legacy config.
  **Configured is not the same as bound.** `IsConfigured` asks whether the backend can be wired at all:
  runtime present, any model of the layer's kind. The resolvers also ask `HasModel` for the BOUND one. It is a
  separate member because the bind endpoint asks `IsConfigured` before it saves the new model. Without it, a
  deleted chat judge stayed wired while a reranker remained, and every recall was NoOpinion. The bind endpoint
  asks `HasModel` of the NEW model too, so what bind accepts the resolver keeps — a model the router listed from
  llama.cpp's own cache used to bind and then fall back at the next restart. WHY a model is not there is the
  source's clause, `WhyNotHere` (wrong kind; not there and 资源 can fetch it; not there and only the household
  can put it there), shared by the bind refusal and the startup warning. What the startup announces is exactly a gone or
  wrong MODEL — with what the CLI fallback costs, and for 语义 the restart and rebuild that bring it back. For 判断 that is
  `JudgeFallbackStep` (round 6), asked of whichever source the settings NAME — llama.cpp's model or 内置's reranker files
  — where it had been a block in `LlamaWarmStep` reading the llama.cpp source by id; 语义's embedder is still
  `LlamaWarmStep`'s to announce. The text did not change, so `e2e-p52` cases 10 and 10c pin it as before, and `e2e-p56`
  case C pins the 内置 branch (its files gone: only the checking moves, the tagging was on the CLI all along).
  **And whether the CLI it falls back to can do ANY of it.** The warning said what the CLI takes over and never
  whether it could: a missing or signed-out CLI tags nothing and checks nothing, fail-open, so the sentence
  promised work that was not happening. It now reads the cached probe through `MemorySources.CliTaggingNow` —
  the same reader as the bind toast and the reranker's warm warning — and says nothing when nobody has probed.
  It uses that state's `Why` and `Fix`, never its `Text`, whose 「检索时的核对照常」 is true beside a running
  reranker and false after a fallback that moved the checking to the same CLI.
  Proof: `e2e-p52` cases 10 (a gone CHAT judge, CLI signed in — also the control for the next), 10b, and 10c (a
  gone RERANKER, CLI signed out: only the checking moves, and nothing is tagged or checked until it signs in —
  confirmed to FAIL, on that assertion alone, with the appended sentence removed). **Gap:** the branch where 判断
  is switched OFF is asserted by nothing — the switch lives in
  `app_config`, so a fixture would have to set it in the database before the boot that falls back.
  **Residuals, stated rather than fixed:** a missing llama.cpp RUNTIME and the
  built-in embedder's missing FILES still fall back silently at startup; the 内置 reranker's files present but DAMAGED
  pass `HasModel`, so there is no fallback — its lazy load fails at the first recall, logged at Warning once, and the
  judge verifies nothing (fail-open, a `NotConfigured` answer); and a hand-deleted file under a RUNNING
  embedder leaves 语义 wired for the rest of that run while the panel, which resolves, says it is off, and the
  rebuild refuses with 「尚未启用」. Only a hand deletion reaches that — 资源 refuses to delete a bound model.
- **ONE control writes the judge's model.** `DefaultModelByConsumer["memory"]` and cortex's live
  `llm.model.memory` were two writers and cortex won, so a household who set 记忆判断 to `haiku` and later
  moved the judge local had the router asking Ollama for `haiku` — fail-open both sides, hence zero calls and
  no error. `POST /api/manage/memory/layer/judge` writes source and model together; the cortex row is gone.
  The policies' own `Model` stays **null** so the router still resolves per consumer.
  **What was written for one binding must not be read by another.** When 判断 FALLS BACK to the CLI (a chat
  GGUF bound, then its runtime deleted), both the saved `judgeModel` and the live key still named the GGUF —
  the badge read `claude-cli · <gguf>` and the CLI was asked for it, zero enrichment and no error. So
  `ResolveJudgeModel` counts the saved model only when the saved source is the one that resolved, and the
  live key is a ROUTE (`llm.route.memory`, Lyntai D176 since the 3.4 bump) naming the PROVIDER it was written
  for, which a router that does not hold it ignores — the CLI's after a fallback from a GGUF, and the running
  judge's between a rebind and its restart. By provider, not by source: a reranker and the CLI arm both tag on
  the CLI, so a reranker's route — the CLI's model on the CLI — is right even after its runtime goes. Until the
  bump an app-side store withheld the model-only key by CLIENT to the same effect (workaround (2)). `e2e-p52`
  case 4 fails with either half broken — the route's provider (a chat GGUF's route naming the CLI, confirmed on
  the bump) or the saved-source rule (confirmed before it, against the store the route replaced).
  **The trap (fixed upstream in Lyntai 3.1, its D87):** a named client used to narrow its provider POOL but
  reuse the global candidates, so a client pooled over a local provider still resolved candidates from
  `UseDefaultCandidates("claude-cli")` — a provider absent from its own pool. Every call logged `router:
  skipping claude-cli — no provider with this id registered` and failed, and since both policies are
  fail-open the symptom was **zero model calls and no error**. It was contained by appending each source's
  provider to the GLOBAL list (Lyntai Part 93), which also let the default client — the scorers — fall back
  onto a local judge model nobody chose for them. Since 3.1 a name narrows the candidates too, so the
  widening is gone and the global list is `claude-cli` alone. **Verify this class by ROUTING, not
  registration**: the broken version registered cleanly. `e2e-p52` counts the requests arriving at a fake
  llama-server and asserts the judge's annotation reaches it through the named client, with the judge's
  model. An
  EMBEDDING model is refused as a judge by name — installed, well-formed, and unable to answer a judgement,
  which fail-open would turn into recall that quietly never improves.
  **A memory bundle was a third writer**: it exported and imported every `llm.model.*` key, straight into
  `app_config`, including `memory`, whose meaning depends on a `settings.json` binding — one that
  `/api/memory/export` and the startup seed do not carry at all, so the key alone named a model for a
  backend the target install never bound. It now carries a model key only if cortex can set it, exported by
  cortex's own list (`ModelKeys` — each key as cortex stores it, so the scorer as its live route) and imported
  through cortex's writer (`SetModelFromKey`). That is one rule for "the household's tuning", and it refuses
  `memory` for the same reason the cortex row is gone. Proof: `e2e-p14`.
  **The whole-install backup carries BOTH files, and the bundle's own filter isn't enough there.**
  `app_config` is only MERGED (the memory bundle inside the zip is the same upsert as above) while
  `settings.json` is copied wholesale — so a target's own `llm.route.memory`, bound before the restore,
  survives untouched beside a freshly restored binding it can now disagree with, and a route is read wherever
  its PROVIDER is held (a target on the CLI at opus, restored from a backup on the CLI at sonnet, keeps judging
  on opus). `BackupService.ImportAsync` reconciles by deleting the route — and any leftover pre-route
  `llm.model.memory` — right after it copies `settings.json` in: after the restart the restored binding is the
  only answer, and before it the running wiring's own default answers, which belongs to the running client —
  consistent either way. Proof: `e2e-p47`.
- **TWO RERANKER JUDGES, ONE CHAIN** (round 6). 判断 checks with a reranker two ways: llama.cpp's (`LlamaCppSource`, a
  `/v1/rerank` endpoint) and 内置's (`BuiltInJudgeSource`, the in-process ONNX mMiniLMv2). Everything past the model is
  ONE writer, `RerankVerification`: `Build` makes the verifier — `RerankInputCap` fitting each pair to the model's
  declared window, `ChunkedScoreProvider` reading a long candidate in windows, `RerankAdmission` skipping what the machine
  cannot judge in time, `ScoringVerificationPolicy` endorsing a page (`RerankVerification.EndorseCount`) — and `AddPace`
  registers the one `RerankPace`. A source supplies its provider id, its window and where its pace starts, and nothing
  else; `JudgeWiring.Reranker` is the factory both call, and the screen is `RerankScreen` for both (llama.cpp scores it
  over HTTP, 内置 in process). It was llama.cpp's private code until the second source arrived, and COPYING it was the
  alternative: every link is fail-open, so a copy that drifted would make one judge quietly worse with every check green.
  **The in-process scorer adds what only it needs** (`InProcessReranker`, measured on the real export,
  `docs/self-managed-llm-runtime.md` 2026-09-28): passes of 8 documents, longest first, because Lyntai's provider runs a
  whole call as ONE pass and ONNX Runtime's CPU arena keeps what its largest pass needed (48 full windows in one pass took
  a process to 2.4 GB private); each call off the calling thread behind a one-slot gate, the token checked between passes,
  because Lyntai's provider runs on the calling thread and checks the token only at entry — so a deadline could never end
  it; loaded LAZILY, a load failure a `NotConfigured` answer logged once, because Lyntai's eager `AddOnnxProvider` would
  turn a damaged file into an app that does not start. Its pace is built with `abandonedCallsRunOn: false` — an abandoned
  call stops at its next pass, so a cut presumes nothing busy (see the pace bullet) — and STARTS from this machine's CPU,
  timed in process at the pace's first use (`InProcessReranker.MeasurePaceSeed`: eight full windows of dense Chinese,
  the pace's unit, the same floor as llama.cpp's device seed, `RerankDeviceVerdict.NeverFasterThanTheGpuFigure`) — never
  the llama.cpp device meter, which has nothing to measure there. The seed is one call timed at one moment: a start under
  contention read 394 ms per 1,000 pair tokens where a quiet one read 150, which only makes the first sizing more careful.
  **Its window is a SHARED DECLARATION**: `BuiltInJudgeSource.Window` is `GgufCatalog.DeclaredWindow` of the same model's
  GGUF row (512) — the same checkpoint and tokenizer vocabulary, so `RerankInputCap`'s NFKC character bound holds — and
  the export's own window, which Lyntai reads from its files (514 positions narrowed by `tokenizer_config.json` to 512),
  is checked against it at load. Proof: `e2e-p56`, over a tiny but real export (`_tiny-cross-encoder.mjs`: a real ONNX
  graph and a real Unigram `tokenizer.json`, the scores chosen by the suite), which runs the real ONNX Runtime and
  Lyntai's real provider and tokenizer. **Real-binary only, stated**: that the pinned 136 MB export loads and passes the
  screen on its own weights, its memory and its CPU speed — by hand, in the runtime doc, and its judging in
  `docs/judge-bench.md` Run 13; and the skip notice when 内置 ITSELF skips (`GgufCatalog.SkipAdvice.None`: nothing to
  fetch, the Claude CLI or 判断 off, and — where llama.cpp sees a GPU — that a discrete one runs llama.cpp's rerankers much
  faster), which needs a scorer too slow to fit and was verified by reading.
- **A reranker verifies; it never annotates.** A cross-encoder scores (query, document) pairs and never
  generates, so it can do the half of 判断 that checks a recall and none of the half that tags a write — the
  subject handles need a model that writes. A reranker binding is therefore TWO backends, and `JudgeWiring`
  exists to say so: each judge source states its whole wiring (annotation client, annotation model, verifier)
  instead of `GatherlightApp` branching on "is this a reranker", the if/else chain the source catalog replaces.
  For a reranker, `LlamaCppSource` annotates on the default client (the Claude CLI) with
  `MemorySources.DefaultJudgeModel`, and verifies through Lyntai's `ScoringVerificationPolicy` over an HTTP
  provider of its own (`llamacpp-rerank`, producing scores). `Wiring` and `Register` branch on the same
  `IsReranker` over the same context, and must: `ScoringVerificationPolicy` THROWS at construction when its
  provider id names no registered backend. `e2e-p52` case 6 boots a server bound to a reranker and proves both
  halves by ROUTING — a fact write makes no chat call to llama.cpp and is tagged by the CLI on `haiku`, and a
  recall's `/v1/rerank` request carries both the query and the written fact's CONTENT (a token only its content
  holds, not its topic). One fact, so it proves the reranker reads content — not that every candidate is sent.
  **`llm.route.memory` is the ANNOTATION route, never the reranker's id.** The binding writes
  `AnnotationProvider(model):AnnotationModel(model)`, which for a reranker is `claude-cli:haiku`. Writing the id
  would hand it to Claude on every fact write: fail-open, zero tagging, no error; and writing llama.cpp's provider
  would name one the tagging client's router does not hold, so the route would never be read. `p52` case 5 calls
  it THE TRAP and reads the key from the database, because no API response carries it. The route names a
  PROVIDER (previous bullet) for the same reason: a reranker and the CLI arm both tag on the CLI, so a reranker's
  route stays right even after its runtime goes.
  **`ChecksOnly` is STATED beside `AnnotationModel`, never inferred.** The bind toast said 「标注与核对」 for
  every binding, which a reranker made false. The first fix DERIVED "checks only" as "the annotation model
  differs from the bound one" — which reads any source whose `AnnotationModel` merely normalises a name (an
  alias, a case fold) as checks-only, and the toast would then tell that household its tagging had moved to
  Claude. It defaults to false, and `LlamaCppSource` overrides it next to `AnnotationModel`, both from
  `IsReranker`, because the two answer one question. What the toast, the cost line and the reranker notes say
  about the tagging half is ONE clause, `MemorySources.CliTaggingCost` — including that it spends the account,
  which all three once left out beside a checking half saying 不消耗账号额度, so the only quota sentence a
  household read about this binding was the reassuring one. `p52` case 5 pins it in all three.
  **A reranker is SCREENED before it may bind**, because "it returned scores" is not "it ranks": Lyntai's own
  rerank screen found a converted GGUF that loads, scores and ranks BACKWARDS, and a fail-open verifier turns
  that into recall that quietly gets worse. The pair (`RerankScreen.Query`, `RerankScreen.Documents`, shared by both reranker judges) is built so that every
  cheap way to pass fails: the answer is SECOND in input order, so a model echoing input order fails, and the
  distractor shares MORE of the query than the answer does (distinct characters 1.000 against 0.667, bigrams
  7 of 8 against 5), so ranking by overlap puts the distractor first. **The first pair was passable by
  overlap** — its answer won on overlap (0.750 against 0.125), so a lexical model passed it — which is what a
  screen that "works" looks like while checking nothing. It asserts ORDERING only, never a margin (a
  household-dropped reranker may score on another scale), and every document must be scored exactly once,
  because llama.cpp's `relevance_score` is a raw logit that can be negative and an unfilled zero could outrank
  it. Measured on both real rerankers (`docs/self-managed-llm-runtime.md` §2026-09-23: the answer ahead by
  4.131 and 3.400, the reversed scores failing); `p52` case 5 refuses an overlap model and a backwards one,
  quotes a refusing server's own words, and calls a short reply unusable rather than a failed self-check.
  **`EndorseCount` is the recall page** — `RecallFactsTool.DefaultRecallLimit`, 8, read from the tool rather
  than restated. It is a constant because it cannot be anything else: the verifier's request carries no limit
  (Lyntai never tells a verifier what the caller asked for), and endorsing MORE than a page replaces the
  ranking instead of refining it — the partition's documented cost. Held by construction rather than by a
  suite; its consequence is measured in `docs/judge-bench.md` Run 2, which also says no other limit was.
  **Preset and warm are launch CONTRACT, like `--n-gpu-layers`.** `reranking = true` plus a 4096
  `ctx-size`/`batch-size`/`ubatch-size` — or the smaller window the row declares (the capped-input bullet) — go on
  a reranker's section only — a cross-encoder needs the whole pair
  in ONE physical batch — and `p51` pins `reranking = true`, both batch sizes, and that neither `embeddings`
  nor `reranking` crosses kinds. A reranker warms through `/v1/rerank`, never the chat route: a chat warm sent
  to a reranking child gets a **500** even though the router loads the model, so it warms AND reports failure
  (measured, `docs/self-managed-llm-runtime.md`); `p51` counts the warm request at a fake router and asserts
  its path.
  **Partition leaves FIRST PLACE to the engine, which is why a reranker's gain is found@8.** Its verdict is
  one bit per candidate over a full page, so it decides WHICH eight facts make the page and the engine decides
  their order: found@8 +33.3 / +33.8pp, top-1 +3.8 / +4.6pp (LAMAR / BGE, `docs/judge-bench.md` Run 11 on Lyntai
  3.5.1; Run 2 on 3.2 read +34.6 / +32.5pp and +2.9 / +4.6pp). The scores it
  computed are not used for ordering; whether they should be is a design question that run raises and does
  not answer.
- **A REBUILD SERVES BOTH 语义 ARMS, and guarding it on `_semantic` served only one.** `_semantic` is
  non-null exactly when an EMBEDDER was registered at startup; the Claude CLI rephrasing arm registers
  nothing by design, so for a household bound to it `ReindexSemanticAsync` returned 0 and did nothing —
  while the endpoint still accepted and the detached run still "finished". The effect: binding that arm
  reached FUTURE writes only, an existing knowledge base could never gain phrasings, and the single control
  offered for exactly that reported success having done nothing. So the question is not "is there an embedder" but
  "is anything bound that a pass would re-derive". **They do NOT cost the same thing, and routing both through the
  rebuild was the next mistake.** The rephrasing arm's output is a knowledge COLUMN (`aka`, picked up by the FTS
  trigger on UPDATE) — none of it lives in the graph — so rebuilding to produce it discards every decay position and
  link the household has accumulated in exchange for nothing; the CLI arm gets `ExpandEachAsync`, which touches only
  the column. An embedder's vectors DO belong to the graph's entries, and until Lyntai 3.5 the only way to recompute
  one was to re-remember it — so that arm's reindex was the destructive rebuild, an annotation per fact included. Since
  D194 it re-embeds every entry in place (see «The fact index is DERIVED»), so NEITHER arm's reindex discards anything
  the graph has learned, and neither annotates: the back-fill that follows an embedder's pass, for facts with no index
  entry at all, is the one part that does. That is not a tidiness point: the
  over-broad version made "bind it, then rebuild" advice with a hidden price, and made measuring the arm's
  own benefit an operation nobody should agree to. **The rephrasing pass counts what it STORED**: it counted the facts
  it VISITED, with `ExpandAkaAsync` swallowing every failure, so a signed-out CLI — which rephrases nothing — was
  reported as 「N 条事实补写了检索用的说法」. It now reports stored and failed apart, and a pass that stored nothing is
  an error naming the likely cause (`e2e-p48` case 12, a FORCE_ERROR fact and a signed-out stub, confirmed to FAIL on the
  old count). Proof lives in `e2e-p48`, which writes facts BEFORE binding the arm
  and was confirmed to FAIL against the old guard — the phrasings stay empty. Note this also makes the
  advice "bind it, then rebuild" true; it was not, and the panel gave no sign. **And the SAVED arm picks which pass
  runs, never what is wired** (2026-09-27). `_semantic` is the embedder this process STARTED with, and the rephrasing
  arm is live from its bind, so between a rebind from an embedder to the CLI arm and the restart both are true — and
  choosing by `_semantic` re-embedded every entry with the arm just left and reported 「5 条向量已原地重新计算」 for a
  layer that now stores phrasings. The reindex's embedder gate (`EmbedderReadyAsync`) is likewise asked only for an
  EMBEDDER arm: with the old embedder down it refused (409) a rephrasing pass that never calls it. The reverse rebind
  (CLI arm → an embedder) is the 409 「请先重启服务」 (case 11d). Proof: `e2e-p52` case 11e, on the server case 11d
  leaves running with an embedder wired — (a) confirmed to FAIL with the arm chosen by `_semantic` (the summary, 5
  content embeds, no phrasing), (b) with the gate asked for every arm (409).
- **A rebuild runs detached, and the console reports COVERAGE rather than a run history.** `ReindexSemanticAsync`
  can take minutes — it used to re-remember every fact (a model call each with enrichment on); it is a Claude call per
  fact for the rephrasing arm, and an embed per entry for an embedder (2.6 s per 100 short facts on one GPU, 5.6 s on
  the CPU) — so running it inside the POST gave a greyed-out button for minutes, indistinguishable from a hang, over a
  request the browser may abandon while the server carries on. It returns 202 and reports progress through `GET /api/manage/memory`; the status is
  deliberately **not** bound to the request's `CancellationToken` (that would cancel the work when the browser
  stopped waiting) and deliberately **not** persisted: the run is an in-process `Task`, so a stored `running`
  would outlive the work it describes — the same lie `SelfHealStateStep` refuses. The run's STATUS needs no
  durability; its OBLIGATION does, and each path keeps it in state that already exists. An interrupted REBUILD heals
  itself: `RebuildAsync` clears every `graph_ref` up front, which is exactly what the startup back-fill repairs
  (measured 2026-08-21: 2/6 → 6/6 across a restart). An interrupted RE-EMBED clears nothing, so no back-fill would ever
  return to it — the entries after the cut would stay on the old model with their refs intact — so the pass records the
  vectors as owed in the layout marker before it starts (a token of its own, `FactIndexLayout.PassPrefix`, read as owed
  by `FactIndexLayout.IsVectorsOwed`) and swaps it for the current layout only once it COMPLETED, by compare-and-set,
  and the next start re-embeds in place (`FactIndexStep`). `e2e-p52` case 11b kills a pass mid-way
  and sees the next start finish it — confirmed to FAIL with the owed marker removed. So the panel answers "is what I
  know searchable NOW" with `coverage {indexed,total}`, shown only when short — state is self-correcting where an event
  log is not. The PROGRESS is the server's words (`ReindexSnapshot.Phase` and `ReindexSnapshot.Summary`): a re-embed is ONE engine
  call that reports nothing on the way, so it shows indeterminate, with the fact count in its sentence, where a bar
  pinned at 0% would read as stuck; the back-fill after it and the phrasings count fact by fact. The client wrote its
  own cost clause, 「开启了判断,每条事实会多一次模型调用」, for every pass; the in-place re-embed made it false, and the
  server now says it only for the back-fill, whose writes are annotated.
- **Data where it churns, code where it doesn't** — `fill_itinerary`'s form map. A form's *shape*
  (field names, `{n}` row templates, `maxRows`, font sizes, flatten) lives in `.claude/forms/*.json`,
  seeded by the template and editable by the agent through the normal diff gate; the PDF machinery
  (pdf-lib, fontkit, CJK embedding) stays compiled and shipped. So a revised visa form is a file
  edit, not a release — without the cost of the S1 proposal to make the whole tool a Script
  capability, which would have vendored pdf-lib + fontkit into every household's data folder (a
  grant's fs vocabulary is site-relative; the leaf lives in the install's `res/`). The map path is
  agent-nameable, so it resolves through the SAME `ResolveSitePath` guard as the PDF it describes,
  and a field the PDF lacks is reported BY NAME — a blank form otherwise looks like a filled one.
  Proof lives in `e2e-p10`, whose fixture fields are deliberately nothing like the visa form's.
- **The sandbox's node is a provisioned resource, not an assumption.** The capability sandbox needs
  `--permission` + `module.registerHooks` (Node 22.15+); the node inside the Playwright driver is
  older, so this used to depend on whatever the machine had, and a clean install had every Script
  capability refusing to run with nothing offering a fix. A pinned Node LTS is now a catalog entry
  (sha256-pinned, since nodejs.org serves a mutable path — bump version and checksum together), and
  `CapabilityRuntime` still PROBES whatever it picks, so a wrong pin fails closed rather than
  pretending.

## Packaging & auto-update

- **The app version has ONE source: `src/Directory.Build.props` (`<VersionPrefix>`).** Every csproj under
  `src/` inherits it and `devtools/project.config.mjs` reads it, so grepping a csproj for `<Version>` finds
  nothing and **proves nothing** — the one csproj that does set it is `Gatherlight.Resources`, which tracks
  the Playwright package rather than the app. Said here because the absence reads as a missing value: it
  cost a false "the version isn't wired up" report right after 1.2.0 shipped correctly.
  A wrong version is the rare defect that disables its own remedy — the running app reports itself from the
  entry assembly (`AppVersion.Semver`) and the updater compares THAT against the release, so a bundle built
  at the OLD version and tagged with the NEW one leaves every install deciding it is already current. The
  version is never set by hand — `release.yml` owns the bump, the tag and the release; the checks below
  exist so that ownership is verified rather than assumed. The release workflow
  therefore (a) reads the bump back through `project.config.mjs` after writing it, because PowerShell's
  `-replace` returns the string unchanged on no-match and would otherwise report success for a bump that
  never happened, and (b) asserts `manifest.json` and the shipped `Gatherlight.Host.dll` both agree with the
  version being tagged, before the commit/tag/release steps. Selecting the artifact by NAME rather than
  first-match belongs to the same failure: every later step trusts whichever zip was picked.
- `dev.mjs publish` (→ `devtools/scripts/build-production.mjs`) builds the **framework-dependent** host
  (~20 MB; the .NET 10 runtime is NOT bundled — the launcher installs it once at first run via the
  official MS installers, `src/launcher/dotnet_runtime.cpp`, so updates are ~20 MB not ~110 MB) **plus
  the native C++ launcher** (`src/launcher/`, MSVC — CI selects the v143 toolset via `CI=true`; falls
  back to `Gatherlight.cmd` where MSVC is absent) into `publish/Gatherlight/` (`libs/`·`res/`·`data/` +
  sha256 `manifest.json` + zip). The launcher carries the app icon (`src/assets/gatherlight.ico`,
  regen via `make-icon.ps1`).
- **Anything a tool needs at runtime must be IN the bundle** — the release ships `libs/`·`res/`·`data/`
  and nothing else; a path that resolves only by walking up to a repo root works in dev and is dead on
  every install. Node leaf tools (`tools/<name>`) therefore ship **esbuild-bundled** into
  `res/tools/<name>/<entry>.cjs` (self-contained, run by plain `node` — no npm install/npx/tsx/node_modules
  on the target), resolved by `ResourcePaths.NodeLeaf` (bundle layout first, then the dev walk-up so
  `src/*.ts` edits stay live). Adding a leaf = add it to `build-production.mjs` step 3.8 **and** its
  `required()` list. This is a rule because it already shipped broken: nothing under `tools/` was packed,
  so `pdf_inspect`/`pdf_fill`/`pdf_merge`/`fill_itinerary` threw `工具目录不存在:` in every installed copy
  and only worked from the source repo. Coverage: `e2e-p10` runs the tools in BOTH shapes.
- **Large resources are download-at-setup, not bundled** (default lean bundle ~200 MB vs ~350 MB):
  chromium + git + the **claude CLI** are provisioned by `Platform/Hosting/Resources`
  (`ResourceProvisioner` → `/api/manage/resources`, the 资源 · Resources console panel) into
  `{data}/state/resources/…`
  (in the data folder → survives updates, fetched once). Runtime resolvers prefer that copy
  (`PlaywrightHost` browsers path, `GitCliService.LocateGit` and `ClaudeCliRuntime.Locate` data-aware).
  `build-production.mjs --offline` bundles them for air-gapped installs. The Playwright **driver** (`libs/.playwright`,
  the chromium-install bootstrap) is still bundled.
- **A resource the app cannot BOOT without is provisioned automatically, never reported.** git is that
  one — the data repo is the audit trail the diff gate rests on — and being download-at-setup like
  chromium, a fresh install on a machine with no git spawned the PATH `git` that wasn't there and died
  in `DataRepoInitStep` with a raw Win32 `系统找不到指定的文件`. That step is essential, so the gate stayed
  closed; and the remedy the product documented — the 资源 panel — is `/api`, which the same gate 503s
  (settings too, so even the first-run wizard never appeared). **The failure sealed the door to its own
  fix**: 重试 re-ran a step that could not succeed, on an install with no way to reach the thing it
  needed. Before adding an essential step, ask what its failure leaves the household able to DO. Now
  `GitRuntimeStep` runs immediately before `data-repo` and downloads MinGit (sha256-pinned; the same
  constants `build-production.mjs` reads for `--offline`, so the bundled and downloaded gits cannot
  drift) into `{data}/state/resources/git`. Three traps: `GitCliService` resolved its exe **once in the
  constructor**, which DI builds before any step runs — so the download three steps earlier was
  invisible and a retry still spawned the missing PATH `git` (it re-resolves per call until it finds a
  real file); *installed* is not *usable*, so the step probes what it will actually run and says so when
  that fails; and a fixture that puts git in place before the boot passes against all of it, which is
  why `e2e-p49`'s case C makes git appear **mid-life** (confirmed to hang the gate against the pre-fix
  binary). A household that already has git downloads nothing — `p49` asserts that too, because a
  surprise 37 MB is its own defect.
- **The app can hold its OWN Claude login, and a panel must not block on a process spawn.** Two things the
  claude-CLI surface got wrong, both fixed together because both were about the same row.
  **(1) One session for two users.** The CLI keeps credentials in a config directory, so every process
  started as the same OS user shares a session — the app was signed in as whoever the household is signed in
  as in their own terminal. Fine when those are the same account and wrong when they are not (a personal
  account for their own work, a family one for the planner). `CLAUDE_CONFIG_DIR` isolates it completely
  (verified 2026-08-22: the same binary reported `loggedIn:false, authMethod:none` against a fresh directory
  while the machine session stayed signed in, and wrote its own `.claude.json` there). `ClaudeSessionMode`
  is `machine` (default, unchanged behaviour) or `app` (`{data}/state/resources/claude/home`), stored in
  `app_config` because it is read per call — so the next spawn uses it, no restart — and `Apply()` SETS the
  variable for `app` and CLEARS it for `machine`, because a stale `CLAUDE_CONFIG_DIR` would silently keep the
  app on an account they had switched away from. It lives under `state/`, which the backup does NOT carry
  (`plans household .claude ui uploads .git`) — an OAuth token has no business travelling in a zip.
  **Signing out is offered ONLY for the app's own session**, and the refusal is the point: the machine's
  login is the household's own terminal credential, and ending it from our panel is the same overreach as a
  delete button aimed at a daemon we did not install.
  **(2) The login instruction could not be followed.** Five places said "run `claude auth login` in a
  terminal", which is unactionable for a CLI installed through 资源: that copy lives in
  `{data}/state/resources/claude/` and the directory is never added to PATH — we resolve it internally and
  pass `CLAUDE_CMD`. `StartLogin()` spawns the RESOLVED binary, one attempt at a time, and is the one spawn
  in this codebase that WANTS a window (every other is `CreateNoWindow`; with output redirected the CLI may
  not treat it as a terminal). It is loopback-only — not as a permission check, the access gate already
  decided who may call it, but because the window opens on the server's machine and "started" would be a lie
  to a remote browser. **No e2e positive control, stated as a gap**: success opens an interactive console,
  and the refusal half is not drivable either because `Locate()` falls through to PATH, so even a CLI-less
  fixture resolves one on a developer machine — attempting it spawned real windows twice before the attempt
  was removed. `p50` asserts everything that does not spawn.
  **(3) A PANEL MUST NOT AWAIT A PROCESS.** 资源 took ~0.7 s to render anything because it awaited the CLI
  probe, and 本机模型 took 3.24 s on the first open after every restart because it awaited llama.cpp's full
  probe (`--version` 1811 ms + `--list-devices` 1592 ms, for two strings that decorate one row). Both now
  read what is CACHED, kick a background refresh, and send null for the unknown field — null being
  deliberately distinct from "absent", because "no GPU" and "nobody has asked yet" are different answers.
  Measured after: 0.02 s and 0.25 s. **The trap in doing this**: taking the probe off the request path also
  took `Apply()` off it, and `Apply()` is what adopts a CLI installed from that very panel by setting
  `CLAUDE_CMD` — so a fresh install stopped being picked up until something else happened to probe. That is
  the resolve-once trap this file already documents, re-created one layer out; `p50`'s "installed mid-life is
  adopted with no restart" caught it. Apply is microseconds (two env reads, a `File.Exists`, a set) and now
  runs on every request while the probe does not — the two costs are separate and only one of them is slow.

- **A resource the app cannot WORK without but CAN boot without is OFFERED, never forced.** The claude
  CLI is that one, and it is the mirror image of the git rule above — same root failure, opposite remedy.
  It was the last runtime dependency we merely assumed: a fresh install spawned the PATH `claude` that
  wasn't there, died at spawn in 17ms, and told the household "计划阶段未能完成(CLI 报告错误),请重试" —
  naming neither cause nor fix, on a retry that could never succeed. It is a catalog entry now, but
  `ClaudeRuntimeStep` is deliberately **not** `Essential`: git is boot-essential so it downloads inline,
  whereas gating the boot on a ~265 MB CLI would put the 资源 panel that installs it *behind* the very
  failure — the trap git fell into. So the step applies, probes, warns, and lets the app come up.
  Three differences from the sha256-pinned entries, each load-bearing:
  (1) **the version and checksum are read LIVE** from the vendor (`/latest` → `/<v>/manifest.json` →
  `/<v>/<platform>/claude.exe` — the contract the shipped `claude.ai/install.ps1` uses), because the
  checksum is still what guarantees the bytes of an executable we are about to run, it is just *read*
  rather than restated; a pinned CLI could not be updated without a release of ours, and a stale one
  eventually stops working against the API, so "never update" is not the safe default it is for git.
  (2) **installed ≠ usable** in a second way — a downloaded binary is not a signed-in one; the panel row
  carries the login state, and `claude auth login` is browser-interactive with no headless flag, so the
  app detects it exactly and cannot complete it. (3) **the version is only tracked for what WE
  installed**: a household on a machine-wide CLI has no marker of ours and must never be offered an
  "update" that would silently replace their own install. `ReplaceBinaryAsync` tolerates a running image
  (Windows refuses to overwrite a loaded exe, and an update is exactly when one may be mid-chat) by
  renaming the old copy aside. **That fallback was DEAD CODE until 2026-09-23**: it caught `IOException`,
  and overwriting a running image is ACCESS DENIED, which .NET raises as `UnauthorizedAccessException` — so
  every update during a chat failed with "Access to the path is denied" while the comment promised the
  opposite. Nothing drove an UPDATE, only a first install. `e2e-p50` case H now updates 9.9.9 → 9.9.10
  under a REALLY running binary (a copy of node.exe, since a fake payload cannot run) and failed with that
  exact message before the fix; it asserts the displaced copy BY NAME when checking the next sweep,
  because a freshly written exe is briefly held (AV) and may legitimately be set aside once more.
  **And a HELD file is transient.** The suspect is a scanner reading the fresh exe, possibly prompted by our
  own `auth status` probe spawning it — not the spawn itself, which maps the image WITH delete-sharing (that
  is why case H can rename a running exe). The rename aside gave up on it at once, so an update under load
  failed while the 1.3.0 notes promised the opposite. The first overwrite stays a single attempt — the
  fallback covers it — and every move after it retries a sharing violation for ~7 s. If the new binary
  cannot go in, the old one is moved BACK (retried the same way), because a marker naming a missing binary
  is an install that cannot run. **The household's sentence is chosen by what is ON DISK, three ways**:
  `claude.exe` in place → "the installed version is unaffected"; missing but a `claude.exe.old-*` exists →
  the old copy was set aside, and 更新 or a restart puts it back; neither → the download did not go in, try
  again — naming no button, because a `version.txt` that outlived its binary makes the row read 更新 where
  a first install reads 下载. The marker alone never buys the "set aside" line: it would promise a copy that
  may not exist (say, a scanner quarantined the exe and left the marker). That
  second promise is kept by `RestoreDisplacedClaudeAsync`, which moves the newest aside back BEFORE any
  network request — so an offline click or a bad checksum cannot keep it aside — and again at boot from
  `ClaudeRuntimeStep`; the sweep skipping while `claude.exe` is missing is only a backstop. Proof: `e2e-p50`
  case H2 holds `dest` (waited out; and past the budget, "unaffected", failing at the rename aside with
  nothing moved); H3 holds the DOWNLOAD, so the rename aside succeeds, the move in fails and only the move
  back leaves a binary (confirmed to fail with the move back removed); H4 plants the displaced state and
  makes the next download fail its checksum, and the binary is back anyway (confirmed to fail with the
  top-of-provision restore removed); H5 is a first install with a held download and H5b the same with a
  surviving `version.txt` — both told "did not go in", with no button and no "set aside". The
  holder is PowerShell with `FileShare.Read`, because Node opens files with delete-sharing and cannot
  stand in for one; H3's and H5's spin on the open, since the download is unopenable while being written,
  and assert their own marker so a missed window fails instead of passing vacuously. **Still undriven:**
  the boot-time restore — no suite restarts a server in the displaced state; and the middle of the three
  on-disk sentences, 「旧版本已移到一旁、没能放回」 — it needs the move BACK to fail, and every case lets it succeed
  (H3 holds only the download, so the move back is exactly what rescues it). Proof
  also lives in `e2e-p50`'s tampered-download denial, paired with the same bytes installing under the
  right checksum, and case A asserts the app boots ANYWAY.
  **The login SPAWN is tested too, and the reason it briefly was not is worth keeping.** It was recorded as
  untestable because succeeding opens an interactive console — true of `claude auth login`, which waits for
  a human in a browser and never returns, and false of the thing a suite actually runs. Case G points
  `GATHERLIGHT_CLAUDE_CMD` at a `.cmd` that appends its argv to a file and exits, then asserts `auth login`
  reached it: the real rule is that a suite must not leave a window WAITING for somebody, not that no child
  may ever have one. It needs its own stub rather than reusing `writeAuthStub` because `StartLogin` uses
  ShellExecute — which takes a FILE, where every other spawn takes `node <script>` — and that difference is
  the point of the test. Two vacuity guards ride along: the marker must also contain the probe's own `auth
  status` (proving the file is that stub's log and not an artefact), and the remote refusal is asserted by
  its MESSAGE, because `StartLogin`'s reentrancy guard returns the same 409 as a remote click.
- **Auto-update is two-phase**: the server (`Platform/Hosting/Update`) checks the configured
  GitHub release + downloads/sha256-verifies into `{install}/.update/staged`; the C++ launcher
  overlays it on the next restart (a running exe can't replace itself) and is itself excluded
  from the overlay. That split is the whole reason the launcher exists. Release: a single
  **manual-trigger** `.github/workflows/release.yml` (`workflow_dispatch`; version bump → **optional**
  e2e gate → bundle → optional tag → GitHub Release) — no auto CI on push/PR (D3dx-style). **The e2e
  gate is opt-in (`run_e2e`, default off)**: it is run locally before a release, and ~10 min of runner
  time per release re-proves that rather than reducing a risk. Every release still COMPILES the client,
  server and launcher, so a release is build-checked even when it is not behaviour-checked — and the run
  summary says which it was. Turn it on for a dependency bump, a packaging change, or a long gap since
  the last local run; it stays SERIAL there, because a gate you asked for should give a trustworthy
  answer rather than a fast one. The release
  BODY comes from `docs/release-notes/next.md` when present (generated commit log underneath,
  collapsed), and the workflow archives it to `<version>.md` in the bump commit — a `next.md` left
  behind is republished verbatim on the next release.
- **The launcher's failure paths must not block, because nothing is watching them.** The overlay's
  "could not apply the update" branch raised a modal `MessageBoxW`, which waits forever; on the
  unattended `--apply-and-exit` seam that turned the file's own "never fatal — the current version
  still starts" promise into a launcher that never returns, and a harness could only ever report a
  timeout, never the failure the seam exists to catch. `ApplyPendingUpdate` now takes `unattended`.
  Testing it needed care worth keeping: robocopy answers a file/directory collision with **4** and a
  read-only destination with **0**, both `< 8` and therefore SUCCESS here, so the obvious fixtures
  make a **vacuous** test. A staged path that is not a directory gives 16 — and is a real corruption
  case, since the "marker without staged files" guard uses `PathFileExistsW`, which tests existence,
  not type. `p19` pairs it with an anti-vacuity control (removals are skipped only if the overlay
  really failed) and was confirmed to FAIL against the pre-fix binary.
- **A >260-char install root is not a supported scenario, and not a bug we can fix.** Windows cannot
  create a process from an image path past MAX_PATH: measured at 347 chars, a stock `system32` binary
  copied there fails identically to ours, by `CreateProcess` **and** by `ShellExecute` (a
  double-click), against a positive control of the same binary at 62 chars. So `longPathAware` in a
  manifest would buy nothing — it governs what a RUNNING process does with paths, not whether the
  loader will start one. Don't re-open it. The launcher's 32768-wide buffers are still load-bearing
  for the real case: a root under the limit holding individual FILES past it.

## Data folder discipline

- ALL user data in the untracked data folder (`local/` default, `GATHERLIGHT_DATA` override);
  it has its own private git repo. The server never edits `state/`-external data outside the
  reviewed flows (chat gates, fs ops, seeder) — and those all serialize on `DataWriteLock`
  (one writer, or git index.lock collisions + corrupted review diffs).
- **A git the app runs works on the repository its working directory holds — never one the ENVIRONMENT names.** Git
  picks a repository two ways: by discovery (walking up from the working directory), which `GIT_CEILING_DIRECTORIES`
  bounds, and by NAME — `GIT_DIR` and its siblings — which skips discovery; git's own docs say the ceiling "will not
  exclude … a GIT_DIR set … in the environment". **The incident (2026-09-27):** a debugging agent ran `git bisect run`
  from a LINKED WORKTREE, and bisect run there exports `GIT_DIR` (`.git/worktrees/<name>`, absolute) and `GIT_EXEC_PATH`
  to every child — measured; from a main checkout it exported no `GIT_DIR`, and `git -c k=v …` adds
  `GIT_CONFIG_PARAMETERS`. A fixture server passed them on to its own git, so its data-repo commands ran against the
  developer's MAIN repository: `git init` set `core.bare = true`, the fixture's commits landed on the worktree's HEAD, and
  `DataRepoMaintenance`'s `reflog expire --expire=now --all` + `gc --prune=now` erased every reflog. The walk-up the
  ceiling closed, one door over. **Now `ChildEnvironment.ForGit`** is the one place every git spawn is confined —
  today `GitCliService.RunAsync`, which 系统模式's `CodeRepoGit` inherits; nothing else in the app starts git — and it
  strips `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`; `GIT_CONFIG` (it redirects `git config`'s WRITES, so the data
  repo's `user.name` would land in someone else's file); `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT` and its
  `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` (a parent's `-c`, which ANSWERED the data repo's `git config user.name`
  probe, so an injected identity signed every commit of the audit trail); and `GIT_EXEC_PATH` (the parent git's
  helpers, while ours may be the provisioned MinGit) — then sets the ceiling. What it keeps, and why, is in its doc. The
  e2e harness drops EVERY `GIT_*` from its own process at import (`_e2e-common.mjs`): its own git calls — p47's `gc
  --prune=now`, p7's `init`/`add -A`/`commit` — are not the app's, and `-C` moves only the working directory. Proof:
  `e2e-p49` case F, against a SCRATCH main repo with one linked worktree, `GIT_DIR` naming the worktree's gitdir and a
  `user.name` injected through `GIT_CONFIG_PARAMETERS`: the data repo is the data folder's and carries the fixture's
  commits, none signed with the injected name, and not one file under the scratch's `.git` changes. Confirmed to FAIL
  without the strip (`core.bare` false → true, the worktree's HEAD moved — 7 checks) and with `GIT_CONFIG_PARAMETERS`
  kept (3 of 3 commits signed with it) — measured when the per-spawn strip was the only one; since round 6 the whole
  process forgets the same set at startup (next bullet), so F holds on either half and case G is what fails without the
  process-level one. **Still: never run e2e — or anything that boots a fixture server — under `git bisect run` from a
  linked worktree**, nor from a git hook (git hands a hook `GIT_INDEX_FILE` and `GIT_AUTHOR_*`, measured). The server
  now forgets them for every child it starts, but the harness's own processes and whatever a suite spawns directly are
  outside the server; to bisect a fixture regression, have the bisect script clear the `GIT_*` variables before it runs
  anything.
- **Every child the app starts inherits the app's environment NARROWED, per class, in ONE helper —
  `ChildEnvironment` (`Platform/Kernel/Services`), never a copy per site.** Two mechanisms, because three spawns have no
  seam. **(1) The process forgets the launcher's context** at the top of `GatherlightApp.Build`, before anything spawns
  (`ForgetLauncherContext`), four families, logging the NAMES dropped, never a value (several are credentials): the
  repository set above; the Claude Code session it was started from (`ParentSessionVariables` — `CLAUDECODE`,
  `CLAUDE_CODE_ENTRYPOINT`/`_SESSION_ID`/`_CHILD_SESSION`/`_SESSION_ATTENDED`/`_MESSAGING_SOCKET`/`_MESSAGING_TOKEN`/
  `_EXECPATH`/`_SSE_PORT`, `CLAUDE_PID`, and — the security review, from the same per-session builder —
  `CLAUDE_EFFORT`, `TRACEPARENT`/`TRACESTATE`; `AI_AGENT` stays, the CLI sets it for itself); what would take the claude
  CLI OFF the subscription login (`OffSubscriptionVariables`, below the table); the CLI switches that could add the
  agent a tool past the scope guard (`AgentToolVariables`, likewise); and the app's own secrets (`AppSecretVariables`,
  likewise). The session markers were in the environment of every Bash command a Claude Code session ran here
  (2026-09-28), and the installed CLI names each: so every dev and fixture server started from one announced its agent
  to the CLI as a child of the developer's session, with that session's messaging pipe. Why the PROCESS and not the
  spawn: Lyntai's CLI runs (agent session and one-shot provider alike) go through its sealed `ProcessRunner`, whose
  `environment` argument can only SET; a BYO `IProcessRunner` is Lyntai's documented seam, but
  `CliProviderEngine.IsAvailable` is optimistic for any runner that is not its own, so a missing CLI would stop being
  skipped by the router and become a failed call instead — and the process environment is already the app's seam into
  those spawns (`ClaudeCliRuntime.Apply` sets `CLAUDE_CMD`/`CLAUDE_CONFIG_DIR` there). The ShellExecute login and
  Playwright's driver (which builds its `ProcessStartInfo` inside the library) inherit the process's too. **(2) A class
  that needs less is narrowed at its own spawn:**

  | class | sites | narrowed to | why |
  |---|---|---|---|
  | git | `GitCliService.RunAsync` | − the repository set, + the ceiling (`ForGit`) | the bullet above |
  | the claude CLI | Lyntai's `ProcessRunner` (chat, jobs, playground, validation; scorers, memory judge, rephrase), `ClaudeCliRuntime`'s `auth status`/`logout`, `StartLogin` | the floor only | the household's own CLI: keeps `NODE_OPTIONS`, proxies, CA files, the subscription login (`CLAUDE_CODE_OAUTH_TOKEN`) and the model settings; `CLAUDE_CONFIG_DIR`/`CLAUDE_CMD` are the app's own. Loses whatever picks another account or endpoint (below) |
  | external stdio MCP | `StdioMcpConnection.Start` | the floor only | the household's program, unsandboxed by design: its environment is theirs to configure, and the app has no policy over what it needs |
  | node leaf | `NodeLeafTool.RunAsync` (both shapes, the whole `npx tsx` tree) | − `NODE_OPTIONS`, `NODE_PATH` (`ForPlatformNode`) | code we ship: `--require` runs a file first, `--allow-*` makes a node without `--permission` refuse to start (measured, Node 24.15), and the leaf runs on one of three nodes |
  | capability sandbox | `NodeCapabilityLauncher.Build`, `CapabilityRuntime`'s probe | an ALLOW-LIST (`ForSandbox`) | the capability bullet under *Backend* |
  | llama-server | the router spawn, its `--version`/`--list-devices` probes, `RerankDeviceMeter` | − `LLAMA_API_KEY`, every `LLAMA_ARG_*` but `LLAMA_ARG_LOG_*`, `LLAMA_SERVER_*` (`ForLlamaServer`) | measured on b10549: an inherited `LLAMA_API_KEY` makes the router answer the app 401, which the runtime reads as a port HELD by a stranger; every other `LLAMA_ARG_*` is a launch argument the contract did not choose (argv wins only for the keys we pass). KEPT: `LLAMA_ARG_LOG_*` and `GGML_*`, the diagnostic and device-emulation levers `docs/self-managed-llm-runtime.md` uses through the app's environment, and `LLAMA_CACHE` |
  | 系统模式 build gate | `BuildVerifyService` (`npm run build`) | the floor only | a developer's toolchain |
  | the rest | Playwright's driver, `where.exe`, the desktop host's ShellExecute launches | the floor only | no seam (Playwright), or nothing read beyond PATH |

  Proof: `e2e-p49` case G (the startup probe, an agent turn and a one-shot annotation: no spawn got a marker, the
  agent's own `git rev-parse` finds the data repo and not the scratch one `GIT_DIR` named, a control variable still
  arrives, the log names without values), `e2e-p38` case 2b (the sandbox, capability bullet), `e2e-p10` (both leaf
  shapes under an inherited `NODE_OPTIONS`, the stub proving the injection real) and `e2e-p53` case A (the measurement
  children, with the logging and device variables as positive controls). **Confirmed to FAIL** (2026-09-28, one build
  with all four strips removed; each suite exercises one mechanism, and each failed on exactly its new assertions while
  the rest stayed green): p49 G 3 of its checks — the startup probe, the agent turn and the annotation each carried
  `GIT_DIR`, `GIT_CONFIG_PARAMETERS` and nine session markers (all but `_SSE_PORT`, which no shell here sets), the
  agent's git found the SCRATCH worktree's gitdir, no log line; p10 2 — `npx-cli.js`, tsx's `cli.mjs` and `src/*.ts` ran the
  preload in the source shape, `inspect.cjs`/`fill.cjs` in the bundled one (each phase reads its own log, so neither can
  pass on the other's evidence); p53 1 — every measurement child carried all three. With only `ForGit`'s strip removed,
  F and G both pass: the startup forget alone holds F. **Not driven, and why it does not need its own
  case:** the router spawn (a fake router is always ADOPTED, and the stand-in binary is `more.com`), the login window, an
  MCP server, the build gate and Playwright each inherit the one process environment case G proves clean, and none builds
  its own.
  **"Never an API key" is enforced at spawn** (owner decision, 2026-09-28; the security review widened it to the family).
  The CLI's authentication docs rank a provider switch, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` ABOVE the `/login`
  subscription, and in `-p` mode — how the app runs it — a present key "is always used": an inherited key billed the
  household's API account while 资源 said the CLI was signed in. `OffSubscriptionVariables`, each name checked in the
  installed binary (2.1.283): CREDENTIALS (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, the providers' own keys
  `ANTHROPIC_AWS_API_KEY`/`_FOUNDRY_API_KEY`/`_FOUNDRY_AUTH_TOKEN`, the federation `ANTHROPIC_IDENTITY_TOKEN`/`_FILE`,
  `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`); SELECTORS (`CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY` and the siblings the
  binary names, `_ANTHROPIC_AWS`/`_ANTHROPIC_GOOGLE_CLOUD`/`_GATEWAY`/`_MANTLE`; `ANTHROPIC_PROFILE`,
  `ANTHROPIC_FEDERATION_RULE_ID` and `ANTHROPIC_CONFIG_DIR`, which pick a Console profile or federation credential the
  docs rank above `/login`); ENDPOINTS (`ANTHROPIC_BASE_URL`, `CLAUDE_CODE_API_BASE_URL`, every `ANTHROPIC_*_BASE_URL`
  through `ChildEnvironment.IsOffSubscriptionVariable`, `ANTHROPIC_API_HOST`, `ANTHROPIC_UNIX_SOCKET`,
  `ANTHROPIC_CUSTOM_HEADERS` — the review rated the base URL highest: it sends every prompt, and the household's data in
  it, to another host). KEPT: `CLAUDE_CODE_OAUTH_TOKEN` and its refresh and descriptor siblings — `claude setup-token`'s
  token, which the docs say "authenticates with your Claude subscription"; it outranks `/login`, so while set it picks
  WHICH subscription, over the app's own login mode — `AWS_*`/`GOOGLE_*` (other programs read them, and without the
  stripped switch they select nothing for the CLI), the providers' ids and the model settings. The probe (`auth
  status`) runs in the same process environment as every CLI spawn, so it reports the account the app will use; a
  Warning names what was ignored, once (「Claude CLI: ignored …」). What an environment strip CANNOT reach: an `env`
  block or `apiKeyHelper` in the CLI's own settings files (the machine's `~/.claude/settings.json` in machine login
  mode, managed settings) and an active federation profile in the default Anthropic configuration directory — the CLI's
  configuration, read by the CLI. And since the strip is process-wide, an external MCP server that calls the Anthropic
  API itself takes its key from its own configured `env`, applied after the inherited one.
  **The app's own secrets are withheld from every child**: `GATHERLIGHT_ACCESS_TOKEN` and
  `GATHERLIGHT_TLS_CERT_PASSWORD`, the two secret-bearing `GATHERLIGHT_*` the server reads (the rest are URLs, paths,
  ports, flags and test knobs — kept; the stub and the measurement fake read their own). The agent's Bash could print
  the access token and an external MCP server is someone else's code; no child needs it, since the agent reaches the
  app through the loopback channel's own token. The app reads both through `ChildEnvironment.Launched`, which remembers
  what the floor removed: the desktop host re-resolves them on every start of its in-process server (`BuildOptions` →
  `ResolveAccessToken`), and the settings panel's `envOverrides` says which settings the environment overrides.
  Proof: `e2e-p49` case G2, the same boot as G — a fake `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`,
  `CLAUDE_CODE_USE_BEDROCK` and `GATHERLIGHT_ACCESS_TOKEN` reach no stub spawn, `CLAUDE_CODE_OAUTH_TOKEN` reaches every
  one (the positive control), the Warning names the three once, the panel still lists `accessToken` as env-overridden,
  and no value is in the server's stdout, its file log or the stub's. Confirmed to FAIL (2026-09-28, two builds, each
  failing only its own checks): on one, the off-subscription strip removed (all three names in every spawn, no
  Warning), the settings reader on the raw environment (`["port"]` only), `CLAUDE_EFFORT`/`TRACEPARENT` removed from
  the session set (case G) and a secret's value logged; on the other, the secret strip removed and the OAuth token
  over-stripped. Not driven: the host's restart path (`desktop-e2e` is out of the fleet); it reads `Launched` exactly as
  the settings panel does, which is asserted.
  **The CLI's feature switches, as a jail question** (the security review, 2026-09-28; `AgentToolVariables`). Each
  non-account `CLAUDE_CODE_USE_*` the binary names was checked for whether it adds or replaces a tool, or changes how
  file access is mediated: `_POWERSHELL_TOOL` STRIPPED (it turns on a shell tool the guard's matcher does not list —
  but see the jail bullet below: on Windows that tool is on by DEFAULT, so the strip is not what closes it);
  `_COWORK_PLUGINS` STRIPPED (undocumented — none of the CLI's 210 documentation pages names it — and by its name it
  loads another product's plugins, which contribute MCP servers, hooks that run outside the permission checks, skills
  and subagents); `_CCR_V2` STRIPPED, failing closed (undocumented; by its name the protocol of remote sessions another
  client drives, which a local `-p` run never uses — stripped because nothing shows it leaves the tool set alone, not
  because it was measured to add one); `_NATIVE_FILE_SEARCH` KEPT (documented: it discovers custom commands, subagents
  and output styles with Node.js file APIs instead of ripgrep, and "does not affect the Grep or file search tools").
  A Warning names what was ignored. Proof: `e2e-p49` case G3 — the three injected switches reach no stub spawn,
  `_NATIVE_FILE_SEARCH` reaches every one (the control), the Warning names the three; confirmed to FAIL with the strip
  removed.
- The spawned agent is **jailed** by the PreToolUse scope-guard hook
  (`ChatEnvironmentService.ScopeGuardMjs` planner / `guard/system-scope-guard.mjs`
  系统模式 — identical logic, different write-scope; `e2e-p24` runs both): **reads**
  (Read/Grep/Glob) confined to the jail and NEVER `state/` (token / TLS key / DB), **writes**
  (Edit/Write/…) to `plans/ household/ .claude/ ui/` except the PROTECTED set — `.claude/hooks`,
  `.claude/settings*.json`, `.mcp.json` (planner) — or the **whole code repo except the PROTECTED set**
  — `guard/`, `src/server`, `.claude/settings*.json`, `.mcp.json`, `.git` — (系统模式). Each guard
  combines an allow-list (`WRITE_DIRS`) with a `PROTECTED` deny-list that overrides it (so the agent
  can't neuter its own guard, settings or MCP config). **Bash** denied git-history / network-egress /
  inline-eval (`node -e`, `python -c`) / fs-crawl / path-escape / shell-launch / and any path-token
  resolving into `state/` or a PROTECTED path (`BASH_PROTECTED`, best-effort — the three-legs bullet
  below). Anything genuinely **out-of-boundary must route through a server MCP tool** — mediated +
  auditable — never raw Bash. Enforcement, not trust. The guard carries a `GUARD_VERSION` (10 planner /
  8 system); the PLANNER guard lives at `state/agent/scope-guard.mjs` (app state inside the data folder,
  carved out of the guard's checks, regenerated every boot), so a bump reaches an old data folder on its
  next boot without a version-gated re-issue and a backup cannot roll it back (`state/` is not carried). The `guard/` folder (system guard)
  is app-managed (shipped + overlaid by updates), read-only to the agent. Residuals the hook can't
  close (code run *inside* an agent-authored script; exfil via a fetched URL) need an OS sandbox —
  **declined**, and the reasoning is on the record in `docs/ROADMAP.md`: the `claude` CLI authenticates
  per-user, so a low-privilege service account breaks the mechanism the whole product rests on.
  **A built-in the matcher does not name never reaches the guard — and two such built-ins run shell commands, so every
  agent run REMOVES them** (`UnguardedTools`, applied in `AgentRunner.RunAsync`, the one door every run site uses:
  chat plan/execute/revise/repair, jobs, the playground, validation, `extract` and the migrator; it becomes
  `--disallowed-tools`, which "removes the matching tools from Claude's context", and subagents inherit only what the
  main conversation has). Found 2026-09-28 from the CLI's tools reference, permission-modes and headless docs, not
  measured on a real CLI (that would need a signed-in model call): **`PowerShell` is on by DEFAULT on Windows** —
  "enabled automatically" without Git Bash, "on by default for claude.ai and Console accounts" with it — and in the
  execute runs' `acceptEdits` mode the CLI auto-approves its `Set-Content`/`Add-Content`/`Clear-Content`/
  `Remove-Item` on every path in the data folder but its own protected `.git`/`.claude`, so `state/`, `site.json`
  and `uploads/` were writable and deletable with no prompt and no guard; and **`Monitor`** "uses the same permission
  rules as Bash", so the execute settings' bare `Bash` allow pre-approved any background command, which the guard's Bash
  checks (egress, inline eval, git history, path escape) never saw. The planner needs neither. What the docs say of the
  rest: a tool that needs a permission and is not allowed is REFUSED in a `-p` run with no permission host, so it cannot
  run (`Artifact`, `Workflow`, `EnterWorktree`…); `Agent` is guarded, since hooks fire for a subagent's tool calls;
  `LSP` is inactive until a code-intelligence plugin is installed; `SendUserFile`, `RemoteTrigger`, `CronCreate` and
  `ReadMcpResourceTool` need no permission but reach the household's own account, session or MCP servers, not a path
  past the jail. **Plan (read-only) runs are CONFINED, not merely write-disallowed** (since 2026-09-28): they now pass a
  generated read-only settings file (`ChatEnvironmentService.ReadOnlySettingsPath` / `SystemReadOnlySettingsPath`) that
  sets `permissions.blockReadsOutsideWorkingDirectories` — the CLI v2.1.257+ fence that makes the file tools AND
  recognized read-only Bash file-commands (cat, head) refuse a path outside the working directory in every mode — and
  registers the SAME guard hook, so a plan-phase Bash is checked for egress / inline-eval / shell-launch too.
  **And Bash is REMOVED OUTRIGHT from every read-only run** (`UnguardedTools`, keyed on `ToolPolicy.ReadOnly` in
  `AgentRunner`): a plan writes nothing, so Bash's only use was reads (which the fence confines), while a read-only Bash
  could still run inline eval or launch a shell — so plan, revise, read-only jobs, the playground, `extract`, `validate`
  and the migrator all lose it, AND the read-only `--settings` allow-list drops it (belt-and-suspenders, and the reason a
  no-settings site like `extract` is still covered — the removal is central). The plan run previously PRE-APPROVED Bash,
  the security review's regression. `defaultMode` is `default`, not acceptEdits (a plan writes nothing). Read-only JOBS
  now also pass `ReadOnlySettingsPath` (fence + guard) since they run in the data folder; the playground/extract/validate
  keep "no Bash" only (a neutral cwd / dev tool — an unfenced read is a stated residual there). `e2e-p54` asserts the
  plan spawn carries the read-only settings AND disallows Bash AND the allow-list omits it, confirmed to FAIL with the
  plan run's SettingsPath removed. **Still: Lyntai's one-shot calls**
  (scorers, the memory judge, rephrasing) run with the CLI's default tool set minus `AskUserQuestion` from a neutral cwd
  (`ClaudeArgs`), with no seam for the app to narrow them — read-only commands and permission-free tools are available
  there, nothing that needs approval is; closing that is Lyntai's `TASKS.md` Part 330 (the reciprocal of the D190
  per-consumer tool host), and when it ships the adopter drops its own `PowerShell`/`Monitor` removal for the library
  seam. Proof: `e2e-p49` case G3 reads the stub's argv: the plan and the execute run each name `PowerShell` and `Monitor`
  in `--disallowed-tools`; confirmed to FAIL with the `AgentRunner` line removed.
- **Bash cannot launch ANOTHER shell or interpreter** (`GUARD_VERSION` 10 planner / 8 system, hardened by the
  2026-09-28 security review and its re-review). A built-in the matcher does not see is one door past the guard; launching `powershell` / `pwsh` /
  `cmd` / `wscript` / `cscript` / `mshta` / a nested `bash`|`sh` / `source` / `.` / `wsl` / `rundll32` / `regsvr32` — or
  `Start-Process`, or `git -c` of a command-running key (`alias.*=!…`, `core.pager`/`editor`/`sshCommand`, a
  `credential`/`filter` helper) — from inside Bash is another, because whatever runs in the child never reaches the
  guard's Bash checks. Both guards deny the launch itself, whatever its arguments, matched against each pipeline
  segment's COMMAND WORD: the leading token PAST any wrapper (`env`/`command`/`exec`/`sudo`/`nice`/`nohup`/`time`/
  `xargs`/`timeout`/`stdbuf`/`ionice`/`chrt`/`setarch`/…) and any `VAR=value` prefix, path and `.exe` stripped — so a
  shell NAME used as an argument (`command -v sh`) is not caught, but `env powershell`, `FOO=1 bash x`, `xargs sh`,
  `{ sh x; }`, `` `sh x` ``, `sh<x` and `git -c core.pager=powershell log` are. Segments split on
  `; | & \n ( ) { } \` < >`. **A wrapper's OWN arguments precede the command it runs** (the re-review's finding:
  `timeout 5 bash x`, `nice -n 10 bash x`, `stdbuf -oL bash x`, `ionice -c2 …`, `chrt 10 …` and `setarch x86_64 …` were
  all ALLOWED, because the word after the wrapper was its argument, not the command), so past a wrapper the guard skips
  its options, the value of each option that takes one (`WRAPPER_VALUE_OPTS`: `-n 10`, `-u root`, `-s KILL`), numeric
  durations and priorities, and `setarch`'s one positional; `env -S` is deliberately not a value option, since its value
  IS a command line, and `command -v`/`-V` only describe a command, so they yield no command word. **This is
  BEST-EFFORT defence in depth** — leg (3) of the guard's integrity (the next bullet): a token scan is fooled by a
  variable, a `$(…)` or a constructed string, and a VARIABLE command word (`x=sh; $x plans/y.sh`) is ALLOWED — `e2e-p24`
  pins that as a known allow with a comment, so a change to it is deliberate. The closure that does not depend on
  parsing is PowerShell/Monitor removed from every run; "code inside an agent-authored script" stays the residual.
  `e2e-p24` runs the full battery on both guards with positive controls (`ls`/`mv`/`node x.mjs`/`command -v sh`/
  `timeout 5 node x` stay allowed); every deny case confirmed non-vacuous against the guard before it (the wrapper
  forms: 14 of them, against `81d082b`'s guards).
- **The guard's integrity rests on THREE LEGS, and only one of them is solid** (2026-09-28 security review; corrected
  by its re-review, which caught an earlier version of this bullet calling the placement "structural"). `state/` is
  still INSIDE the data folder: it is carved out of the guard's CHECKS, not out of the filesystem. The legs:
  **Edit/Write/Read/Grep/Glob cannot reach `state/`** — solid, because every such call passes through the guard;
  **the Bash path-token scan** refuses a token naming it — best effort; **no nested shell** — best effort. A
  constructed token (`$PWD/state/agent/scope-guard.mjs`, a variable, a `$(…)`) or a nested shell that slips past the
  last two can OVERWRITE the guard file and neuter it for the rest of the session (the next boot regenerates it), and
  can READ `state/` — the database, the TLS key — in an EXECUTE run where a Bash exists (Git Bash present; a plan run
  has no Bash at all, and a household with no Git Bash has none in any run). Both fall inside the declared residual
  "code inside an agent-authored script needs an OS sandbox", which was declined (`docs/ROADMAP.md`). What changed:
  **(1) The planner guard moved out of the data repo.** It moved from `.claude/hooks/scope-guard.mjs` (tracked, in a
  directory Edit was PROTECTED from and Bash was not checked for at all) to `state/agent/scope-guard.mjs`: app state,
  gitignored, backup-excluded, regenerated every boot like the settings files, referenced by ABSOLUTE path from the
  generated `--settings`. So a backup cannot roll it back, a direct Bash token naming it is refused, and a guard neutered
  mid-session is restored at the next boot. `ChatEnvironmentService.EnsureFiles` writes it and DELETES the old in-repo
  copy (`RemoveLegacyGuard`, returning its path so the deletion commits out of the audit trail). The generated
  `--settings` files already lived in `state/`. The system guard stays in `guard/` (app-managed, shipped + overlaid by
  updates) — Edit-protected, and now Bash-protected on the same best-effort terms. A truly-external dir (`%LOCALAPPDATA%`)
  was DECLINED: a per-site guard needs a writable per-data-folder home, and moving it further would not change which
  legs its integrity stands on — only an OS sandbox would.
  **(2) `state/` is out of the READ jail and the Bash token scan** (planner `READ_DENY`). Read/Grep/Glob naming `state/`
  — and a Glob `pattern` / Grep `glob` whose literal head is `state/` — are denied (a recursive `**` head is a stated
  residual). `state/` holds the access token, the TLS pfx and the database. A constructed Bash token still reads it
  (the residual above).
  **(3) Bash writes are WRITE-scoped, not just jail-scoped** (`BASH_PROTECTED`). A `cp`/`echo >`/`rm`/`tee`/`cat` naming
  the guard, `.claude/settings*.json`, `.mcp.json`, `site.json`, `.git`, `src/server`/`guard` (system) — or `state/` — is
  denied by resolving EVERY path-like token against the root (a bare `site.json`/`.mcp.json` has no slash but is a
  data-root path). Best-effort — leg (2) — stated as such in the guard and here.
  **(4) The `--settings` carry `disableAllHooks: false`, the hot-reload finding.** Measured at 0 tokens against the real
  CLI 2.1.283: a `-p` run DOES execute the project's `.claude/settings.json` hooks, and a project `{"disableAllHooks":
  true}` disables our flag-level hooks — but a command-line `--settings` `disableAllHooks:false` wins over it (settings
  precedence: managed > command-line > local > project > user). So a settings FILE cannot disable our hook, and
  `.claude/settings*.json`/`.mcp.json` are protected from Edit/Write (solid) and from a direct Bash token (best effort).
  What `disableAllHooks:false` does NOT cover is the hook's own script: overwrite `state/agent/scope-guard.mjs` through
  the residual above and the hook still fires — running the neutered file. A `ConfigChange` hook to block
  project-settings changes was considered and NOT shipped: the mechanism was inconclusive at 0 tokens, and it adds
  nothing over the two protections above.
  **(5) C2/C3 normalization** — both guards' `norm()` strips trailing dots/spaces per segment (Windows folds them, so
  `.claude/settings.json.` and `.claude/hooks./guard` name the protected file) and the JS already lowercases (case);
  and `oddSegment` REFUSES outright a path segment carrying an 8.3 short name (`~` + digit — `STATE~1`, `SETTIN~1.JSO`
  name state/ and the settings), an alternate data stream (a colon past the drive letter) or a device name, for
  Read/Grep/Glob and Edit/Write, and — short names and streams only — for a PATH-LIKE Bash token (one with a slash, so
  `git log HEAD~1`, `git show HEAD~2:plans/x.md` (a `rev:path` is split at its colon) and `echo a:b` stay allowed).
  `SiteWriteScope.Resolve` (the fs tools' write scope) normalizes each segment the same way, folds case
  (`OrdinalIgnoreCase`, was `Ordinal`), REJECTS a colon (ADS / drive-relative), an 8.3 short name (`~`) and a device
  name (`CON`/`NUL`/`COM1`…) — so `plans/x.md:evil` is a clean refusal, not a 500 out of `ResolveSitePath` — and then
  re-checks PROTECTED against the GetFullPath-RESOLVED relative path, so anything Windows folds that the segment rules
  miss still names the protected file. `.mcp.json` is PROTECTED because a `-p` run CONNECTS a project `.mcp.json`'s
  servers even untrusted (measured, 0 tokens) — a stdio server there is a command the CLI starts. Proof: `e2e-p24`
  (both guards: C1 Bash-protected/state, C2 trailing-dot, C4, with positive controls, every deny non-vacuous), `e2e-p54`
  (`fs_move` to a trailing-dot / case-folded / ADS-colon target refused), `e2e-p42`/`e2e-p37` (the guard at
  `state/agent/`, `GUARD_VERSION 10`), `e2e-p47` (a backup can no longer plant a weakened guard nor leave one in the jail).
- **The agent MOVES, RENAMES and DELETES files through scoped MCP tools, never a shell** (`fs_move` · `fs_delete` ·
  `file_info`, `Platform/Capabilities/Tools/Services/Tools/FileOpsTools`). A tool beats a shell for this: its scope is
  the guard's own write scope (`ISiteWriteScope`, rendered from the site manifest — one source of truth with the guard),
  every call is audited (`AgentRunner.ToolDetail`), and the change lands at the diff gate (`AgentRunner` records the
  touched paths into the run's `EditTracker`; the tools do NOT commit). The mutating two run in EXECUTE runs only —
  `IAgentRunScope` (entered by `AgentRunner` per run, the server-side gate a fake CLI cannot bypass) refuses them in a
  read-only plan run, and `ToolRegistry.McpAllowedToolNames(writable:false)` drops them from a plan run's allow-list.
  `file_info` (size + mtime) is read-only, any path in the read jail — so `/cleanup` needs no `ls -l`. `e2e-p54` drives
  both phases, the path guard and the overwrite refusal; confirmed to FAIL (7 assertions) with the run-scope forced
  writable.
- **A guarded Bash is GUARANTEED where the household wants one — offered, never forced.** With PowerShell and Monitor
  removed, a household with no Git Bash has no shell; the file tools are the substitute, and 资源 OFFERS PortableGit as a
  Git Bash the app can guard. MinGit — what the data repo runs on — ships NO `bash.exe` and cannot back the CLI's Bash
  tool (measured, `docs/self-managed-llm-runtime.md`: MinGit's `sh.exe` as `CLAUDE_CODE_GIT_BASH_PATH` ran no command;
  PortableGit's `bin\bash.exe` ran and beat WSL's on PATH), so it is a SEPARATE, sha256-pinned, opt-in resource
  (`ResourceProvisioner` id `git-bash`, a 7-Zip self-extractor). `ClaudeCliRuntime.Apply` sets the variable only when the
  CLI would find no Git Bash on its own (no household variable, nothing at `C:\Program Files\Git` / `(x86)`, no `git` on
  PATH → `..\..\bin\bash.exe`) and our PortableGit is installed — re-applied per probe (a mid-life install is adopted
  with no restart), never overruling the household's own or a discovered Git for Windows. **The discovery does NOT spawn
  a process**: `GitBashDiscoverable` ran `where.exe git` (up to 3 s) on every `Apply` probe and every 资源 render — the
  "a panel must not await a process" trap — so it now SCANS the PATH directories itself (skipping a git shim inside
  `node_modules`/a virtualenv) and CACHES the deterministic filesystem result; the `GATHERLIGHT_ASSUME_NO_GIT_BASH` test
  seam is read UNCACHED, before the cache. **Household text names no `PowerShell` removal and no `判断`** (both dev-facing
  facts a household never saw): the not-installed `AgentShellDetail` reads 「规划助手默认没有可用的命令行…」 and the git-bash
  row's `NeededFor` drops both. The data repo stays on MinGit (owner decision). `e2e-p55` (the
  `GATHERLIGHT_ASSUME_NO_GIT_BASH` seam) asserts the offer shows only when no Git Bash is discoverable, the mid-life
  adopt, the household's variable winning, and that the row names no `PowerShell`/`判断`; confirmed to FAIL (the adopt)
  without the `ApplyGitBash` call.
- **Egress is audited, not closed — and both planes are audited the same.** The agent reaches the
  network two ways: the CLI's built-in `WebFetch` and the registry's `scrape`. Neither can be shut for
  a planner whose job is reading arbitrary travel sites, and denying `WebFetch` alone only moves the
  channel — `scrape` takes the same arbitrary URL (`SsrfGuard` blocks *internal* targets, which is a
  different threat). So `capabilities.deny` is a **lever, not a default**: the shipped manifest denies
  nothing, and a household that wants the built-in closed gets a mechanism that removes it from the
  generated allow-list AND the guard together (`e2e-p24`). What is always on is the record — every
  outbound URL lands in the durable event stream via `AgentRunner.ToolDetail`, which is why it has an
  `mcp__*` case: without it the MEDIATED path was the less auditable of the two, which is backwards.
  Proof lives in `e2e-p21`, which drives one turn through both planes and asserts each URL in the trace.
- The shipped knowledge base lives in `Assets/SiteTemplate/` and is seeded/upgraded by
  `ZhikuSeeder` (hash-guarded: user-modified files are never overwritten).

## Dev loop

- `node devtools/dev.mjs <server|host|vite|build|publish|resources-pack|e2e|desktop-e2e|smoke|shot|memory|eval|embed-bench|recall-bench|judge-bench|rerank-window|test-data|new-tool|fetch-tools|install-hooks|check-sensitive|check-layering|check-ui-registry|check-tool-docs|check-host-actions|check-doc-refs>`
  — kept in step with the tool's own usage line (`dev.mjs`, bottom of the switch). It had drifted by six commands
  (2026-09-24); `rerank-window` re-measures what mMiniLMv2's declared 512-token window rests on.
- **`fatal: timeout` USUALLY MEANS THE SERVER NEVER BOUND, and the reason is in the fixture's own log.**
  A suite whose Kestrel fails to start reports only that the harness ran out of patience — which reads
  exactly like a hang in the code under test, and cost a long hunt for a regression that did not exist.
  The real line was three deep in `devtools/_e2e-pN-data/state/logs/`: `SocketException — an attempt was
  made to access a socket in a way forbidden by its access permissions` (WSAEACCES). **Windows
  dynamically RESERVES tcp ranges** (Hyper-V/WSL/Docker; `netsh interface ipv4 show excludedportrange
  protocol=tcp`), and on 2026-08-23 those ranges moved mid-session to cover 5321–5420 and 5487–5586 —
  29 of the suites' ports. The same fleet had passed 51/51 an hour earlier on the same numbers, which is
  the tell that it is machine state and not the tree. Renumbering the suites is churn for a transient
  condition and the new band can be reserved next reboot; the fix is that `dev.mjs e2e` now prints the
  fixture's last `[ERROR]` line beside a failure, because that log is CLOBBERED by the next run of the
  suite and this is the only moment it is still true. If it recurs: check the excluded ranges first.
  **And when moving ports out of a reserved range, avoid the WHATWG fetch "bad ports"** (6000, 6566, 6665–6669, 6697,
  10080 among them): Node's `fetch` refuses them client-side (`fetch failed` / `bad port`), so `waitHealthy` polls a
  server that IS up until its 180 s ceiling and reports `fatal: timeout`. It cost a wrong "environmental" verdict on
  `p16` (2026-09-28): a +600 shift mapped its 5400 to 6000; +700/+900 pass.
- **A UI HARNESS MUST RETRY THE ACTION, not only poll the result.** `desktop-e2e` polled for the view
  after clicking a tab ONCE — and a click dispatched before React has wired the handler is swallowed
  silently, so no amount of waiting produces the view. That flapped run to run and reads as "the Cortex
  tab is broken". Same shape twice more in the same file: the memory cards were read after a fixed 900 ms
  (the panel fetches its own state after Cortex mounts, so the assertion reported "renders nothing" while
  a diagnostic three lines later found all three), and the enrichment toggle was read 900 ms after
  clicking, mid-refetch, so it reported "the switch does not flip". **A fixed sleep does not fail
  honestly — it fails as a wrong description of the product**, which is worse than a red that says
  "timed out". Poll the condition, and re-issue the action each round.
- **`host --dev` FAILS LOUDLY on a wedged WebView2 profile, and the symptom is why.** The flag points
  WebView2 at a throwaway user-data folder and deletes it each run — with `force: true`, which SWALLOWS a
  failed delete. `msedgewebview2.exe` children OUTLIVE the host and keep handles on that folder, so the
  delete half-succeeds, WebView2 fails to initialise, and **the host exits ~30 s after startup with
  nothing in the log** — it completes startup migration, serves, then vanishes. That reads as "the app
  crashes", which is the wrong investigation entirely. The plain `dev.mjs host` (what ships) is unaffected
  and stays up; only the debug path breaks, so a release is not gated on it. Now the removal is verified
  and a failure says which process to kill.
- **`dev.mjs check-doc-refs` — every code identifier a LIVE doc names must exist.** Docs rot silently: a
  class is renamed, the prose pointing at it is not, and the next session follows the reference, finds
  nothing, and re-derives what was already written down. A WRONG doc costs more than a missing one — a
  search plus the time spent trusting it. Found by hand first (`GitCliService.GitExe`, whose member is
  `LocateGit`; three Ollama APIs still named in a rule after the backend went), which is why it is now a
  check rather than a habit.
  **Scope is the design.** Only the docs a session is expected to ACT on are checked;
  `docs/superpowers/plans|specs` are point-in-time records, and a July plan naming a since-renamed class is
  HISTORY, not an error — rewriting it would destroy the record of what was decided. Checking them would
  produce noise that trains everyone to ignore the check.
  **The allowlist is keyed `doc::identifier`, not by identifier.** `ClaudeCliRunner` is legitimate in
  `ROADMAP.md`, which records that a phase DELETED it, and would be a rotted reference anywhere presenting
  it as current — a bare-name allowlist cannot tell those apart, and the second case is the one that
  matters. Every entry carries a reason, so the list forces a decision rather than silencing one. Three of
  the five current entries are not drift at all: a filename PATTERN, an MSBuild property named while
  explaining that we do NOT use it, and a class belonging to Vidora, a sibling project.
  **It checks three kinds of reference**: backticked SYMBOLS, markdown LINKS to local files, and
  backticked PATHS. Paths resolve against every base the docs legitimately write relative to, plus the
  `Platform/<Group>/<Name>` and `Product/Planner/<Name>` prefixes the layout rule itself prescribes —
  mapping those in the checker is right, because rewriting the docs to spell out the project directory
  would make them disagree with the convention stated three bullets above. Two allowlist kinds recur and
  both are legitimate: files in the DATA folder (user data, not the tree) and files in a SIBLING PROJECT
  a note compares against. The check prints how many references it resolved — read the count there, not
  here: a figure quoted in this file went stale within a month. Confirmed non-vacuous by planting a renamed
  class, a dead link and a dead path.
  **A qualified `Type.Member` is checked against the TYPE, and against its code only.** The symbol pass used
  to match the last segment anywhere in the corpus, comments included — so a method renamed on 2026-09-23
  stayed "resolved" in this file for as long as one e2e suite's COMMENT still carried its old name: the doc and
  the stale comment kept each other alive. When the tree declares the type in C#, the member must now appear in
  a declaring file with comments and string literals blanked out (a small tokenizer, because a regex cannot
  tell `//` in a URL from a comment). A type the tree does not declare — Lyntai's, the BCL's — still falls back
  to the last segment, deliberately: the app uses Lyntai types it never names, and demanding the type there
  flagged real API. The known cost is that a MISSPELLED in-tree type takes that fallback too. Confirmed against
  the original case (a doc naming the old member while a planted comment carries it: the old checker passes, this
  one fails) with a misspelled member and a live one as controls.
- **`dev.mjs e2e all` NAMES what it did not cover.** `desktop-e2e` drives the real UI over CDP and cannot
  join the fleet — it needs `dev.mjs host --dev` and a WebView2 window — so the fleet's summary says so
  where "all green" is read. Being outside the fleet is exactly why it rotted once: it asserted control
  names a rename had retired months earlier and nothing noticed, because nothing ran it. A gap nobody is
  reminded of is a gap that comes back, and the reminder costs one line.
- e2e suites live in `devtools/scripts/e2e/` as `pN.mjs` (discovered by `^p\d+\.mjs$`); they self-host
  the server against isolated `devtools/_e2e-*` data folders with the claude stub; every phase of work
  lands with its suite green. Shared harness: `devtools/scripts/e2e/_e2e-common.mjs` (leading `_` → not
  discovered as a suite).
- `dev.mjs eval [scenarios.json]` = the prompt/agent playground (dry-plan + auto-score, a quality
  benchmark); `dev.mjs memory <export|import>` transfers DB memory; `host`/`publish` run/build the
  desktop bundle; `dev.mjs desktop-e2e` drives the host's WebView2 over CDP.
- **`dev.mjs embed-bench [models…]` re-measures the embedding shortlist** on this app's own recall job
  (fictional zh/en corpus, paraphrase queries), defaulting to whatever embedding models are installed.
  It is committed rather than scratch BECAUSE `EmbeddingCatalog.cs` carries measured numbers and models
  keep appearing — a figure nobody can reproduce decays into an opinion with a number on it. It embeds
  through the OpenAI-compatible endpoint and prompts symmetrically, exactly as the product does; a
  benchmark that embeds differently measures a product we do not ship.
- Scratch files: `devtools/_*` (gitignored). Never OS temp.
