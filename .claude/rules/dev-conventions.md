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
  own `lyntai_*` tables + `lyntai_version_info` (migrated eagerly by `UseSqliteStorage`).
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
  through Lyntai's `AddMcpToolHost(new ClaudeCliMcpDialect())`, which registers an
  `ICliToolProvisioner` — read ONLY by `ClaudeCliProvider`, i.e. the one-shot `ILlmClient` path,
  so this affects the judges and nothing else (the agent path, `ClaudeAgentSession`, takes no
  provisioner — it reaches the app's tools through the loopback channel in the next bullet, a
  different endpoint with a different lifetime). Per call Lyntai starts a bearer-gated loopback
  Kestrel and tears it down after. **It executes app code, so the jail is the load-bearing part**:
  read-only, text extensions only, size-capped, and a POSITIVE allow-list of `plans/ household/
  .claude/` — never `state/` (access token, TLS pfx, DB), with symlink targets re-checked and every
  listing hit re-resolved. That's the same set the planner agent may already read, so the judges gain
  no reach the scope guard doesn't already grant. Registering zero `ITool`s makes the host a no-op.
  Proof lives in `e2e-p36` (the claude stub drives the MCP server for real and asserts the denials).
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
- **Split a growing class into SERVICES, not `partial`s.** `ChatSessionService` reached 1615 lines;
  a `partial` split made the files smaller and changed nothing that mattered, because the class could
  still absorb anything and nobody ever felt the cost. It is now four types — `ChatSessionService`
  (sessions + the two-gate pipeline), `ChatGateService` (the five between-turns gates), `GateMarkers`
  (final text → marker, pure) and `GateCards` (runtime facts → card, pure). The boundary is
  structural: `ChatGateService`'s constructor takes the provision/login/draft/capability/manifest
  services the session pipeline does not need, so a sixth gate lands where those dependencies already
  are. The cycle you would expect is avoided by passing the host per CALL rather than injecting it —
  `ChatSessionService` implements `IChatGateHost` explicitly (seven members), so the seam does not
  widen its public API and anything a gate wants beyond those seven is a design question. `GateCards`
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
  is gone — `error` is honest. A parked one has nothing in flight and its state is already durable, so
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

- **claude CLI only, never API keys.** Resolve the executable via `where.exe` once, preferring
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
  `ClaudeCommand.Resolve` *inside the run*, so only the env var can carry a CLI installed after startup.
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
  diagnosis rewrites the failed-turn messages other suites assert on.

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
  facts themselves were replaced. The graph dedups on **content hash**, so editing a fact orphans its
  previous node; recall over-asks and filters to resolvable refs so an orphan never shrinks the page.
  And every operation degrades to FTS rather than throwing — an index that fails closed is worse than
  one that ranks by relevance alone, and an empty result reads to the agent as "the household knows
  nothing", which is a lie told on their own data. `recall_facts` therefore reports `ranked:
  graph|fts`, because a graph answer and a fallback answer are otherwise indistinguishable. Proof lives
  in `e2e-p48`, whose restore assertion was confirmed to FAIL with the rebuild removed.
- **THE BENCH ASKED IN THE FACT'S OWN LANGUAGE, so it could not see what these layers are for**
  (found 2026-08-23, by the owner, after three sessions of me reporting "no measurable benefit").
  `recall-bench` now generates FOUR question sets per fact (`QUESTION_SETS`): same, cross, a third language,
  and code-switched. Its generator used to be told *"use the same language as the fact"* — so every probe
  shared a script with the text it was hunting, and the 公式 floor could always reach it lexically.
  Meanwhile `ClaudeCliSemanticSource`'s prompt explicitly asks for 另一种语言的常见叫法. **The instrument
  measured everything except the case the feature exists for, and the null result was then read as "the
  feature does nothing".** In a bilingual household a fact written in Chinese and asked in English shares
  NO tokens with the stored text — no trigram, no bm25, nothing for the graph's lexical half — which is
  the one situation where an enrichment layer is the route rather than a bonus.
  Measured with a CROSS-LANGUAGE probe set added beside the same-language one (16 facts, `--limit=3`):

  | set | arm | top-1 | found | miss | MRR |
  |---|---|---|---|---|---|
  | 同语言 | 公式 only | 10/16 | 11/16 | 0.313 | 0.646 |
  | 同语言 | + 判断 | 10/16 | 11/16 | 0.313 | 0.646 |
  | 跨语言 | 公式 only | 9/16 | 9/16 | 0.438 | 0.563 |
  | 跨语言 | **+ 判断** | 10/16 | **11/16** | **0.313** | 0.656 |
  | 第三语言 (ja) | 公式 only | 11/16 | 11/16 | 0.313 | 0.688 |
  | 第三语言 (ja) | **+ 判断** | 12/16 | **13/16** | **0.188** | 0.781 |
  | 混合语言 (code-switched) | 公式 only | 13/16 | 13/16 | 0.188 | 0.813 |
  | 混合语言 (code-switched) | **+ 判断** | 15/16 | **15/16** | **0.063** | 0.938 |

  **The recovery is +2 facts in EVERY non-same-language set and 0 in same-language** — miss rate down a
  flat 0.125 across three independent probe styles, which is far more convincing than any single delta.
  A two-way zh↔en flip was itself too narrow: a household with Japanese or Korean material is not served
  by it, and **code-switching is how people actually type in chat** — a Chinese sentence keeping the key
  nouns in English. That set has both the best floor (it shares some tokens) and the best result with
  enrichment (1 miss of 16). Note the Japanese floor beats the English one, which looks wrong until you
  remember the trigram index: a Japanese question shares KANJI with a Chinese fact, so it is partially
  lexical where English is not. The footer
  that reported one number as "what 判断 did" now names its set and says why the same-language cell reads
  ~0 — quoting it alone argued the layer was useless. **When a measurement says "no effect", check the
  instrument can express the effect** before concluding anything about the feature.
- **判断 DOES reorder a recall — I claimed the opposite and was wrong** (measured 2026-08-22, `dev.mjs
  recall-bench` on this household's own 16 facts). With `VerificationFilters` off — which is how we register
  it, deliberately, so a mistaken verdict costs a little learning rather than a lost answer — a verdict does
  not FILTER and does not re-sort. It sets `answered` and narrows which nodes are REINFORCED. **That
  narrowing reaches the ordering anyway**, which the first version of this bullet denied: proved in a
  fixture by endorsing a fact the engine had ranked third and watching it come back at the top of the page,
  against a measured no-verdict baseline. Reinforcing only the endorsed facts raises their standing inside
  the same call. So the numbers came out byte-identical with the judge on and off (top-1
  10/16, found 11/16, MRR 0.646 both ways, `--limit=3`) at **68–90 ms against 8,936–16,914 ms** per query
  across five paired runs — essentially all of it a CLI spawn, and NOT stable: the panel quoted "约 9 秒"
  for months, which is the fastest of the five and about half the typical wait. Quote a range for anything
  whose cost is a process spawn; a single number is one machine on one afternoon. **The identical MRR is the tell**: "did not help" would have moved the
  third decimal, while "did not run at all on the ordering" is what an exact tie across 16 queries means.
  The bench is **paired and counterbalanced** for this: each query is asked under both arms back to back,
  alternating which goes first, because recall REINFORCES what it returns and LINKS what it returns
  together — running one arm to completion and then the other compares a cold graph to a warmed one. The
  result held under the clean design, which is what makes it a finding rather than an artefact.
  **Both results stand together**, and that is the whole lesson: the judge CAN move a
  result, and on this corpus it moved none, because it endorsed what already ranked top. **That last
  clause is measured, not assumed** — `recall-bench` reports a `judged` column precisely because "the
  judge never produced a parseable verdict" and "the judge agreed with the ranking" yield the IDENTICAL
  table and call for opposite responses. It reads **13/13** with 判断 on and 0/13 with it off, so the
  verdicts were real and the agreement is the explanation. Anything comparing two recall configurations
  has to report how often the thing under test actually ran.
  **The DENOMINATOR is the graph-ranked queries, and getting that wrong invented a defect.** The column
  first counted against all 16 and read 13/16 — which looks like a judge failing 19% of the time, and sent
  me into the logs hunting one that was not there. `answered` rides only on a graph result (`MemoryTools`
  suppresses it on the FTS fallback, where the judged candidates are not the facts being shown), so the
  three had no verdict to report rather than a verdict that failed. Those call for opposite responses —
  the exact conflation this column exists to end, reproduced one level down in its own arithmetic. "Did not change
  the answer here" is a measurement; "cannot change the answer" was an inference, and it was false.
  A workaround was built on that inference — an `AsyncLocal` verdict capture plus an app-side promotion —
  and REVERTED once four successive fixtures all passed with it disabled. Four vacuous tests in a row is
  not bad luck; it is the code under test doing nothing, and the honest reading was that the engine already
  did the job. The fix was to stop claiming otherwise: the panel promised 明显提升召回
  质量 to a household who could not have observed it, and the honest sentence names a cumulative gain against
  an immediate wait. **Anything measured here belongs in the panel**, because the household is the one paying
  the 10 s.
- **A LAYER'S COST LINE DESCRIBES THE BOUND ARM, and 语义's did not — it promised privacy it could not
  keep.** 判断 has always derived its cost from `boundJudge`; 语义 carried a fixed string from when the only
  arm was an embedder: 「占用磁盘与本机算力,不消耗 token;资料不离开这台电脑」. Adding the Claude CLI arm
  left that sentence in place, so a household who chose it was told their facts stay on their machine while
  every fact was being sent to Claude to be rephrased, and billed. **Adding an arm to a layer means
  re-reading everything the layer SAYS**, because the description was written when the set of arms was
  smaller — and a fixed string cannot be wrong about a backend that did not exist when it was written. The
  `what` was wrong the same way (「用本机模型为事实生成向量」 for an arm that is neither local nor makes
  vectors) and now names the JOB instead. `p51` binds each arm and asserts the claim tracks it — including
  that a local arm still SAYS the data stays put, because deleting the promise everywhere would understate
  what running the model yourself actually buys.
- **CROSS-RUN COMPARISON ON THIS CORPUS IS NOT TRUSTWORTHY, and that invalidates the 语义 aggregate
  numbers — including the ones I reported.** Recall REINFORCES, so every `recall-bench` run mutates the
  graph it measures. Two ADJACENT runs came out byte-identical, which looks like stability and is not: it
  shows the state had converged by then, not that it never moved across the ten runs before. So the
  "phrasings present vs cleared" comparison — taken many runs apart — cannot attribute its 1-fact
  differences to phrasings, and the tempting mechanisms do not survive checking: bm25 column weights on
  `aka` changed NOTHING because `judged/graph` shows almost every query is GRAPH-ranked, and the graph
  does not use bm25 at all. **The only trustworthy comparison this tool makes is the within-run paired
  one** (the two 判断 arms), and phrasings cannot be toggled per call — they are durable rows. Measuring
  this layer's aggregate effect properly needs a fixture whose graph state is reset between arms, which
  `recall-bench` deliberately does not do (it runs against the household's real memory).
  What survived: the DIRECT proof, which needed no corpus at all — one fact, one query naming a wording
  that appears only in its phrasings. Two mechanisms built on the unreliable numbers (a phrasing-only
  promotion that displaced the graph's weakest row, and bm25 weights) were both REVERTED as unmeasured.
- **THE REPHRASE PROMPT OFFERED CROSS-LANGUAGE AS AN OPTION, so the model never took it** — and that,
  not the plumbing, is why this layer measured as useless. It said 用词要换(同义词、口语说法、另一种语言的
  常见叫法), three choices, and a model asked for "a different wording" reaches for a synonym every time.
  **Measured on one real fact: four phrasings, not one latin character among them.** A paraphrase that
  stays in the fact's own language adds surface the lexical floor could already reach — which is exactly
  the shape of a feature that runs, costs a model call per fact, and changes nothing.
  The prompt now REQUIRES a line in another language. Same fact, re-written: 1 of 4 phrasings came back in
  English, and an English question then retrieved a fact whose text is entirely Chinese (`ranked: fts` —
  the phrasing in `aka` is what matched). **The mechanism was never in doubt and did not need a corpus to
  prove**: one fact, one query naming a wording that appears only in its phrasings, is the whole test.
  Reaching for a 16-fact benchmark first is what made this look unanswerable for three sessions.
  `e2e-p48` guards the retrieval half — the half that can rot silently — and was confirmed to FAIL when the
  stub's cross-language phrasing is removed.
- **语义's PHRASINGS ARE UNREACHABLE AS WIRED, and forcing them costs more than it buys** (isolated
  2026-08-23). Turning the binding off does not stop phrasings being searched — they are a `knowledge`
  column the FTS table indexes unconditionally — so the only true A/B is *phrasings written* vs *cleared*,
  two database states. Compared on the FLOOR row (`--arms=off`, seconds per run since nothing spawns a
  CLI), with 13 of 16 facts back-filled, across all four question sets: **every cell identical.** Not
  narrowed — unchanged. The cause is the top-up rule: FTS fills only slots the graph left empty, and on
  this corpus the graph fills the page at `--limit=3` AND `--limit=8`, so a phrasing never gets a slot.
  **Tested the obvious fix and rejected it on the numbers.** Letting one text match displace the graph's
  weakest row gave 跨语言 +1 and 混合语言 +1 — and 同语言 **−1**, MRR down. Net +1 across 64 queries,
  bought by breaking the one property that makes the design explainable ("cannot displace a ranked hit")
  and by making the COMMON case worse. Reverted. So the honest statement is that this arm is unproven on
  a corpus this size, and that sentence is now in the arm's own description rather than left for a
  household to discover after paying ~46 s per fact. Contrast 判断, which on the same probes recovers +2
  in every non-same-language set — the two layers are NOT in the same evidential position and the panel
  should not imply they are.
- **语义 · Claude CLI MEASURED, and it changed nothing on this corpus** (2026-08-23, `dev.mjs recall-bench`
  against the household's own 16 facts, phrasings back-filled onto 13 of them). At `--limit=3`: identical to
  the no-phrasing run on every column. At `--limit=8`: found 12/16 and MRR 0.654, against 13/16 and 0.664
  measured before any phrasings existed — no gain, possibly a point of noise the other way. **Two structural
  reasons, and both matter more than the number.** (1) FTS only TOPS UP: when the graph resolves a full page
  the top-up never runs, so at a page of 3 with 3 graph hits a phrasing cannot reach the household at all.
  That is the deliberate "never displace a ranked hit" trade, and its cost is that this arm is inert exactly
  when the graph is confident and wrong. (2) 16 facts cannot support the found/miss columns — the tool says
  so itself rather than printing a number to be quoted. What this does NOT license is removing the arm: it
  is unmeasurable here, not measured useless, and the machine that needs it (no GPU to spare, declining a
  222 MB download) is not this one. It also cost **~46 s per fact** to back-fill, which is the number a
  household weighing it should see.
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
  rather than by dropping a column the backup carries: it earns its place on rows matched by TEXT or by
  SUBJECT, which carry no retrievability and so had no usage signal at all. "Read it or stop writing it" —
  and reading it was the smaller change.
- **A WORKAROUND FOR A LYNTAI GAP IS RECORDED ON BOTH SIDES, or it becomes a duplicate feature.** We are
  review-only on Lyntai, so our fixes for its gaps live here and the request lives in its `TASKS.md`. Each
  half has to name the other: the code says *this exists because the library does not do it, and here is
  what happens when it does*; the task says *an adopter already shipped a workaround, so landing this means
  telling them to remove it*. Without both, a future release closes the gap silently and the app keeps
  running its own copy — two implementations in one call path, each looking necessary to whoever reads only
  one repository. `FactIndex.AppendBySubjectAsync` ↔ Lyntai Part 94 is the worked example, and it also shows
  the note must state the CONSEQUENCE precisely rather than warn vaguely: there, an engine-side seed would
  not double any row (we dedup by graph ref) and would report better numbers than we can, so the honest
  instruction is "delete this", not "beware of conflicts".
- **SUBJECT HANDLES ARE SEARCHABLE, and they were bought long before they were.** With 判断 on, every write
  is annotated and its subjects — stable handles naming what the fact is ABOUT, "配偶", "deploy-key" — are
  recorded. Two things read them, both at WRITE time: linking two facts, and prompting the annotator to
  reuse a handle. **No recall path touched them**, so a household asking "配偶" got nothing from a fact whose
  text says 太太, while a handle saying exactly that sat in the store, paid for by a model call they had
  already made. Same shape as the embedding bought on every write with `SemanticSeedK` at 0 — a cost with no
  matching benefit, invisible from every API response. `FactIndex.AppendBySubjectAsync` closes it: handles
  matching the query as SUBSTRINGS (the query is a sentence and CJK has no spaces — the same reason the FTS
  is trigram), normalized by CALLING `MemorySubject.Normalize` rather than restating it, because the store's
  write applied it and a private `ToLower()` folds `"I"` differently under a Turkish culture. **APPENDED
  after the graph's answer, never merged into it**: `ByGraphRefsAsync` preserves rank order exactly, so this
  can only lengthen a short page and never displace a better hit — which is why it needs no tuning knob.
  That is also why the handles are NOT put into the FTS text, where a generic handle would compete for bm25
  against the fact's own words. A subject hit reports `matched:"subject"` and **omits** retrievability and
  degree — neither was measured, and printing `0.0` claims the fact is fully decayed, a statement about the
  household's memory that nothing checked (the `ranked` principle, one level down). Proof lives in `e2e-p48`
  and was confirmed to FAIL with the append removed — the query returns `[]`, since no fact's text contains
  the handle. **The stub taught the same lesson twice**: its annotation branch must read only the text after
  the last `Fact:`, because Lyntai composes the prompt as [known subjects] + [earlier facts] + the write, so
  a whole-prompt scan hands every handle to every write. That is the p28 cross-fire exactly, one call site
  over, and it was caught by the selectivity assertion rather than in production.
- **Recall quality is THREE INDEPENDENT SWITCHES, and where each one's config lives is decided by WHEN it
  is read.** *Formula* (graph decay + rank fusion + FTS trigram) is the floor: always on, no setup, no
  cost. *Claude CLI* adds annotation per write and verification per recall — and costs a model call for
  each, measured at 4 for 3 writes + 1 recall. *Local model* adds real semantic vectors from a LOCAL
  Ollama: disk and local compute, no tokens, and nothing leaves the machine. They are independent rather
  than tiered because they are complements — verification ACTS ON what was retrieved, embeddings change
  what is RETRIEVABLE — so a household must be able to drop the token cost without losing local semantics.
  The enrichment was adopted wholesale with Lyntai 3.0 and spent that per-operation cost for months with
  no way to decline it; the default stays ON (turning it off by default would silently degrade recall on
  upgrade) but declining is now a setting. **It is an `app_config` value read per call, not a
  registration** — `ServerConfig` reserves `settings.json` for "what must exist before the DB opens", its
  model already lived in cortex as `llm.model.memory`, and splitting one feature's controls across two
  stores also made it need a restart. The decorators that make it live are registered BEFORE
  `AddMemoryAnnotation`/`AddMemoryVerification`, whose `TryAddSingleton` then stands down — the BYO seam
  those registrations document — and "off" returns the library's own `MemoryAnnotation.None` /
  `MemoryVerification.NoOpinion`, a state the engine already treats as "no policy registered", which is
  what makes runtime flipping safe. **NoOpinion, never `NothingRelevant`**: the latter asserts every recall
  found nothing useful and teaches the engine exactly the wrong thing. The LOCAL MODEL is the honest
  exception and stays in `settings.json`: the embedder, vector store and engine member are consumed at DI
  REGISTRATION time, before the container — and therefore the DB — exists, the same reason `security.*`
  lives there. **A consumer routed in `DefaultModelByConsumer` must be settable SOMEWHERE the household can
  reach** — otherwise its model is routable in principle and unreachable in practice, which `memory` was for
  a while, with a comment promising a live override the product gave no way to set. Cortex's `ModelCatalog`
  is the default home and the right one for `chat`/`extract`/`scorer`. **`memory` is the exception and is
  deliberately absent from it**: 记忆检索 binds the judge's model together with its BACKEND, and a cortex row
  beside that was a SECOND writer of one value — the one that won. A household who set 记忆判断 to `haiku`
  there and later moved the judge to a local model had the router asking the Ollama provider for a model
  called `haiku`; both memory policies are fail-open, so the symptom was zero model calls and no error at
  all. Two controls for one value is worse than one control in an unexpected place. Proof lives in
  `e2e-p51`, which asserts the cortex row is GONE as well as that the binding writes the key.
- **Meaning-based fact recall is a GRAPH OPTION and ONE SCOPE — not a second engine member.** Both halves
  were got wrong first, both failed silently, and neither was visible from any API response, so the
  reasoning is on the record. (1) With an embedder + vector store registered, `UseGraph()` already embeds
  every write — for novelty judgement and for linking entries whose text never overlaps — but
  `GraphMemoryOptions.SemanticSeedK` **ships at 0**, "considers none, which is what every version before
  this did". So the embedding was bought on every write and consulted on no recall. Adding a
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
  GRAPH recall too. **3.0.2 fixes (2) upstream — the graph's semantic half now spans scopes on a null-scope
  recall — and one scope stays anyway**: spanning rests on the OPTIONAL `IListableVectorStore`, so a store
  without it yields nothing on the DEFAULT recall, silently, which is the failure class this bullet exists
  to record; and it searches one collection per kind for the same vectors. Note also what one scope did NOT
  buy: cross-kind LINKING already worked, because the graph's lexical recall spans scopes when the query
  names none. Because scope addresses the graph, moving it strands existing entries at the old
  address — reachable only by a rebuild — so `FactIndexStep` carries a **layout marker** (`facts.index.layout`)
  and pays a one-off `RebuildAsync` on upgrade, writing the marker LAST so a crash mid-rebuild retries
  instead of settling into the silent FTS fallback. Proof lives in `e2e-p48`, which asserts the ONE SCOPE
  against the store (no API response shows it, and the suite runs without an embedder so it cannot see
  vectors at all) and was confirmed to FAIL against kind-as-scope. **Lyntai 3.0.2 added a wiring finding for
  (1)** — an embedder + vector store with `SemanticSeedK` at 0 is logged at Warning when the engine factory
  is built — so a regression that re-buys the embedding and reads none of it now announces itself instead of
  showing up as "recall feels no different". Verified both ways on 2026-08-21: silent on the current wiring,
  and firing by name with `SemanticSeedK` put back to 0.
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
  **(2) Ollama's pull/delete was deleted** because 资源 was scoped to "only what Gatherlight provisions".
  That scope decision is about what a PANEL SHOWS; it got carried through into removing
  `PullModelAsync`/`RemoveModelAsync` from `IOllamaRuntime` and the endpoints with them, justified as "an
  unused management verb is an invitation to the next caller". Code hygiene does not outrank what the
  household can do. It cost the free-form field whose own docstring records why it exists — *a catalogue
  baked into a release cannot contain a model published after it*, and this product already shipped once
  without the two strongest options that existed. Restored under 记忆检索 · 本机 — and then removed AGAIN, on
  purpose, when Ollama stopped being a backend at all: at that point the app no longer depended on the daemon,
  so there was nothing left to half-manage. Two removals of the same code, one wrong and one right; the
  difference is whether the DEPENDENCY went with it, not how tidy the interface looked.
  **The test:** if the honest sentence is "it does this less well" or "this costs more", ship the option with
  that sentence attached and let the household weigh it. A DECLINED entry is only for a real impossibility
  (内置 on 判断 needs an in-process chat model, which does not exist) — never for an option nobody built.
  A model row saying "you do not need this" is the same error in miniature: state the trade-off, and say
  when it is unmeasured. And a removed capability needs a test asserting the household can still do it —
  both removals above passed every check, because nothing asserted the ability existed (`p51` now does).

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
  `openai-compat` is ONE class for the whole OpenAI-compatible family (llama-server · LM Studio · vLLM ·
  Jan · LocalAI), not one per product, for the same reason `EmbeddingCatalog` is not a gate: a list of
  products goes stale the moment somebody ships a new runtime. Ollama keeps its own backend because the app can
  *enumerate* it — a model list comes back from the daemon, where `openai-compat` only knows what an address
  reports. It does NOT manage it: as of 2026-08-22 the runtime the app provisions is llama.cpp (next
  bullet). **It is not a backend at all any more** — see the RETIRED ids in the vocabulary bullet: first we
  stopped installing it, then stopped managing its models, and finally stopped connecting to it, because each
  step left the app depending on a runtime it would not own. The intermediate state is the instructive one:
  记忆检索 offered a daemon's models while nothing anywhere could add or remove one, which is a shape with no
  consistent version. `p49` asserts the absent spec against the present `llama-cpp` one, and `p51` asserts
  that binding a retired id is REFUSED (400) rather than silently redirected — the fallback would have moved
  判断 onto account quota nobody chose and switched 语义 off, both invisibly.
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
  latency (25 ms/query through the app against 69). Three things about it are load-bearing and all three
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
  **`p51` pins it, and needed no spawn either**: the start endpoint warms the models the ROUTER reports, so a
  fake router naming two models receives both warm calls. It asserts the two are DIFFERENT requests —
  `/v1/embeddings` for an embedder, `/v1/chat/completions` otherwise — because `embeddings = true` restricts
  that child to one API and the wrong warm call fails against a real llama-server.
  **The first version of that test was vacuous and this is the useful part**: it asserted the endpoint's own
  `warmed` list, which still came back complete with the warm call deleted, because the endpoint builds it
  from the models it probed. A field reporting that work happened is not evidence the work happened. It now
  counts the requests that arrived at the fake server, and fails with `requests:[] reported:[both]` — which
  is the shape of every self-reported metric in this codebase, one level down.
  **(3) `embeddings = true` RESTRICTS a child to embeddings**, so it goes only on embedders, and the answer
  has exactly ONE writer (`ResourceProvisioner.IsEmbeddingGguf`) — exact for what we provision, a *stated*
  name heuristic for a GGUF the household dropped in. It briefly had two copies of a substring test in two
  files, which is the drift this file keeps paying for.
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
- **ONE control writes the judge's model.** `DefaultModelByConsumer["memory"]` and cortex's live
  `llm.model.memory` were two writers and cortex won, so a household who set 记忆判断 to `haiku` and later
  moved the judge local had the router asking Ollama for `haiku` — fail-open both sides, hence zero calls and
  no error. `POST /api/manage/memory/layer/judge` writes source and model together; the cortex row is gone.
  The policies' own `Model` stays **null** so the router still resolves per consumer.
  **The trap:** `LlmRouterFactory.For()` narrows a
  named client's provider POOL but reuses the same options, so a client pooled over `ollama-chat` still
  resolved candidates from `UseDefaultCandidates("claude-cli")` — a provider absent from its own pool. Every
  call logged `router: skipping claude-cli — no provider with this id registered` and failed, and since both
  policies are fail-open the symptom was **zero model calls and no error**. Contained by appending the
  backend to the GLOBAL candidate list with `claude-cli` still first (a fallback, not a re-route, reaching
  only the one-shot `ILlmClient` consumers — never the agent path, which uses `IAgentSession` and does not
  route). Filed upstream. **Verify this class by ROUTING, not registration**: the broken version registered
  cleanly; the probe that caught it drives a real write + recall and reads which backend answered. An
  EMBEDDING model is refused as a judge by name — installed, well-formed, and unable to answer a judgement,
  which fail-open would turn into recall that quietly never improves.
- **A REBUILD SERVES BOTH 语义 ARMS, and guarding it on `_semantic` served only one.** `_semantic` is
  non-null exactly when an EMBEDDER was registered at startup; the Claude CLI rephrasing arm registers
  nothing by design, so for a household bound to it `ReindexSemanticAsync` returned 0 and did nothing —
  while the endpoint still accepted and the detached run still "finished". The effect: binding that arm
  reached FUTURE writes only, an existing knowledge base could never gain phrasings, and the single control
  offered for exactly that reported success having done nothing. Both arms re-derive the same way (re-remember
  every fact), so the question is not "is there an embedder" but "is anything bound that a rewrite would
  re-derive". **They do NOT cost the same thing, and routing both through the rebuild was the next mistake.**
  The rephrasing arm's output is a knowledge COLUMN (`aka`, picked up by the FTS trigger on UPDATE) — none
  of it lives in the graph — so rebuilding to produce it discards every decay position and link the
  household has accumulated in exchange for nothing. An embedder is the opposite: its vectors belong to the
  graph's entries and are written as each is remembered, so re-embedding really is re-remembering. The CLI
  arm gets `ExpandEachAsync` instead, which touches only the column. That is not a tidiness point: the
  over-broad version made "bind it, then rebuild" advice with a hidden price, and made measuring the arm's
  own benefit an operation nobody should agree to. Proof lives in `e2e-p48`, which writes facts BEFORE binding the arm
  and was confirmed to FAIL against the old guard — the phrasings stay empty. Note this also makes the
  advice "bind it, then rebuild" true; it was not, and the panel gave no sign.
- **A rebuild runs detached, and the console reports COVERAGE rather than a run history.** `ReindexSemanticAsync`
  re-remembers every fact (a model call each with enrichment on), so running it inside the POST gave a
  greyed-out button for minutes — indistinguishable from a hang, over a request the browser may abandon while
  the server carries on. It returns 202 and reports progress through `GET /api/manage/memory`; the status is
  deliberately **not** bound to the request's `CancellationToken` (that would cancel the work when the browser
  stopped waiting) and deliberately **not** persisted: the run is an in-process `Task`, so a stored `running`
  would outlive the work it describes — the same lie `SelfHealStateStep` refuses. Durability is unnecessary
  because an interrupted rebuild already heals: `RebuildAsync` clears every `graph_ref` up front, which is
  exactly what the startup back-fill repairs (measured 2026-08-21: 2/6 → 6/6 across a restart). So the panel
  answers "is what I know searchable NOW" with `coverage {indexed,total}`, shown only when short — state is
  self-correcting where an event log is not.
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
  (`PlaywrightHost` browsers path, `GitCliService.GitExe` and `ClaudeCliRuntime.Locate` data-aware).
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
  "update" that would silently replace their own install. `ReplaceBinary` tolerates a running image
  (Windows refuses to overwrite a loaded exe, and an update is exactly when one may be mid-chat) by
  renaming the old copy aside. Proof lives in `e2e-p50`, whose tampered-download denial is paired with
  the same bytes installing under the right checksum, and whose case A asserts the app boots ANYWAY.
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
- The spawned agent is **jailed** by the PreToolUse scope-guard hook
  (`ChatEnvironmentService.ScopeGuardMjs` planner / `guard/system-scope-guard.mjs`
  系统模式 — identical logic, different write-scope; `e2e-p24` runs both): **reads**
  (Read/Grep/Glob) confined to the jail, **writes** (Edit/Write/…) to `plans/ household/ .claude/`
  (planner) or the **whole code repo except the PROTECTED set** — `guard/`, `src/server`,
  `.claude/settings*.json`, `.git` — (系统模式). Each guard combines an allow-list (`WRITE_DIRS`)
  with a `PROTECTED` deny-list that overrides it (the planner protects `.claude/hooks` + settings so
  the agent can't neuter its own guard). **Bash** denied git-history / network-egress / inline-eval
  (`node -e`, `python -c`) / fs-crawl / path-escape. Anything genuinely **out-of-boundary must
  route through a server MCP tool** — mediated + auditable — never raw Bash. Enforcement, not
  trust. The guard carries a `GUARD_VERSION`; the server re-issues it into existing data folders
  when it bumps (it's a security boundary, not editable KB content). The `guard/` folder is
  app-managed (shipped + overlaid by updates), read-only to the agent. Residuals the hook can't
  close (code run *inside* an agent-authored script; exfil via a fetched URL) need an OS sandbox —
  **declined**, and the reasoning is on the record in `docs/ROADMAP.md`: the `claude` CLI authenticates
  per-user, so a low-privilege service account breaks the mechanism the whole product rests on.
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

- `node devtools/dev.mjs <server|host|desktop-e2e|vite|build|publish|resources-pack|e2e|smoke|memory|eval|embed-bench|test-data|install-hooks|check-sensitive|check-layering|check-ui-registry|check-tool-docs|check-host-actions>`
  — kept in step with the tool's own usage line (`dev.mjs`, bottom of the switch).
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
- **A UI HARNESS MUST RETRY THE ACTION, not only poll the result.** `desktop-e2e` polled for the view
  after clicking a tab ONCE — and a click dispatched before React has wired the handler is swallowed
  silently, so no amount of waiting produces the view. That flapped run to run and reads as "the Cortex
  tab is broken". Same shape twice more in the same file: the memory cards were read after a fixed 900 ms
  (the panel fetches its own state after Cortex mounts, so the assertion reported "renders nothing" while
  a diagnostic three lines later found all three), and the enrichment toggle was read 900 ms after
  clicking, mid-refetch, so it reported "the switch does not flip". **A fixed sleep does not fail
  honestly — it fails as a wrong description of the product**, which is worse than a red that says
  "timed out". Poll the condition, and re-issue the action each round.
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
